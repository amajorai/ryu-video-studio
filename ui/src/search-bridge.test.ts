import { expect, test } from "bun:test";
import {
	beginShotSearchIndex,
	type SearchIndex,
	transcriptDocuments,
	updateShotSearchEntry,
	verifiedSearchDocument,
} from "../../shared/search-index.ts";
import type { ShotIndex } from "../../shared/shot-index.ts";
import { transcriptSchema } from "../../shared/transcript.ts";
import type { StudioSpaces } from "./bridge.ts";
import {
	ASSET_DRAG_MIME,
	readAssetDrag,
	type StudioSearchServices,
	searchFootage,
	writeAssetDrag,
} from "./search-bridge.ts";

function fixture() {
	const asset = {
		id: crypto.randomUUID(),
		name: "Film",
		kind: "video" as const,
		duration: 60,
		width: 640,
		height: 360,
		hasAudio: true,
		createdAt: new Date().toISOString(),
	};
	const transcript = transcriptSchema.parse({
		assetId: asset.id,
		revision: 3,
		status: "completed",
		nextOffset: 60,
		duration: 60,
		updatedAt: new Date().toISOString(),
		cues: [
			{
				id: crypto.randomUUID(),
				start: 1,
				end: 5,
				text: "Edit a film and export the story.",
			},
			{ id: crypto.randomUUID(), start: 40, end: 45, text: "Mix the sound." },
		],
	});
	const entries = transcriptDocuments(asset, transcript).map(
		(entry, index) => ({ ...entry, docId: `doc-${index}`, ready: true })
	);
	const index: SearchIndex = {
		assetId: asset.id,
		spaceId: "space",
		spaceName: "My source index",
		transcriptRevision: 3,
		revision: 1,
		entries,
		obsolete: [],
		updatedAt: new Date().toISOString(),
	};
	return { asset, transcript, index };
}
test("source index groups preserve bounded source ranges and reject altered documents", () => {
	const { index } = fixture();
	expect(index.entries).toHaveLength(2);
	expect(
		verifiedSearchDocument(index, "doc-0", index.entries[0]!.source)?.start
	).toBe(1);
	expect(
		verifiedSearchDocument(
			index,
			"doc-0",
			index.entries[0]!.source.replace("Edit", "Overwrite")
		)
	).toBeNull();
	expect(
		verifiedSearchDocument(index, "foreign", index.entries[0]!.source)
	).toBeNull();
});
test("semantic results require current mappings and app-owned Core documents", async () => {
	const { index } = fixture();
	const reads: string[] = [];
	const spaces: StudioSpaces = {
		ensureSpace: async () => "space",
		createDoc: async () => "unused",
		updateDoc: async () => {},
		deleteDoc: async () => {},
		getDoc: async ({ doc_id }) => {
			reads.push(doc_id);
			return {
				id: doc_id,
				title: "Indexed",
				source: index.entries[0]!.source,
				kind: "app:@ryu/video-studio",
			};
		},
		search: async () => [
			{
				document_id: "foreign",
				chunk_id: "a",
				distance: 0.1,
				content: "untrusted asset ID",
			},
			{
				document_id: "doc-0",
				chunk_id: "b",
				distance: 0.2,
				content: "Search excerpt",
			},
		],
	};
	const found = await searchFootage(
		spaces,
		[{ ...index, current: true }],
		"space",
		"post production"
	);
	expect(found).toHaveLength(1);
	expect(found[0]?.assetId).toBe(index.assetId);
	expect(reads).toEqual(["doc-0"]);
	expect(
		await searchFootage(
			spaces,
			[{ ...index, current: false }],
			"space",
			"post production"
		)
	).toEqual([]);
	spaces.getDoc = async ({ doc_id }) => ({
		id: doc_id,
		title: "Other app",
		source: index.entries[0]!.source,
		kind: "app:other",
	});
	expect(
		await searchFootage(
			spaces,
			[{ ...index, current: true }],
			"space",
			"post production"
		)
	).toEqual([]);
});
test("Core search denial is not replaced with local cached results", async () => {
	const { index } = fixture();
	const spaces: StudioSearchServices = {
		search: async () => {
			throw new Error("Space access denied");
		},
		getDoc: async () => {
			throw new Error("Search denial must stop document reads");
		},
	};
	await expect(
		searchFootage(spaces, [{ ...index, current: true }], "space", "film")
	).rejects.toThrow("Space access denied");
});

test("shot documents surface as visual matches with their labels", async () => {
	const { asset } = fixture();
	const shots: ShotIndex = {
		format: "ryu.video-studio.shots.v1",
		assetId: asset.id,
		analysisCreatedAt: new Date().toISOString(),
		revision: 4,
		sampleRate: 4,
		shots: [
			{
				start: 2,
				end: 6,
				brightness: 0.2,
				saturation: 0.6,
				motion: 0.07,
				edgeDensity: 0.3,
				colors: [{ hex: "#1020c0", name: "blue", weight: 0.9 }],
				labels: ["dark", "vivid", "wide", "motion", "blue"],
			},
		],
		updatedAt: new Date().toISOString(),
	};
	let index = beginShotSearchIndex(null, asset, shots, {
		rebuild: false,
		spaceId: "space",
		spaceName: "Footage",
	});
	index = updateShotSearchEntry(index, {
		docId: "shot-doc",
		key: index.entries[0]?.key ?? "",
		ready: true,
		revision: index.revision,
	});
	const source = index.entries[0]?.source ?? "";
	const spaces: StudioSearchServices = {
		getDoc: async ({ doc_id }) => ({
			id: doc_id,
			title: "Shot",
			source,
			kind: "app:@ryu/video-studio",
		}),
		search: async () => [
			{ document_id: "shot-doc", chunk_id: "a", distance: 0.3, content: "x" },
		],
	};
	const found = await searchFootage(spaces, [], "space", "dark blue", [
		{ ...index, current: true },
	]);
	expect(found).toEqual([
		expect.objectContaining({
			assetId: asset.id,
			kind: "shot",
			start: 2,
			end: 6,
			labels: ["dark", "vivid", "wide", "motion", "blue"],
		}),
	]);
	expect(
		await searchFootage(spaces, [], "space", "dark blue", [
			{ ...index, current: false },
		])
	).toEqual([]);
});

test("source range drag payload round-trips and rejects malformed data", () => {
	const data = new Map<string, string>();
	const transfer = {
		effectAllowed: "none" as DataTransfer["effectAllowed"],
		setData: (type: string, value: string) => {
			data.set(type, value);
		},
		getData: (type: string) => data.get(type) ?? "",
	};
	const assetId = crypto.randomUUID();
	writeAssetDrag(transfer, { assetId, sourceIn: 2, sourceOut: 6 });
	expect(transfer.effectAllowed).toBe("copy");
	expect(data.get("text/plain")).toBe("2.00–6.00s");
	expect(readAssetDrag(transfer)).toEqual({
		assetId,
		sourceIn: 2,
		sourceOut: 6,
	});
	data.set(
		ASSET_DRAG_MIME,
		JSON.stringify({ assetId, sourceIn: 6, sourceOut: 2 })
	);
	expect(readAssetDrag(transfer)).toBeNull();
	data.set(ASSET_DRAG_MIME, "{not json");
	expect(readAssetDrag(transfer)).toBeNull();
	expect(readAssetDrag({ getData: () => "" })).toBeNull();
	expect(ASSET_DRAG_MIME).toBe("application/x-ryu-asset");
	// A whole-asset drag (the library tile contract) carries no range.
	data.set(ASSET_DRAG_MIME, JSON.stringify({ assetId }));
	expect(readAssetDrag(transfer)).toEqual({ assetId });
	data.set(ASSET_DRAG_MIME, JSON.stringify({ assetId, sourceIn: 1 }));
	expect(readAssetDrag(transfer)).toBeNull();
	expect(() =>
		writeAssetDrag(transfer, {
			assetId: "nope",
			sourceIn: 0,
			sourceOut: 1,
		})
	).toThrow();
});
