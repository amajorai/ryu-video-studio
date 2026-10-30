import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { type Asset, projectSchema } from "../../shared/project.ts";
import {
	type SoundtrackRequest,
	soundtrackJobSchema,
} from "../../shared/soundtrack.ts";
import * as media from "./media.ts";
import { createStudioServer } from "./server.ts";
import {
	activeSynthesisSlots,
	estimatedSynthesisMs,
	INLINE_SYNTHESIS_BUDGET_MS,
	SoundtrackBusyError,
	soundtrackRendersInBackground,
	synthesisTimeoutMs,
} from "./soundtrack.ts";
import { StudioStore } from "./store.ts";

const stores: StudioStore[] = [];
const servers: ReturnType<typeof createStudioServer>[] = [];
const pending: ReturnType<typeof Promise.withResolvers<string>>[] = [];
const launches: { args: string[]; signal?: AbortSignal }[] = [];

async function fixture() {
	const store = new StudioStore(
		await mkdtemp(join(tmpdir(), "ryu-soundtrack-jobs-"))
	);
	stores.push(store);
	const token = crypto.randomUUID();
	const app = createStudioServer({ store, token, port: 0 });
	servers.push(app);
	const call = (path: string, method = "GET", body?: unknown) =>
		fetch(`http://127.0.0.1:${app.server.port}/api/video-studio${path}`, {
			method,
			headers: {
				authorization: `Bearer ${token}`,
				"content-type": "application/json",
			},
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		});
	return { app, call, store };
}

/**
 * ffmpeg stub that waits until the test resolves (or rejects) each launch.
 * Like `runMedia`, it refuses an aborted signal and stops on abort: a job
 * whose server stopped while it was still preparing (slow file system calls
 * on Windows) must not launch after the test's cleanup and keep its
 * synthesis slot into the next test.
 */
function holdRenderer() {
	spyOn(media, "runMedia").mockImplementation(async (args, options) => {
		const signal = options?.signal;
		await Bun.write(args.at(-1) ?? "", "fixture WAV source");
		if (signal?.aborted) {
			throw new Error("Operation canceled.");
		}
		const done = Promise.withResolvers<string>();
		pending.push(done);
		launches.push({ args, signal });
		signal?.addEventListener(
			"abort",
			() => done.reject(new Error("Operation canceled.")),
			{ once: true }
		);
		return await done.promise;
	});
	spyOn(media, "probe").mockResolvedValue({
		kind: "audio",
		duration: 600,
		width: 0,
		height: 0,
		hasAudio: true,
	});
}

/**
 * Polls for up to 4 s (inside the 5 s test timeout): the full serial suite
 * can delay fixture work past the old 2 s window.
 */
async function until(predicate: () => boolean) {
	for (let attempt = 0; attempt < 800 && !predicate(); attempt++) {
		await Bun.sleep(5);
	}
	if (!predicate()) {
		throw new Error("Fixture work did not reach the expected stage.");
	}
}

async function pollJob(
	call: Awaited<ReturnType<typeof fixture>>["call"],
	id: string
) {
	for (let attempt = 0; attempt < 400; attempt++) {
		const job = soundtrackJobSchema.parse(
			await (await call(`/soundtrack-jobs?id=${id}`)).json()
		);
		if (job.status !== "running") {
			return job;
		}
		await Bun.sleep(5);
	}
	throw new Error("The soundtrack job did not finish.");
}

afterEach(async () => {
	for (const done of pending.splice(0)) {
		done.reject(new Error("fixture canceled"));
	}
	launches.splice(0);
	for (const server of servers.splice(0)) {
		server.stop();
	}
	// A canceled launch frees its sidecar-wide slot only after removing its
	// temporary file; under load that outlives a fixed pause, and a leaked
	// slot makes the next test's budget look full.
	for (
		let attempt = 0;
		attempt < 400 && activeSynthesisSlots() > 0;
		attempt++
	) {
		await Bun.sleep(5);
	}
	mock.restore();
	for (const store of stores.splice(0)) {
		store.close();
		await rm(store.directory, { recursive: true, force: true });
	}
});

const longBand: SoundtrackRequest = {
	bpm: 120,
	duration: 600,
	mood: "upbeat",
	sections: [
		{ start: 0, end: 300, intensity: 0.3 },
		{ start: 300, end: 600, intensity: 1 },
	],
};

describe("synthesis budget", () => {
	test("time limits cover a slow full band with headroom", () => {
		// Measured: the full band with sections costs about 255 ms per second.
		expect(synthesisTimeoutMs(1)).toBe(121_000);
		expect(synthesisTimeoutMs(600)).toBeGreaterThan(600 * 255 * 2);
		expect(synthesisTimeoutMs(7200)).toBe(7_320_000);
	});

	test("only band scores that outlast the request window render in the background", () => {
		expect(estimatedSynthesisMs(longBand)).toBeGreaterThan(
			INLINE_SYNTHESIS_BUDGET_MS
		);
		expect(soundtrackRendersInBackground(longBand)).toBe(true);
		expect(
			soundtrackRendersInBackground({ ...longBand, duration: 60, sections: [] })
		).toBe(false);
		// The original pluck score keeps its synchronous contract.
		expect(
			soundtrackRendersInBackground({ duration: 7200, mood: "warm" })
		).toBe(false);
	});

	test("the busy message names local audio jobs, not soundtracks", () => {
		expect(new SoundtrackBusyError().message).toBe(
			"Two local audio jobs (soundtracks or sound effects) are already running. Wait for one to finish, then try again."
		);
	});
});

describe("background soundtrack jobs", () => {
	test("a long band score returns 202 and its job finishes with the asset after the request ends", async () => {
		holdRenderer();
		const { call, store } = await fixture();
		const response = await call("/soundtrack", "POST", longBand);
		expect(response.status).toBe(202);
		const { job } = (await response.json()) as { job: unknown };
		const started = soundtrackJobSchema.parse(job);
		expect(started.status).toBe("running");
		await until(() => launches.length === 1);
		// The job's signal is not tied to the finished HTTP request.
		expect(launches[0]?.signal?.aborted).toBe(false);
		expect(launches[0]?.args.join(" ")).toContain("d=600");
		const running = await call(`/soundtrack-jobs?id=${started.id}`);
		expect(soundtrackJobSchema.parse(await running.json()).status).toBe(
			"running"
		);
		pending[0]?.resolve("");
		const finished = await pollJob(call, started.id);
		expect(finished.status).toBe("done");
		expect(finished.asset).toMatchObject({ kind: "audio" });
		expect(store.assets()).toHaveLength(1);
		expect(
			await readdir(join(store.directory, "imports", "soundtracks"))
		).toEqual([]);
	});

	test("a long script music bed renders in the background and is placed when it finishes", async () => {
		holdRenderer();
		const { call, store } = await fixture();
		const asset = (kind: Asset["kind"], duration: number): Asset => {
			const value: Asset = {
				createdAt: new Date().toISOString(),
				duration,
				hasAudio: kind !== "image",
				height: kind === "audio" ? 0 : 720,
				id: crypto.randomUUID(),
				kind,
				name: kind,
				width: kind === "audio" ? 0 : 1280,
			};
			store.putAsset(value);
			return value;
		};
		const voice = asset("audio", 300);
		const still = asset("image", 0);
		const project = store.create("Long script");
		const response = await call(
			`/projects/${project.id}/script-assemble`,
			"POST",
			{
				captions: false,
				music: { mood: "upbeat" },
				revision: project.revision,
				scenes: [
					{
						narrationAssetId: voice.id,
						text: "Long.",
						visualAssetId: still.id,
					},
				],
			}
		);
		expect(response.status).toBe(200);
		const body = z
			.object({
				music: z.object({
					job: z.object({ id: z.string() }),
					mood: z.string(),
					status: z.string(),
				}),
				project: z.unknown(),
			})
			.parse(await response.json());
		expect(body.music).toMatchObject({ mood: "upbeat", status: "running" });
		const assembled = projectSchema.parse(body.project);
		expect(assembled.segments).toHaveLength(2);
		await until(() => launches.length === 1);
		expect(launches[0]?.args.join(" ")).toContain("d=300");
		pending[0]?.resolve("");
		const finished = await pollJob(call, body.music.job.id);
		expect(finished.status).toBe("done");
		const latest = store.project(project.id);
		expect(latest.revision).toBe(assembled.revision + 1);
		const bed = latest.segments.find((segment) => segment.track === 2);
		expect(bed).toMatchObject({ duckUnderVoice: true, start: 0 });
		expect(bed?.sourceOut).toBe(300);
	});

	test("a failed job reports a readable error and frees its slot", async () => {
		holdRenderer();
		const { call } = await fixture();
		const response = await call("/soundtrack", "POST", longBand);
		const { job } = (await response.json()) as { job: { id: string } };
		await until(() => launches.length === 1);
		pending[0]?.reject(new Error("ffmpeg exited with code 1"));
		const failed = await pollJob(call, job.id);
		expect(failed).toMatchObject({
			status: "failed",
			error: {
				code: "SOUNDTRACK_FAILED",
				message: "ffmpeg exited with code 1",
			},
		});
		const again = await call("/soundtrack", "POST", longBand);
		expect(again.status).toBe(202);
	});

	test("server shutdown cancels a background job", async () => {
		holdRenderer();
		const { app, call } = await fixture();
		const response = await call("/soundtrack", "POST", longBand);
		expect(response.status).toBe(202);
		await until(() => launches.length === 1);
		app.stop();
		expect(launches[0]?.signal?.aborted).toBe(true);
	});

	test("a full budget refuses a job with 429 and records nothing", async () => {
		holdRenderer();
		const { call } = await fixture();
		const sfx = [
			call("/sfx", "POST", { kind: "riser", duration: 4 }),
			call("/sfx", "POST", { kind: "riser", duration: 4 }),
		];
		await until(() => launches.length === 2);
		const busy = await call("/soundtrack", "POST", longBand);
		expect(busy.status).toBe(429);
		expect(await busy.json()).toEqual({
			code: "SOUNDTRACK_BUSY",
			message: new SoundtrackBusyError().message,
		});
		for (const done of pending.splice(0)) {
			done.resolve("");
		}
		expect((await Promise.all(sfx)).map((item) => item.status)).toEqual([
			201, 201,
		]);
	});

	test("unknown or malformed job ids are refused", async () => {
		const { call } = await fixture();
		const missing = await call(`/soundtrack-jobs?id=${crypto.randomUUID()}`);
		expect(missing.status).toBe(404);
		const malformed = await call("/soundtrack-jobs?id=nope");
		expect(malformed.status).toBe(400);
	});
});
