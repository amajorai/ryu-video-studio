import { expect, test } from "bun:test";
import {
	type SearchIndex,
	transcriptDocuments,
	verifiedSearchDocument,
} from "../../shared/search-index.ts";
import { transcriptSchema } from "../../shared/transcript.ts";
import type { StudioSpaces } from "./bridge.ts";
import { searchFootage } from "./search-bridge.ts";

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
	const spaces = {
		search: async () => {
			throw new Error("Space access denied");
		},
	} as Pick<StudioSpaces, "search">;
	await expect(
		searchFootage(
			spaces as StudioSpaces,
			[{ ...index, current: true }],
			"space",
			"film"
		)
	).rejects.toThrow("Space access denied");
});
