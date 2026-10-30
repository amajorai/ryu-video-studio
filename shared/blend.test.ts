import { describe, expect, test } from "bun:test";
import {
	blendChannel,
	blendModeLabels,
	blendModes,
	blendPreviewGaps,
	componentBlendOf,
	componentPixel,
	compositePixel,
	cssBlendModeOf,
	ffmpegBlendOf,
	isBlended,
	isBlendMode,
	isComponentBlendMode,
	previewApproximates,
	rgbToYcc,
	yccToRgb,
} from "./blend.ts";
import { newSegment, segmentSchema } from "./project.ts";

const asset = {
	createdAt: "2026-01-01T00:00:00.000Z",
	duration: 4,
	hasAudio: false,
	height: 1080,
	id: "00000000-0000-4000-8000-000000000001",
	kind: "video" as const,
	name: "Clip",
	width: 1920,
};

describe("blend mode tables", () => {
	test("every mode has a label, a CSS mode and (except normal) a render recipe", () => {
		expect(blendModes).toHaveLength(20);
		expect(blendModes[0]).toBe("normal");
		for (const mode of blendModes) {
			expect(blendModeLabels[mode].length).toBeGreaterThan(0);
			expect(cssBlendModeOf(mode)).toBeString();
			if (mode === "normal") {
				expect(ffmpegBlendOf(mode)).toBeNull();
				expect(componentBlendOf(mode)).toBeNull();
			} else if (isComponentBlendMode(mode)) {
				expect(ffmpegBlendOf(mode)).toBeNull();
				expect(componentBlendOf(mode)).not.toBeNull();
			} else {
				expect(ffmpegBlendOf(mode)?.mode).toMatch(/^[a-z]+$/);
				expect(componentBlendOf(mode)).toBeNull();
			}
		}
	});

	test("the component modes take luma, hue and saturation from the right input", () => {
		expect(blendModes.filter(isComponentBlendMode)).toEqual([
			"hue",
			"saturation",
			"color",
			"luminosity",
		]);
		expect(componentBlendOf("color")).toEqual({
			chromaAmount: "layer",
			chromaDirection: "layer",
			luma: "base",
		});
		expect(componentBlendOf("luminosity")).toEqual({
			chromaAmount: "base",
			chromaDirection: "base",
			luma: "layer",
		});
		expect(componentBlendOf("hue")).toEqual({
			chromaAmount: "base",
			chromaDirection: "layer",
			luma: "base",
		});
		expect(componentBlendOf("saturation")).toEqual({
			chromaAmount: "layer",
			chromaDirection: "base",
			luma: "base",
		});
		for (const mode of ["hue", "saturation", "color", "luminosity"] as const) {
			expect(cssBlendModeOf(mode)).toBe(mode);
			expect(blendPreviewGaps(mode)).toEqual(["component-ycbcr"]);
		}
	});

	test("maps to FFmpeg's names and operand order", () => {
		expect(ffmpegBlendOf("color-dodge")).toEqual({
			layerFirst: true,
			mode: "dodge",
		});
		expect(ffmpegBlendOf("color-burn")).toEqual({
			layerFirst: true,
			mode: "burn",
		});
		expect(ffmpegBlendOf("linear-light")).toEqual({
			layerFirst: true,
			mode: "linearlight",
		});
		expect(ffmpegBlendOf("add")).toEqual({
			layerFirst: false,
			mode: "addition",
		});
		expect(ffmpegBlendOf("subtract")).toEqual({
			layerFirst: false,
			mode: "subtract",
		});
		expect(ffmpegBlendOf("pin-light")?.mode).toBe("pinlight");
		expect(ffmpegBlendOf("hard-light")?.mode).toBe("hardlight");
		expect(ffmpegBlendOf("soft-light")?.mode).toBe("softlight");
	});

	test("CSS falls back for the modes browsers lack", () => {
		expect(cssBlendModeOf("add")).toBe("plus-lighter");
		expect(cssBlendModeOf("subtract")).toBe("difference");
		expect(cssBlendModeOf("linear-light")).toBe("hard-light");
		expect(cssBlendModeOf("pin-light")).toBe("hard-light");
		expect(cssBlendModeOf("multiply")).toBe("multiply");
		const approximate = blendModes.filter((mode) => previewApproximates(mode));
		expect(approximate).toEqual([
			"soft-light",
			"subtract",
			"linear-light",
			"pin-light",
			"hue",
			"saturation",
			"color",
			"luminosity",
		]);
	});

	test("preview gaps name every known difference from the render", () => {
		expect(blendPreviewGaps("normal", { clipBackground: true })).toEqual([]);
		expect(blendPreviewGaps("multiply")).toEqual([]);
		expect(blendPreviewGaps("subtract")).toEqual(["css-fallback"]);
		expect(blendPreviewGaps("soft-light")).toEqual(["soft-light-curve"]);
		// Add is exact at full opacity; plus-lighter differs once alpha < 1.
		expect(blendPreviewGaps("add")).toEqual([]);
		expect(previewApproximates("add", { partlyTransparent: false })).toBe(
			false
		);
		expect(blendPreviewGaps("add", { partlyTransparent: true })).toEqual([
			"add-opacity",
		]);
		expect(
			blendPreviewGaps("pin-light", {
				clipBackground: true,
				partlyTransparent: true,
			})
		).toEqual(["css-fallback", "clip-background"]);
		expect(previewApproximates("screen", { clipBackground: true })).toBe(true);
	});

	test("the flagged gaps are real differences from the CSS formulas", () => {
		// W3C soft light (the browser) against FFmpeg's pegtop curve.
		const base = 0.25;
		const layer = 0.75;
		const d = Math.sqrt(base);
		const cssSoftLight = base + (2 * layer - 1) * (d - base);
		expect(cssSoftLight).toBeCloseTo(0.375);
		expect(blendChannel("soft-light", base, layer)).toBeCloseTo(0.343_75);
		// plus-lighter at half opacity against the render's add.
		const cssAdd = Math.min(1, 0.5 * 0.5 + 0.8);
		expect(cssAdd).toBe(1);
		const grey = (value: number): [number, number, number] => [
			value,
			value,
			value,
		];
		expect(compositePixel("add", grey(0.8), grey(0.5), 0.5)[0]).toBeCloseTo(
			0.9
		);
		// At full opacity the two agree.
		expect(compositePixel("add", grey(0.8), grey(0.5), 1)[0]).toBeCloseTo(1);
	});

	test("guards and the optional field", () => {
		expect(isBlendMode("screen")).toBe(true);
		expect(isBlendMode("dissolve")).toBe(false);
		const legacy = segmentSchema.parse(newSegment(asset));
		expect("blendMode" in legacy).toBe(false);
		expect(isBlended(legacy)).toBe(false);
		expect(isBlended({ blendMode: "normal" })).toBe(false);
		expect(isBlended({ blendMode: "multiply" })).toBe(true);
	});
});

describe("reference channel math", () => {
	test("identity layers leave the base", () => {
		for (const base of [0, 0.25, 0.5, 1]) {
			expect(blendChannel("multiply", base, 1)).toBeCloseTo(base);
			expect(blendChannel("screen", base, 0)).toBeCloseTo(base);
			expect(blendChannel("add", base, 0)).toBeCloseTo(base);
			expect(blendChannel("subtract", base, 0)).toBeCloseTo(base);
			expect(blendChannel("difference", base, 0)).toBeCloseTo(base);
			expect(blendChannel("darken", base, 1)).toBeCloseTo(base);
			expect(blendChannel("lighten", base, 0)).toBeCloseTo(base);
			expect(blendChannel("linear-light", base, 0.5)).toBeCloseTo(base);
		}
	});

	test("asymmetric modes treat base as the backdrop", () => {
		expect(blendChannel("subtract", 0.8, 0.3)).toBeCloseTo(0.5);
		expect(blendChannel("subtract", 0.3, 0.8)).toBe(0);
		expect(blendChannel("color-dodge", 0.4, 0.5)).toBeCloseTo(0.8);
		expect(blendChannel("color-dodge", 0, 1)).toBe(1);
		expect(blendChannel("color-burn", 0.6, 0.8)).toBeCloseTo(0.5);
		expect(blendChannel("color-burn", 1, 0)).toBe(0);
		// Overlay decides by the base, hard light by the layer.
		expect(blendChannel("overlay", 0.25, 0.8)).toBeCloseTo(0.4);
		expect(blendChannel("hard-light", 0.25, 0.8)).toBeCloseTo(0.7);
		expect(blendChannel("pin-light", 0.9, 0.2)).toBeCloseTo(0.4);
		expect(blendChannel("pin-light", 0.1, 0.8)).toBeCloseTo(0.6);
		expect(blendChannel("linear-light", 0.5, 0.9)).toBe(1);
	});

	test("soft light follows FFmpeg's curve and stays in range", () => {
		expect(blendChannel("soft-light", 0.5, 0.5)).toBeCloseTo(0.5);
		expect(blendChannel("soft-light", 0.25, 1)).toBeCloseTo(0.4375);
		for (const base of [0, 0.3, 0.7, 1]) {
			for (const layer of [0, 0.3, 0.7, 1]) {
				const value = blendChannel("soft-light", base, layer);
				expect(value).toBeGreaterThanOrEqual(0);
				expect(value).toBeLessThanOrEqual(1);
			}
		}
	});

	test("compositePixel mixes by alpha", () => {
		expect(compositePixel("multiply", [0.5, 0.5, 0.5], [1, 0, 0], 0.5)).toEqual(
			[0.5, 0.25, 0.25]
		);
		expect(compositePixel("normal", [0.2, 0.4, 0.6], [1, 1, 1], 1)).toEqual([
			1, 1, 1,
		]);
		expect(compositePixel("screen", [0.2, 0.4, 0.6], [1, 1, 1], 0)).toEqual([
			0.2, 0.4, 0.6,
		]);
		expect(compositePixel("add", [0.8, 0.8, 0.8], [0.5, 0.5, 0.5], 2)).toEqual([
			1, 1, 1,
		]);
	});
});

describe("component mode math", () => {
	const blue: [number, number, number] = [0.25, 0.5, 0.78];
	const orange: [number, number, number] = [0.78, 0.38, 0.16];
	const grey = (value: number): [number, number, number] => [
		value,
		value,
		value,
	];
	/** Largest per-channel difference between two colours. */
	const gap = (actual: readonly number[], expected: readonly number[]) =>
		Math.max(
			...expected.map((value, index) => Math.abs((actual[index] ?? 0) - value))
		);

	test("YCbCr round trips and greys have no chroma", () => {
		expect(gap(yccToRgb(rgbToYcc(blue)), blue)).toBeLessThan(1e-4);
		const neutral = rgbToYcc(grey(0.4));
		expect(neutral.y).toBeCloseTo(0.4);
		expect(neutral.cb).toBeCloseTo(0);
		expect(neutral.cr).toBeCloseTo(0);
	});

	test("each mode keeps the documented components", () => {
		const base = rgbToYcc(blue);
		const layer = rgbToYcc(orange);
		const color = rgbToYcc(componentPixel("color", blue, orange));
		expect(color.y).toBeCloseTo(base.y, 3);
		expect(color.cb).toBeCloseTo(layer.cb, 3);
		const luminosity = rgbToYcc(componentPixel("luminosity", blue, orange));
		expect(luminosity.y).toBeCloseTo(layer.y, 3);
		expect(luminosity.cr).toBeCloseTo(base.cr, 3);
		const hue = rgbToYcc(componentPixel("hue", blue, orange));
		expect(hue.y).toBeCloseTo(base.y, 3);
		expect(Math.hypot(hue.cb, hue.cr)).toBeCloseTo(
			Math.hypot(base.cb, base.cr),
			3
		);
		expect(Math.sign(hue.cr)).toBe(Math.sign(layer.cr));
		const saturation = rgbToYcc(componentPixel("saturation", blue, orange));
		expect(Math.hypot(saturation.cb, saturation.cr)).toBeCloseTo(
			Math.hypot(layer.cb, layer.cr),
			3
		);
		expect(Math.sign(saturation.cb)).toBe(Math.sign(base.cb));
	});

	test("a grey layer has no hue, and grey saturation desaturates", () => {
		const luma = rgbToYcc(blue).y;
		expect(
			gap(componentPixel("hue", blue, grey(0.5)), grey(luma))
		).toBeLessThan(1e-4);
		expect(
			gap(componentPixel("saturation", blue, grey(0.5)), grey(luma))
		).toBeLessThan(1e-4);
		expect(
			gap(componentPixel("luminosity", grey(0.5), grey(0.8)), grey(0.8))
		).toBeLessThan(1e-4);
	});

	test("opacity mixes the component result with the base", () => {
		const full = componentPixel("color", blue, orange);
		const half = compositePixel("color", blue, orange, 0.5);
		for (const index of [0, 1, 2] as const) {
			expect(half[index]).toBeCloseTo((blue[index] + full[index]) / 2);
		}
		expect(gap(compositePixel("hue", blue, orange, 0), blue)).toBeLessThan(
			1e-4
		);
	});
});
