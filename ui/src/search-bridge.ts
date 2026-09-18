import {
	type SearchDocument,
	type SearchIndex,
	searchIndexSchema,
	verifiedSearchDocument,
} from "../../shared/search-index.ts";
import { request, type StudioSpaces } from "./bridge.ts";

const ownedKind = "app:@ryu/video-studio";
export interface IndexedSource extends SearchIndex {
	current: boolean;
}
export async function readSearchIndexes(): Promise<IndexedSource[]> {
	const result = await request<{ indexes: unknown[] }>("/search-indexes");
	return result.indexes.map((value) => {
		const { current, ...record } = value as Record<string, unknown>;
		return { ...searchIndexSchema.parse(record), current: current === true };
	});
}
export async function indexSource(
	spaces: StudioSpaces,
	assetId: string,
	spaceName: string,
	rebuild: boolean,
	onStatus: (text: string) => void
): Promise<SearchIndex> {
	const spaceId = await spaces.ensureSpace({
		name: spaceName,
		description: "Video Studio source transcript index",
	});
	let index = searchIndexSchema.parse(
		await request(`/assets/${assetId}/index`, "POST", {
			spaceId,
			spaceName,
			rebuild,
		})
	);
	for (const entry of [...index.obsolete]) {
		if (!entry.docId) {
			continue;
		}
		const doc = await spaces.getDoc({ doc_id: entry.docId });
		if (
			doc?.kind === ownedKind &&
			(doc.source === entry.source || !(entry.ready || doc.source.trim())) &&
			doc.title === entry.title
		) {
			await spaces.deleteDoc({ doc_id: entry.docId });
		}
		index = searchIndexSchema.parse(
			await request(`/assets/${assetId}/prune-index`, "POST", {
				revision: index.revision,
				docId: entry.docId,
			})
		);
	}
	for (const [position, entry] of index.entries.entries()) {
		let docId = entry.docId;
		if (!docId) {
			docId = await spaces.createDoc({ space_id: spaceId, title: entry.title });
			index = searchIndexSchema.parse(
				await request(`/assets/${assetId}/index`, "PUT", {
					revision: index.revision,
					key: entry.key,
					docId,
					ready: false,
				})
			);
		}
		const doc = await spaces.getDoc({ doc_id: docId });
		if (!doc || doc.kind !== ownedKind) {
			throw new Error(
				"An index document is missing or unavailable. Rebuild the index to recover it."
			);
		}
		if (entry.ready) {
			if (doc.source !== entry.source || doc.title !== entry.title) {
				throw new Error(
					"An index document was edited outside Video Studio. Rebuild to preserve it and create a fresh projection."
				);
			}
			continue;
		}
		if (
			doc.title !== entry.title ||
			(doc.source.trim() && doc.source !== entry.source)
		) {
			throw new Error(
				"The pending index document changed. Rebuild instead of overwriting it."
			);
		}
		await spaces.updateDoc({
			doc_id: docId,
			title: entry.title,
			source: entry.source,
		});
		index = searchIndexSchema.parse(
			await request(`/assets/${assetId}/index`, "PUT", {
				revision: index.revision,
				key: entry.key,
				docId,
				ready: true,
			})
		);
		onStatus(
			`Indexing transcript · ${position + 1} of ${index.entries.length}`
		);
	}
	return index;
}
export interface FootageMatch extends SearchDocument {
	distance: number;
	docId: string;
}
export async function searchFootage(
	spaces: StudioSpaces,
	indexes: IndexedSource[],
	spaceId: string,
	query: string
): Promise<FootageMatch[]> {
	const active = indexes.filter(
		(index) =>
			index.current &&
			index.spaceId === spaceId &&
			index.entries.every((entry) => entry.ready)
	);
	const hits = await spaces.search({ space_id: spaceId, query, limit: 30 });
	const results: FootageMatch[] = [];
	const seen = new Set<string>();
	for (const hit of hits) {
		if (seen.has(hit.document_id) || !Number.isFinite(hit.distance)) {
			continue;
		}
		const index = active.find((item) =>
			item.entries.some((entry) => entry.docId === hit.document_id)
		);
		if (!index) {
			continue;
		}
		const doc = await spaces.getDoc({ doc_id: hit.document_id });
		if (!doc || doc.kind !== ownedKind) {
			continue;
		}
		const result = verifiedSearchDocument(index, doc.id, doc.source);
		if (!result) {
			continue;
		}
		seen.add(doc.id);
		results.push({ ...result, docId: doc.id, distance: hit.distance });
	}
	return results;
}
