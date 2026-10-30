import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import {
	type LottieMeta,
	lottieFinishResponseSchema,
} from "../../shared/lottie.ts";
import {
	abortLottieSession,
	appendLottieFrames,
	finishLottieSession,
	LOTTIE_SESSION_IDLE_MS,
	type LottieIdleScheduler,
	lottieEncodeArgs,
	lottieOutputBudget,
	lottiePreviewArgs,
	lottieSessionCount,
	MAX_LOTTIE_SESSIONS,
	pruneLottieSessions,
} from "./lottie-encode.ts";
import { runMedia } from "./media.ts";
import { isMediaLeftover, sweepMediaLeftovers } from "./media-leftovers.ts";
import { routes } from "./routes/matte.ts";
import { createStudioServer } from "./server.ts";
import { ConflictError, StudioStore } from "./store.ts";

/** A scheduler driven by an explicit clock instead of real timers. */
function manualScheduler() {
	let now = 0;
	const pending = new Map<number, { at: number; callback: () => void }>();
	let nextHandle = 0;
	const scheduler: LottieIdleScheduler = {
		clear: (handle) => {
			if (typeof handle === "number") {
				pending.delete(handle);
			}
		},
		set: (callback, ms) => {
			nextHandle += 1;
			pending.set(nextHandle, { at: now + ms, callback });
			return nextHandle;
		},
	};
	const advance = (ms: number) => {
		now += ms;
		for (const [handle, timer] of [...pending].sort(
			(left, right) => left[1].at - right[1].at
		)) {
			if (timer.at <= now && pending.has(handle)) {
				pending.delete(handle);
				timer.callback();
			}
		}
	};
	return { advance, scheduler };
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) {
		await cleanup();
	}
});

let scratch = "";
let frame = "";
let smallFrame = "";

async function rgbaPng(size: string, name: string): Promise<string> {
	const path = join(scratch, name);
	await runMedia([
		"-hide_banner",
		"-loglevel",
		"error",
		"-y",
		"-f",
		"lavfi",
		"-i",
		`color=c=red@0.5:s=${size},format=rgba`,
		"-frames:v",
		"1",
		"-f",
		"image2",
		path,
	]);
	return (await readFile(path)).toString("base64");
}

beforeAll(async () => {
	scratch = await mkdtemp(join(tmpdir(), "ryu-lottie-frames-"));
	frame = await rgbaPng("64x48", "frame.png");
	smallFrame = await rgbaPng("32x32", "small.png");
	return async () => await rm(scratch, { recursive: true, force: true });
});

async function testStore() {
	const store = new StudioStore(await mkdtemp(join(tmpdir(), "ryu-lottie-")));
	cleanups.push(async () => {
		store.close();
		await rm(store.directory, { recursive: true, force: true });
	});
	return store;
}

const meta = (overrides: Partial<LottieMeta> = {}): LottieMeta => ({
	fps: 30,
	frameCount: 4,
	height: 48,
	name: "Spinner",
	width: 64,
	...overrides,
});

const frames = (count: number) => Array.from({ length: count }, () => frame);

async function workDirectories(store: StudioStore): Promise<string[]> {
	return (await readdir(join(store.directory, "media"))).filter((name) =>
		name.startsWith(".lottie-")
	);
}

describe("Lottie frame sessions", () => {
	test("chunks must arrive in order; out-of-order and repeated chunks conflict", async () => {
		const store = await testStore();
		const sessionId = crypto.randomUUID();
		expect(
			await appendLottieFrames(store, {
				frames: frames(2),
				index: 0,
				meta: meta(),
				sessionId,
			})
		).toEqual({ frameCount: 4, received: 2, sessionId });
		await expect(
			appendLottieFrames(store, { frames: frames(1), index: 3, sessionId })
		).rejects.toBeInstanceOf(ConflictError);
		await expect(
			appendLottieFrames(store, { frames: frames(1), index: 1, sessionId })
		).rejects.toBeInstanceOf(ConflictError);
		// Re-opening an existing session is refused too.
		await expect(
			appendLottieFrames(store, {
				frames: frames(1),
				index: 0,
				meta: meta(),
				sessionId,
			})
		).rejects.toBeInstanceOf(ConflictError);
		await expect(
			appendLottieFrames(store, { frames: frames(3), index: 2, sessionId })
		).rejects.toThrow("More Lottie frames");
		// Finishing early is refused and keeps the session.
		await expect(finishLottieSession(store, sessionId)).rejects.toThrow(
			"2 of 4 frames"
		);
		expect(
			await appendLottieFrames(store, {
				frames: frames(2),
				index: 2,
				sessionId,
			})
		).toEqual({ frameCount: 4, received: 4, sessionId });
		expect(
			(
				await readdir(join(store.directory, "media", `.lottie-${sessionId}`))
			).sort()
		).toEqual([
			"frame-00000.png",
			"frame-00001.png",
			"frame-00002.png",
			"frame-00003.png",
		]);
	});

	test("unknown sessions, wrong sizes and non-PNG frames are refused", async () => {
		const store = await testStore();
		await expect(
			appendLottieFrames(store, {
				frames: frames(1),
				index: 1,
				sessionId: crypto.randomUUID(),
			})
		).rejects.toThrow("expired");
		await expect(
			appendLottieFrames(store, {
				frames: [smallFrame],
				index: 0,
				meta: meta(),
				sessionId: crypto.randomUUID(),
			})
		).rejects.toThrow("must be 64x48; got 32x32");
		await expect(
			appendLottieFrames(store, {
				frames: [Buffer.from("not a png at all, sorry").toString("base64")],
				index: 0,
				meta: meta(),
				sessionId: crypto.randomUUID(),
			})
		).rejects.toThrow("must be PNG");
		// A failed first chunk leaves no session or files behind.
		expect(lottieSessionCount(store)).toBe(0);
		expect(await workDirectories(store)).toEqual([]);
	});

	test("abort and idle expiry delete the frames; open sessions are bounded", async () => {
		const store = await testStore();
		const ids = Array.from({ length: MAX_LOTTIE_SESSIONS }, () =>
			crypto.randomUUID()
		);
		for (const sessionId of ids) {
			await appendLottieFrames(
				store,
				{ frames: frames(1), index: 0, meta: meta(), sessionId },
				1000
			);
		}
		await expect(
			appendLottieFrames(
				store,
				{
					frames: frames(1),
					index: 0,
					meta: meta(),
					sessionId: crypto.randomUUID(),
				},
				1000
			)
		).rejects.toThrow("already running");
		expect(await abortLottieSession(store, ids[0] ?? "")).toBe(true);
		expect(await abortLottieSession(store, ids[0] ?? "")).toBe(false);
		expect(await workDirectories(store)).toHaveLength(1);
		expect(
			await pruneLottieSessions(store, 1000 + LOTTIE_SESSION_IDLE_MS)
		).toEqual([]);
		expect(
			await pruneLottieSessions(store, 1001 + LOTTIE_SESSION_IDLE_MS)
		).toEqual([ids[1]]);
		expect(lottieSessionCount(store)).toBe(0);
		expect(await workDirectories(store)).toEqual([]);
	});

	test("encode arguments are ProRes 4444 with 10-bit alpha at the project rate", () => {
		const args = lottieEncodeArgs({ fps: 29.97, frameCount: 12 });
		const flagValue = (flag: string) => args[args.indexOf(flag) + 1];
		expect(flagValue("-framerate")).toBe("30000/1001");
		expect(flagValue("-frames:v")).toBe("12");
		expect(flagValue("-c:v")).toBe("prores_ks");
		expect(flagValue("-profile:v")).toBe("4");
		expect(flagValue("-pix_fmt")).toBe("yuva444p10le");
		expect(flagValue("-protocol_whitelist")).toBe("file");
		expect(args.at(-1)).toBe("lottie.mov");
		expect(
			lottieOutputBudget({ frameCount: 600, height: 1920, width: 1920 })
		).toBe(4 * 1024 * 1024 * 1024);
	});

	test("an idle session expires on its own timer, without another upload", async () => {
		const store = await testStore();
		const sessionId = crypto.randomUUID();
		await appendLottieFrames(
			store,
			{ frames: frames(1), index: 0, meta: meta(), sessionId },
			Date.now(),
			{ idleMs: 40 }
		);
		expect(lottieSessionCount(store)).toBe(1);
		expect(await workDirectories(store)).toHaveLength(1);
		await Bun.sleep(200);
		expect(lottieSessionCount(store)).toBe(0);
		expect(await workDirectories(store)).toEqual([]);
		// The reservation was released with it: a later chunk finds no session.
		await expect(
			appendLottieFrames(store, { frames: frames(1), index: 1, sessionId })
		).rejects.toThrow("expired");
	});

	test("an upload resets the idle timer", async () => {
		const store = await testStore();
		const sessionId = crypto.randomUUID();
		const clock = manualScheduler();
		await appendLottieFrames(
			store,
			{ frames: frames(1), index: 0, meta: meta(), sessionId },
			Date.now(),
			{ idleMs: 150, scheduler: clock.scheduler }
		);
		clock.advance(100);
		await appendLottieFrames(store, { frames: frames(1), index: 1, sessionId });
		clock.advance(100);
		expect(lottieSessionCount(store)).toBe(1);
		clock.advance(50);
		expect(lottieSessionCount(store)).toBe(0);
	});

	test("work files left by a stopped sidecar are swept on first use", async () => {
		const store = await testStore();
		const media = join(store.directory, "media");
		const orphan = join(media, `.lottie-${crypto.randomUUID()}`);
		const matteTemp = `.matte-${crypto.randomUUID()}.png`;
		await mkdir(orphan, { recursive: true });
		await writeFile(join(orphan, "frame-00000.png"), "x");
		await writeFile(join(media, matteTemp), "x");
		await writeFile(join(media, ".lottie-notes"), "kept");
		expect(isMediaLeftover(matteTemp)).toBe(true);
		expect(isMediaLeftover(".lottie-notes")).toBe(false);
		// Any matte or Lottie call sweeps first; a new session is then kept.
		const sessionId = crypto.randomUUID();
		await appendLottieFrames(store, {
			frames: frames(1),
			index: 0,
			meta: meta(),
			sessionId,
		});
		expect((await readdir(media)).sort()).toEqual(
			[".lottie-notes", `.lottie-${sessionId}`].sort()
		);
		// The sweep runs once per store.
		expect(await sweepMediaLeftovers(store)).toHaveLength(2);
		await abortLottieSession(store, sessionId);
	});

	test("preview arguments are VP9 with alpha", () => {
		const args = lottiePreviewArgs({ fps: 25, frameCount: 9 });
		const flagValue = (flag: string) => args[args.indexOf(flag) + 1];
		expect(flagValue("-framerate")).toBe("25");
		expect(flagValue("-frames:v")).toBe("9");
		expect(flagValue("-c:v")).toBe("libvpx-vp9");
		expect(flagValue("-pix_fmt")).toBe("yuva420p");
		expect(flagValue("-f")).toBe("image2");
		expect(args.at(-2)).toBe("webm");
	});

	test("finish encodes a video asset with alpha and removes the session", async () => {
		const store = await testStore();
		const sessionId = crypto.randomUUID();
		await appendLottieFrames(store, {
			frames: frames(3),
			index: 0,
			meta: meta({ frameCount: 6 }),
			sessionId,
		});
		await appendLottieFrames(store, { frames: frames(3), index: 3, sessionId });
		const { asset, preview } = await finishLottieSession(store, sessionId);
		expect(asset).toMatchObject({
			derivation: "lottie",
			hasAudio: false,
			height: 48,
			kind: "video",
			name: "Spinner",
			width: 64,
		});
		expect(asset.duration).toBeCloseTo(0.2, 2);
		// The browser preview copy is a VP9 WebM proxy of the master.
		expect(preview).toMatchObject({
			derivation: "proxy",
			derivedFromAssetId: asset.id,
			height: 48,
			kind: "video",
			width: 64,
		});
		expect(
			store
				.assets()
				.map((item) => item.id)
				.sort()
		).toEqual([asset.id, preview?.id ?? ""].sort());
		const previewStream = await ffprobeStream(
			store.mediaPath(preview?.id ?? "")
		);
		expect(previewStream.codec_name).toBe("vp9");
		// Decoded with libvpx (as Chromium does), the alpha plane survives.
		// The frames are 50% opaque red; lossy VP9 keeps that within a step.
		const alpha = await previewAlpha(store.mediaPath(preview?.id ?? ""));
		expect(Math.abs(alpha - 128)).toBeLessThanOrEqual(2);
		expect(lottieSessionCount(store)).toBe(0);
		expect(await workDirectories(store)).toEqual([]);
		const stream = await ffprobeStream(store.mediaPath(asset.id));
		expect(stream.codec_name).toBe("prores");
		expect(stream.pix_fmt).toMatch(/^yuva444p/);
		expect(stream.nb_frames).toBe("6");
	}, 60_000);
});

/** Center alpha of the first frame, decoding with libvpx-vp9 (alpha-aware). */
async function previewAlpha(path: string): Promise<number> {
	const output = join(scratch, `${crypto.randomUUID()}.gray`);
	await runMedia([
		"-hide_banner",
		"-loglevel",
		"error",
		"-y",
		"-c:v",
		"libvpx-vp9",
		"-i",
		path,
		"-vf",
		"alphaextract,crop=1:1:32:24,format=gray",
		"-frames:v",
		"1",
		"-f",
		"rawvideo",
		output,
	]);
	return (await readFile(output))[0] ?? -1;
}

async function ffprobeStream(path: string) {
	const output = join(scratch, `${crypto.randomUUID()}.json`);
	await runMedia(
		[
			"-v",
			"error",
			"-select_streams",
			"v:0",
			"-show_entries",
			"stream=codec_name,pix_fmt,nb_frames",
			"-of",
			"json",
			"-o",
			output,
			path,
		],
		{ probe: true }
	);
	return (
		z
			.object({
				streams: z.array(
					z.object({
						codec_name: z.string(),
						// WebM streams carry no frame count.
						nb_frames: z.string().optional(),
						pix_fmt: z.string(),
					})
				),
			})
			.parse(JSON.parse(await readFile(output, "utf8"))).streams[0] ?? {
			codec_name: "",
			nb_frames: "",
			pix_fmt: "",
		}
	);
}

describe("Lottie routes", () => {
	test("upload, conflict, abort and finish over HTTP", async () => {
		const store = await testStore();
		const token = crypto.randomUUID();
		const app = createStudioServer({ store, token, port: 0, routes });
		cleanups.push(async () => app.stop());
		const call = (method: string, path: string, body?: unknown) =>
			fetch(`http://127.0.0.1:${app.server.port}/api/video-studio${path}`, {
				method,
				headers: {
					authorization: `Bearer ${token}`,
					"content-type": "application/json",
				},
				body: body === undefined ? undefined : JSON.stringify(body),
			});
		const sessionId = crypto.randomUUID();
		const first = await call("POST", "/lottie-frames", {
			frames: frames(2),
			index: 0,
			meta: meta({ frameCount: 2 }),
			sessionId,
		});
		expect(first.status).toBe(200);
		expect(await first.json()).toEqual({
			frameCount: 2,
			received: 2,
			sessionId,
		});
		const missingMeta = await call("POST", "/lottie-frames", {
			frames: frames(1),
			index: 0,
			sessionId,
		});
		expect(missingMeta.status).toBe(400);
		const finished = await call("POST", "/lottie-frames-finish", { sessionId });
		expect(finished.status).toBe(201);
		const result = lottieFinishResponseSchema.parse(await finished.json());
		expect(result.asset.derivation).toBe("lottie");
		expect(result.preview?.derivedFromAssetId).toBe(result.asset.id);
		expect(
			(await call("POST", "/lottie-frames-finish", { sessionId })).status
		).toBe(409);

		const aborted = crypto.randomUUID();
		await call("POST", "/lottie-frames", {
			frames: frames(1),
			index: 0,
			meta: meta({ frameCount: 2 }),
			sessionId: aborted,
		});
		const reordered = await call("POST", "/lottie-frames", {
			frames: frames(1),
			index: 2,
			sessionId: aborted,
		});
		expect(reordered.status).toBe(409);
		const removed = await call("DELETE", `/lottie-frames?sessionId=${aborted}`);
		expect(await removed.json()).toEqual({ aborted: true });
		expect((await call("DELETE", "/lottie-frames?sessionId=nope")).status).toBe(
			400
		);
		expect(await workDirectories(store)).toEqual([]);
	}, 60_000);
});
