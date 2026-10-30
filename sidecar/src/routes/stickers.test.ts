import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { creditsForProject } from "../../../shared/credits.ts";
import { type Asset, newSegment } from "../../../shared/project.ts";
import { stickerAnimation } from "../../../shared/stickers/place.ts";
import { ffmpegLacksDecoder } from "../ffmpeg-build-fixture.ts";
import { createStudioServer } from "../server.ts";
import { STICKER_RASTER_UNAVAILABLE_MESSAGE } from "../stickers.ts";
import { StudioStore } from "../store.ts";
import { routes } from "./stickers.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const clean of cleanup.splice(0)) {
		await clean();
	}
});

function video(): Asset {
	return {
		createdAt: new Date().toISOString(),
		duration: 10,
		hasAudio: false,
		height: 360,
		id: crypto.randomUUID(),
		kind: "video",
		name: "footage.mp4",
		width: 640,
	};
}

async function setup() {
	const directory = await mkdtemp(join(tmpdir(), "ryu-video-studio-stickers-"));
	const store = new StudioStore(directory);
	const token = crypto.randomUUID();
	const app = createStudioServer({ port: 0, routes, store, token });
	cleanup.push(async () => {
		app.server.stop(true);
		store.close();
		await rm(directory, {
			force: true,
			recursive: true,
			maxRetries: 10,
			retryDelay: 100,
		});
	});
	const base = `http://127.0.0.1:${app.server.port}/api/video-studio`;
	const headers = {
		authorization: `Bearer ${token}`,
		"content-type": "application/json",
	};
	const get = (path: string) => fetch(`${base}${path}`, { headers });
	const post = (path: string, body: unknown) =>
		fetch(`${base}${path}`, {
			body: JSON.stringify(body),
			headers,
			method: "POST",
		});
	return { get, post, store };
}

test("GET /stickers searches the bundled catalog with credits and presets", async () => {
	const { get } = await setup();
	const response = await get("/stickers?query=flag%20japan&limit=5");
	expect(response.status).toBe(200);
	const body = (await response.json()) as {
		presets: { id: string; label: string }[];
		sources: { id: string; licenseName: string }[];
		stickers: { category: string; id: string; licenseName: string }[];
		total: number;
	};
	expect(body.stickers[0]).toMatchObject({
		category: "flags",
		licenseName: "MIT",
	});
	expect(body.total).toBeGreaterThanOrEqual(1);
	expect(body.presets.map((preset) => preset.id)).toContain("float");
	expect(body.sources.map((source) => source.id)).toEqual([
		"twemoji",
		"flag-icons",
		"ryu",
	]);
	const shapes = (await (
		await get("/stickers?category=shapes&limit=500")
	).json()) as { stickers: { category: string }[]; total: number };
	expect(shapes.stickers.length).toBe(shapes.total);
	expect(
		shapes.stickers.every((sticker) => sticker.category === "shapes")
	).toBe(true);
	expect((await get("/stickers?limit=0")).status).toBe(400);
});

// Bundled stickers are drawn by FFmpeg's librsvg decoder, which some package
// builds (Homebrew, Chocolatey essentials) leave out.
const lacksLibrsvg = ffmpegLacksDecoder("librsvg");

test.skipIf(!lacksLibrsvg)(
	"without librsvg, placing a sticker names the missing decoder and adds nothing",
	async () => {
		const { post, store } = await setup();
		const project = store.create("Sticker agent");
		const response = await post(`/projects/${project.id}/stickers`, {
			revision: project.revision,
			stickerId: "emoji-1f600",
		});
		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({
			message: STICKER_RASTER_UNAVAILABLE_MESSAGE,
		});
		expect(store.assets()).toHaveLength(0);
		expect(store.project(project.id).revision).toBe(project.revision);
	}
);

test.skipIf(lacksLibrsvg)(
	"POST /projects/:id/stickers rasterizes, credits and places with a preset",
	async () => {
		const { post, store } = await setup();
		const footage = video();
		store.putAsset(footage);
		const created = store.create("Sticker agent");
		const project = store.save({
			...created,
			segments: [newSegment(footage, 0, 0)],
		});
		const response = await post(`/projects/${project.id}/stickers`, {
			duration: 3,
			preset: "pop",
			revision: project.revision,
			stickerId: "emoji-1f600",
			time: 2,
		});
		expect(response.status).toBe(201);
		const body = (await response.json()) as {
			asset: Asset;
			project: typeof project;
			reused: boolean;
			segmentId: string;
			track: number;
		};
		expect(body.reused).toBe(false);
		expect(body.asset).toMatchObject({
			derivation: "sticker",
			folder: "Stickers",
			height: 1024,
			kind: "image",
			name: "Sticker · Grinning face",
			width: 1024,
		});
		expect(body.asset.origin).toMatchObject({
			identifier: "emoji-1f600",
			provider: "bundled",
		});
		const png = await readFile(store.mediaPath(body.asset.id));
		expect([...png.subarray(1, 4)]).toEqual([0x50, 0x4e, 0x47]);
		const segment = body.project.segments.find(
			(item) => item.id === body.segmentId
		);
		expect(segment).toMatchObject({
			assetId: body.asset.id,
			scale: 0.35,
			sourceOut: 3,
			start: 2,
			track: 1,
		});
		expect(segment?.animation).toEqual(stickerAnimation("pop"));
		expect(body.track).toBe(1);
		expect(
			creditsForProject(body.project, store.assets()).entries[0]?.attribution
		).toContain("Twemoji");

		const again = await post(`/projects/${project.id}/stickers`, {
			revision: body.project.revision,
			stickerId: "emoji-1f600",
			time: 2,
		});
		expect(again.status).toBe(201);
		const second = (await again.json()) as {
			asset: Asset;
			reused: boolean;
			track: number;
		};
		expect(second.reused).toBe(true);
		expect(second.asset.id).toBe(body.asset.id);
		expect(second.track).toBe(2);
		expect(
			store.assets().filter((asset) => asset.derivation === "sticker")
		).toHaveLength(1);
	}
);

test("stale revisions, unknown stickers and bad presets are refused", async () => {
	const { post, store } = await setup();
	const project = store.create("Refusals");
	const stale = await post(`/projects/${project.id}/stickers`, {
		revision: project.revision + 1,
		stickerId: "shape-star",
	});
	expect(stale.status).toBe(409);
	const unknown = await post(`/projects/${project.id}/stickers`, {
		revision: project.revision,
		stickerId: "not-a-sticker",
	});
	expect(unknown.status).toBe(400);
	expect(JSON.stringify(await unknown.json())).toContain("GET /stickers");
	const preset = await post(`/projects/${project.id}/stickers`, {
		preset: "wobble",
		revision: project.revision,
		stickerId: "shape-star",
	});
	expect(preset.status).toBe(400);
	expect(store.assets()).toHaveLength(0);
});
