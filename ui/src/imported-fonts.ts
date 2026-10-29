/**
 * Imported and system fonts in the Companion: the library list, importing a
 * .ttf/.otf file, registering a font with the browser (`FontFace`) so the
 * preview draws titles and captions with the same file the export renders
 * through libass, and the node's installed families for the system group.
 */
import { useCallback, useEffect, useState } from "react";
import { z } from "zod";
import {
	importedFontCssFamily,
	MAX_FONT_BYTES,
	MAX_INLINE_FONT_BYTES,
} from "../../shared/font-file.ts";
import {
	type CustomFont,
	type FontChoice,
	fontFamilyNameSchema,
	type ImportedFont,
	importedFontSchema,
	OPEN_FONT_LICENSES,
} from "../../shared/schema/font.ts";
import { mediaBlob, request, uploadChunks } from "./bridge.ts";
import { studioFormat } from "./i18n/format.ts";

const listSchema = z.object({ fonts: z.array(importedFontSchema) });
const systemListSchema = z.object({
	available: z.boolean(),
	fonts: z.array(z.string()),
});

/** File types the Import font picker accepts. */
export const FONT_FILE_ACCEPT = ".ttf,.otf,font/ttf,font/otf";

export async function listImportedFonts(): Promise<ImportedFont[]> {
	return (await request(listSchema, "/fonts")).fonts;
}

function base64(bytes: Uint8Array): string {
	let binary = "";
	for (let index = 0; index < bytes.length; index += 0x80_00) {
		binary += String.fromCharCode(...bytes.subarray(index, index + 0x80_00));
	}
	return btoa(binary);
}

/**
 * Import one font file; throws with the sidecar's reason when it is refused.
 * Files over 1.4 MB (CJK families run to 15–20 MB) go through the chunked
 * upload session, 512 KiB at a time.
 */
export async function importFontFile(
	file: File,
	progress: (value: number) => void = () => undefined
): Promise<ImportedFont> {
	if (file.size > MAX_FONT_BYTES) {
		throw new Error(
			studioFormat("{name} is larger than the {limit} MB font import limit.", {
				limit: MAX_FONT_BYTES / 1_000_000,
				name: file.name,
			})
		);
	}
	if (file.size <= MAX_INLINE_FONT_BYTES) {
		const bytes = new Uint8Array(await file.arrayBuffer());
		return await request(importedFontSchema, "/fonts", "POST", {
			data: base64(bytes),
			name: file.name,
		});
	}
	const uploadId = await uploadChunks(file, progress, "font");
	return await request(importedFontSchema, "/fonts", "POST", {
		name: file.name,
		uploadId,
	});
}

/** One font in the online catalog (Fontsource), as `GET /font-catalog` lists it. */
export const catalogFontSchema = z.object({
	category: z.string().optional(),
	defaultSubset: z.string(),
	family: z.string(),
	id: z.string(),
	license: z.enum(OPEN_FONT_LICENSES),
	styles: z.array(z.enum(["normal", "italic"])),
	subsets: z.array(z.string()),
	weights: z.array(z.number().int()),
});
export type CatalogFont = z.infer<typeof catalogFontSchema>;

/** Search the online catalog by family name. */
export async function searchCatalogFonts(
	query: string
): Promise<CatalogFont[]> {
	const result = await request(
		z.object({ fonts: z.array(catalogFontSchema) }),
		`/font-catalog?q=${encodeURIComponent(query.trim().slice(0, 80))}`
	);
	return result.fonts;
}

/** Add a catalog font (regular weight, upright, default subset when offered). */
export async function importCatalogFont(
	font: Pick<CatalogFont, "id" | "styles" | "weights">
): Promise<ImportedFont> {
	const weight = font.weights.includes(400) ? 400 : (font.weights[0] ?? 400);
	const style = font.styles.includes("normal") ? "normal" : "italic";
	return await request(importedFontSchema, "/font-catalog", "POST", {
		id: font.id,
		style,
		weight,
	});
}

const faces = new Map<string, Promise<boolean>>();

/**
 * Register an imported font with the document under
 * `importedFontCssFamily(id)`, once. Resolves false when the font is gone
 * or the browser cannot load it (the title then uses its fallback family).
 */
export function ensureImportedFontFace(id: string): Promise<boolean> {
	let pending = faces.get(id);
	if (!pending) {
		pending = (async () => {
			if (typeof FontFace === "undefined" || !document.fonts) {
				return false;
			}
			// Read in 512 KiB chunks so large (CJK) fonts stay within the
			// bridge's message size.
			const blob = await mediaBlob(
				`/fonts?id=${encodeURIComponent(id)}`,
				"font/ttf"
			);
			const bytes = new Uint8Array(await blob.arrayBuffer());
			const face = new FontFace(importedFontCssFamily(id), bytes);
			document.fonts.add(await face.load());
			return true;
		})().catch(() => {
			faces.delete(id);
			return false;
		});
		faces.set(id, pending);
	}
	return pending;
}

/**
 * The CSS font-family list for a title or caption: the imported face, else
 * the system family by name, then the bundled fallback.
 */
export function fontChoiceCss(
	choice: {
		customFont?: CustomFont | null | undefined;
		systemFont?: string | null | undefined;
	},
	fallback: string
): string {
	if (choice.customFont) {
		return `"${importedFontCssFamily(choice.customFont.id)}", ${fallback}`;
	}
	return choice.systemFont ? `"${choice.systemFont}", ${fallback}` : fallback;
}

/** The CSS font-family list for a title: the imported font, then its fallback. */
export function titleFontCss(
	customFont: CustomFont | null,
	fallback: string
): string {
	return fontChoiceCss({ customFont }, fallback);
}

/** Register every imported font the given titles or caption styles use. */
export function useProjectFontFaces(
	styles: readonly { customFont?: CustomFont | null | undefined }[]
) {
	const ids = [
		...new Set(
			styles.flatMap((style) => (style.customFont ? [style.customFont.id] : []))
		),
	]
		.sort()
		.join(",");
	useEffect(() => {
		for (const id of ids ? ids.split(",") : []) {
			ensureImportedFontFace(id).catch(() => undefined);
		}
	}, [ids]);
}

/** Families the browser reports through the Local Font Access API, if any. */
async function browserLocalFonts(): Promise<string[]> {
	const query = (
		window as Window & {
			queryLocalFonts?: () => Promise<readonly { family: string }[]>;
		}
	).queryLocalFonts;
	if (typeof query !== "function") {
		return [];
	}
	try {
		return (await query()).map((font) => font.family);
	} catch {
		return [];
	}
}

/** Valid, unique family names in alphabetical order. */
export function systemFontNames(families: readonly string[]): string[] {
	const names = new Set<string>();
	for (const family of families) {
		const parsed = fontFamilyNameSchema.safeParse(family);
		if (parsed.success) {
			names.add(parsed.data);
		}
	}
	return [...names].sort((left, right) =>
		left.localeCompare(right, "en", { sensitivity: "base" })
	);
}

let systemFonts: Promise<string[]> | null = null;

/**
 * Installed font families: the node's fontconfig list (what the export can
 * render), or the browser's local fonts when the node has no fc-list.
 */
export function listSystemFonts(): Promise<string[]> {
	if (!systemFonts) {
		systemFonts = (async () => {
			const listed = await request(systemListSchema, "/system-fonts").catch(
				() => ({ available: false, fonts: [] })
			);
			return systemFontNames(
				listed.available ? listed.fonts : await browserLocalFonts()
			);
		})();
	}
	return systemFonts;
}

/** The installed families for the picker's system group. */
export function useSystemFonts(): string[] {
	const [fonts, setFonts] = useState<string[]>([]);
	useEffect(() => {
		let active = true;
		listSystemFonts()
			.then((next) => {
				if (active) {
					setFonts(next);
				}
			})
			.catch(() => undefined);
		return () => {
			active = false;
		};
	}, []);
	return fonts;
}

/** The choice with only one font source: an imported font wins. */
export function singleFontChoice(choice: FontChoice): FontChoice {
	if (choice.customFont) {
		return { customFont: choice.customFont };
	}
	return choice.systemFont ? { systemFont: choice.systemFont } : {};
}

/** The font library for pickers, with a refresh after imports. */
export function useImportedFonts() {
	const [fonts, setFonts] = useState<ImportedFont[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const refresh = useCallback(async () => {
		try {
			setFonts(await listImportedFonts());
			setError(null);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		}
	}, []);
	useEffect(() => {
		refresh().catch(() => undefined);
	}, [refresh]);
	return { error, fonts, refresh };
}

/** Forget registered faces and the system font list (tests). */
export function resetImportedFontFaces() {
	faces.clear();
	systemFonts = null;
}
