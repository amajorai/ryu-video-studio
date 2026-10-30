/**
 * Reading imported font files: only plain TrueType (`.ttf`) and OpenType CFF
 * (`.otf`) fonts are accepted, because both the export renderer (libass via
 * FreeType) and every browser preview read them without extra decoders. The
 * family name comes from the font's own `name` table, so titles name it
 * exactly as the renderer will look it up.
 */
import { fontFamilyNameSchema, type ImportedFont } from "./schema/font.ts";

/**
 * Largest font file one import accepts. Large files (CJK families run to
 * 15–20 MB) arrive through the chunked upload session, 512 KiB at a time.
 */
export const MAX_FONT_BYTES = 24_000_000;
/** Largest font the one-request JSON import (`data` as base64) accepts. */
export const MAX_INLINE_FONT_BYTES = 1_400_000;
/** Most fonts one library keeps. */
export const MAX_IMPORTED_FONTS = 100;

export class FontFileError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "FontFileError";
	}
}

const TRUETYPE = 0x00_01_00_00;
const tag = (view: DataView, offset: number) =>
	String.fromCharCode(
		view.getUint8(offset),
		view.getUint8(offset + 1),
		view.getUint8(offset + 2),
		view.getUint8(offset + 3)
	);

function utf16(bytes: Uint8Array): string {
	let text = "";
	for (let index = 0; index + 1 < bytes.length; index += 2) {
		text += String.fromCharCode(
			((bytes[index] ?? 0) << 8) | (bytes[index + 1] ?? 0)
		);
	}
	return text;
}

const latin1 = (bytes: Uint8Array) => String.fromCharCode(...bytes);

interface NameRecord {
	language: number;
	nameId: number;
	platform: number;
	text: string;
}

function nameRecords(bytes: Uint8Array, view: DataView, offset: number) {
	const count = view.getUint16(offset + 2);
	const strings = offset + view.getUint16(offset + 4);
	const records: NameRecord[] = [];
	for (let index = 0; index < Math.min(count, 2000); index++) {
		const at = offset + 6 + index * 12;
		if (at + 12 > bytes.length) {
			break;
		}
		const platform = view.getUint16(at);
		const encoding = view.getUint16(at + 2);
		const language = view.getUint16(at + 4);
		const nameId = view.getUint16(at + 6);
		const length = view.getUint16(at + 8);
		const start = strings + view.getUint16(at + 10);
		if (start + length > bytes.length) {
			continue;
		}
		const raw = bytes.subarray(start, start + length);
		const unicode = platform === 0 || (platform === 3 && encoding <= 1);
		if (!(unicode || (platform === 1 && encoding === 0))) {
			continue;
		}
		records.push({
			language,
			nameId,
			platform,
			text: unicode ? utf16(raw) : latin1(raw),
		});
	}
	return records;
}

/** The family to name: typographic family (16), then family (1); English first. */
function pickFamily(records: readonly NameRecord[]): string | undefined {
	const rank = (record: NameRecord) => {
		if (record.platform === 3 && record.language === 0x4_09) {
			return 0;
		}
		return record.platform === 3 || record.platform === 0 ? 1 : 2;
	};
	for (const nameId of [16, 1]) {
		const best = records
			.filter((record) => record.nameId === nameId && record.text.trim())
			.sort((a, b) => rank(a) - rank(b))[0];
		if (best) {
			return best.text.trim();
		}
	}
	return;
}

/**
 * Validate a font file and read its family name and format. Throws a
 * `FontFileError` that says what is wrong for collections, web fonts and
 * files that are not fonts.
 */
export function readFontFile(
	bytes: Uint8Array
): Pick<ImportedFont, "family" | "format"> {
	if (bytes.length > MAX_FONT_BYTES) {
		throw new FontFileError(
			`The font is larger than the ${(MAX_FONT_BYTES / 1_000_000).toFixed(1)} MB import limit.`
		);
	}
	if (bytes.length < 12) {
		throw new FontFileError("This file is not a font.");
	}
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const signature = view.getUint32(0);
	const magic = tag(view, 0);
	if (magic === "wOFF" || magic === "wOF2") {
		throw new FontFileError(
			"Web fonts (.woff, .woff2) are not supported. Import the .ttf or .otf file."
		);
	}
	if (magic === "ttcf") {
		throw new FontFileError(
			"Font collections (.ttc) are not supported. Import a single .ttf or .otf font."
		);
	}
	let format: ImportedFont["format"];
	if (magic === "OTTO") {
		format = "opentype";
	} else if (signature === TRUETYPE || magic === "true") {
		format = "truetype";
	} else {
		throw new FontFileError("This file is not a TrueType or OpenType font.");
	}
	const tables = view.getUint16(4);
	if (12 + tables * 16 > bytes.length) {
		throw new FontFileError("The font's table directory is truncated.");
	}
	let nameOffset = -1;
	for (let index = 0; index < tables; index++) {
		const at = 12 + index * 16;
		if (tag(view, at) === "name") {
			nameOffset = view.getUint32(at + 8);
		}
	}
	if (nameOffset < 0 || nameOffset + 6 > bytes.length) {
		throw new FontFileError("The font has no name table.");
	}
	const family = pickFamily(nameRecords(bytes, view, nameOffset));
	const parsed = fontFamilyNameSchema.safeParse(family ?? "");
	if (!parsed.success) {
		throw new FontFileError(
			"The font's family name is missing or contains characters titles cannot use (commas, braces, quotes or backslashes)."
		);
	}
	return { family: parsed.data, format };
}

/** The stored file name of an imported font. */
export const importedFontFile = (
	font: Pick<ImportedFont, "format" | "id">
): string => `${font.id}.${font.format === "opentype" ? "otf" : "ttf"}`;

/** The CSS family the preview registers for an imported font. */
export const importedFontCssFamily = (id: string) => `ryu-font-${id}`;
