import { z } from "zod";
import {
	type IndexEntry,
	type SearchIndex,
	type ShotSearchIndex,
	searchIndexSchema,
	shotSearchIndexSchema,
	verifiedSearchDocument,
	verifiedShotDocument,
} from "../../shared/search-index.ts";
import {
	type ShotIndex,
	shotColorSchema,
	shotIndexSchema,
} from "../../shared/shot-index.ts";
import { request, type StudioSpaces, studioResponseSchema } from "./bridge.ts";
import {
	assetDragPayloadSchema,
	ASSET_DRAG_MIME as LIBRARY_ASSET_DRAG_MIME,
} from "./library/drag-source.ts";

const ownedKind = "app:@ryu/video-studio";
export interface IndexedSource extends SearchIndex {
	current: boolean;
}
export interface IndexedShots extends ShotSearchIndex {
	current: boolean;
}
const indexedSourceSchema = searchIndexSchema.extend({
	current: z.boolean().default(false).catch(false),
});
const indexedShotsSchema = shotSearchIndexSchema.extend({
	current: z.boolean().default(false).catch(false),
});
export async function readSearchIndexes(): Promise<IndexedSource[]> {
	return z
		.object({ indexes: z.array(indexedSourceSchema) })
		.parse(await request(studioResponseSchema, "/search-indexes")).indexes;
}
export async function readShotIndexes(): Promise<IndexedShots[]> {
	return z
		.object({ indexes: z.array(indexedShotsSchema) })
		.parse(await request(studioResponseSchema, "/shot-indexes")).indexes;
}

/** The parts of a Spaces projection that the sync loop reads. */
interface Projection {
	entries: IndexEntry[];
	obsolete: IndexEntry[];
	revision: number;
}
interface ProjectionRoutes<Index extends Projection> {
	/** Status line prefix, e.g. "Indexing transcript". */
	label: string;
	prunePath: string;
	schema: z.ZodType<Index>;
	updatePath: string;
}

/**
 * Bring a Space in line with a sidecar projection: delete obsolete app-owned
 * documents, create a document per pending entry and write its body, and
 * record each step under the projection's revision. Documents edited outside
 * Video Studio are never overwritten.
 */
async function syncProjection<Index extends Projection>(
	spaces: StudioSpaces,
	spaceId: string,
	initial: Index,
	routes: ProjectionRoutes<Index>,
	onStatus: (text: string) => void
): Promise<Index> {
	let index = initial;
	for (const entry of index.obsolete) {
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
		index = routes.schema.parse(
			await request(studioResponseSchema, routes.prunePath, "POST", {
				revision: index.revision,
				docId: entry.docId,
			})
		);
	}
	for (const [position, entry] of index.entries.entries()) {
		let docId = entry.docId;
		if (!docId) {
			docId = await spaces.createDoc({ space_id: spaceId, title: entry.title });
			index = routes.schema.parse(
				await request(studioResponseSchema, routes.updatePath, "PUT", {
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
		index = routes.schema.parse(
			await request(studioResponseSchema, routes.updatePath, "PUT", {
				revision: index.revision,
				key: entry.key,
				docId,
				ready: true,
			})
		);
		onStatus(`${routes.label} · ${position + 1} of ${index.entries.length}`);
	}
	return index;
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
	const index = searchIndexSchema.parse(
		await request(studioResponseSchema, `/assets/${assetId}/index`, "POST", {
			spaceId,
			spaceName,
			rebuild,
		})
	);
	return await syncProjection(
		spaces,
		spaceId,
		index,
		{
			label: "Indexing transcript",
			prunePath: `/assets/${assetId}/prune-index`,
			schema: searchIndexSchema,
			updatePath: `/assets/${assetId}/index`,
		},
		onStatus
	);
}

/** Measure (or reuse) a video's per-shot colors, motion and labels. */
export async function analyzeShots(
	assetId: string,
	refresh = false
): Promise<ShotIndex> {
	return shotIndexSchema.parse(
		await request(studioResponseSchema, `/assets/${assetId}/shots`, "POST", {
			refresh,
		})
	);
}

/** Project a video's current shot index into a Space, one document per shot. */
export async function indexShots(
	spaces: StudioSpaces,
	assetId: string,
	spaceName: string,
	rebuild: boolean,
	onStatus: (text: string) => void
): Promise<ShotSearchIndex> {
	const spaceId = await spaces.ensureSpace({
		name: spaceName,
		description: "Video Studio source transcript index",
	});
	const index = shotSearchIndexSchema.parse(
		await request(
			studioResponseSchema,
			`/assets/${assetId}/shots/index`,
			"POST",
			{ spaceId, spaceName, rebuild }
		)
	);
	return await syncProjection(
		spaces,
		spaceId,
		index,
		{
			label: "Indexing shots",
			prunePath: `/assets/${assetId}/shots/prune-index`,
			schema: shotSearchIndexSchema,
			updatePath: `/assets/${assetId}/shots/index`,
		},
		onStatus
	);
}

const shotSearchResponseSchema = z.object({
	query: z.string(),
	labels: z.array(z.string()),
	/** Negated labels ("not dark"); absent from older sidecars. */
	excluded: z.array(z.string()).optional(),
	ignored: z.array(z.string()),
	/** Words matched against vision captions and tags; absent from older sidecars. */
	textTerms: z.array(z.string()).optional(),
	results: z.array(
		z.object({
			assetId: z.string(),
			assetName: z.string(),
			caption: z.string().optional(),
			colors: z.array(shotColorSchema),
			end: z.number(),
			labels: z.array(z.string()),
			score: z.number(),
			start: z.number(),
			tags: z.array(z.string()).optional(),
			textMatches: z.array(z.string()).optional(),
		})
	),
});
export type ShotSearchResponse = z.infer<typeof shotSearchResponseSchema>;

/** Label search over analyzed shots; works without Spaces access. */
export async function searchShotsLocally(
	query: string,
	assetId?: string
): Promise<ShotSearchResponse> {
	const params = new URLSearchParams({ q: query });
	if (assetId) {
		params.set("assetId", assetId);
	}
	return shotSearchResponseSchema.parse(
		await request(studioResponseSchema, `/shot-search?${params.toString()}`)
	);
}

export interface FootageMatch {
	assetId: string;
	distance: number;
	docId: string;
	end: number;
	kind: "shot" | "transcript";
	/** Visual labels of a shot match; empty for transcript matches. */
	labels: string[];
	start: number;
	text: string;
}
export type StudioSearchServices = Pick<StudioSpaces, "search" | "getDoc">;
export async function searchFootage(
	spaces: StudioSearchServices,
	indexes: IndexedSource[],
	spaceId: string,
	query: string,
	shotIndexes: readonly IndexedShots[] = []
): Promise<FootageMatch[]> {
	const ready = <
		Index extends { current: boolean; entries: IndexEntry[]; spaceId: string },
	>(
		index: Index
	) =>
		index.current &&
		index.spaceId === spaceId &&
		index.entries.every((entry) => entry.ready);
	const active = indexes.filter(ready);
	const activeShots = shotIndexes.filter(ready);
	const hits = await spaces.search({ space_id: spaceId, query, limit: 30 });
	const results: FootageMatch[] = [];
	const seen = new Set<string>();
	const owns = (index: { entries: IndexEntry[] }, docId: string) =>
		index.entries.some((entry) => entry.docId === docId);
	for (const hit of hits) {
		const { distance } = hit;
		if (
			seen.has(hit.document_id) ||
			distance === null ||
			!Number.isFinite(distance)
		) {
			continue;
		}
		const index = active.find((item) => owns(item, hit.document_id));
		const shots = index
			? undefined
			: activeShots.find((item) => owns(item, hit.document_id));
		if (!(index || shots)) {
			continue;
		}
		const doc = await spaces.getDoc({ doc_id: hit.document_id });
		if (!doc || doc.kind !== ownedKind) {
			continue;
		}
		if (index) {
			const result = verifiedSearchDocument(index, doc.id, doc.source);
			if (result) {
				seen.add(doc.id);
				results.push({
					assetId: result.assetId,
					distance,
					docId: doc.id,
					end: result.end,
					kind: "transcript",
					labels: [],
					start: result.start,
					text: result.text,
				});
			}
		} else if (shots) {
			const result = verifiedShotDocument(shots, doc.id, doc.source);
			if (result) {
				seen.add(doc.id);
				results.push({
					assetId: result.assetId,
					distance,
					docId: doc.id,
					end: result.end,
					kind: "shot",
					labels: result.labels,
					start: result.start,
					text: result.text,
				});
			}
		}
	}
	return results;
}

/**
 * Library asset drag payload (the W1-T6 contract): `application/x-ryu-asset`
 * carrying the asset id and, for a marked or searched range, its source
 * in/out seconds. Search results write it so the timeline drop target treats
 * them exactly like a library tile drag. The MIME type and schema are owned by
 * `library/drag-source.ts` (which `timeline/useTimelineDrop.ts` reads), so both
 * drag sources stay identical.
 */
export const ASSET_DRAG_MIME = LIBRARY_ASSET_DRAG_MIME;
export const assetDragSchema = assetDragPayloadSchema;
export type AssetDrag = z.infer<typeof assetDragSchema>;

export function writeAssetDrag(
	transfer: Pick<DataTransfer, "effectAllowed" | "setData">,
	drag: AssetDrag
): void {
	const payload = assetDragSchema.parse(drag);
	transfer.effectAllowed = "copy";
	transfer.setData(ASSET_DRAG_MIME, JSON.stringify(payload));
	if (payload.sourceIn !== undefined && payload.sourceOut !== undefined) {
		transfer.setData(
			"text/plain",
			`${payload.sourceIn.toFixed(2)}–${payload.sourceOut.toFixed(2)}s`
		);
	}
}

export function readAssetDrag(
	transfer: Pick<DataTransfer, "getData">
): AssetDrag | null {
	const raw = transfer.getData(ASSET_DRAG_MIME);
	if (!raw) {
		return null;
	}
	try {
		const parsed = assetDragSchema.safeParse(JSON.parse(raw));
		return parsed.success ? parsed.data : null;
	} catch {
		return null;
	}
}
