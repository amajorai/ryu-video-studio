import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as media from "./media.ts";
import { createStudioServer } from "./server.ts";
import { generateSoundtrack, SoundtrackBusyError } from "./soundtrack.ts";
import { StudioStore } from "./store.ts";

const stores: StudioStore[] = [];
const servers: ReturnType<typeof createStudioServer>[] = [];
const requests: Promise<unknown>[] = [];
const jobs: {
	output: string;
	signal?: AbortSignal;
	done: ReturnType<typeof Promise.withResolvers<string>>;
}[] = [];
const probes: ReturnType<
	typeof Promise.withResolvers<Awaited<ReturnType<typeof media.probe>>>
>[] = [];
let holdProbe = false;
const audio: Awaited<ReturnType<typeof media.probe>> = {
	kind: "audio",
	duration: 0.5,
	width: 0,
	height: 0,
	hasAudio: true,
};

async function fixture() {
	const store = new StudioStore(
		await mkdtemp(join(tmpdir(), "ryu-soundtrack-admission-"))
	);
	stores.push(store);
	const token = crypto.randomUUID();
	const app = createStudioServer({ store, token, port: 0 });
	servers.push(app);
	return {
		store,
		app,
		token,
		url: `http://127.0.0.1:${app.server.port}/api/video-studio/soundtrack`,
	};
}

function stubRenderer() {
	const launch = spyOn(media, "runMedia").mockImplementation(
		async (args, options) => {
			const output = args.at(-1)!;
			await Bun.write(output, "small fixture WAV source");
			const done = Promise.withResolvers<string>();
			jobs.push({ output, signal: options?.signal, done });
			return await done.promise;
		}
	);
	spyOn(media, "probe").mockImplementation(async (_path, signal) => {
		signal?.throwIfAborted();
		if (!holdProbe) {
			return audio;
		}
		const done =
			Promise.withResolvers<Awaited<ReturnType<typeof media.probe>>>();
		probes.push(done);
		return await done.promise;
	});
	return launch;
}

async function until(predicate: () => boolean) {
	for (let i = 0; i < 200 && !predicate(); i++) {
		await Bun.sleep(5);
	}
	if (!predicate()) {
		throw new Error("Fixture work did not reach the expected stage.");
	}
}

function post(
	app: Awaited<ReturnType<typeof fixture>>,
	duration = 0.5,
	token: string = app.token
) {
	const response = fetch(app.url, {
		method: "POST",
		headers: {
			authorization: `Bearer ${token}`,
			"content-type": "application/json",
		},
		body: JSON.stringify({ duration, mood: "warm" }),
	});
	requests.push(response);
	return response;
}

afterEach(async () => {
	for (const server of servers.splice(0)) {
		server.stop();
	}
	for (const job of jobs.splice(0)) {
		job.done.reject(new Error("fixture canceled"));
	}
	for (const probe of probes.splice(0)) {
		probe.reject(new Error("fixture canceled"));
	}
	await Promise.allSettled(requests.splice(0));
	mock.restore();
	for (const store of stores.splice(0)) {
		store.close();
		await rm(store.directory, {
			recursive: true,
			force: true,
			maxRetries: 10,
			retryDelay: 100,
		});
	}
	holdProbe = false;
});

test("authenticated soundtrack pressure is bounded across stores, factories, and direct callers until import cleanup", async () => {
	const launch = stubRenderer();
	const first = await fixture();
	const second = await fixture();
	const firstResponse = post(first);
	await until(() => jobs.length === 1);
	expect(launch).toHaveBeenCalledTimes(1); // Prove the stub before requesting the two-hour boundary.
	const secondResponse = post(second, 7200);
	await until(() => jobs.length === 2);
	expect(launch.mock.calls[1]![0]).toContain("7200");
	for (const app of [first, second]) {
		const busy = await post(app);
		expect(busy.status).toBe(429);
		expect(await busy.json()).toMatchObject({ code: "SOUNDTRACK_BUSY" });
	}
	const unauthorized = await post(second, 0.5, "wrong-token");
	expect(unauthorized.status).toBe(401);
	const direct = generateSoundtrack(first.store, { duration: 0.5 });
	requests.push(direct);
	await expect(direct).rejects.toBeInstanceOf(SoundtrackBusyError);
	expect(launch).toHaveBeenCalledTimes(2);
	holdProbe = true;
	jobs[0]!.done.resolve("");
	await until(() => probes.length === 1);
	expect((await post(second)).status).toBe(429); // Generation has ended, import still owns the slot.
	probes[0]!.resolve(audio);
	expect((await firstResponse).status).toBe(201);
	expect(await Bun.file(jobs[0]!.output).exists()).toBe(false);
	holdProbe = false;
	const retry = post(first);
	await until(() => jobs.length === 3);
	jobs[2]!.done.resolve("");
	jobs[1]!.done.resolve("");
	expect((await retry).status).toBe(201);
	expect((await secondResponse).status).toBe(201);
	expect(
		await readdir(join(first.store.directory, "imports", "soundtracks"))
	).toEqual([]);
	expect(
		await readdir(join(second.store.directory, "imports", "soundtracks"))
	).toEqual([]);
});

test("synthesis and probe failure release admission after their temporary files are removed", async () => {
	stubRenderer();
	const app = await fixture();
	const failed = post(app);
	await until(() => jobs.length === 1);
	jobs[0]!.done.reject(new Error("synthesis failed"));
	expect((await failed).status).toBe(400);
	expect(await Bun.file(jobs[0]!.output).exists()).toBe(false);
	holdProbe = true;
	const probeFailed = post(app);
	await until(() => jobs.length === 2);
	jobs[1]!.done.resolve("");
	await until(() => probes.length === 1);
	probes[0]!.reject(new Error("probe failed"));
	expect((await probeFailed).status).toBe(400);
	expect(await Bun.file(jobs[1]!.output).exists()).toBe(false);
	expect(app.store.assets()).toEqual([]);
	holdProbe = false;
	const retry = post(app);
	await until(() => jobs.length === 3);
	jobs[2]!.done.resolve("");
	expect((await retry).status).toBe(201);
});

test("shutdown cancels generation but holds admission until subprocess work and cleanup settle", async () => {
	stubRenderer();
	const first = await fixture();
	const second = await fixture();
	post(first);
	post(first);
	await until(() => jobs.length === 2);
	first.app.stop();
	expect(jobs.every((job) => job.signal?.aborted)).toBe(true);
	expect((await post(second)).status).toBe(429);
	jobs[0]!.done.reject(new Error("subprocess closed after cancel"));
	jobs[1]!.done.reject(new Error("subprocess closed after cancel"));
	await Promise.allSettled(requests.slice(0, 2));
	expect(
		await readdir(join(first.store.directory, "imports", "soundtracks"))
	).toEqual([]);
	const retry = post(second);
	await until(() => jobs.length === 3);
	jobs[2]!.done.resolve("");
	expect((await retry).status).toBe(201);
});

test("invalid and already canceled calls consume no soundtrack admission", async () => {
	const launch = stubRenderer();
	const app = await fixture();
	await expect(
		generateSoundtrack(app.store, { duration: 7201 })
	).rejects.toBeDefined();
	const signal = AbortSignal.abort();
	await expect(
		generateSoundtrack(app.store, { duration: 7200 }, { signal })
	).rejects.toBeDefined();
	expect(launch).not.toHaveBeenCalled();
});
