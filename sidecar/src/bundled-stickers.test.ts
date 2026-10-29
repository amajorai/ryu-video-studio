import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { STICKER_CATALOG } from "../../shared/stickers/catalog.ts";
import { EMBEDDED_STICKERS } from "./bundled-stickers.ts";
import { stickerBinding } from "./generate-bundled-stickers.ts";
import {
	isMissingSvgDecoder,
	STICKER_RASTER_UNAVAILABLE_MESSAGE,
	stickerSvg,
} from "./stickers.ts";

const assets = join(import.meta.dir, "../../shared/stickers/assets");

test("the embedded sticker table is generated from exactly the catalog", () => {
	expect(Object.keys(EMBEDDED_STICKERS).sort()).toEqual(
		STICKER_CATALOG.map((entry) => entry.file).sort()
	);
	const source = readFileSync(
		join(import.meta.dir, "bundled-stickers.ts"),
		"utf8"
	);
	for (const entry of STICKER_CATALOG) {
		const binding = stickerBinding(entry.file);
		expect(source).toContain(
			`import ${binding} from "../../shared/stickers/assets/${entry.file}" with {`
		);
		expect(source).toContain(`"${entry.file}": ${binding},`);
	}
	const bindings = STICKER_CATALOG.map((entry) => stickerBinding(entry.file));
	expect(new Set(bindings).size).toBe(bindings.length);
});

test("every embedded sticker is its bundled SVG, byte for byte", () => {
	for (const entry of STICKER_CATALOG) {
		expect(stickerSvg(entry)).toBe(
			readFileSync(join(assets, entry.file), "utf8")
		);
	}
	expect(() =>
		stickerSvg({ file: "shapes/none.svg", name: "None" }, {})
	).toThrow("None is not bundled with this sidecar.");
});

test("a missing librsvg decoder is reported as such", () => {
	expect(
		isMissingSvgDecoder(
			"The media operation failed. Unknown input format: 'svg_pipe'"
		)
	).toBe(true);
	expect(isMissingSvgDecoder("Media operation timed out.")).toBe(false);
	expect(STICKER_RASTER_UNAVAILABLE_MESSAGE).toContain("librsvg");
});
