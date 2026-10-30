import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type Asset,
	activeCaptions,
	newSegment,
	type Project,
	projectDuration,
	projectSchema,
} from "../../../shared/project.ts";
import { createStudioServer, openapi } from "../server.ts";
import { StudioStore } from "../store.ts";
import { routes } from "./auto-edit.ts";

const stores: StudioStore[] = [];
const servers: ReturnType<typeof createStudioServer>[] = [];
afterEach(async () => {
	for (const server of servers.splice(0)) {
		server.stop();
	}
	for (const store of stores.splice(0)) {
		store.close();
		await rm(store.directory, { force: true, recursive: true });
	}
});

async function studio() {
	const store = new StudioStore(await mkdtemp(join(tmpdir(), "ryu-autocut-")));
	stores.push(store);
	const token = crypto.randomUUID();
	const app = createStudioServer({ port: 0, store, token });
	servers.push(app);
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
		return {
			body: (await response.json()) as Record<string, unknown>,
			status: response.status,
		};
	};
	return { call, store };
}

function register(
	store: StudioStore,
	kind: Asset["kind"],
	duration: number
): Asset {
	const asset: Asset = {
		createdAt: new Date().toISOString(),
		duration,
		hasAudio: kind !== "image",
		height: kind === "audio" ? 0 : 1080,
		id: crypto.randomUUID(),
		kind,
		name: `${kind}-${duration}`,
		width: kind === "audio" ? 0 : 1920,
	};
	store.putAsset(asset);
	return asset;
}

/** A completed analysis with a loud burst between `loudFrom` and `loudTo`. */
function analyse(
	store: StudioStore,
	asset: Asset,
	loud?: { from: number; to: number },
	beats?: number[]
) {
	const bins = 100;
	store.putAnalysis({
		assetId: asset.id,
		createdAt: new Date().toISOString(),
		duration: asset.duration,
		sceneCuts: [],
		status: "completed",
		waveform: Array.from({ length: bins }, (_, index) => {
			const time = (index / bins) * asset.duration;
			return loud && time >= loud.from && time < loud.to ? 0.9 : 0.1;
		}),
		...(beats
			? {
					beats: {
						analyzedDuration: asset.duration,
						beats,
						bpm: 120,
						confidence: 0.9,
						downbeats: beats.filter((_, index) => index % 4 === 0),
						method: "spectral-flux" as const,
					},
				}
			: {}),
	});
}

test("the module registers the AutoCut root route and the shorts route", () => {
	expect(routes.map((route) => route.operation.id)).toEqual([
		"video_studio_auto_edit",
		"video_studio_shorts",
	]);
	const paths = openapi().paths as Record<string, Record<string, unknown>>;
	expect(paths["/api/video-studio/auto-edit"]?.post).toBeDefined();
	expect(paths["/api/video-studio/projects/{id}/shorts"]?.post).toBeDefined();
});

test("auto-edit creates a beat-cut project from the sources and music", async () => {
	const { call, store } = await studio();
	const a = register(store, "video", 40);
	const b = register(store, "video", 40);
	const music = register(store, "audio", 16);
	analyse(store, a, { from: 20, to: 30 });
	const beats = Array.from({ length: 31 }, (_, index) => (index + 1) * 0.5);
	analyse(store, music, undefined, beats);
	const before = store.projects().length;
	const response = await call("/auto-edit", {
		aspect: "9:16",
		assetIds: [a.id, b.id],
		duration: 30,
		musicAssetId: music.id,
		style: "smooth",
		title: "Launch recap",
	});
	expect(response.status).toBe(200);
	const project = projectSchema.parse(response.body.project);
	expect(store.projects().length).toBe(before + 1);
	expect(store.project(project.id).revision).toBe(project.revision);
	expect(project.title).toBe("Launch recap");
	expect(project.width).toBe(1080);
	expect(project.height).toBe(1920);
	expect(response.body.beatSource).toBe("detected");
	expect(response.body.duration).toBe(16);
	expect(projectDuration(project)).toBeCloseTo(16, 3);
	const slots = response.body.slots as { start: number }[];
	// Smooth cuts on the detected bar starts (every fourth beat from 0.5 s).
	expect(slots.map((slot) => slot.start)).toEqual([
		0, 2.5, 4.5, 6.5, 8.5, 10.5, 12.5,
	]);
	expect(response.body.transitions).toBe(slots.length - 1);
	const visuals = project.segments.filter((segment) => segment.track === 0);
	expect(visuals.every((segment) => segment.muted === true)).toBe(true);
	// Every visual clip was put on the 9:16 canvas; without media files to
	// track, each keeps the centred crop and says so.
	const reframe = response.body.reframe as {
		clipId: string;
		mode: string;
		note?: string;
	}[];
	expect(reframe.map((clip) => clip.clipId).sort()).toEqual(
		visuals.map((segment) => segment.id).sort()
	);
	expect(
		reframe.every((clip) => clip.mode === "center" && Boolean(clip.note))
	).toBe(true);
	expect(visuals.every((segment) => segment.fit === "fill")).toBe(true);
	expect(project.segments.some((segment) => segment.assetId === music.id)).toBe(
		true
	);
});

test("auto-edit validates its sources", async () => {
	const { call, store } = await studio();
	const music = register(store, "audio", 10);
	const response = await call("/auto-edit", {
		assetIds: [music.id],
		duration: 10,
	});
	expect(response.status).toBe(400);
	expect(String(response.body.message)).toContain("video or image");
	const invalid = await call("/auto-edit", { assetIds: [], duration: 10 });
	expect(invalid.status).toBe(400);
});

function talkProject(store: StudioStore): { camera: Asset; project: Project } {
	const camera = register(store, "video", 120);
	analyse(store, camera, { from: 40, to: 70 });
	const created = store.create("Talk");
	const project = store.save({
		...created,
		captions: [
			{
				end: 52,
				id: crypto.randomUUID(),
				start: 50,
				text: "the big reveal",
			},
		],
		segments: [{ ...newSegment(camera, 0, 0), sourceOut: 120 }],
	});
	return { camera, project };
}

test("shorts creates vertical projects for the best highlights", async () => {
	const { call, store } = await studio();
	const { project } = talkProject(store);
	const response = await call(`/projects/${project.id}/shorts`, {
		count: 2,
		maxSeconds: 30,
		minSeconds: 20,
		revision: project.revision,
	});
	expect(response.status).toBe(200);
	const shorts = response.body.shorts as {
		end: number;
		project: unknown;
		reframe: { clipId: string; mode: string }[];
		start: number;
	}[];
	expect(shorts.length).toBeGreaterThan(0);
	expect(shorts.length).toBeLessThanOrEqual(2);
	for (const [index, short] of shorts.entries()) {
		const saved = projectSchema.parse(short.project);
		expect(saved.id).not.toBe(project.id);
		expect(saved.title).toBe(`Talk · short ${index + 1}`);
		expect(saved.width).toBe(1080);
		expect(saved.height).toBe(1920);
		expect(saved.exportSettings?.platformPreset).toBe("youtube-shorts");
		expect(projectDuration(saved)).toBeCloseTo(short.end - short.start, 2);
		expect(saved.segments[0]?.fit).toBe("fill");
		expect(short.reframe.map((clip) => clip.clipId)).toEqual([
			saved.segments[0]?.id,
		]);
		expect(store.project(saved.id).revision).toBe(saved.revision);
	}
	const best = projectSchema.parse(shorts[0]?.project);
	// The loud burst (40-70 s) ranks first and carries the caption inside it.
	expect(shorts[0]?.start).toBeGreaterThanOrEqual(30);
	expect(activeCaptions(best).map((caption) => caption.text)).toEqual([
		"the",
		"big",
		"reveal",
	]);
	// The source is unchanged.
	expect(store.project(project.id).revision).toBe(project.revision);
});

test("shorts ignores the loudness of clips nobody hears", async () => {
	const { call, store } = await studio();
	const { project } = talkProject(store);
	const [clip] = project.segments;
	// A muted clip's loud burst is not a highlight.
	const muted = store.save({
		...project,
		segments: clip ? [{ ...clip, muted: true }] : [],
	});
	const response = await call(`/projects/${muted.id}/shorts`, {
		count: 1,
		maxSeconds: 30,
		minSeconds: 20,
		revision: muted.revision,
	});
	const shorts = (response.body.shorts ?? []) as { start: number }[];
	expect(shorts.every((short) => short.start < 30)).toBe(true);
});

test("shorts refuses a stale revision and impossible lengths", async () => {
	const { call, store } = await studio();
	const { project } = talkProject(store);
	const stale = await call(`/projects/${project.id}/shorts`, {
		revision: project.revision + 1,
	});
	expect(stale.status).toBe(409);
	const none = await call(`/projects/${project.id}/shorts`, {
		maxSeconds: 600,
		minSeconds: 500,
		revision: project.revision,
	});
	expect(none.status).toBe(400);
	expect(String(none.body.message)).toContain("No highlights fit");
});
