import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	CUTOUT_PEAK_BYTES,
	cutoutMaxSeconds,
	cutoutOutputBytes,
	cutoutRequestSchema,
} from "../../shared/keying.ts";
import type { Asset } from "../../shared/project.ts";
import {
	assertCutoutSource,
	CUTOUT_CHUNK_SECONDS,
	cutoutAsset,
	cutoutChunkArgs,
	cutoutChunks,
	cutoutConcatArgs,
	cutoutFilterGraph,
	cutoutReservationBytes,
} from "./cutout.ts";
import { routes } from "./routes/cutout.ts";
import { createStudioServer } from "./server.ts";
import { StudioStore } from "./store.ts";

const video: Asset = {
	createdAt: "2026-01-01T00:00:00.000Z",
	duration: 24,
	hasAudio: true,
	height: 720,
	id: "00000000-0000-4000-8000-0000000000c1",
	kind: "video",
	name: "Locked-off shot",
	width: 1280,
};

const request = cutoutRequestSchema.parse({ cleanPlateTime: 1.5 });

describe("cutoutChunks", () => {
	test("covers the duration in bounded chunks", () => {
		expect(cutoutChunks(24)).toEqual([
			{ length: 10, start: 0 },
			{ length: 10, start: 10 },
			{ length: 4, start: 20 },
		]);
		expect(cutoutChunks(10)).toEqual([{ length: 10, start: 0 }]);
		expect(cutoutChunks(0.4)).toEqual([{ length: 0.4, start: 0 }]);
		for (const chunk of cutoutChunks(600)) {
			expect(chunk.length).toBeLessThanOrEqual(CUTOUT_CHUNK_SECONDS);
		}
	});
});

describe("cutout FFmpeg arguments", () => {
	test("keys each chunk against one clean-plate frame and trims it off", () => {
		expect(cutoutFilterGraph(request)).toBe(
			"[0:v]trim=end_frame=1,setpts=PTS-STARTPTS,setsar=1,format=yuva444p[plate];" +
				"[1:v]setpts=PTS-STARTPTS,setsar=1,format=yuva444p[clip];" +
				"[plate][clip]concat=n=2:v=1:a=0,backgroundkey=threshold=0.5:similarity=0.1:blend=0.05,trim=start_frame=1,setpts=PTS-STARTPTS[cutout]"
		);
	});

	test("seeks the plate and the chunk separately and writes alpha", () => {
		const args = cutoutChunkArgs("/media/shot.mov", request, {
			length: 10,
			start: 10,
		});
		expect(args.slice(args.indexOf("-ss"), args.indexOf("-ss") + 4)).toEqual([
			"-ss",
			"1.500000",
			"-i",
			"/media/shot.mov",
		]);
		expect(args).toContain("10.000000");
		expect(args).toContain("yuva444p10le");
		expect(args).toContain("-an");
		expect(args).toContain("prores_ks");
		expect(args).not.toContain("libvpx-vp9");
	});

	test("concatenates without re-encoding and carries audio", () => {
		const prores = cutoutConcatArgs("/media/shot.mov", video);
		expect(prores).toContain("copy");
		expect(prores).toContain("aac");
		expect(prores).toContain("1:a:0");
		expect(prores.slice(-2)).toEqual(["-f", "mov"]);
		const silent = cutoutConcatArgs("/media/shot.mov", {
			...video,
			hasAudio: false,
		});
		expect(silent).not.toContain("1:a:0");
		expect(silent).not.toContain("/media/shot.mov");
	});

	test("reserves every chunk plus the joined file, unclamped", () => {
		const output = cutoutOutputBytes(video);
		expect(output).toBe(Math.ceil(1280 * 720 * 30 * 0.75 * 24));
		const bytes = cutoutReservationBytes(video);
		expect(bytes).toBeGreaterThan(2 * output);
		// The longest accepted 1080p30 source reserves close to the whole
		// peak budget instead of a single-file cap.
		const hd = { ...video, frameRate: 30, height: 1080, width: 1920 };
		const longest = { ...hd, duration: cutoutMaxSeconds(hd) };
		expect(cutoutReservationBytes(longest)).toBeGreaterThan(
			0.9 * CUTOUT_PEAK_BYTES
		);
		// A 4K ten-minute source would need far more than one file's cap.
		const uhd = { ...video, duration: 600, height: 2160, width: 3840 };
		expect(cutoutReservationBytes(uhd)).toBeGreaterThan(10 * CUTOUT_PEAK_BYTES);
	});
});

describe("assertCutoutSource", () => {
	test("refuses media that cannot be cut out", () => {
		expect(() =>
			assertCutoutSource({ ...video, kind: "image" }, request)
		).toThrow("needs a video clip");
		expect(() =>
			assertCutoutSource({ ...video, derivation: "cutout" }, request)
		).toThrow("already a cutout");
		expect(() =>
			assertCutoutSource({ ...video, duration: 601 }, request)
		).toThrow("1280×720 media up to 4 min 18 s long");
		// The limit shrinks with resolution and frame rate, up front.
		expect(() =>
			assertCutoutSource(
				{ ...video, duration: 120, frameRate: 30, height: 1080, width: 1920 },
				request
			)
		).toThrow("1920×1080 media up to 1 min 55 s long");
		expect(() =>
			assertCutoutSource(
				{ ...video, duration: 30, height: 2160, width: 3840 },
				request
			)
		).toThrow("up to 28 seconds long");
		expect(() =>
			assertCutoutSource(
				{ ...video, duration: 600, height: 360, width: 640 },
				request
			)
		).not.toThrow();
		expect(() =>
			assertCutoutSource(video, { ...request, cleanPlateTime: 24 })
		).toThrow("inside the media");
		expect(() => assertCutoutSource(video, request)).not.toThrow();
	});

	test("refuses a build without ProRes 4444, even with VP9", async () => {
		await expect(
			cutoutAsset({} as StudioStore, video, request, {
				encoders: { "libvpx-vp9": true },
			})
		).rejects.toThrow("no prores_ks encoder");
	});
});

describe("POST /assets/:id/cutout", () => {
	const cleanup: (() => Promise<void>)[] = [];
	afterEach(async () => {
		for (const clean of cleanup.splice(0)) {
			await clean();
		}
	});

	async function serve() {
		const directory = await mkdtemp(join(tmpdir(), "ryu-video-studio-cutout-"));
		const store = new StudioStore(directory);
		const token = crypto.randomUUID();
		const app = createStudioServer({ port: 0, routes, store, token });
		cleanup.push(async () => {
			app.stop();
			store.close();
			await rm(directory, {
				force: true,
				recursive: true,
				maxRetries: 10,
				retryDelay: 100,
			});
		});
		const post = (assetId: string, body: unknown) =>
			fetch(
				`http://127.0.0.1:${app.server.port}/api/video-studio/assets/${assetId}/cutout`,
				{
					body: JSON.stringify(body),
					headers: {
						authorization: `Bearer ${token}`,
						"content-type": "application/json",
					},
					method: "POST",
				}
			);
		return { post, store };
	}

	test("validates the body strictly", async () => {
		const { post, store } = await serve();
		store.putAsset(video);
		expect((await post(video.id, {})).status).toBe(400);
		expect(
			(await post(video.id, { cleanPlateTime: 1, extra: true })).status
		).toBe(400);
		expect(
			(await post(video.id, { cleanPlateTime: 1, threshold: 2 })).status
		).toBe(400);
		// VP9 is not offered: exports would decode it without alpha.
		expect(
			(await post(video.id, { cleanPlateTime: 1, codec: "vp9" })).status
		).toBe(400);
	});

	test("refuses non-video media with a reason", async () => {
		const { post, store } = await serve();
		const image: Asset = {
			...video,
			id: "00000000-0000-4000-8000-0000000000c2",
			kind: "image",
		};
		store.putAsset(image);
		const response = await post(image.id, { cleanPlateTime: 0 });
		expect(response.status).toBe(400);
		expect(((await response.json()) as { message: string }).message).toContain(
			"needs a video clip"
		);
	});
});
