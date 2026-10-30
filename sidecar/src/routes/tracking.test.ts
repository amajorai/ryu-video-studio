import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type Asset,
	newSegment,
	type Project,
	titleSchema,
} from "../../../shared/project.ts";
import { probe, runMedia } from "../media.ts";
import { createStudioServer, openapi } from "../server.ts";
import { StudioStore } from "../store.ts";
import { routes } from "./tracking.ts";

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
	for (const task of cleanup.splice(0).reverse()) {
		await task();
	}
});

const WIDTH = 320;
const HEIGHT = 180;
const PATCH = 48;
/** Patch top-left at time `t`: 60 px/s right, 15 px/s down (whole pixels). */
const patchX = (t: number) => Math.floor(40 + 60 * t);
const patchY = (t: number) => Math.floor(60 + 15 * t);

/** A blocky 8x8 noise patch scaled to 48 px, moving over a flat card. */
async function fixture(directory: string, rate: number): Promise<string> {
	let state = 12_345;
	const noise = new Uint8Array(64).map(() => {
		state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
		return 30 + (state % 196);
	});
	const raw = join(directory, "patch.gray");
	const png = join(directory, "patch.png");
	const output = join(directory, "moving.mp4");
	await Bun.write(raw, noise);
	await runMedia([
		"-y",
		"-f",
		"rawvideo",
		"-pix_fmt",
		"gray",
		"-s",
		"8x8",
		"-i",
		raw,
		"-vf",
		`scale=${PATCH}:${PATCH}:flags=neighbor`,
		png,
	]);
	await runMedia([
		"-y",
		"-f",
		"lavfi",
		"-i",
		`color=c=0x506070:s=${WIDTH}x${HEIGHT}:r=${rate}:d=2.5`,
		"-loop",
		"1",
		"-i",
		png,
		"-filter_complex",
		"[0][1]overlay=x='40+60*t':y='60+15*t':format=rgb:shortest=1,format=yuv420p",
		"-c:v",
		"libx264",
		"-crf",
		"12",
		"-t",
		"2.5",
		output,
	]);
	return output;
}

/** `rate` is the source frame rate; the project stays at its default. */
async function harness(rate = 30) {
	const directory = await mkdtemp(join(tmpdir(), "ryu-video-studio-tracking-"));
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
	const file = await fixture(directory, rate);
	const asset: Asset = {
		...(await probe(file)),
		createdAt: new Date().toISOString(),
		id: crypto.randomUUID(),
		name: "moving.mp4",
	};
	await Bun.write(store.mediaPath(asset.id), Bun.file(file));
	store.putAsset(asset);
	const image: Asset = {
		...asset,
		duration: 5,
		hasAudio: false,
		id: crypto.randomUUID(),
		kind: "image",
		name: "still.png",
	};
	store.putAsset(image);
	const created = store.create("Tracking API");
	const clip = { ...newSegment(asset, 0), sourceOut: 2.4 };
	const still = { ...newSegment(image, 0, 1), sourceOut: 2 };
	const label = titleSchema.parse({
		color: "#ffffff",
		end: 2.4,
		fadeIn: 0,
		fadeOut: 0,
		fontSize: 0.05,
		id: crypto.randomUUID(),
		start: 0,
		text: "Tag",
		x: 0.2,
		y: 0.3,
	});
	const project = store.save({
		...created,
		segments: [clip, still],
		titles: [label],
	});
	const call = async (body: unknown) => {
		const response = await fetch(
			`http://127.0.0.1:${app.server.port}/api/video-studio/projects/${project.id}/track`,
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
	return { call, clip, label, project, still, store };
}

const roi = {
	height: PATCH / HEIGHT,
	width: PATCH / WIDTH,
	x: patchX(0) / WIDTH,
	y: patchY(0) / HEIGHT,
};

test("a title follows a moving patch tracked from real frames", async () => {
	const { call, clip, label, project } = await harness();
	const response = await call({
		clipId: clip.id,
		revision: project.revision,
		roi,
		target: { id: label.id, kind: "title" },
		time: 0,
	});
	expect(response.status).toBe(200);
	expect(response.body.target).toEqual({ id: label.id, kind: "title" });
	expect(response.body.lostFrames).toBe(0);
	expect(response.body.confidence).toBeGreaterThan(0.9);
	expect(response.body.samples).toBeGreaterThan(60);
	const saved: Project = response.body.project;
	expect(saved.revision).toBe(project.revision + 1);
	const frames = saved.titles[0]?.keyframes ?? [];
	const xs = frames
		.filter((frame) => frame.property === "x")
		.sort((a, b) => a.time - b.time);
	const last = xs.at(-1);
	if (!last) {
		throw new Error("no x keyframes");
	}
	// The last 30 fps sample before the clip end; the path holds it from
	// there to the end of the tracked window.
	const lastSample = (Math.ceil(last.time * 30 - 1e-6) - 1) / 30;
	const expected = 0.2 + (patchX(lastSample) - patchX(0)) / WIDTH;
	expect(Math.abs(last.value - expected) * WIDTH).toBeLessThan(2);
	const scales = frames.filter((frame) => frame.property === "scale");
	for (const frame of scales) {
		expect(Math.abs(frame.value - 1)).toBeLessThan(0.06);
	}
});

test("a mosaic region adds a tracked adjustment layer", async () => {
	const { call, clip, project } = await harness();
	const response = await call({
		clipId: clip.id,
		duration: 1,
		revision: project.revision,
		roi,
		target: { createRegion: "mosaic" },
		time: 0.5,
	});
	expect(response.status).toBe(200);
	const layer = response.body.project.adjustmentLayers?.[0];
	expect(layer?.effects?.[0]?.type).toBe("mosaic");
	expect(layer?.start).toBeCloseTo(0.5, 5);
	expect(layer?.end).toBeLessThanOrEqual(1.5 + 1e-6);
	expect(response.body.range.start).toBeCloseTo(0.5, 5);
});

test("a region from a 24 fps source covers the clip to its last project frame", async () => {
	const { call, clip, project } = await harness(24);
	const clipEnd = clip.start + (clip.sourceOut - clip.sourceIn) / clip.speed;
	const response = await call({
		clipId: clip.id,
		revision: project.revision,
		roi,
		target: { createRegion: "blur" },
		time: 0,
	});
	expect(response.status).toBe(200);
	const layer = response.body.project.adjustmentLayers?.[0];
	expect(layer?.end).toBe(clipEnd);
	expect(response.body.range.end).toBe(clipEnd);
	const lastFrame = clipEnd - 1 / project.fps / 2;
	expect(layer?.end).toBeGreaterThan(lastFrame);
});

test("a follower clip on a locked track is refused", async () => {
	const { call, clip, project, still, store } = await harness();
	const locked = store.save({
		...project,
		trackSettings: [
			{
				locked: true,
				muted: false,
				name: "V2",
				solo: false,
				track: still.track,
			},
		],
	});
	const response = await call({
		clipId: clip.id,
		revision: locked.revision,
		roi,
		target: { id: still.id, kind: "clip" },
		time: 0,
	});
	expect(response.status).toBe(400);
	expect(response.body.message).toContain("Unlock the clip track");
	expect(store.project(project.id).revision).toBe(locked.revision);
});

test("stale revisions, still images and missing clips are refused", async () => {
	const { call, clip, project, still } = await harness();
	const base = {
		clipId: clip.id,
		revision: project.revision,
		roi,
		target: { createRegion: "blur" },
		time: 0,
	};
	expect((await call({ ...base, revision: project.revision + 5 })).status).toBe(
		409
	);
	const image = await call({ ...base, clipId: still.id });
	expect(image.status).toBe(400);
	expect(image.body.message).toContain("video clips only");
	const missing = await call({ ...base, clipId: crypto.randomUUID() });
	expect(missing.status).toBe(400);
	const outside = await call({ ...base, time: 3 });
	expect(outside.status).toBe(400);
	expect((await call({ ...base, roi: { ...roi, x: 0.95 } })).status).toBe(400);
});

test("the operation is documented in OpenAPI", () => {
	const document = openapi(routes) as {
		paths: Record<string, Record<string, { operationId?: string }>>;
	};
	expect(
		document.paths["/api/video-studio/projects/{id}/track"]?.post?.operationId
	).toBe("video_studio_track_motion");
});
