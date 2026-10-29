import { z } from "zod";
import type { Asset } from "../project.ts";
import catalogData from "./assets/catalog.json" with { type: "json" };

/** Where a bundled sticker's artwork comes from (see `LICENSES.md`). */
export const stickerSourceSchema = z.enum(["twemoji", "flag-icons", "ryu"]);
export type StickerSource = z.infer<typeof stickerSourceSchema>;

export const stickerCategorySchema = z.enum(["emoji", "flags", "shapes"]);
export type StickerCategory = z.infer<typeof stickerCategorySchema>;

export const stickerEntrySchema = z
	.object({
		/** Width over height of the artwork's view box. */
		aspect: z.number().finite().min(0.1).max(10),
		category: stickerCategorySchema,
		/** Path of the SVG under `assets/`. */
		file: z
			.string()
			.regex(
				/^(emoji|flags|shapes)\/[a-z0-9-]+\.svg$/,
				"Invalid sticker path."
			),
		id: z.string().regex(/^[a-z0-9-]+$/, "Invalid sticker id."),
		keywords: z.array(z.string().trim().min(1).max(60)).max(20),
		name: z.string().trim().min(1).max(120),
		source: stickerSourceSchema,
	})
	.strict();
export type StickerEntry = z.infer<typeof stickerEntrySchema>;

/** The bundled sticker set, in display order. */
export const STICKER_CATALOG: readonly StickerEntry[] = Object.freeze(
	z.array(stickerEntrySchema).max(2000).parse(catalogData)
);

export interface StickerSourceInfo {
	/** Credit line shown in the panel and recorded on imported assets. */
	attribution: string;
	label: string;
	licenseName: string;
	/** Omitted for Ryu's own artwork, which carries no third-party license. */
	licenseUrl?: string;
	pageUrl: string;
	rights: string;
}

/**
 * License and credit for each bundled set. Twemoji requires attribution
 * (CC-BY 4.0); flag-icons is MIT; the shapes are original to Ryu.
 */
export const STICKER_SOURCES: Readonly<
	Record<StickerSource, StickerSourceInfo>
> = {
	"flag-icons": {
		attribution:
			"Flag artwork from flag-icons by Panayiotis Lipiridis and contributors (MIT).",
		label: "flag-icons",
		licenseName: "MIT",
		licenseUrl: "https://github.com/lipis/flag-icons/blob/main/LICENSE",
		pageUrl: "https://github.com/lipis/flag-icons",
		rights:
			"MIT License. Copyright (c) 2013 Panayiotis Lipiridis. Bundled with Ryu Video Studio.",
	},
	ryu: {
		attribution: "Original geometric shape from Ryu Video Studio.",
		label: "Ryu shapes",
		licenseName: "Ryu Video Studio",
		pageUrl: "https://ryuhq.com",
		rights:
			"Original artwork bundled with Ryu Video Studio; free to use in your videos.",
	},
	twemoji: {
		attribution:
			"Twemoji graphics by Twitter, Inc and other contributors, licensed under CC-BY 4.0.",
		label: "Twemoji",
		licenseName: "CC-BY 4.0",
		licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
		pageUrl: "https://github.com/jdecked/twemoji",
		rights:
			"Creative Commons Attribution 4.0 International. Credit Twemoji when you publish a video that uses this sticker.",
	},
};

/** Every source in display order, for the panel's credits footer. */
export const STICKER_SOURCE_ORDER: readonly StickerSource[] = [
	"twemoji",
	"flag-icons",
	"ryu",
];

const tokenize = (value: string) =>
	value
		.toLowerCase()
		.replace(/[’']/g, "")
		.split(/[^a-z0-9]+/)
		.filter(Boolean);

/** Lower is better; `null` when `token` matches nothing on the entry. */
function tokenRank(entry: StickerEntry, token: string): number | null {
	const nameWords = tokenize(entry.name);
	if (nameWords.includes(token)) {
		return 0;
	}
	if (nameWords.some((word) => word.startsWith(token))) {
		return 1;
	}
	const keywordWords = entry.keywords.flatMap(tokenize);
	if (keywordWords.includes(token)) {
		return 2;
	}
	if (keywordWords.some((word) => word.startsWith(token))) {
		return 3;
	}
	return null;
}

export interface StickerSearchOptions {
	category?: StickerCategory | "all";
	/** Most results returned; defaults to every match. */
	limit?: number;
}

/**
 * Search by name or keyword. Every query word must match a name word or a
 * keyword (whole word or prefix); results rank whole-name matches first and
 * otherwise keep catalog order, so the output is deterministic.
 */
export function searchStickers(
	query: string,
	options: StickerSearchOptions = {},
	catalog: readonly StickerEntry[] = STICKER_CATALOG
): StickerEntry[] {
	const category = options.category ?? "all";
	const tokens = tokenize(query);
	const scored: { entry: StickerEntry; index: number; score: number }[] = [];
	for (const [index, entry] of catalog.entries()) {
		if (category !== "all" && entry.category !== category) {
			continue;
		}
		let score = 0;
		let matched = true;
		for (const token of tokens) {
			const rank = tokenRank(entry, token);
			if (rank === null) {
				matched = false;
				break;
			}
			score += rank;
		}
		if (!matched) {
			continue;
		}
		if (
			tokens.length > 0 &&
			tokenize(entry.name).join(" ") === tokens.join(" ")
		) {
			score = -1;
		}
		scored.push({ entry, index, score });
	}
	scored.sort((a, b) => a.score - b.score || a.index - b.index);
	const limit = options.limit ?? scored.length;
	return scored.slice(0, Math.max(0, limit)).map((item) => item.entry);
}

/** The catalog entry for an id, if bundled. */
export function stickerById(
	id: string,
	catalog: readonly StickerEntry[] = STICKER_CATALOG
): StickerEntry | undefined {
	return catalog.find((entry) => entry.id === id);
}

/** Library name of an imported sticker. */
export function stickerAssetName(entry: StickerEntry): string {
	return `Sticker · ${entry.name}`.slice(0, 200);
}

/** Longest edge, in pixels, of a rasterized sticker PNG. */
export const STICKER_RASTER_EDGE = 1024;

export interface RasterSize {
	height: number;
	width: number;
}

/**
 * Pixel size of a sticker whose artwork has `aspect` (width / height): the
 * longest edge is `edge` and the other keeps the aspect, at least 1 px.
 */
export function rasterSize(
	aspect: number,
	edge: number = STICKER_RASTER_EDGE
): RasterSize {
	const longest = Math.max(1, Math.round(edge));
	const ratio = Number.isFinite(aspect) && aspect > 0 ? aspect : 1;
	if (ratio >= 1) {
		return {
			height: Math.max(1, Math.round(longest / ratio)),
			width: longest,
		};
	}
	return { height: longest, width: Math.max(1, Math.round(longest * ratio)) };
}

/** Library folder imported stickers are filed under. */
export const STICKER_FOLDER = "Stickers";

export type StickerOrigin = NonNullable<Asset["origin"]>;

/** Asset provenance recorded for an imported sticker (feeds the credits). */
export function stickerOrigin(entry: StickerEntry): StickerOrigin {
	const source = STICKER_SOURCES[entry.source];
	const origin: StickerOrigin = {
		attribution: source.attribution,
		identifier: entry.id,
		pageUrl: source.pageUrl,
		provider: "bundled",
		rights: source.rights,
	};
	if (source.licenseUrl) {
		origin.licenseUrl = source.licenseUrl;
	}
	return origin;
}

/**
 * The attributed library asset already imported for a bundled sticker
 * (matched by its bundled origin), so placing the same sticker again reuses
 * it instead of uploading a duplicate (one credit entry per sticker).
 */
export function bundledStickerAsset<Item extends Asset>(
	assets: readonly Item[],
	entry: Pick<StickerEntry, "id">
): Item | undefined {
	return assets.find(
		(asset) =>
			asset.kind === "image" &&
			asset.derivation === "sticker" &&
			asset.origin?.provider === "bundled" &&
			asset.origin.identifier === entry.id
	);
}

export const STICKER_LIST_LIMIT = 500;

export const stickerListQuerySchema = z
	.object({
		category: z.union([stickerCategorySchema, z.literal("all")]).default("all"),
		limit: z.coerce.number().int().min(1).max(STICKER_LIST_LIMIT).default(50),
		query: z.string().trim().max(200).default(""),
	})
	.strict();
export type StickerListQuery = z.infer<typeof stickerListQuerySchema>;

/** One sticker as agents see it: catalog metadata plus its license credit. */
export interface StickerListing {
	aspect: number;
	attribution: string;
	category: StickerCategory;
	id: string;
	keywords: string[];
	licenseName: string;
	licenseUrl?: string;
	name: string;
	source: StickerSource;
}

export function stickerListing(entry: StickerEntry): StickerListing {
	const source = STICKER_SOURCES[entry.source];
	const listing: StickerListing = {
		aspect: entry.aspect,
		attribution: source.attribution,
		category: entry.category,
		id: entry.id,
		keywords: [...entry.keywords],
		licenseName: source.licenseName,
		name: entry.name,
		source: entry.source,
	};
	if (source.licenseUrl) {
		listing.licenseUrl = source.licenseUrl;
	}
	return listing;
}

/** Search results for `GET /stickers`: the matches and how many there were. */
export function listStickers(
	input: StickerListQuery,
	catalog: readonly StickerEntry[] = STICKER_CATALOG
): { stickers: StickerListing[]; total: number } {
	const matches = searchStickers(
		input.query,
		{ category: input.category },
		catalog
	);
	return {
		stickers: matches.slice(0, input.limit).map(stickerListing),
		total: matches.length,
	};
}
