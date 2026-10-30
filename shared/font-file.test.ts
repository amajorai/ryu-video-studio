import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
	FontFileError,
	importedFontFile,
	MAX_FONT_BYTES,
	readFontFile,
} from "./font-file.ts";

/** A minimal sfnt with only a `name` table holding `records`. */
function syntheticFont(
	magic: number | string,
	records: { family: string; nameId: number; platform: number }[]
): Uint8Array {
	const strings = records.map((record) =>
		record.platform === 1
			? new Uint8Array([...record.family].map((char) => char.charCodeAt(0)))
			: new Uint8Array(
					[...record.family].flatMap((char) => [0, char.charCodeAt(0)])
				)
	);
	const nameSize =
		6 + records.length * 12 + strings.reduce((sum, s) => sum + s.length, 0);
	const bytes = new Uint8Array(12 + 16 + nameSize);
	const view = new DataView(bytes.buffer);
	if (typeof magic === "string") {
		bytes.set(new TextEncoder().encode(magic), 0);
	} else {
		view.setUint32(0, magic);
	}
	view.setUint16(4, 1);
	bytes.set(new TextEncoder().encode("name"), 12);
	view.setUint32(20, 28);
	view.setUint32(24, nameSize);
	const name = 28;
	view.setUint16(name + 2, records.length);
	view.setUint16(name + 4, 6 + records.length * 12);
	let offset = 0;
	for (const [index, record] of records.entries()) {
		const at = name + 6 + index * 12;
		const text = strings[index] ?? new Uint8Array();
		view.setUint16(at, record.platform);
		view.setUint16(at + 2, record.platform === 3 ? 1 : 0);
		view.setUint16(at + 4, record.platform === 3 ? 0x4_09 : 0);
		view.setUint16(at + 6, record.nameId);
		view.setUint16(at + 8, text.length);
		view.setUint16(at + 10, offset);
		bytes.set(text, name + 6 + records.length * 12 + offset);
		offset += text.length;
	}
	return bytes;
}

describe("imported font files", () => {
	test("a real bundled TTF reads its family", async () => {
		const bytes = await Bun.file(
			join(import.meta.dir, "../sidecar/assets/fonts/Lobster-Regular.ttf")
		).bytes();
		expect(readFontFile(bytes)).toEqual({
			family: "Lobster",
			format: "truetype",
		});
	});

	test("the typographic family wins over the legacy family; OTTO is OpenType", () => {
		expect(
			readFontFile(
				syntheticFont("OTTO", [
					{ family: "Acme Display Light", nameId: 1, platform: 3 },
					{ family: "Acme Display", nameId: 16, platform: 3 },
				])
			)
		).toEqual({ family: "Acme Display", format: "opentype" });
		expect(
			readFontFile(
				syntheticFont(0x00_01_00_00, [
					{ family: "Mac Only", nameId: 1, platform: 1 },
				])
			).family
		).toBe("Mac Only");
	});

	test("web fonts, collections, non-fonts and unsafe names are refused", () => {
		expect(() => readFontFile(syntheticFont("wOF2", []))).toThrow(/Web fonts/);
		expect(() => readFontFile(syntheticFont("ttcf", []))).toThrow(
			/collections/
		);
		expect(() =>
			readFontFile(new TextEncoder().encode("hello, world!"))
		).toThrow(FontFileError);
		expect(() =>
			readFontFile(
				syntheticFont("OTTO", [{ family: "Bad,Name", nameId: 1, platform: 3 }])
			)
		).toThrow(/family name/);
		expect(() => readFontFile(new Uint8Array(MAX_FONT_BYTES + 1))).toThrow(
			/import limit/
		);
	});

	test("stored files keep the format's extension", () => {
		const id = crypto.randomUUID();
		expect(importedFontFile({ format: "opentype", id })).toBe(`${id}.otf`);
		expect(importedFontFile({ format: "truetype", id })).toBe(`${id}.ttf`);
	});
});
