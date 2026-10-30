import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Asset } from "../../../shared/project.ts";
import {
	assetFilmstrip,
	filmstripArgs,
	filmstripCacheKey,
	filmstripRequestSchema,
	filmstripSampleTimes,
	parseFilmstripQuery,
	pngDimensions,
	resolveFilmstripRange,
} from "../filmstrip.ts";
import { probe, runMedia } from "../media.ts";
import { createStudioServer, openapi } from "../server.ts";
import { StudioStore } from "../store.ts";
import { routes } from "./filmstrip.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const clean of cleanup.splice(0)) {
		await clean();
	}
});

const request = { count: 8, end: 4, height: 48, start: 0 };

describe("filmstrip planning", () => {
	test("cache keys change with every input that changes the sprite", () => {
		const media = { mtimeMs: 1000, size: 2048 };
		const id = crypto.randomUUID();
		const key = filmstripCacheKey(id, media, request);
		expect(key).toMatch(/^[0-9a-f]{40}$/);
		expect(filmstripCacheKey(id, media, { ...request })).toBe(key);
		// Sub-millisecond noise in the range keeps the same key.
		expect(filmstripCacheKey(id, media, { ...request, end: 4.000_01 })).toBe(
			key
		);
		const variants = [
			filmstripCacheKey(crypto.randomUUID(), media, request),
			filmstripCacheKey(id, { ...media, size: 2049 }, request),
			filmstripCacheKey(id, { ...media, mtimeMs: 2000 }, request),
			filmstripCacheKey(id, media, { ...request, start: 0.5 }),
			filmstripCacheKey(id, media, { ...request, end: 3 }),
			filmstripCacheKey(id, media, { ...request, count: 16 }),
			filmstripCacheKey(id, media, { ...request, height: 60 }),
		];
		expect(new Set([key, ...variants]).size).toBe(variants.length + 1);
	});

	test("frames sample the middle of equal slices of the range", () => {
		expect(filmstripSampleTimes({ count: 4, end: 6, start: 2 })).toEqual([
			2.5, 3.5, 4.5, 5.5,
		]);
	});

	test("queries are bounded and strict", () => {
		expect(
			parseFilmstripQuery(new URLSearchParams("start=1&end=3&count=12"))
		).toEqual({ count: 12, end: 3, height: 48, start: 1 });
		for (const query of [
			"end=3&count=61",
			"end=3&count=0",
			"end=3&count=4&height=91",
			"end=3&count=4&height=8",
			"start=3&end=3&count=4",
			"end=3&count=2.5",
			"count=4",
		]) {
			expect(() => parseFilmstripQuery(new URLSearchParams(query))).toThrow();
		}
		expect(
			filmstripRequestSchema.safeParse({ ...request, extra: true }).success
		).toBe(false);
	});

	test("video ranges clamp to the source, audio is refused", () => {
		const video = { duration: 3, kind: "video" } as const;
		expect(resolveFilmstripRange(video, request).end).toBe(3);
		expect(() =>
			resolveFilmstripRange(video, { ...request, start: 3.5, end: 5 })
		).toThrow("starts after");
		expect(() =>
			resolveFilmstripRange({ duration: 3, kind: "audio" }, request)
		).toThrow("video or image");
		const still = { duration: 5, kind: "image" } as const;
		expect(resolveFilmstripRange(still, { ...request, end: 40 }).end).toBe(40);
	});

	test("FFmpeg seeks to the range start and tiles one row", () => {
		const args = filmstripArgs(
			"/media/x",
			{ duration: 10, kind: "video" },
			{ count: 4, end: 6, height: 48, start: 2 },
			"/out.png"
		);
		expect(args[args.indexOf("-ss") + 1]).toBe("2.000000");
		const filter = args[args.indexOf("-vf") + 1] ?? "";
		expect(filter).toContain("fps=fps=4000/4000");
		expect(filter).toContain("scale=w=-1:h=48");
		expect(filter).toContain("tile=4x1");
		expect(
			filmstripArgs(
				"/media/x",
				{ duration: 5, kind: "image" },
				request,
				"/o.png"
			)
		).not.toContain("-ss");
	});

	test("PNG dimensions come from the IHDR chunk", () => {
		const header = new Uint8Array(24);
		header.set([137, 80, 78, 71, 13, 10, 26, 10]);
		const view = new DataView(header.buffer);
		view.setUint32(16, 688);
		view.setUint32(20, 48);
		expect(pngDimensions(header)).toEqual({ height: 48, width: 688 });
		expect(() => pngDimensions(new Uint8Array(24))).toThrow("PNG");
	});
});

async function studio() {
	const directory = await mkdtemp(join(tmpdir(), "ryu-video-studio-strip-"));
	const store = new StudioStore(directory);
	const token = crypto.randomUUID();
	const app = createStudioServer({ port: 0, routes, store, token });
	cleanup.push(async () => {
		app.stop();
		store.close();
		await rm(directory, { force: true, recursive: true });
	});
	const get = (path: string) =>
		fetch(`http://127.0.0.1:${app.server.port}/api/video-studio${path}`, {
			headers: { authorization: `Bearer ${token}` },
		});
	return { directory, get, store };
}

async function importMedia(
	store: StudioStore,
	name: string,
	args: string[]
): Promise<Asset> {
	const file = join(store.directory, `${name}.source`);
	await runMedia(["-hide_banner", "-loglevel", "error", "-y", ...args, file]);
	const asset: Asset = {
		...(await probe(file)),
		createdAt: new Date().toISOString(),
		id: crypto.randomUUID(),
		name,
	};
	await Bun.write(store.mediaPath(asset.id), Bun.file(file));
	await rm(file, { force: true });
	store.putAsset(asset);
	return asset;
}

interface SpriteBody {
	cached: boolean;
	count: number;
	data: string;
	frameHeight: number;
	frameWidth: number;
	times: number[];
	width: number;
}

test("a testsrc clip returns a cached single-row sprite of the requested size", async () => {
	const { directory, get, store } = await studio();
	const video = await importMedia(store, "camera", [
		"-f",
		"lavfi",
		"-i",
		"testsrc2=s=320x180:r=30:d=4",
		"-c:v",
		"libx264",
		"-pix_fmt",
		"yuv420p",
		"-f",
		"mp4",
	]);
	const first = await get(
		`/assets/${video.id}/filmstrip?start=0.5&end=3.5&count=6&height=36`
	);
	expect(first.status).toBe(200);
	const body = (await first.json()) as SpriteBody;
	expect(body.count).toBe(6);
	expect(body.cached).toBe(false);
	expect(body.frameHeight).toBe(36);
	expect(body.frameWidth).toBe(64);
	expect(body.width).toBe(6 * 64);
	expect(body.times).toEqual([0.75, 1.25, 1.75, 2.25, 2.75, 3.25]);
	const bytes = Uint8Array.from(Buffer.from(body.data, "base64"));
	expect(pngDimensions(bytes)).toEqual({ height: 36, width: 384 });
	const probed = await probe(
		join(
			directory,
			"filmstrips",
			(await readdir(join(directory, "filmstrips")))[0] ?? ""
		)
	);
	expect(probed.width).toBe(384);

	const again = (await (
		await get(
			`/assets/${video.id}/filmstrip?start=0.5&end=3.5&count=6&height=36`
		)
	).json()) as SpriteBody;
	expect(again.cached).toBe(true);
	expect(again.data).toBe(body.data);
	expect(await readdir(join(directory, "filmstrips"))).toHaveLength(1);

	// A range past the end of the media clamps and still fills every tile.
	const tail = (await (
		await get(`/assets/${video.id}/filmstrip?start=3&end=9&count=4&height=36`)
	).json()) as SpriteBody;
	expect(tail.width).toBe(4 * 64);
	expect(tail.times).toEqual([3.125, 3.375, 3.625, 3.875]);
});

test("stills repeat, audio is refused, and the route is documented", async () => {
	const { get, store } = await studio();
	const still = await importMedia(store, "still", [
		"-f",
		"lavfi",
		"-i",
		"testsrc2=s=200x100:d=1",
		"-frames:v",
		"1",
		"-f",
		"image2",
		"-c:v",
		"png",
	]);
	const sprite = (await (
		await get(`/assets/${still.id}/filmstrip?end=1&count=3&height=40`)
	).json()) as SpriteBody;
	expect(sprite.frameWidth).toBe(80);
	expect(sprite.width).toBe(240);

	const sound = await importMedia(store, "sound", [
		"-f",
		"lavfi",
		"-i",
		"sine=frequency=440:duration=1",
		"-c:a",
		"pcm_s16le",
		"-f",
		"wav",
	]);
	const refused = await get(`/assets/${sound.id}/filmstrip?end=1&count=3`);
	expect(refused.status).toBe(400);
	const invalid = await get(`/assets/${still.id}/filmstrip?end=1&count=99`);
	expect(invalid.status).toBe(400);

	const operation =
		openapi(routes).paths["/api/video-studio/assets/{id}/filmstrip"]?.get;
	expect(operation?.operationId).toBe("video_studio_media_filmstrip");
	expect(operation?.parameters?.map((parameter) => parameter.name)).toEqual([
		"id",
		"start",
		"end",
		"count",
		"height",
	]);
});

test("a waiter that disconnects does not cancel a shared render", async () => {
	const { directory, store } = await studio();
	const video = await importMedia(store, "long", [
		"-f",
		"lavfi",
		"-i",
		"testsrc2=s=320x180:r=30:d=20",
		"-c:v",
		"libx264",
		"-preset",
		"ultrafast",
		"-pix_fmt",
		"yuv420p",
		"-f",
		"mp4",
	]);
	const range = { count: 40, end: 19.5, height: 48, start: 0.5 };
	const leaving = new AbortController();
	const first = assetFilmstrip(store, video, range, {
		signal: leaving.signal,
	});
	const second = assetFilmstrip(store, video, range, {
		signal: new AbortController().signal,
	});
	setTimeout(() => leaving.abort(), 30);
	await expect(first).rejects.toThrow("Operation canceled.");
	const sprite = await second;
	expect(sprite.cached).toBe(false);
	expect(sprite.width).toBe(40 * 85);
	expect(await readdir(join(directory, "filmstrips"))).toHaveLength(1);

	// When every waiter leaves, the render stops and a later request
	// starts a fresh one instead of joining the canceled run.
	const other = { ...range, count: 32 };
	const one = new AbortController();
	const two = new AbortController();
	const both = [
		assetFilmstrip(store, video, other, { signal: one.signal }),
		assetFilmstrip(store, video, other, { signal: two.signal }),
	];
	setTimeout(() => {
		one.abort();
		two.abort();
	}, 30);
	const settled = await Promise.allSettled(both);
	expect(
		settled.map((result) =>
			result.status === "rejected" && result.reason instanceof Error
				? result.reason.message
				: result.status
		)
	).toEqual(["Operation canceled.", "Operation canceled."]);
	const fresh = await assetFilmstrip(store, video, other);
	expect(fresh.cached).toBe(false);
	expect(fresh.width).toBe(32 * 85);
});
