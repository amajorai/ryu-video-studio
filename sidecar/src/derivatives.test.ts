import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import {
	type Asset,
	assetSchema,
	newSegment,
	projectSchema,
} from "../../shared/project.ts";
import {
	derivativeVideoArgs,
	grayFramesArgs,
	parseVideoStreamGeometry,
	probeDerivativeFilterSupport,
} from "./derivative-encode.ts";
import { interpolateAsset } from "./interpolate.ts";
import { probe, runMedia } from "./media.ts";
import { routes } from "./routes/derivatives.ts";
import { routes as upscaleRoutes } from "./routes/upscale.ts";
import { createStudioServer } from "./server.ts";
import { stabilizeAsset } from "./stabilize.ts";
import { StudioStore } from "./store.ts";
import { upscaleAsset, upscaleReservationBytes } from "./upscale.ts";

const resultSchema = z.object({
	asset: assetSchema,
	created: z.boolean(),
	method: z.string(),
	mode: z.string().optional(),
});

let directory = "";
let store: StudioStore;
let app: ReturnType<typeof createStudioServer>;
let video: Asset;
let rotated: Asset;
const token = crypto.randomUUID();

const trackerOnly = {
	cas: false,
	minterpolate: true,
	nlmeans: false,
	vidstab: false,
};

const quiet = ["-hide_banner", "-loglevel", "error", "-y"];

async function addAsset(path: string, name: string): Promise<Asset> {
	const asset = assetSchema.parse({
		...(await probe(path)),
		createdAt: new Date().toISOString(),
		id: crypto.randomUUID(),
		name,
	});
	await Bun.write(store.mediaPath(asset.id), Bun.file(path));
	store.putAsset(asset);
	return asset;
}

async function videoStream(path: string) {
	const output = await runMedia(
		[
			"-v",
			"error",
			"-count_frames",
			"-select_streams",
			"v:0",
			"-show_entries",
			"stream=width,height,duration,nb_read_frames",
			"-of",
			"json",
			path,
		],
		{ probe: true }
	);
	const stream = z
		.object({
			streams: z.array(
				z.object({
					duration: z.string(),
					height: z.number(),
					nb_read_frames: z.string(),
					width: z.number(),
				})
			),
		})
		.parse(JSON.parse(output)).streams[0];
	if (!stream) {
		throw new Error("No video stream.");
	}
	return {
		duration: Number(stream.duration),
		frames: Number(stream.nb_read_frames),
		height: stream.height,
		width: stream.width,
	};
}

async function post(path: string, body: unknown) {
	return await fetch(
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
}

beforeAll(async () => {
	directory = await mkdtemp(join(tmpdir(), "ryu-video-derivatives-test-"));
	store = new StudioStore(directory);
	const source = join(directory, "source.mp4");
	await runMedia([
		"-hide_banner",
		"-loglevel",
		"error",
		"-y",
		"-f",
		"lavfi",
		"-i",
		"testsrc2=s=96x64:r=10:d=1",
		"-f",
		"lavfi",
		"-i",
		"sine=frequency=440:duration=1",
		"-c:v",
		"libx264",
		"-pix_fmt",
		"yuv420p",
		"-c:a",
		"aac",
		"-shortest",
		source,
	]);
	video = assetSchema.parse({
		...(await probe(source)),
		createdAt: new Date().toISOString(),
		id: crypto.randomUUID(),
		name: "Tiny video",
	});
	await Bun.write(store.mediaPath(video.id), Bun.file(source));
	store.putAsset(video);
	const landscape = join(directory, "landscape.mp4");
	const portrait = join(directory, "portrait.mp4");
	await runMedia([
		...quiet,
		"-f",
		"lavfi",
		"-i",
		"testsrc2=s=96x64:r=10:d=1",
		"-c:v",
		"libx264",
		"-pix_fmt",
		"yuv420p",
		landscape,
	]);
	await runMedia([
		...quiet,
		"-display_rotation",
		"90",
		"-i",
		landscape,
		"-c",
		"copy",
		portrait,
	]);
	rotated = await addAsset(portrait, "Phone clip");
	app = createStudioServer({
		port: 0,
		routes: [...routes, ...upscaleRoutes],
		store,
		token,
	});
});

afterAll(async () => {
	app.stop();
	store.close();
	await rm(directory, { force: true, recursive: true });
});

describe("derivative encode helpers", () => {
	test("probe combines tracked capabilities with the filter list", async () => {
		const support = await probeDerivativeFilterSupport(
			async () =>
				" TSC cas               V->V       Contrast Adaptive Sharpen.\n",
			async () => ({
				filters: {
					minterpolate: true,
					vidstabdetect: true,
					vidstabtransform: false,
				},
			})
		);
		expect(support).toEqual({
			cas: true,
			minterpolate: true,
			nlmeans: false,
			vidstab: false,
		});
	});
	test("a failing filter list counts as missing filters", async () => {
		const support = await probeDerivativeFilterSupport(
			() => Promise.reject(new Error("no ffmpeg")),
			async () => ({
				filters: {
					minterpolate: false,
					vidstabdetect: false,
					vidstabtransform: false,
				},
			})
		);
		expect(support).toEqual({
			cas: false,
			minterpolate: false,
			nlmeans: false,
			vidstab: false,
		});
	});
	test("geometry swaps rotated streams and prefers the video duration", () => {
		const fallback = { duration: 2.02, height: 180, width: 320 };
		expect(
			parseVideoStreamGeometry(
				JSON.stringify({
					streams: [
						{
							duration: "1.900000",
							height: 180,
							side_data_list: [{ rotation: -90 }],
							width: 320,
						},
					],
				}),
				fallback
			)
		).toEqual({ duration: 1.9, height: 320, width: 180 });
		expect(
			parseVideoStreamGeometry(
				JSON.stringify({
					streams: [{ height: 180, tags: { rotate: "270" }, width: 320 }],
				}),
				fallback
			)
		).toEqual({ duration: 2.02, height: 320, width: 180 });
		expect(parseVideoStreamGeometry("{}", fallback)).toEqual(fallback);
	});
	test("upscale admission grows with the pixel factor and is capped", () => {
		const headroom = 64 * 1024 * 1024;
		expect(upscaleReservationBytes(1000, 2, "video")).toBe(8000 + headroom);
		expect(upscaleReservationBytes(1000, 4, "image")).toBe(128_000 + headroom);
		expect(upscaleReservationBytes(1e12, 4, "video")).toBe(
			10 * 1024 * 1024 * 1024
		);
	});
	test("encode arguments keep audio only when present", () => {
		const withAudio = derivativeVideoArgs("in.mp4", "out.mp4", "null", true);
		expect(withAudio).toContain("aac");
		expect(withAudio.at(-1)).toBe("out.mp4");
		expect(derivativeVideoArgs("in.mp4", "out.mp4", "null", false)).toContain(
			"-an"
		);
		expect(grayFramesArgs("in.mp4", "format=gray", "f.gray")).toEqual(
			expect.arrayContaining(["rawvideo", "gray", "f.gray"])
		);
	});
});

describe("derivative routes", () => {
	test("stabilize creates, then reuses, a linked derivative", async () => {
		const first = await post(`/assets/${video.id}/stabilize`, {
			level: "low",
		});
		expect(first.status).toBe(201);
		const created = resultSchema.parse(await first.json());
		expect(created.asset).toMatchObject({
			derivation: "stabilize",
			derivedFromAssetId: video.id,
			hasAudio: true,
			height: 64,
			kind: "video",
			name: "Tiny video · stabilized (low)",
			width: 96,
		});
		expect(["vidstab", "translate"]).toContain(created.method);
		const second = await post(`/assets/${video.id}/stabilize`, {
			level: "low",
		});
		expect(second.status).toBe(200);
		expect(resultSchema.parse(await second.json()).asset.id).toBe(
			created.asset.id
		);
		expect(await Bun.file(store.mediaPath(created.asset.id)).exists()).toBe(
			true
		);
	});

	test("stabilize refuses unknown fields and audio", async () => {
		expect(
			(await post(`/assets/${video.id}/stabilize`, { zoom: 3 })).status
		).toBe(400);
	});

	test("interpolate blends to the target rate and keeps duration", async () => {
		const response = await post(`/assets/${video.id}/interpolate`, {
			fps: 20,
			mode: "blend",
		});
		expect(response.status).toBe(201);
		const result = resultSchema.parse(await response.json());
		expect(result).toMatchObject({ method: "framerate", mode: "blend" });
		expect(result.asset).toMatchObject({
			derivation: "interpolate",
			derivedFromAssetId: video.id,
			frameRate: 20,
			name: "Tiny video · 20 fps blend",
		});
		expect(Math.abs(result.asset.duration - video.duration)).toBeLessThan(0.15);
	});

	test("smooth slow motion swaps a slow clip onto an interpolated derivative", async () => {
		const segment = {
			...newSegment(video, 0),
			frameInterpolation: "blend" as const,
			sourceIn: 0.2,
			sourceOut: 0.8,
			speed: 0.5,
		};
		const created = store.create("Smooth");
		const project = store.save({ ...created, segments: [segment] });
		const stale = await post(`/projects/${project.id}/smooth-slow-motion`, {
			clipId: segment.id,
			revision: project.revision + 1,
		});
		expect(stale.status).toBe(409);
		const response = await post(`/projects/${project.id}/smooth-slow-motion`, {
			clipId: segment.id,
			revision: project.revision,
		});
		expect(response.status).toBe(200);
		const saved = projectSchema.parse(await response.json());
		const clip = saved.segments[0];
		const derivative = store
			.assets()
			.find((asset) => asset.id === clip?.assetId);
		expect(derivative).toMatchObject({
			derivation: "interpolate",
			derivedFromAssetId: video.id,
			frameRate: 60,
		});
		expect(clip).toMatchObject({
			frameInterpolation: "blend",
			sourceIn: 0.2,
			sourceOut: 0.8,
			speed: 0.5,
		});
	});

	test("smooth slow motion refuses clips at normal speed", async () => {
		const segment = {
			...newSegment(video, 0),
			frameInterpolation: "blend" as const,
		};
		const created = store.create("Normal speed");
		const project = store.save({ ...created, segments: [segment] });
		const response = await post(`/projects/${project.id}/smooth-slow-motion`, {
			clipId: segment.id,
			revision: project.revision,
		});
		expect(response.status).toBe(400);
	});

	test("enhanced upscale links and tags its derivative", async () => {
		const response = await post(`/assets/${video.id}/upscale`, {
			enhance: true,
			factor: 2,
		});
		expect(response.status).toBe(201);
		expect(assetSchema.parse(await response.json())).toMatchObject({
			derivation: "enhance",
			derivedFromAssetId: video.id,
			hasAudio: true,
			height: 128,
			name: "Tiny video · 2× enhanced upscale",
			width: 192,
		});
	});

	test("a custom name renders a new derivative instead of reusing one", async () => {
		const first = await stabilizeAsset(
			store,
			video,
			{ level: "high" },
			{ support: trackerOnly }
		);
		expect(first.created).toBe(true);
		const named = await stabilizeAsset(
			store,
			video,
			{ level: "high", name: "My take" },
			{ support: trackerOnly }
		);
		expect(named.created).toBe(true);
		expect(named.asset.id).not.toBe(first.asset.id);
		expect(named.asset.name).toBe("My take");
		const again = await stabilizeAsset(
			store,
			video,
			{ level: "high" },
			{ support: trackerOnly }
		);
		expect(again).toMatchObject({
			asset: { id: first.asset.id },
			created: false,
		});
	});
});

describe("rotated and bounded derivatives", () => {
	test("the built-in tracker stabilizes rotated phone footage", async () => {
		expect(rotated).toMatchObject({ height: 64, width: 96 });
		const result = await stabilizeAsset(
			store,
			rotated,
			{ level: "medium" },
			{ support: trackerOnly }
		);
		expect(result).toMatchObject({ created: true, method: "translate" });
		const stream = await videoStream(store.mediaPath(result.asset.id));
		expect(stream).toMatchObject({ height: 96, width: 64 });
		expect(stream.frames).toBe(10);
	});

	test("upscale sizes rotated footage from the displayed frame", async () => {
		const next = await upscaleAsset(
			store,
			rotated,
			{ enhance: true, factor: 2 },
			{ support: trackerOnly }
		);
		const stream = await videoStream(store.mediaPath(next.id));
		expect(stream).toMatchObject({ height: 192, width: 128 });
	});

	test("optical flow keeps the source video duration", async () => {
		const result = await interpolateAsset(
			store,
			video,
			{ fps: 30, mode: "optical-flow" },
			{ support: trackerOnly }
		);
		expect(result).toMatchObject({
			method: "minterpolate",
			mode: "optical-flow",
		});
		const source = await videoStream(store.mediaPath(video.id));
		const stream = await videoStream(store.mediaPath(result.asset.id));
		expect(stream.frames).toBe(30);
		expect(Math.abs(stream.duration - source.duration)).toBeLessThanOrEqual(
			1 / 30 + 1e-6
		);
	});

	test("enhanced upscale is admitted against the media quota", async () => {
		const reserve = store.reserveMediaStorage.bind(store);
		const before = store.assets().length;
		store.reserveMediaStorage = () => {
			throw new Error("Media storage quota reached.");
		};
		try {
			await expect(
				upscaleAsset(
					store,
					video,
					{ enhance: true, factor: 2 },
					{ support: trackerOnly }
				)
			).rejects.toThrow("Media storage quota reached.");
		} finally {
			store.reserveMediaStorage = reserve;
		}
		expect(store.assets()).toHaveLength(before);
	});

	test("enhanced upscale refuses video longer than ten minutes", async () => {
		const long = assetSchema.parse({
			...video,
			duration: 601,
			id: crypto.randomUUID(),
		});
		await expect(
			upscaleAsset(
				store,
				long,
				{ enhance: true, factor: 2 },
				{ support: trackerOnly }
			)
		).rejects.toThrow("10 minutes");
	});
});
