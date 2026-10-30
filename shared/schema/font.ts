import { z } from "zod";

/**
 * Family names that are safe in an ASS style line (comma separated) and a
 * CSS font-family value: no commas, braces, backslashes, quotes or controls.
 */
export const fontFamilyNameSchema = z
	.string()
	.trim()
	.min(1)
	.max(64)
	.regex(/^[^,{}\\"'\p{Cc}]+$/u);

/** Licenses an online font must carry before Video Studio imports it. */
export const OPEN_FONT_LICENSES = ["OFL-1.1", "Apache-2.0", "UFL-1.0"] as const;
export const openFontLicenseSchema = z.enum(OPEN_FONT_LICENSES);
export type OpenFontLicense = z.infer<typeof openFontLicenseSchema>;

/**
 * Where a font from an online catalog came from and under which license, for
 * the credits and provenance report. Fonts imported from a file have none.
 */
export const fontOriginSchema = z
	.object({
		attribution: z.string().trim().min(1).max(500),
		/** Catalog font id plus the subset, weight and style file taken. */
		identifier: z.string().trim().min(1).max(200),
		license: openFontLicenseSchema,
		licenseUrl: z.url(),
		pageUrl: z.url(),
		provider: z.literal("fontsource"),
	})
	.strict();
export type FontOrigin = z.infer<typeof fontOriginSchema>;

/** A font file imported into the node's font library. */
export const importedFontSchema = z
	.object({
		createdAt: z.string(),
		/** The font's own family name (from its `name` table). */
		family: fontFamilyNameSchema,
		format: z.enum(["truetype", "opentype"]),
		id: z.uuid(),
		/** The name it was imported under (usually the file name). */
		name: z.string().trim().min(1).max(120),
		origin: fontOriginSchema.optional(),
		size: z.number().int().positive(),
	})
	.strict();
export type ImportedFont = z.infer<typeof importedFontSchema>;

/**
 * An imported font chosen for a title or a caption style. The family is
 * copied in so the render and preview can name it without a library lookup;
 * when the font is missing from the library, `fontFamily` is used instead.
 */
export const customFontSchema = z
	.object({ family: fontFamilyNameSchema, id: z.uuid() })
	.strict();
export type CustomFont = z.infer<typeof customFontSchema>;

/**
 * An installed system font chosen by family name (as `fc-list` reports it).
 * libass finds it through the system font provider at render time and the
 * preview names it in CSS; `fontFamily` is the fallback when it is missing.
 */
export const systemFontSchema = fontFamilyNameSchema;

/** The font sources a title or caption style can name besides `fontFamily`. */
export interface FontChoice {
	customFont?: CustomFont | undefined;
	systemFont?: string | undefined;
}

/**
 * The family name the render asks libass for: the imported font, then the
 * system font, or null to use the bundled `fontFamily`.
 */
export const chosenFontFamily = (choice: {
	customFont?: CustomFont | null | undefined;
	systemFont?: string | null | undefined;
}): string | null => choice.customFont?.family ?? choice.systemFont ?? null;
