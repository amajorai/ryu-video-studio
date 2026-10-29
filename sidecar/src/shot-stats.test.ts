import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MediaAnalysis } from "../../shared/analysis.ts";
import type { Asset } from "../../shared/project.ts";
import type { ShotIndex, ShotStats } from "../../shared/shot-index.ts";
import {
	analyzeShots,
	beginShotIndexing,
	currentShotIndexes,
	pruneShotIndexEntry,
	readShotIndex,
	readShotSearchIndex,
	searchStoredShots,
	shotIndexIsCurrent,
	shotSearchIndexes,
	updateShotIndexEntry,
} from "./shot-stats.ts";
import { ConflictError, StudioStore } from "./store.ts";

// Seeds the store and the `<data>/shots/*.json` files directly, so the
// freshness and search glue is proven without decoding frames.

const ANALYZED_AT = "2026-02-01T00:00:00.000Z";
const REANALYZED_AT = "2026-02-02T00:00:00.000Z";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) {
		await cleanup();
	}
});

async function makeStore(): Promise<StudioStore> {
	const store = new StudioStore(
		await mkdtemp(join(tmpdir(), "ryu-shot-stats-"))
	);
	cleanups.push(async () => {
		store.close();
		await rm(store.directory, { force: true, recursive: true });
	});
	return store;
}

let nextId = 1;
function addVideo(store: StudioStore, name: string): Asset {
	const asset: Asset = {
		createdAt: "2026-01-01T00:00:00.000Z",
		duration: 10,
		frameRate: 25,
		hasAudio: false,
		height: 360,
		id: `00000000-0000-4000-8000-${String(nextId++).padStart(12, "0")}`,
		kind: "video",
		name,
		width: 640,
	};
	store.putAsset(asset);
	return asset;
}

function putAnalysis(
	store: StudioStore,
	assetId: string,
	overrides: Partial<MediaAnalysis> = {}
) {
	store.putAnalysis({
		assetId,
		createdAt: ANALYZED_AT,
		duration: 10,
		sceneCuts: [5],
		status: "completed",
		waveform: [],
		...overrides,
	});
}

function shot(start: number, end: number, labels: ShotStats["labels"]) {
	return {
		brightness: 0.5,
		colors: [],
		edgeDensity: 0.2,
		end,
		labels,
		motion: 0.1,
		saturation: 0.5,
		start,
	} satisfies ShotStats;
}

async function writeShots(
	store: StudioStore,
	asset: Asset,
	overrides: Partial<ShotIndex> = {}
): Promise<ShotIndex> {
	const index: ShotIndex = {
		analysisCreatedAt: ANALYZED_AT,
		assetId: asset.id,
		format: "ryu.video-studio.shots.v1",
		revision: 0,
		sampleRate: 2,
		shots: [shot(0, 5, ["dark", "blue"]), shot(5, 10, ["bright", "red"])],
		updatedAt: ANALYZED_AT,
		...overrides,
	};
	await mkdir(join(store.directory, "shots"), { recursive: true });
	await writeFile(
		join(store.directory, "shots", `${asset.id}.json`),
		JSON.stringify(index)
	);
	return index;
}

describe("shot index freshness", () => {
	test("is current only for the completed analysis it was built from", async () => {
		const store = await makeStore();
		const asset = addVideo(store, "Beach");
		putAnalysis(store, asset.id);
		const index = await writeShots(store, asset);
		expect(readShotIndex(store, asset.id)).toEqual(index);
		expect(shotIndexIsCurrent(store, index)).toBe(true);

		// A fresh analysis run supersedes the stored shots.
		putAnalysis(store, asset.id, { createdAt: REANALYZED_AT });
		expect(shotIndexIsCurrent(store, index)).toBe(false);

		putAnalysis(store, asset.id, { status: "running" });
		expect(shotIndexIsCurrent(store, index)).toBe(false);
	});

	test("is not current once the source media is gone", async () => {
		const store = await makeStore();
		const asset = addVideo(store, "Beach");
		putAnalysis(store, asset.id);
		const index = await writeShots(store, asset);
		store.discardAsset(asset.id);
		expect(shotIndexIsCurrent(store, index)).toBe(false);
	});

	test("refuses a shot file that names a different asset", async () => {
		const store = await makeStore();
		const first = addVideo(store, "First");
		const second = addVideo(store, "Second");
		putAnalysis(store, first.id);
		const index = await writeShots(store, first);
		await writeFile(
			join(store.directory, "shots", `${second.id}.json`),
			JSON.stringify(index)
		);
		expect(readShotIndex(store, second.id)).toBeNull();
		expect(() => readShotIndex(store, "../escape")).toThrow(
			"Invalid media id."
		);
	});

	test("analyzeShots reuses the current stored index without decoding", async () => {
		const store = await makeStore();
		const asset = addVideo(store, "Beach");
		putAnalysis(store, asset.id);
		const index = await writeShots(store, asset, { revision: 4 });
		// No media file exists, so any decode attempt would fail.
		expect(await analyzeShots(store, asset)).toEqual(index);

		putAnalysis(store, asset.id, { status: "failed" });
		await expect(analyzeShots(store, asset)).rejects.toThrow(
			"Complete source analysis before indexing shots."
		);
		await expect(
			analyzeShots(store, { ...asset, kind: "image" })
		).rejects.toThrow("Visual shot search indexes video sources only.");
	});
});

describe("searchStoredShots", () => {
	test("searches only current indexes and attaches asset names", async () => {
		const store = await makeStore();
		const fresh = addVideo(store, "Fresh clip");
		const stale = addVideo(store, "Stale clip");
		putAnalysis(store, fresh.id);
		putAnalysis(store, stale.id, { createdAt: REANALYZED_AT });
		await writeShots(store, fresh);
		await writeShots(store, stale); // built from the older analysis

		expect(currentShotIndexes(store).map((index) => index.assetId)).toEqual([
			fresh.id,
		]);
		const found = searchStoredShots(store, "dark blue");
		expect(found.query).toBe("dark blue");
		expect(found.results).toHaveLength(1);
		expect(found.results[0]).toMatchObject({
			assetId: fresh.id,
			assetName: "Fresh clip",
			end: 5,
			start: 0,
		});

		const excluded = searchStoredShots(store, "not dark");
		expect(excluded.results.map((match) => match.start)).toEqual([5]);

		const other = addVideo(store, "Other");
		expect(
			searchStoredShots(store, "dark", { assetId: other.id }).results
		).toEqual([]);
	});
});

describe("shot Spaces projection", () => {
	const space = { rebuild: false, spaceId: "space-1", spaceName: "Shots" };

	test("prunes an obsolete document and persists the new revision", async () => {
		const store = await makeStore();
		const asset = addVideo(store, "Beach");
		putAnalysis(store, asset.id);
		await writeShots(store, asset);

		const begun = beginShotIndexing(store, asset, space);
		expect(begun.revision).toBe(0);
		const key = begun.entries[0]?.key ?? "";
		const linked = updateShotIndexEntry(store, asset, {
			docId: "doc-1",
			key,
			ready: true,
			revision: 0,
		});
		const rebuilt = beginShotIndexing(store, asset, {
			...space,
			rebuild: true,
		});
		expect(rebuilt.revision).toBe(linked.revision + 1);
		expect(rebuilt.obsolete.map((entry) => entry.docId)).toEqual(["doc-1"]);

		expect(() =>
			pruneShotIndexEntry(store, asset, {
				docId: "doc-1",
				revision: rebuilt.revision - 1,
			})
		).toThrow(ConflictError);
		expect(readShotSearchIndex(store, asset.id)?.obsolete).toHaveLength(1);

		const pruned = pruneShotIndexEntry(store, asset, {
			docId: "doc-1",
			revision: rebuilt.revision,
		});
		expect(pruned.obsolete).toEqual([]);
		expect(readShotSearchIndex(store, asset.id)).toEqual(pruned);
	});

	test("refuses to prune without a stored projection", async () => {
		const store = await makeStore();
		const asset = addVideo(store, "Beach");
		expect(() =>
			pruneShotIndexEntry(store, asset, { docId: "doc-1", revision: 0 })
		).toThrow(ConflictError);
	});

	test("reports a projection stale once its shots are superseded", async () => {
		const store = await makeStore();
		const asset = addVideo(store, "Beach");
		putAnalysis(store, asset.id);
		await writeShots(store, asset);
		beginShotIndexing(store, asset, space);
		expect(shotSearchIndexes(store).map((index) => index.current)).toEqual([
			true,
		]);

		await writeShots(store, asset, { revision: 1 });
		expect(shotSearchIndexes(store).map((index) => index.current)).toEqual([
			false,
		]);

		putAnalysis(store, asset.id, { createdAt: REANALYZED_AT });
		expect(() => beginShotIndexing(store, asset, space)).toThrow(
			"Analyze shots for the current source analysis first."
		);
	});
});
