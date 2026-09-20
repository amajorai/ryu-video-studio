import { z } from "zod";

export const stockProviderSchema = z.enum([
	"archive.org",
	"coverr",
	"openverse.audio",
	"openverse.image",
	"unsplash.image",
	"wikimedia.commons",
	"nasa",
	"pexels",
	"pixabay",
]);
export type StockProvider = z.infer<typeof stockProviderSchema>;

export const stockSearchResultSchema = z
	.object({
		attribution: z.string().min(1).max(500),
		duration: z.number().finite().nonnegative().nullable(),
		format: z.string().min(1).max(80),
		identifier: z.string().min(1).max(200),
		provider: stockProviderSchema,
		rights: z.string().min(1).max(2000),
		sizeBytes: z.number().int().nonnegative().nullable(),
		sourceUrl: z.string().url(),
		title: z.string().min(1).max(500),
	})
	.strict();

export const stockSearchResponseSchema = z
	.object({
		provider: stockProviderSchema,
		results: z.array(stockSearchResultSchema).max(20),
	})
	.strict();

export type StockSearchResult = z.infer<typeof stockSearchResultSchema>;
