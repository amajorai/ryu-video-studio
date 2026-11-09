/**
 * Online font catalog: search Fontsource and import one of its open-licensed
 * fonts into the node's font library.
 *
 * Only two HTTPS hosts are contacted: `api.fontsource.org` for the catalog and
 * a font's metadata (including its SPDX license id), and `cdn.jsdelivr.net`
 * for the `.ttf` file. A redirect to any other host is refused. Only fonts
 * licensed OFL-1.1, Apache-2.0 or UFL-1.0 are imported; the downloaded file
 * is validated by `readFontFile` like any imported font, and its source and
 * license are kept on the font record for the credits report.
 *
 * Fontsource serves fonts split by Unicode subset, weight and style. One
 * import takes one file: the font's default subset (or the chosen one) at the
 * chosen weight and style.
 */
import { z } from "zod";
import { MAX_FONT_BYTES } from "../../shared/font-file.ts";
import {
	type FontOrigin,
	type ImportedFont,
	OPEN_FONT_LICENSES,
	type OpenFontLicense,
	openFontLicenseSchema,
} from "../../shared/schema/font.ts";
import type { FontLibrary } from "./font-library.ts";

export const FONTSOURCE_API_HOST = "api.fontsource.org";
export const FONTSOURCE_FILE_HOST = "cdn.jsdelivr.net";
const CATALOG_URL = `https://${FONTSOURCE_API_HOST}/v1/fonts`;
/** How long the catalog listing is reused before it is fetched again. */
const CATALOG_TTL_MS = 30 * 60 * 1000;
/** Largest catalog listing accepted (the full listing is about 0.6 MB). */
const MAX_CATALOG_BYTES = 8 * 1024 * 1024;
/** Most results one search returns. */
export const MAX_FONT_CATALOG_RESULTS = 40;

const LICENSE_URLS: Readonly<Record<OpenFontLicense, string>> = {
	"Apache-2.0": "https://spdx.org/licenses/Apache-2.0.html",
	"OFL-1.1": "https://spdx.org/licenses/OFL-1.1.html",
	"UFL-1.0": "https://spdx.org/licenses/UFL-1.0.html",
};

const fontIdSchema = z
	.string()
	.trim()
	.min(1)
	.max(100)
	.regex(/^[a-z0-9][a-z0-9-]*$/);
const subsetSchema = z
	.string()
	.min(1)
	.max(40)
	.regex(/^[a-z0-9[\]-]+$/);
const styleSchema = z.enum(["normal", "italic"]);

const catalogEntrySchema = z.object({
	category: z.string().max(40).optional().catch(undefined),
	defSubset: subsetSchema.optional().catch(undefined),
	family: z.string().min(1).max(120),
	id: fontIdSchema,
	license: z.string().max(80).optional().catch(undefined),
	styles: z.array(z.string().max(20)).max(10).optional().catch(undefined),
	subsets: z.array(z.string().max(40)).max(400).optional().catch(undefined),
	weights: z.array(z.number().int()).max(20).optional().catch(undefined),
});
type CatalogEntry = z.infer<typeof catalogEntrySchema>;

const fontDetailSchema = catalogEntrySchema.extend({
	source: z.string().max(300).optional().catch(undefined),
	variants: z.record(
		z.string(),
		z.record(
			z.string(),
			z.record(
				z.string(),
				z.object({
					url: z.object({ ttf: z.string().max(400).optional() }).loose(),
				})
			)
		)
	),
});

/** One catalog search result, as the editor lists it. */
export const fontCatalogResultSchema = z
	.object({
		category: z.string().optional(),
		defaultSubset: z.string(),
		family: z.string(),
		id: z.string(),
		/** The SPDX id; only open licenses are listed. */
		license: openFontLicenseSchema,
		styles: z.array(styleSchema),
		subsets: z.array(z.string()),
		weights: z.array(z.number().int()),
	})
	.strict();
export type FontCatalogResult = z.infer<typeof fontCatalogResultSchema>;

export const fontCatalogImportSchema = z
	.object({
		id: fontIdSchema,
		style: styleSchema.default("normal"),
		subset: subsetSchema.optional(),
		weight: z.number().int().min(100).max(1000).default(400),
	})
	.strict();
export type FontCatalogImport = z.infer<typeof fontCatalogImportSchema>;

/** Thrown when a font's license is not one Video Studio may import. */
export class FontLicenseError extends Error {
	constructor(license: string | undefined) {
		super(
			`This font's license (${license ?? "unknown"}) is not one Video Studio imports. Only ${OPEN_FONT_LICENSES.join(", ")} fonts can be added.`
		);
		this.name = "FontLicenseError";
	}
}

export type FetchLike = (
	input: string,
	init?: RequestInit
) => Promise<Response>;

let catalogCache: { at: number; entries: CatalogEntry[] } | null = null;

/** Forget the cached catalog listing (tests). */
export function clearFontCatalogCache(): void {
	catalogCache = null;
}

/** An `https:` URL on exactly `host`, or null. */
export function allowedFontUrl(value: string, host: string): URL | null {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return null;
	}
	if (
		url.protocol !== "https:" ||
		url.hostname.toLowerCase() !== host ||
		url.port !== "" ||
		url.username !== "" ||
		url.password !== ""
	) {
		return null;
	}
	return url;
}

/** Read a response body, refusing more than `limit` bytes. */
async function boundedBody(response: Response, limit: number) {
	const declared = Number(response.headers.get("content-length") ?? "");
	if (Number.isFinite(declared) && declared > limit) {
		throw new Error("The font file is larger than the import limit.");
	}
	const reader = response.body?.getReader();
	if (!reader) {
		return new Uint8Array();
	}
	const parts: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) {
			break;
		}
		total += value.byteLength;
		if (total > limit) {
			await reader.cancel();
			throw new Error("The font file is larger than the import limit.");
		}
		parts.push(value);
	}
	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const part of parts) {
		bytes.set(part, offset);
		offset += part.byteLength;
	}
	return bytes;
}

/**
 * GET an allowlisted HTTPS URL without following redirects (a redirect is
 * refused rather than followed to another host).
 */
async function fetchAllowed(
	fetcher: FetchLike,
	value: string,
	host: string,
	accept: string,
	signal: AbortSignal | undefined
): Promise<Response> {
	const url = allowedFontUrl(value, host);
	if (!url) {
		throw new Error(`Font downloads are limited to https://${host}.`);
	}
	const response = await fetcher(url.toString(), {
		headers: { accept },
		redirect: "manual",
		signal: signal
			? AbortSignal.any([signal, AbortSignal.timeout(30_000)])
			: AbortSignal.timeout(30_000),
	});
	if (response.status >= 300 && response.status < 400) {
		throw new Error(
			`${host} redirected the font request; it was not followed.`
		);
	}
	if (!response.ok) {
		throw new Error(`${host} returned HTTP ${response.status}.`);
	}
	return response;
}

async function fetchJson<T>(
	fetcher: FetchLike,
	url: string,
	schema: z.ZodType<T>,
	signal?: AbortSignal
): Promise<T> {
	const response = await fetchAllowed(
		fetcher,
		url,
		FONTSOURCE_API_HOST,
		"application/json",
		signal
	);
	const body = await boundedBody(response, MAX_CATALOG_BYTES);
	return schema.parse(JSON.parse(new TextDecoder().decode(body)));
}

function openLicense(license: string | undefined): OpenFontLicense | null {
	const parsed = openFontLicenseSchema.safeParse(license);
	return parsed.success ? parsed.data : null;
}

async function catalogEntries(
	fetcher: FetchLike,
	signal?: AbortSignal
): Promise<CatalogEntry[]> {
	if (catalogCache && Date.now() - catalogCache.at < CATALOG_TTL_MS) {
		return catalogCache.entries;
	}
	const raw = await fetchJson(
		fetcher,
		CATALOG_URL,
		z.array(z.unknown()).max(20_000),
		signal
	);
	const entries = raw.flatMap((item) => {
		const parsed = catalogEntrySchema.safeParse(item);
		return parsed.success ? [parsed.data] : [];
	});
	catalogCache = { at: Date.now(), entries };
	return entries;
}

function resultFor(entry: CatalogEntry): FontCatalogResult | null {
	const license = openLicense(entry.license);
	if (!license) {
		return null;
	}
	const styles = (entry.styles ?? ["normal"]).filter(
		(style): style is "normal" | "italic" =>
			style === "normal" || style === "italic"
	);
	return {
		...(entry.category ? { category: entry.category } : {}),
		defaultSubset: entry.defSubset ?? entry.subsets?.[0] ?? "latin",
		family: entry.family,
		id: entry.id,
		license,
		styles: styles.length ? styles : ["normal"],
		subsets: entry.subsets ?? [],
		weights: entry.weights?.length ? entry.weights : [400],
	};
}

/**
 * Search the catalog by family name (case-insensitive substring; an empty
 * query lists the first families). Fonts without an accepted open license
 * are left out.
 */
export async function searchFontCatalog(
	query: string,
	options: { fetch?: FetchLike; signal?: AbortSignal } = {}
): Promise<FontCatalogResult[]> {
	const needle = query.trim().toLowerCase();
	const entries = await catalogEntries(options.fetch ?? fetch, options.signal);
	const results: FontCatalogResult[] = [];
	const ranked = needle
		? entries
				.filter((entry) => entry.family.toLowerCase().includes(needle))
				.sort(
					(left, right) =>
						Number(!left.family.toLowerCase().startsWith(needle)) -
							Number(!right.family.toLowerCase().startsWith(needle)) ||
						left.family.localeCompare(right.family)
				)
		: entries;
	for (const entry of ranked) {
		const result = resultFor(entry);
		if (result) {
			results.push(result);
		}
		if (results.length >= MAX_FONT_CATALOG_RESULTS) {
			break;
		}
	}
	return results;
}

/**
 * Download one Fontsource font file and add it to `library`, with its source
 * and license recorded. Refuses a font whose license is not open, a variant
 * the font does not have, a file URL off the allowlisted CDN, and a file
 * `readFontFile` rejects.
 */
export async function importCatalogFont(
	library: FontLibrary,
	input: FontCatalogImport,
	options: { fetch?: FetchLike; signal?: AbortSignal } = {}
): Promise<ImportedFont> {
	const fetcher = options.fetch ?? fetch;
	const detail = await fetchJson(
		fetcher,
		`${CATALOG_URL}/${encodeURIComponent(input.id)}`,
		fontDetailSchema,
		options.signal
	);
	if (detail.id !== input.id) {
		throw new Error("Fontsource answered with a different font.");
	}
	const license = openLicense(detail.license);
	if (!license) {
		throw new FontLicenseError(detail.license);
	}
	const subset = input.subset ?? detail.defSubset ?? "latin";
	const fileUrl =
		detail.variants[String(input.weight)]?.[input.style]?.[subset]?.url.ttf;
	if (!fileUrl) {
		throw new Error(
			`${detail.family} has no ${input.style} ${input.weight} weight in the ${subset} subset.`
		);
	}
	if (!allowedFontUrl(fileUrl, FONTSOURCE_FILE_HOST)) {
		throw new Error(
			`Font downloads are limited to https://${FONTSOURCE_FILE_HOST}.`
		);
	}
	const response = await fetchAllowed(
		fetcher,
		fileUrl,
		FONTSOURCE_FILE_HOST,
		"font/ttf, application/octet-stream",
		options.signal
	);
	const bytes = await boundedBody(response, MAX_FONT_BYTES);
	const origin: FontOrigin = {
		attribution: `${detail.family} by its designers, from Fontsource${detail.source ? ` (${detail.source.slice(0, 200)})` : ""}`,
		identifier: `${detail.id}:${subset}-${input.weight}-${input.style}`,
		license,
		licenseUrl: LICENSE_URLS[license],
		pageUrl: `https://fontsource.org/fonts/${detail.id}`,
		provider: "fontsource",
	};
	const name = `${detail.family} ${input.weight}${input.style === "italic" ? " italic" : ""}`;
	// `add` validates the file with `readFontFile` before storing it.
	return await library.add(name, bytes, origin);
}
