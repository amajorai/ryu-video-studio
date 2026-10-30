import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Title } from "./project.ts";
import {
	assAlignment,
	assBold,
	BUNDLED_FONT_FILES,
	DEFAULT_TITLE_OUTLINE,
	estimateTextSize,
	glyphFillColor,
	isStyledTitle,
	mixHex,
	TITLE_FONTS,
	titleStyleOf,
	titleStylePatch,
} from "./text-style.ts";

const legacy: Title = {
	animation: "fade",
	color: "#ffffff",
	end: 3,
	fadeIn: 0.2,
	fadeOut: 0.2,
	fontSize: 0.08,
	id: "00000000-0000-4000-8000-000000000001",
	start: 0,
	text: "Hello",
	x: 0.5,
	y: 0.5,
};

describe("title style accessors", () => {
	test("legacy titles resolve to the legacy look and stay unstyled", () => {
		expect(isStyledTitle(legacy)).toBe(false);
		expect(isStyledTitle({ ...legacy, keyframes: [] })).toBe(false);
		expect(titleStyleOf(legacy)).toMatchObject({
			align: "center",
			backgroundColor: null,
			fontFamily: "system-sans",
			fontWeight: 700,
			outlineColor: "#000000",
			outlineWidth: DEFAULT_TITLE_OUTLINE,
			shadowDepth: 0,
		});
	});

	test("any style or motion field marks a title as styled", () => {
		expect(isStyledTitle({ ...legacy, fontFamily: "anton" })).toBe(true);
		expect(isStyledTitle({ ...legacy, animationLoop: "pulse" })).toBe(true);
		expect(isStyledTitle({ ...legacy, lane: 2 })).toBe(false);
	});

	test("style patches copy look and motion but not text, place, or time", () => {
		const patch = titleStylePatch({
			...legacy,
			animationIn: "pop",
			fontFamily: "lobster",
			italic: true,
		});
		expect(patch).toEqual({
			animationIn: "pop",
			color: "#ffffff",
			fontFamily: "lobster",
			fontSize: 0.08,
			italic: true,
		});
	});

	test("ASS alignment and bold flags", () => {
		expect([
			assAlignment("left"),
			assAlignment("center"),
			assAlignment("right"),
		]).toEqual([4, 5, 6]);
		expect([assBold(400), assBold(500), assBold(600), assBold(900)]).toEqual([
			0, 0, -1, -1,
		]);
	});

	test("text size estimates grow with length, rows, and spacing", () => {
		const style = titleStyleOf(legacy);
		const short = estimateTextSize("Hi", style, 100);
		const long = estimateTextSize("Hello there", style, 100);
		const rows = estimateTextSize("Hi\nthere", style, 100);
		const spaced = estimateTextSize(
			"Hello there",
			{ ...style, letterSpacing: 0.2 },
			100
		);
		expect(long.width).toBeGreaterThan(short.width);
		expect(rows.height).toBeCloseTo(100 * (1 + style.lineHeight));
		expect(spaced.width - long.width).toBeCloseTo(10 * 0.2 * 100);
	});

	test("every catalog font file is bundled", () => {
		const directory = join(import.meta.dir, "../sidecar/assets/fonts");
		for (const file of BUNDLED_FONT_FILES) {
			expect(existsSync(join(directory, file))).toBe(true);
		}
		expect(TITLE_FONTS["system-sans"].files).toEqual([]);
		expect(BUNDLED_FONT_FILES.length).toBeGreaterThanOrEqual(12);
	});
});

describe("gradient fill and text blur", () => {
	test("gradient colors run from the title color to the end color per glyph", () => {
		expect(mixHex("#ff0000", "#0000ff", 0.5)).toBe("#800080");
		const title = {
			animation: "fade" as const,
			color: "#000000",
			end: 1,
			fadeIn: 0,
			fadeOut: 0,
			fillMode: "gradient" as const,
			fontSize: 0.1,
			gradientColor: "#ffffff",
			id: crypto.randomUUID(),
			start: 0,
			text: "abc",
			textBlur: 0.004,
			x: 0.5,
			y: 0.5,
		};
		const style = titleStyleOf(title);
		expect(style.textBlur).toBe(0.004);
		expect(glyphFillColor(title, style, 0, 3)).toBe("#000000");
		expect(glyphFillColor(title, style, 2, 3)).toBe("#ffffff");
		expect(
			glyphFillColor(
				title,
				titleStyleOf({ ...title, fillMode: undefined }),
				2,
				3
			)
		).toBe("#000000");
	});
});
