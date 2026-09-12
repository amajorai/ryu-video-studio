import { z } from "zod";
import type { Asset } from "./project.ts";
import { type SearchIndex, verifiedSearchDocument } from "./search-index.ts";

export const mediaSearchRequestSchema = z
	.object({
		assetId: z.uuid().optional(),
		limit: z.coerce.number().int().min(1).max(50).default(10),
		q: z.string().trim().min(1).max(200),
	})
	.strict();

export const mediaSearchResultSchema = z
	.object({
		assetId: z.uuid(),
		assetName: z.string().min(1),
		docId: z.string().min(1),
		score: z.number().finite().min(0),
		start: z.number().min(0).max(7200),
		end: z.number().min(0).max(7200),
		text: z.string().min(1),
	})
	.strict();

export type MediaSearchResult = z.infer<typeof mediaSearchResultSchema>;

/** Search current app-owned transcript documents by normalized spoken text. */
export function searchMedia(
	indexes: readonly (SearchIndex & { current: boolean })[],
	assets: readonly Asset[],
	input: unknown
): { query: string; results: MediaSearchResult[] } {
	const request = mediaSearchRequestSchema.parse(input);
	const query = request.q.toLocaleLowerCase();
	const terms = query.split(/\s+/u).filter(Boolean);
	const names = new Map(assets.map((asset) => [asset.id, asset.name]));
	const results: MediaSearchResult[] = [];
	for (const index of indexes) {
		if (
			!index.current ||
			(request.assetId && request.assetId !== index.assetId)
		) {
			continue;
		}
		for (const entry of index.entries) {
			if (!(entry.ready && entry.docId)) {
				continue;
			}
			const document = verifiedSearchDocument(index, entry.docId, entry.source);
			if (!document) {
				continue;
			}
			const text = document.text.toLocaleLowerCase();
			if (!terms.every((term) => text.includes(term))) {
				continue;
			}
			const score = terms.reduce(
				(total, term) => total + (text.split(term).length - 1),
				0
			);
			results.push(
				mediaSearchResultSchema.parse({
					assetId: document.assetId,
					assetName: names.get(document.assetId) ?? "Missing media",
					docId: entry.docId,
					score,
					start: document.start,
					end: document.end,
					text: document.text,
				})
			);
		}
	}
	return {
		query: request.q,
		results: results
			.sort((a, b) => b.score - a.score || a.start - b.start)
			.slice(0, request.limit),
	};
}
