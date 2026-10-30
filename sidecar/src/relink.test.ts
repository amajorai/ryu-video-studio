import {
	afterEach,
	beforeEach,
	describe,
	expect,
	mock,
	spyOn,
	test,
} from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Asset, newSegment, projectSchema } from "../../shared/project.ts";
import { offlineAssetReportSchema } from "../../shared/relink.ts";
import * as media from "./media.ts";
import {
	mediaFileState,
	offlineAssetReports,
	relinkAsset,
	relinkBatch,
} from "./relink.ts";
import { RenderQueue } from "./render.ts";
import { routes } from "./routes/relink.ts";
import { createStudioServer } from "./server.ts";
import { ConflictError, OfflineMediaError, StudioStore } from "./store.ts";

/** Fixture media bytes FFprobe would reject (see the probe stub). */
const CORRUPT = "corrupt: not a media file";

const cleanups: (() => Promise<void>)[] = [];
beforeEach(() => {
	// Fixture files are placeholder bytes: they "decode" unless marked
	// corrupt. Real FFprobe behaviour is covered by verify-relink.ts.
	spyOn(media, "probe").mockImplementation(async (path) => {
		if ((await Bun.file(path).text()).startsWith("corrupt")) {
			throw new Error("Invalid data found when processing input");
		}
		return {
			duration: 4,
			hasAudio: true,
			height: 360,
			kind: "video",
			width: 640,
		};
	});
	spyOn(media, "thumbnail").mockResolvedValue();
});
afterEach(async () => {
	mock.restore();
	for (const cleanup of cleanups.splice(0)) {
		await cleanup();
	}
});

async function tempStore() {
	const store = new StudioStore(
		await mkdtemp(join(tmpdir(), "ryu-video-relink-"))
	);
	cleanups.push(async () => {
		store.close();
		await rm(store.directory, { force: true, recursive: true });
	});
	return store;
}

function asset(overrides: Partial<Asset> = {}): Asset {
	return {
		createdAt: new Date(0).toISOString(),
		duration: 4,
		hasAudio: true,
		height: 360,
		id: crypto.randomUUID(),
		kind: "video",
		name: "Take.mp4",
		width: 640,
		...overrides,
	};
}

/** Register an asset whose media file holds `bytes` (omit for offline). */
async function addAsset(
	store: StudioStore,
	overrides: Partial<Asset> = {},
	bytes: string | null = "media"
): Promise<Asset> {
	const value = asset(overrides);
	store.putAsset(value);
	if (bytes !== null) {
		await writeFile(store.mediaPath(value.id), bytes);
	}
	return value;
}

function projectUsing(store: StudioStore, ...media: Asset[]) {
	const project = store.create("Relink");
	return store.save({
		...project,
		segments: media.map((item, index) => newSegment(item, index * 5)),
	});
}

describe("mediaFileState", () => {
	test("classifies missing, empty, directory and readable files", async () => {
		const store = await tempStore();
		const path = join(store.directory, "probe-target");
		expect(mediaFileState(path)).toBe("missing");
		await writeFile(path, "");
		expect(mediaFileState(path)).toBe("empty");
		await writeFile(path, "x");
		expect(mediaFileState(path)).toBeNull();
		await rm(path);
		await mkdir(path);
		expect(mediaFileState(path)).toBe("not-a-file");
	});
});

describe("offline detection", () => {
	test("store lists offline assets and skips nested sequences", async () => {
		const store = await tempStore();
		const online = await addAsset(store, { name: "Online.mp4" });
		const missing = await addAsset(store, { name: "Missing.mp4" }, null);
		const empty = await addAsset(store, { name: "Empty.mp4" }, "");
		await addAsset(
			store,
			{ name: "Sequence", sequenceProjectId: crypto.randomUUID() },
			null
		);
		const offline = store.offlineAssets();
		expect(offline.map(({ asset: item }) => item.id).sort()).toEqual(
			[missing.id, empty.id].sort()
		);
		expect(
			offline.find(({ asset: item }) => item.id === empty.id)?.reason
		).toBe("empty");
		expect(offline.some(({ asset: item }) => item.id === online.id)).toBe(
			false
		);
	});

	test("render refuses with the offline asset names", async () => {
		const store = await tempStore();
		const online = await addAsset(store, { name: "Online.mp4" });
		const missing = await addAsset(store, { name: "Gone.mp4" }, null);
		const project = projectUsing(store, online, missing);
		expect(
			store.offlineRenderAssets(project.id).map((item) => item.id)
		).toEqual([missing.id]);
		const queue = new RenderQueue(store);
		let refused: unknown;
		try {
			queue.start(project);
		} catch (error) {
			refused = error;
		}
		expect(refused).toBeInstanceOf(OfflineMediaError);
		expect(
			(refused as OfflineMediaError).assets.map((item) => item.id)
		).toEqual([missing.id]);
		expect((refused as Error).message).toBe(
			'Relink offline media before exporting: "Gone.mp4".'
		);
		expect(store.jobs()).toEqual([]);
	});

	test("nested sequence media refuses the outer render", async () => {
		const store = await tempStore();
		const leaf = await addAsset(store, { name: "Leaf.mp4" }, null);
		const inner = projectUsing(store, leaf);
		const sequence = await addAsset(
			store,
			{ name: "Inner", sequenceProjectId: inner.id },
			null
		);
		const outer = projectUsing(store, sequence);
		expect(store.offlineRenderAssets(outer.id).map((a) => a.id)).toEqual([
			leaf.id,
		]);
		expect(() => new RenderQueue(store).start(outer)).toThrow(
			'Relink offline media before exporting: "Leaf.mp4".'
		);
		expect(store.offlineRenderAssets(crypto.randomUUID())).toEqual([]);
	});

	test("an offline background image refuses the render", async () => {
		const store = await tempStore();
		const clip = await addAsset(store, { name: "Clip.mp4" });
		const backdrop = await addAsset(
			store,
			{ duration: 0, hasAudio: false, kind: "image", name: "Backdrop.png" },
			null
		);
		const clipBackdrop = await addAsset(
			store,
			{ duration: 0, hasAudio: false, kind: "image", name: "Behind.png" },
			null
		);
		const project = store.save({
			...store.create("Backgrounds"),
			background: { assetId: backdrop.id, type: "image" },
			segments: [
				{
					...newSegment(clip, 0),
					background: { assetId: clipBackdrop.id, type: "image" },
				},
			],
		});
		expect(
			store
				.offlineRenderAssets(project.id)
				.map((item) => item.id)
				.sort()
		).toEqual([backdrop.id, clipBackdrop.id].sort());
		expect(() => new RenderQueue(store).start(project)).toThrow(
			OfflineMediaError
		);
		expect(store.jobs()).toEqual([]);
	});

	test("proxies are never offline media", async () => {
		const store = await tempStore();
		const source = await addAsset(store, { name: "Big.mp4" });
		await addAsset(
			store,
			{
				derivation: "proxy",
				derivedFromAssetId: source.id,
				name: "Big.mp4 · proxy 960w",
			},
			null
		);
		expect(store.offlineAssets()).toEqual([]);
		expect(await offlineAssetReports(store, { probe: true })).toEqual([]);
	});

	test("updating an existing job is never refused", async () => {
		const store = await tempStore();
		const missing = await addAsset(store, {}, null);
		const project = projectUsing(store, missing);
		const job = {
			createdAt: new Date().toISOString(),
			id: crypto.randomUUID(),
			progress: 0,
			projectId: project.id,
			revision: project.revision,
			status: "running" as const,
		};
		store.putJob(job);
		expect(() => store.putJob({ ...job, status: "pending" })).not.toThrow();
	});
});

describe("relinkAsset", () => {
	test("moves the replacement onto the offline asset and drops its record", async () => {
		const store = await tempStore();
		const offline = await addAsset(
			store,
			{ duration: 4, folder: "Shoot", name: "Take.mp4" },
			null
		);
		const project = projectUsing(store, offline);
		const replacement = await addAsset(
			store,
			{ duration: 4.3, height: 720, name: "Take.mov", width: 1280 },
			"replacement-bytes"
		);
		const result = await relinkAsset(store, offline.id, {
			sourceAssetId: replacement.id,
		});
		expect(result).toMatchObject({
			asset: {
				duration: 4.3,
				folder: "Shoot",
				height: 720,
				id: offline.id,
				name: "Take.mp4",
				width: 1280,
			},
			dryRun: false,
			removedAssetId: replacement.id,
		});
		expect(result.warnings[0]).toContain("640x360 to 1280x720");
		expect(await Bun.file(store.mediaPath(offline.id)).text()).toBe(
			"replacement-bytes"
		);
		expect(await Bun.file(store.mediaPath(replacement.id)).exists()).toBe(
			false
		);
		expect(store.assets().map((item) => item.id)).toEqual([offline.id]);
		expect(store.offlineAssets()).toEqual([]);
		expect(store.offlineRenderAssets(project.id)).toEqual([]);
	});

	test("dry run validates without changing anything", async () => {
		const store = await tempStore();
		const offline = await addAsset(store, {}, null);
		const replacement = await addAsset(store, { duration: 3.6 });
		const result = await relinkAsset(store, offline.id, {
			dryRun: true,
			sourceAssetId: replacement.id,
		});
		expect(result).toMatchObject({ dryRun: true, removedAssetId: null });
		expect(store.assets()).toHaveLength(2);
		expect(store.offlineAssets()).toHaveLength(1);
	});

	test("refuses wrong kind, wrong duration, online targets and used sources", async () => {
		const store = await tempStore();
		const offline = await addAsset(store, {}, null);
		const audio = await addAsset(store, { kind: "audio", name: "Take.wav" });
		await expect(
			relinkAsset(store, offline.id, { sourceAssetId: audio.id })
		).rejects.toThrow("is video media; the replacement is audio");
		const long = await addAsset(store, { duration: 4.6 });
		await expect(
			relinkAsset(store, offline.id, { sourceAssetId: long.id })
		).rejects.toThrow("allowed difference 0.5 s");
		const online = await addAsset(store);
		await expect(
			relinkAsset(store, online.id, { sourceAssetId: long.id })
		).rejects.toBeInstanceOf(ConflictError);
		const used = await addAsset(store, { duration: 4.1 });
		projectUsing(store, used);
		await expect(
			relinkAsset(store, offline.id, { sourceAssetId: used.id })
		).rejects.toThrow("already used in a project");
		const alsoOffline = await addAsset(store, {}, null);
		await expect(
			relinkAsset(store, offline.id, { sourceAssetId: alsoOffline.id })
		).rejects.toThrow("offline too");
		await expect(
			relinkAsset(store, offline.id, { sourceAssetId: offline.id })
		).rejects.toThrow("different file");
		expect(store.offlineAssets().map(({ asset: item }) => item.id)).toContain(
			offline.id
		);
	});

	test("keeps the original duration when a clip reads past the replacement", async () => {
		const store = await tempStore();
		const offline = await addAsset(store, { duration: 4 }, null);
		const project = store.create("Long clip");
		store.save({
			...project,
			segments: [{ ...newSegment(offline, 0), sourceOut: 4 }],
		});
		const replacement = await addAsset(store, { duration: 3.7 });
		const result = await relinkAsset(store, offline.id, {
			sourceAssetId: replacement.id,
		});
		expect(result.asset.duration).toBe(4);
	});
});

describe("relink safety", () => {
	test("media used only as a background image is never consumed", async () => {
		const store = await tempStore();
		const image = { duration: 0, hasAudio: false, kind: "image" } as const;
		const offline = await addAsset(store, { ...image, name: "Logo.png" }, null);
		const background = await addAsset(store, { ...image, name: "Bg.png" });
		const clipBackground = await addAsset(store, { ...image, name: "Cb.png" });
		const clip = await addAsset(store, { name: "Clip.mp4" });
		const project = store.save({
			...store.create("Uses a background"),
			background: { assetId: background.id, type: "image" },
			segments: [
				{
					...newSegment(clip, 0),
					background: { assetId: clipBackground.id, type: "image" },
				},
			],
		});
		for (const source of [background, clipBackground]) {
			await expect(
				relinkAsset(store, offline.id, { sourceAssetId: source.id })
			).rejects.toThrow("already used in a project");
		}
		const batch = await relinkBatch(store, {
			sourceAssetIds: [background.id],
		});
		expect(batch.relinked).toEqual([]);
		expect(store.assets().some((item) => item.id === background.id)).toBe(true);
		expect(() =>
			store.save({ ...project, title: "Still valid" })
		).not.toThrow();
	});

	test("media used as a caption source is never consumed", async () => {
		const store = await tempStore();
		const offline = await addAsset(store, { name: "Talk.mp4" }, null);
		const source = await addAsset(store, { name: "Talk.mov" });
		const clip = await addAsset(store, { name: "Clip.mp4" });
		store.save({
			...store.create("Captions"),
			captions: [
				{
					end: 1,
					id: crypto.randomUUID(),
					sourceAssetId: source.id,
					start: 0,
					text: "Hello",
				},
			],
			segments: [newSegment(clip, 0)],
		});
		await expect(
			relinkAsset(store, offline.id, { sourceAssetId: source.id })
		).rejects.toThrow("already used in a project");
	});

	test("a present file that no longer decodes can be relinked", async () => {
		const store = await tempStore();
		const damaged = await addAsset(store, { name: "Damaged.mp4" }, CORRUPT);
		const project = projectUsing(store, damaged);
		const reports = await offlineAssetReports(store, { probe: true });
		expect(reports.map((report) => [report.assetId, report.reason])).toEqual([
			[damaged.id, "undecodable"],
		]);
		const single = await addAsset(store, { name: "Damaged (2).mp4" });
		const result = await relinkAsset(store, damaged.id, {
			sourceAssetId: single.id,
		});
		expect(result.removedAssetId).toBe(single.id);
		expect(await Bun.file(store.mediaPath(damaged.id)).text()).toBe("media");
		expect(store.offlineRenderAssets(project.id)).toEqual([]);
	});

	test("batch relink matches probed targets it is given", async () => {
		const store = await tempStore();
		const damaged = await addAsset(store, { name: "Damaged.mp4" }, CORRUPT);
		const replacement = await addAsset(store, { name: "damaged.mov" });
		const unprobed = await relinkBatch(store, {
			sourceAssetIds: [replacement.id],
		});
		expect(unprobed.matches).toEqual([]);
		expect(unprobed.unusedSourceAssetIds).toEqual([replacement.id]);
		const probed = await relinkBatch(store, {
			sourceAssetIds: [replacement.id],
			targetAssetIds: (await offlineAssetReports(store, { probe: true })).map(
				(report) => report.assetId
			),
		});
		expect(probed.matches).toMatchObject([
			{ assetId: damaged.id, sourceAssetId: replacement.id },
		]);
		expect(probed.relinked).toHaveLength(1);
		expect(probed.failures).toEqual([]);
	});

	test("a batch target that is online fails its pair instead of relinking", async () => {
		const store = await tempStore();
		const online = await addAsset(store, { name: "Fine.mp4" });
		const replacement = await addAsset(store, { name: "fine.mp4" });
		const result = await relinkBatch(store, {
			sourceAssetIds: [replacement.id],
			targetAssetIds: [online.id],
		});
		expect(result.relinked).toEqual([]);
		expect(result.failures[0]?.reason).toContain("is online");
		expect(await Bun.file(store.mediaPath(online.id)).text()).toBe("media");
	});

	test("relink drops the old proxies and adopts the replacement's", async () => {
		const store = await tempStore();
		const target = await addAsset(store, { name: "Take.mp4" }, null);
		const oldProxy = await addAsset(
			store,
			{
				derivation: "proxy",
				derivedFromAssetId: target.id,
				name: "Take.mp4 · proxy 320w",
				width: 320,
			},
			"old-proxy"
		);
		await writeFile(
			join(store.directory, "media", `${oldProxy.id}.jpg`),
			"jpg"
		);
		const source = await addAsset(store, { name: "Take.mov" });
		const newProxy = await addAsset(
			store,
			{
				derivation: "proxy",
				derivedFromAssetId: source.id,
				name: "Take.mov · proxy 320w",
				width: 320,
			},
			"new-proxy"
		);
		const result = await relinkAsset(store, target.id, {
			sourceAssetId: source.id,
		});
		expect(result.removedProxyAssetIds).toEqual([oldProxy.id]);
		expect(result.proxyAssets).toMatchObject([
			{ derivedFromAssetId: target.id, id: newProxy.id },
		]);
		expect(await Bun.file(store.mediaPath(oldProxy.id)).exists()).toBe(false);
		expect(
			await Bun.file(
				join(store.directory, "media", `${oldProxy.id}.jpg`)
			).exists()
		).toBe(false);
		const proxies = store
			.assets()
			.filter((item) => item.derivation === "proxy");
		expect(proxies.map((item) => [item.id, item.derivedFromAssetId])).toEqual([
			[newProxy.id, target.id],
		]);
	});

	test("proxies are refused as relink targets and replacements", async () => {
		const store = await tempStore();
		const original = await addAsset(store, { name: "Big.mp4" });
		const missingProxy = await addAsset(
			store,
			{ derivation: "proxy", derivedFromAssetId: original.id },
			null
		);
		const replacement = await addAsset(store, { name: "Big (2).mp4" });
		await expect(
			relinkAsset(store, missingProxy.id, { sourceAssetId: replacement.id })
		).rejects.toThrow("preview proxy");
		const offline = await addAsset(store, { name: "Lost.mp4" }, null);
		const proxy = await addAsset(store, {
			derivation: "proxy",
			derivedFromAssetId: original.id,
		});
		await expect(
			relinkAsset(store, offline.id, { sourceAssetId: proxy.id })
		).rejects.toThrow("preview proxy");
	});
});

describe("relinkBatch", () => {
	test("matches by file name and duration and reports leftovers", async () => {
		const store = await tempStore();
		const take = await addAsset(store, { duration: 4, name: "Take.mp4" }, null);
		const voice = await addAsset(
			store,
			{ duration: 2, hasAudio: true, kind: "audio", name: "Voice.wav" },
			null
		);
		const lost = await addAsset(store, { name: "Lost.mp4" }, null);
		const takeSource = await addAsset(store, {
			duration: 4.2,
			name: "take (1).MP4",
		});
		const voiceSource = await addAsset(store, {
			duration: 2.1,
			kind: "audio",
			name: "voice.wav",
		});
		const stray = await addAsset(store, { name: "Stray.mp4" });
		const dry = await relinkBatch(store, {
			dryRun: true,
			sourceAssetIds: [takeSource.id, voiceSource.id, stray.id],
		});
		expect(dry.relinked.every((item) => item.dryRun)).toBe(true);
		expect(store.offlineAssets()).toHaveLength(3);
		const result = await relinkBatch(store, {
			sourceAssetIds: [takeSource.id, voiceSource.id, stray.id],
		});
		expect(
			result.matches.map(({ assetId, sourceAssetId }) => [
				assetId,
				sourceAssetId,
			])
		).toEqual(
			expect.arrayContaining([
				[take.id, takeSource.id],
				[voice.id, voiceSource.id],
			])
		);
		expect(result.relinked).toHaveLength(2);
		expect(result.failures).toEqual([]);
		expect(result.unmatched.map((item) => item.assetId)).toEqual([lost.id]);
		expect(result.unusedSourceAssetIds).toEqual([stray.id]);
		expect(store.offlineAssets().map(({ asset: item }) => item.id)).toEqual([
			lost.id,
		]);
	});

	test("an unknown replacement id is refused", async () => {
		const store = await tempStore();
		await expect(
			relinkBatch(store, { sourceAssetIds: [crypto.randomUUID()] })
		).rejects.toThrow("not found");
	});
});

describe("routes", () => {
	async function server() {
		const store = await tempStore();
		const token = crypto.randomUUID();
		const app = createStudioServer({ store, port: 0, routes, token });
		cleanups.unshift(async () => {
			app.stop();
		});
		const call = (path: string, method = "GET", body?: unknown) =>
			fetch(`http://127.0.0.1:${app.server.port}/api/video-studio${path}`, {
				body: body === undefined ? undefined : JSON.stringify(body),
				headers: {
					authorization: `Bearer ${token}`,
					"content-type": "application/json",
				},
				method,
			});
		return { call, store };
	}

	test("GET /offline-assets lists offline media with its projects", async () => {
		const { call, store } = await server();
		const missing = await addAsset(store, { name: "Missing.mp4" }, null);
		await addAsset(store, { name: "Fine.mp4" });
		const project = projectUsing(store, missing, missing);
		const response = await call("/offline-assets");
		expect(response.status).toBe(200);
		const body = (await response.json()) as { offline: unknown[] };
		expect(
			body.offline.map((item) => offlineAssetReportSchema.parse(item))
		).toEqual([
			{
				assetId: missing.id,
				duration: 4,
				kind: "video",
				name: "Missing.mp4",
				projects: [{ clipCount: 2, projectId: project.id, title: "Relink" }],
				reason: "missing",
			},
		]);
	});

	test("GET /offline-assets?probe=1 reports files that no longer decode", async () => {
		const { call, store } = await server();
		const garbage = await addAsset(store, { name: "Corrupt.mp4" }, CORRUPT);
		const quick = (await (await call("/offline-assets")).json()) as {
			offline: unknown[];
		};
		expect(quick.offline).toEqual([]);
		const deep = (await (await call("/offline-assets?probe=1")).json()) as {
			offline: { assetId: string; reason: string }[];
		};
		expect(deep.offline).toMatchObject([
			{ assetId: garbage.id, reason: "undecodable" },
		]);
	});

	test("POST /assets/:id/relink validates and relinks", async () => {
		const { call, store } = await server();
		const offline = await addAsset(store, {}, null);
		const wrong = await addAsset(store, { duration: 9 });
		const refused = await call(`/assets/${offline.id}/relink`, "POST", {
			sourceAssetId: wrong.id,
		});
		expect(refused.status).toBe(400);
		expect(((await refused.json()) as { message: string }).message).toContain(
			"lasts"
		);
		const strict = await call(`/assets/${offline.id}/relink`, "POST", {
			extra: 1,
			sourceAssetId: wrong.id,
		});
		expect(strict.status).toBe(400);
		const replacement = await addAsset(store, { duration: 4.4 });
		const ok = await call(`/assets/${offline.id}/relink`, "POST", {
			sourceAssetId: replacement.id,
		});
		expect(ok.status).toBe(200);
		expect(await ok.json()).toMatchObject({
			asset: { id: offline.id },
			removedAssetId: replacement.id,
		});
		const online = await call(`/assets/${offline.id}/relink`, "POST", {
			sourceAssetId: wrong.id,
		});
		expect(online.status).toBe(409);
	});

	test("POST /relink runs a batch", async () => {
		const { call, store } = await server();
		const offline = await addAsset(store, { name: "Clip.mp4" }, null);
		const replacement = await addAsset(store, { name: "clip.mp4" });
		const response = await call("/relink", "POST", {
			sourceAssetIds: [replacement.id],
		});
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			matches: [{ assetId: offline.id, sourceAssetId: replacement.id }],
			unmatched: [],
		});
		expect(store.offlineAssets()).toEqual([]);
	});

	test("the render route refuses projects with offline media", async () => {
		const store = await tempStore();
		const token = crypto.randomUUID();
		const app = createStudioServer({ store, port: 0, token });
		cleanups.unshift(async () => {
			app.stop();
		});
		const missing = await addAsset(store, { name: "Gone.mp4" }, null);
		const project = projectSchema.parse(projectUsing(store, missing));
		const response = await fetch(
			`http://127.0.0.1:${app.server.port}/api/video-studio/projects/${project.id}/render`,
			{
				headers: { authorization: `Bearer ${token}` },
				method: "POST",
			}
		);
		expect(response.status).toBe(400);
		expect(((await response.json()) as { message: string }).message).toBe(
			'Relink offline media before exporting: "Gone.mp4".'
		);
	});
});
