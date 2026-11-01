import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { animatedValue } from "../../../shared/animation.ts";
import {
	type Asset,
	newSegment,
	projectSchema,
} from "../../../shared/project.ts";
import { reframedWindowCenter } from "../../../shared/reframe.ts";
import { probe, runMedia } from "../media.ts";
import {
	clipShotCuts,
	splitLumaFrames,
	trackingFrameSize,
	trackingSampleRate,
} from "../saliency.ts";
import { createStudioServer } from "../server.ts";
import { StudioStore } from "../store.ts";
import { routes } from "./reframe.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const clean of cleanup.splice(0)) {
		await clean();
	}
});

async function setup() {
	const directory = await mkdtemp(join(tmpdir(), "ryu-video-studio-reframe-"));
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
	const call = async (path: string, body: unknown) => {
		const response = await fetch(
			`http://127.0.0.1:${app.server.port}/api/video-studio${path}`,
			{
				body: JSON.stringify(body),
				headers: {
					authorization: `Bearer ${token}`,
					"content-type": "application/json",
				},
				method: "POST",
			}
		);
		return { body: await response.json(), status: response.status };
	};
	return { call, store };
}

/** 3 s, 320x180: a white square crossing a dark frame, centre x = 80 + 40t px. */
async function movingSquare(store: StudioStore): Promise<Asset> {
	const file = join(store.directory, "square.mp4");
	await runMedia([
		"-hide_banner",
		"-loglevel",
		"error",
		"-nostdin",
		"-y",
		"-f",
		"lavfi",
		"-i",
		"color=c=0x202020:s=320x180:d=3:r=25",
		"-f",
		"lavfi",
		"-i",
		"color=c=white:s=30x30:d=3:r=25",
		"-filter_complex",
		"[0][1]overlay=x='65+40*t':y=75:shortest=1",
		"-c:v",
		"libx264",
		"-pix_fmt",
		"yuv420p",
		file,
	]);
	const asset: Asset = {
		...(await probe(file)),
		createdAt: new Date().toISOString(),
		id: crypto.randomUUID(),
		name: "Square",
	};
	await Bun.write(store.mediaPath(asset.id), Bun.file(file));
	store.putAsset(asset);
	return asset;
}

test("tracks a moving subject from real frames and saves pan keyframes", async () => {
	const { call, store } = await setup();
	const asset = await movingSquare(store);
	const created = store.create("Reframe");
	const segment = newSegment(asset);
	const project = store.save({
		...created,
		height: 180,
		segments: [segment],
		width: 320,
	});
	const response = await call(`/projects/${project.id}/reframe`, {
		aspect: "9:16",
		mode: "track",
		revision: project.revision,
		smoothing: 0.2,
	});
	expect(response.status).toBe(200);
	expect(response.body).toMatchObject({ height: 320, width: 180 });
	expect(response.body.clips).toEqual([
		expect.objectContaining({ axis: "x", clipId: segment.id, mode: "track" }),
	]);
	expect(response.body.clips[0].keyframes).toBeGreaterThan(1);
	const saved = projectSchema.parse(response.body.project);
	const clip = saved.segments[0];
	if (!clip) {
		throw new Error("missing clip");
	}
	expect(clip.fit).toBe("fill");
	for (const time of [0.5, 1.5, 2.5]) {
		const shown = reframedWindowCenter(
			clip,
			"x",
			animatedValue(clip, "x", time)
		);
		const subject = (80 + 40 * time) / 320;
		expect(Math.abs(shown - subject)).toBeLessThan(0.05);
	}
	expect(store.project(project.id).revision).toBe(saved.revision);
});

test("stabilize swaps each target video onto its stabilized media before tracking", async () => {
	const { call, store } = await setup();
	const asset = await movingSquare(store);
	const video = newSegment(asset);
	const created = store.create("Stabilized reframe");
	const project = store.save({
		...created,
		height: 180,
		segments: [video],
		width: 320,
	});
	const response = await call(`/projects/${project.id}/reframe`, {
		aspect: "9:16",
		mode: "track",
		revision: project.revision,
		stabilize: "low",
	});
	expect(response.status).toBe(200);
	const stabilized = store
		.assets()
		.find((item) => item.derivedFromAssetId === asset.id);
	expect(stabilized?.derivation).toBe("stabilize");
	expect(response.body.stabilized).toEqual([
		{ assetId: stabilized?.id, clipId: video.id },
	]);
	const saved = projectSchema.parse(response.body.project);
	expect(saved.segments.find((item) => item.id === video.id)?.assetId).toBe(
		stabilized?.id
	);
	expect(response.body.clips[0]).toMatchObject({
		clipId: video.id,
		mode: "track",
	});
	expect(response.body.clips[0].keyframes).toBeGreaterThan(1);
	// A second reframe reuses the derivative and skips the stabilized clip.
	const again = await call(`/projects/${project.id}/reframe`, {
		aspect: "1:1",
		clipIds: [video.id],
		mode: "center",
		revision: saved.revision,
		stabilize: "low",
	});
	expect(again.status).toBe(200);
	expect(again.body.stabilized).toEqual([
		{ clipId: video.id, skipped: "Already stabilized." },
	]);
	expect(
		store.assets().filter((item) => item.derivation === "stabilize")
	).toHaveLength(1);
}, 60_000);

test("rejects a stale revision and non-visual clips", async () => {
	const { call, store } = await setup();
	const project = store.create("Stale");
	const stale = await call(`/projects/${project.id}/reframe`, {
		aspect: "1:1",
		mode: "center",
		revision: project.revision + 5,
	});
	expect(stale.status).toBe(409);
	const missing = await call(`/projects/${project.id}/reframe`, {
		aspect: "1:1",
		clipIds: [crypto.randomUUID()],
		mode: "center",
		revision: project.revision,
	});
	expect(missing.status).toBe(400);
});

test("center mode needs no media decode", async () => {
	const { call, store } = await setup();
	const asset: Asset = {
		createdAt: "2026-01-01T00:00:00.000Z",
		duration: 4,
		hasAudio: false,
		height: 1080,
		id: crypto.randomUUID(),
		kind: "video",
		name: "offline.mp4",
		width: 1920,
	};
	store.putAsset(asset);
	const created = store.create("Center");
	const project = store.save({ ...created, segments: [newSegment(asset)] });
	const response = await call(`/projects/${project.id}/reframe`, {
		aspect: "4:5",
		mode: "blur-fill",
		revision: project.revision,
	});
	expect(response.status).toBe(200);
	expect(response.body).toMatchObject({ height: 1350, width: 1080 });
	expect(response.body.project.background.type).toBe("blur");
});

test("clips on locked tracks are refused or left alone", async () => {
	const { call, store } = await setup();
	const asset: Asset = {
		createdAt: "2026-01-01T00:00:00.000Z",
		duration: 4,
		hasAudio: false,
		height: 1080,
		id: crypto.randomUUID(),
		kind: "video",
		name: "locked.mp4",
		width: 1920,
	};
	store.putAsset(asset);
	const clip = newSegment(asset);
	const created = store.create("Locked");
	const project = store.save({
		...created,
		segments: [clip],
		trackSettings: [
			{ locked: true, muted: false, name: "Track 1", solo: false, track: 0 },
		],
	});
	const named = await call(`/projects/${project.id}/reframe`, {
		aspect: "9:16",
		clipIds: [clip.id],
		mode: "center",
		revision: project.revision,
	});
	expect(named.status).toBe(400);
	const all = await call(`/projects/${project.id}/reframe`, {
		aspect: "9:16",
		mode: "center",
		revision: project.revision,
	});
	expect(all.status).toBe(200);
	expect(all.body.clips).toEqual([]);
	expect(all.body.project.segments[0]).toEqual(clip);
});

test("frame sizing, sampling and analysed cuts", () => {
	expect(trackingFrameSize({ height: 1080, width: 1920 })).toEqual({
		height: 90,
		width: 160,
	});
	expect(trackingFrameSize({ height: 1920, width: 1080 })).toEqual({
		height: 284,
		width: 160,
	});
	expect(trackingSampleRate(10)).toBe(4);
	expect(trackingSampleRate(1200)).toBe(2);
	const frames = splitLumaFrames(new Uint8Array(4 * 2 * 5 + 3), {
		height: 2,
		width: 4,
	});
	expect(frames).toHaveLength(5);
	expect(
		clipShotCuts(
			frames,
			{ sourceIn: 10, sourceOut: 11.25 },
			4,
			[9, 10.5, 11, 20]
		)
	).toEqual({ cutTimes: [0.5, 1], cuts: [2, 4] });
});

test("analysed cuts map to the first sample after the cut, with exact times", () => {
	const frames = splitLumaFrames(new Uint8Array(4 * 2 * 20), {
		height: 2,
		width: 4,
	});
	// 1.1 s and 2.37 s at 4 fps fall between samples 4|5 and 9|10; the new
	// shot must start at the later sample so it holds no old-shot frame.
	expect(
		clipShotCuts(frames, { sourceIn: 0, sourceOut: 5 }, 4, [1.1, 2.37])
	).toEqual({ cutTimes: [1.1, 2.37], cuts: [5, 10] });
	// Two cuts between the same samples keep the later time.
	expect(
		clipShotCuts(frames, { sourceIn: 0, sourceOut: 5 }, 4, [1.05, 1.2])
	).toEqual({ cutTimes: [1.2], cuts: [5] });
	// Without scene analysis the cuts come from the frames, with no times.
	expect(
		clipShotCuts(frames, { sourceIn: 0, sourceOut: 5 }, 4, undefined)
	).toEqual({ cuts: [] });
});

test("the reframe route is published in OpenAPI", async () => {
	const { store } = await setup();
	const app = createStudioServer({ port: 0, routes, store, token: "t" });
	try {
		const response = await fetch(
			`http://127.0.0.1:${app.server.port}/openapi.json`,
			{ headers: { authorization: "Bearer t" } }
		);
		const body = await response.json();
		const operation =
			body.paths?.["/api/video-studio/projects/{id}/reframe"]?.post;
		expect(operation?.operationId).toBe("video_studio_reframe");
		expect(
			operation?.requestBody?.content?.["application/json"]?.schema?.required
		).toEqual(["aspect", "mode", "revision"]);
	} finally {
		app.stop();
	}
});
