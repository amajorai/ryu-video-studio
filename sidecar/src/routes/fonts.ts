import { readFile } from "node:fs/promises";
import { z } from "zod";
import {
	FontFileError,
	MAX_FONT_BYTES,
	MAX_INLINE_FONT_BYTES,
} from "../../../shared/font-file.ts";
import { FontInUseError, fontLibraryForStore } from "../font-library.ts";
import {
	FontLicenseError,
	fontCatalogImportSchema,
	importCatalogFont,
	MAX_FONT_CATALOG_RESULTS,
	searchFontCatalog,
} from "../fonts-catalog.ts";
import { listSystemFonts } from "../system-fonts.ts";
import type { StudioQueryParameter, StudioRoute } from "./registry.ts";

/** Bytes one chunked font read returns (the media chunk size). */
const FONT_READ_CHUNK = 512 * 1024;

/**
 * Import body: the font file as base64 (`data`, up to 1.4 MB) or the id of a
 * finished chunked upload (`uploadId`, up to 24 MB), plus a display name.
 */
export const fontImportSchema = z
	.object({
		data: z
			.string()
			.min(16)
			.max(Math.ceil(MAX_INLINE_FONT_BYTES / 3) * 4 + 4)
			.regex(/^[A-Za-z0-9+/]*={0,2}$/)
			.optional(),
		name: z.string().trim().max(120).default(""),
		uploadId: z.uuid().optional(),
	})
	.strict()
	.refine(
		(input) => (input.data === undefined) !== (input.uploadId === undefined),
		{
			message: "Send the font as data or as an uploadId, not both.",
		}
	);

const idQuery: StudioQueryParameter = {
	name: "id",
	schema: { format: "uuid", type: "string" },
};

const fontId = (url: URL) => z.uuid().parse(url.searchParams.get("id"));

export const routes: StudioRoute[] = [
	{
		scope: "root",
		path: "fonts",
		method: "GET",
		operation: {
			id: "video_studio_fonts",
			description:
				"List imported fonts ({fonts}: id, family, format, name, size, and origin {provider, identifier, license, licenseUrl, pageUrl, attribution} for fonts added from the online catalog). With ?id=<font id>, return that font's record and its file as base64 ({font, data}) for a preview @font-face, for fonts up to 1.4 MB; add &offset=<byte offset> to read the file in 512 KiB chunks ({data, size, done}) instead, which larger fonts require (without it they answer 413 FONT_CHUNKED_READ). Use a font with customFont = {id, family} on a title (title routes), on a caption style (caption-style), or on a text template (apply-template); fontFamily is the fallback when the font is missing.",
			query: [
				idQuery,
				{ name: "offset", schema: { minimum: 0, type: "integer" } },
			],
		},
		handle: async ({ json, store, url }) => {
			const library = fontLibraryForStore(store);
			if (!url.searchParams.has("id")) {
				return json({ fonts: await library.list() });
			}
			const id = fontId(url);
			const font = await library.get(id);
			if (!font) {
				return json({ code: "NOT_FOUND", message: "Font not found." }, 404);
			}
			if (
				!url.searchParams.has("offset") &&
				font.size > MAX_INLINE_FONT_BYTES
			) {
				return json(
					{
						code: "FONT_CHUNKED_READ",
						message: `${font.name} is larger than ${(MAX_INLINE_FONT_BYTES / 1_000_000).toFixed(1)} MB. Read it in 512 KiB chunks with &offset=<byte offset>.`,
						size: font.size,
					},
					413
				);
			}
			const bytes = await library.read(id);
			if (url.searchParams.has("offset")) {
				// Chunked read for large fonts, like `GET /assets/:id/data`.
				const offset = z.coerce
					.number()
					.int()
					.min(0)
					.max(bytes.byteLength)
					.parse(url.searchParams.get("offset"));
				const end = Math.min(bytes.byteLength, offset + FONT_READ_CHUNK);
				return json({
					data: Buffer.from(bytes.subarray(offset, end)).toString("base64"),
					done: end >= bytes.byteLength,
					size: bytes.byteLength,
				});
			}
			return json({
				data: Buffer.from(bytes).toString("base64"),
				font,
			});
		},
	},
	{
		scope: "root",
		path: "fonts",
		method: "POST",
		operation: {
			id: "video_studio_import_font",
			description:
				'Import a TrueType (.ttf) or OpenType (.otf) font file. Send JSON {name, data (base64)} for a file up to 1.4 MB, or for a file up to 24 MB (CJK families) upload it first through POST /uploads with purpose "font", PUT /uploads/{id} (512 KiB chunks) and send {name, uploadId} instead of finishing the upload. Font bytes count against the node\'s media storage allowance (not the media asset limit). Web fonts (.woff, .woff2) and collections (.ttc) are refused. The family name is read from the font itself; returns the font record. Imported fonts render in exported titles (through libass) and in the preview.',
			body: fontImportSchema,
		},
		handle: async ({ claimUpload, json, request, store }) => {
			const input = fontImportSchema.parse(await request.json());
			const name = input.name.replace(/\.(ttf|otf)$/i, "");
			const library = fontLibraryForStore(store);
			try {
				if (input.uploadId) {
					const upload = claimUpload(input.uploadId);
					try {
						if (upload.size > MAX_FONT_BYTES) {
							throw new FontFileError(
								`The font is larger than the ${(MAX_FONT_BYTES / 1_000_000).toFixed(1)} MB import limit.`
							);
						}
						const bytes = new Uint8Array(await readFile(upload.path));
						// The upload's storage reservation covers these bytes
						// until the font file is written.
						return json(
							await library.add(
								name || upload.name.replace(/\.(ttf|otf)$/i, ""),
								bytes,
								undefined,
								{ admitted: true }
							),
							201
						);
					} finally {
						await upload.dispose();
					}
				}
				return json(
					await library.add(name, Buffer.from(input.data ?? "", "base64")),
					201
				);
			} catch (error) {
				if (error instanceof FontFileError) {
					return json({ code: "INVALID_FONT", message: error.message }, 400);
				}
				throw error;
			}
		},
	},
	{
		scope: "root",
		path: "font-catalog",
		method: "GET",
		operation: {
			id: "video_studio_font_catalog",
			description: `Search the Fontsource catalog of open-licensed fonts by family name (?q=, case-insensitive; at most ${MAX_FONT_CATALOG_RESULTS} results): {fonts: [{id, family, category, license, defaultSubset, subsets, weights, styles}]}. Only fonts licensed OFL-1.1, Apache-2.0 or UFL-1.0 are listed. Contacts only https://api.fontsource.org; fails with the reason when it is unreachable.`,
			query: [{ name: "q", schema: { maxLength: 80, type: "string" } }],
		},
		handle: async ({ json, request, url }) => {
			const query = z
				.string()
				.max(80)
				.parse(url.searchParams.get("q") ?? "");
			return json({
				fonts: await searchFontCatalog(query, { signal: request.signal }),
			});
		},
	},
	{
		scope: "root",
		path: "font-catalog",
		method: "POST",
		operation: {
			id: "video_studio_import_catalog_font",
			description:
				"Add a Fontsource font to the font library: {id (from GET /font-catalog), weight (default 400), style (normal or italic), subset (default: the font's default subset)}. One .ttf file (that subset, weight and style) is downloaded from https://cdn.jsdelivr.net only, validated like an imported file, and stored with its source and SPDX license (OFL-1.1, Apache-2.0 or UFL-1.0; anything else is refused with FONT_LICENSE) for the credits report. Returns the font record.",
			body: fontCatalogImportSchema,
		},
		handle: async ({ json, request, store }) => {
			const input = fontCatalogImportSchema.parse(await request.json());
			try {
				return json(
					await importCatalogFont(fontLibraryForStore(store), input, {
						signal: request.signal,
					}),
					201
				);
			} catch (error) {
				if (error instanceof FontLicenseError) {
					return json({ code: "FONT_LICENSE", message: error.message }, 400);
				}
				if (error instanceof FontFileError) {
					return json({ code: "INVALID_FONT", message: error.message }, 400);
				}
				throw error;
			}
		},
	},
	{
		scope: "root",
		path: "system-fonts",
		method: "GET",
		operation: {
			id: "video_studio_system_fonts",
			description:
				"List the font families installed on this node ({available, fonts}), from fontconfig (fc-list). Use one as systemFont on a title, a caption style, or a text template; libass finds it by family at render time and fontFamily is the fallback when it is missing. available is false when the node has no fc-list.",
		},
		handle: async ({ json }) => json(await listSystemFonts()),
	},
	{
		scope: "root",
		path: "fonts",
		method: "DELETE",
		operation: {
			id: "video_studio_delete_font",
			description:
				"Delete the imported font named by ?id=<font id>. Refused with FONT_IN_USE while any project's titles, caption styles or templates still use it.",
			query: [{ ...idQuery, required: true }],
		},
		handle: async ({ json, store, url }) => {
			const id = fontId(url);
			try {
				await fontLibraryForStore(store).remove(id, store.projects());
				return json({ deleted: id });
			} catch (error) {
				if (error instanceof FontInUseError) {
					return json({ code: "FONT_IN_USE", message: error.message }, 409);
				}
				throw error;
			}
		},
	},
];
