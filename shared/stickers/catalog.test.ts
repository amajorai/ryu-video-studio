import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { assetSchema } from "../project.ts";
import {
	STICKER_CATALOG,
	STICKER_SOURCES,
	type StickerEntry,
	searchStickers,
	stickerAssetName,
	stickerById,
	stickerOrigin,
} from "./catalog.ts";

const assetsDir = join(import.meta.dir, "assets");

describe("sticker catalog", () => {
	test("bundles about 300 emoji, flags and original shapes", () => {
		const count = (category: StickerEntry["category"]) =>
			STICKER_CATALOG.filter((entry) => entry.category === category).length;
		expect(count("emoji")).toBeGreaterThanOrEqual(280);
		expect(count("emoji")).toBeLessThanOrEqual(320);
		expect(count("flags")).toBeGreaterThanOrEqual(200);
		expect(count("shapes")).toBeGreaterThanOrEqual(20);
	});

	test("ids are unique and every entry has exactly one bundled file", () => {
		const ids = STICKER_CATALOG.map((entry) => entry.id);
		expect(new Set(ids).size).toBe(ids.length);
		const files = ["emoji", "flags", "shapes"].flatMap((folder) =>
			readdirSync(join(assetsDir, folder)).map((name) => `${folder}/${name}`)
		);
		expect(new Set(STICKER_CATALOG.map((entry) => entry.file))).toEqual(
			new Set(files)
		);
	});

	test("every file is a self-contained SVG whose view box matches its aspect", () => {
		for (const entry of STICKER_CATALOG) {
			const svg = readFileSync(join(assetsDir, entry.file), "utf8");
			const viewBox = svg.match(/<svg\b[^>]*\sviewBox="([^"]+)"/)?.[1];
			const [, , width = 0, height = 1] = (viewBox ?? "")
				.split(/\s+/)
				.map(Number);
			expect(Math.abs(width / height - entry.aspect)).toBeLessThan(0.01);
			expect(
				/<script|<foreignObject|\son[a-z]+=|(?:href|src)="(?!#)/i.test(svg)
			).toBe(false);
		}
	});

	test("sources match categories", () => {
		for (const entry of STICKER_CATALOG) {
			const expected: StickerEntry["source"] = {
				emoji: "twemoji" as const,
				flags: "flag-icons" as const,
				shapes: "ryu" as const,
			}[entry.category];
			expect(entry.source).toBe(expected);
		}
	});

	test("no brand logos are bundled", () => {
		const brands =
			/logo|brand|twitter|facebook|instagram|youtube|tiktok|apple inc/i;
		for (const entry of STICKER_CATALOG) {
			expect(brands.test(entry.name)).toBe(false);
		}
	});
});

describe("searchStickers", () => {
	test("an empty query lists the whole catalog in order", () => {
		expect(searchStickers("")).toEqual([...STICKER_CATALOG]);
		expect(searchStickers("  ", { limit: 3 })).toHaveLength(3);
	});

	test("matches names and keywords, whole-name matches first", () => {
		const hearts = searchStickers("heart");
		expect(hearts.length).toBeGreaterThan(3);
		expect(hearts[0]?.name).toBe("Heart");
		expect(searchStickers("red heart")[0]?.id).toBe("emoji-2764");
		const japan = searchStickers("japan", { category: "flags" });
		expect(japan.map((entry) => entry.id)).toEqual(["flag-jp"]);
		expect(searchStickers("JP")[0]?.id).toBe("flag-jp");
		expect(searchStickers("cheerful").map((entry) => entry.id)).toContain(
			"emoji-1f600"
		);
	});

	test("every query word must match; prefixes count", () => {
		expect(searchStickers("grin").length).toBeGreaterThan(1);
		expect(searchStickers("grinning sweat").map((entry) => entry.id)).toEqual([
			"emoji-1f605",
		]);
		expect(searchStickers("zzzz-no-such-sticker")).toEqual([]);
	});

	test("category filter and limit", () => {
		const shapes = searchStickers("", { category: "shapes" });
		expect(shapes.every((entry) => entry.category === "shapes")).toBe(true);
		expect(
			searchStickers("arrow", { category: "shapes", limit: 2 })
		).toHaveLength(2);
		expect(searchStickers("arrow", { limit: 0 })).toEqual([]);
	});

	test("is deterministic", () => {
		expect(searchStickers("star")).toEqual(searchStickers("star"));
	});
});

describe("attribution", () => {
	test("every sticker carries a valid bundled origin", () => {
		for (const entry of STICKER_CATALOG) {
			const origin = stickerOrigin(entry);
			const asset = assetSchema.parse({
				createdAt: new Date(0).toISOString(),
				duration: 5,
				hasAudio: false,
				height: 1024,
				id: crypto.randomUUID(),
				kind: "image",
				name: stickerAssetName(entry),
				origin,
				width: 1024,
			});
			expect(asset.origin?.provider).toBe("bundled");
			expect(asset.origin?.identifier).toBe(entry.id);
		}
	});

	test("Twemoji stickers credit Twemoji under CC-BY 4.0", () => {
		const entry = stickerById("emoji-1f600");
		if (!entry) {
			throw new Error("missing grinning face");
		}
		const origin = stickerOrigin(entry);
		expect(origin.attribution).toContain("Twemoji");
		expect(origin.attribution).toContain("CC-BY 4.0");
		expect(origin.licenseUrl).toBe(
			"https://creativecommons.org/licenses/by/4.0/"
		);
		expect(STICKER_SOURCES["flag-icons"].licenseName).toBe("MIT");
		expect(
			stickerOrigin(searchStickers("hexagon")[0] as StickerEntry)
		).not.toHaveProperty("licenseUrl");
	});
});
