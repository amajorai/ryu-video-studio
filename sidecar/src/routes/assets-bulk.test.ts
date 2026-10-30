import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Asset, newSegment } from "../../../shared/project.ts";
import { probe, runMedia } from "../media.ts";
import { createStudioServer, openapi } from "../server.ts";
import {
	parseSkimFrameQuery,
	resolveSkimTime,
	skimFrameArgs,
	skimFrameFileName,
} from "../skim-frames.ts";
import { StudioStore } from "../store.ts";
import { routes } from "./assets-bulk.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const clean of cleanup.splice(0)) {
		await clean();
	}
});

async function studio() {
	const directory = await mkdtemp(join(tmpdir(), "ryu-video-studio-bulk-"));
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
	const call = (path: string, body?: unknown) =>
		fetch(`http://127.0.0.1:${app.server.port}/api/video-studio${path}`, {
			body: body === undefined ? undefined : JSON.stringify(body),
			headers: {
				authorization: `Bearer ${token}`,
				"content-type": "application/json",
			},
			method: body === undefined ? "GET" : "POST",
		});
	return { call, directory, store };
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
	await Bun.write(join(store.directory, "media", `${asset.id}.jpg`), "jpg");
	return asset;
}

const videoArgs = (duration: number) => [
	"-f",
	"lavfi",
	"-i",
	`testsrc2=s=320x180:r=30:d=${duration}`,
	"-c:v",
	"libx264",
	"-pix_fmt",
	"yuv420p",
	"-f",
	"mp4",
];

const toneArgs = [
	"-f",
	"lavfi",
	"-i",
	"sine=frequency=440:duration=1",
	"-c:a",
	"pcm_s16le",
	"-f",
	"wav",
];

const fileExists = (path: string) =>
	stat(path).then(
		() => true,
		() => false
	);

describe("skim frame planning", () => {
	test("queries are bounded and default the height", () => {
		expect(parseSkimFrameQuery(new URLSearchParams("time=1.5"))).toEqual({
			height: 180,
			time: 1.5,
		});
		for (const query of [
			"",
			"time=-1",
			"time=7201",
			"time=1&height=47",
			"time=1&height=361",
			"time=1&height=90.5",
			"time=abc",
		]) {
			expect(() => parseSkimFrameQuery(new URLSearchParams(query))).toThrow();
		}
	});

	test("times clamp before the last frame, stills use their only frame", () => {
		const video = { duration: 4, kind: "video" } as const;
		expect(resolveSkimTime(video, 1.234_56)).toBe(1.235);
		expect(resolveSkimTime(video, 99)).toBe(3.95);
		expect(resolveSkimTime({ duration: 5, kind: "image" }, 3)).toBe(0);
		expect(() => resolveSkimTime({ duration: 5, kind: "audio" }, 1)).toThrow(
			"video or image"
		);
	});

	test("cache names follow the media identity, time and height", () => {
		const media = { mtimeMs: 1000.4, size: 2048 };
		const name = skimFrameFileName(media, { height: 90, time: 1.5 });
		expect(name).toBe("2048-1000-1500-90.jpg");
		expect(
			new Set([
				name,
				skimFrameFileName({ ...media, size: 4096 }, { height: 90, time: 1.5 }),
				skimFrameFileName({ ...media, mtimeMs: 9 }, { height: 90, time: 1.5 }),
				skimFrameFileName(media, { height: 90, time: 1.501 }),
				skimFrameFileName(media, { height: 120, time: 1.5 }),
			]).size
		).toBe(5);
	});

	test("FFmpeg seeks video before the input and scales to the height", () => {
		const args = skimFrameArgs(
			"/media/x",
			{ kind: "video" },
			{ height: 90, time: 2 },
			"/out.jpg"
		);
		expect(args.indexOf("-ss")).toBeLessThan(args.indexOf("-i"));
		expect(args[args.indexOf("-ss") + 1]).toBe("2.000");
		expect(args[args.indexOf("-vf") + 1]).toBe(
			"scale=w=-2:h=90:flags=bilinear"
		);
		expect(
			skimFrameArgs("/m", { kind: "image" }, { height: 90, time: 0 }, "/o.jpg")
		).not.toContain("-ss");
	});
});

test("delete-many removes unused media and refuses media a project uses", async () => {
	const { call, directory, store } = await studio();
	const used = await importMedia(store, "interview", videoArgs(1));
	const unused = await importMedia(store, "outtake", videoArgs(1));
	const music = await importMedia(store, "music", toneArgs);
	const project = store.create("Cut");
	const saved = store.save({ ...project, segments: [newSegment(used)] });
	// Warm a skim frame so the delete must clean the cache folder too.
	expect((await call(`/assets/${unused.id}/skim-frame?time=0.5`)).status).toBe(
		200
	);
	expect(await fileExists(join(directory, "skim-frames", unused.id))).toBe(
		true
	);
	const missing = crypto.randomUUID();
	const response = await call("/assets-delete-many", {
		ids: [used.id, unused.id, music.id, missing],
	});
	expect(response.status).toBe(200);
	expect(await response.json()).toEqual({
		deleted: [unused.id, music.id],
		refused: [
			{
				id: used.id,
				name: "interview",
				projects: [{ id: saved.id, title: "Cut" }],
				reason: "in-use",
			},
			{ id: missing, projects: [], reason: "not-found" },
		],
	});
	expect(store.assets().map((asset) => asset.id)).toEqual([used.id]);
	// The project keeps its clip: bulk delete never edits timelines.
	expect(store.project(saved.id).segments).toHaveLength(1);
	expect(store.project(saved.id).revision).toBe(saved.revision);
	for (const id of [unused.id, music.id]) {
		expect(await fileExists(store.mediaPath(id))).toBe(false);
		expect(await fileExists(join(directory, "media", `${id}.jpg`))).toBe(false);
		expect(await fileExists(join(directory, "skim-frames", id))).toBe(false);
	}
	expect(await fileExists(store.mediaPath(used.id))).toBe(true);
});

test("delete-many rejects malformed bodies without deleting", async () => {
	const { call, store } = await studio();
	const clip = await importMedia(store, "clip", videoArgs(1));
	for (const body of [{ ids: [] }, { ids: [clip.id], force: true }, {}]) {
		expect((await call("/assets-delete-many", body)).status).toBe(400);
	}
	expect(store.assets()).toHaveLength(1);
});

test("skim frames are scaled JPEGs cached per asset", async () => {
	const { call, directory, store } = await studio();
	const video = await importMedia(store, "camera", videoArgs(2));
	const first = await call(`/assets/${video.id}/skim-frame?time=9&height=90`);
	expect(first.status).toBe(200);
	const body = (await first.json()) as {
		cached: boolean;
		data: string;
		height: number;
		time: number;
	};
	expect(body.cached).toBe(false);
	expect(body.height).toBe(90);
	// Past the end clamps before the last frame.
	expect(body.time).toBe(1.95);
	const bytes = Buffer.from(body.data, "base64");
	expect([bytes[0], bytes[1]]).toEqual([0xff, 0xd8]);
	const files = await readdir(join(directory, "skim-frames", video.id));
	expect(files).toHaveLength(1);
	const size = await runMedia(
		[
			"-v",
			"error",
			"-show_entries",
			"stream=width,height",
			"-of",
			"csv=p=0",
			join(directory, "skim-frames", video.id, files[0] ?? ""),
		],
		{ probe: true }
	);
	expect(size.trim()).toBe("160,90");
	const again = (await (
		await call(`/assets/${video.id}/skim-frame?time=9&height=90`)
	).json()) as { cached: boolean; data: string };
	expect(again.cached).toBe(true);
	expect(again.data).toBe(body.data);

	const tone = await importMedia(store, "tone", toneArgs);
	expect((await call(`/assets/${tone.id}/skim-frame?time=0`)).status).toBe(400);
	expect(
		(await call(`/assets/${crypto.randomUUID()}/skim-frame?time=0`)).status
	).toBe(404);
});

test("OpenAPI documents the bulk delete and skim routes", () => {
	const document = openapi(routes) as {
		paths: Record<string, Record<string, { operationId: string }>>;
	};
	expect(
		document.paths["/api/video-studio/assets-delete-many"]?.post?.operationId
	).toBe("video_studio_delete_media_many");
	expect(
		document.paths["/api/video-studio/assets/{id}/skim-frame"]?.get?.operationId
	).toBe("video_studio_media_skim_frame");
});
