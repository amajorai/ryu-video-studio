import { describe, expect, test } from "bun:test";
import {
	keepsCanvasAspect,
	OUTPUT_RESOLUTIONS,
	outputResolutionError,
	outputResolutionOf,
	outputSizeForResolution,
} from "./output-resolution.ts";

describe("output resolution tiers", () => {
	test("16:9 canvases scale to the standard sizes", () => {
		const canvas = { width: 1920, height: 1080 };
		expect(
			OUTPUT_RESOLUTIONS.map((tier) => outputSizeForResolution(canvas, tier))
		).toEqual([
			{ width: 1280, height: 720 },
			{ width: 1920, height: 1080 },
			{ width: 2560, height: 1440 },
			{ width: 3840, height: 2160 },
		]);
	});

	test("9:16 canvases keep the short side as the width", () => {
		const canvas = { width: 1080, height: 1920 };
		expect(outputSizeForResolution(canvas, "720p")).toEqual({
			width: 720,
			height: 1280,
		});
		expect(outputSizeForResolution(canvas, "4k")).toEqual({
			width: 2160,
			height: 3840,
		});
	});

	test("odd custom ratios keep the aspect with even sizes", () => {
		const fourFive = { width: 1080, height: 1350 };
		expect(outputSizeForResolution(fourFive, "2k")).toEqual({
			width: 1440,
			height: 1800,
		});
		// 1000 × 618 is close to the golden ratio; 1080 × 1.6181 = 1747.57.
		const golden = { width: 1000, height: 618 };
		const size = outputSizeForResolution(golden, "1080p");
		expect(size).toEqual({ width: 1748, height: 1080 });
		expect(size.width % 2).toBe(0);
		expect(Math.abs(size.width / size.height - 1000 / 618)).toBeLessThan(0.002);
		const square = { width: 1000, height: 1000 };
		expect(outputSizeForResolution(square, "4k")).toEqual({
			width: 2160,
			height: 2160,
		});
	});

	test("recognizes the tier a size matches", () => {
		const canvas = { width: 1080, height: 1350 };
		expect(outputResolutionOf(canvas, { width: 1440, height: 1800 })).toBe(
			"2k"
		);
		expect(
			outputResolutionOf(canvas, { width: 1440, height: 1440 })
		).toBeUndefined();
		expect(outputResolutionOf(canvas, {})).toBeUndefined();
	});

	test("refuses tiers whose long side passes the frame limit", () => {
		const wide = { width: 8192, height: 1024 };
		expect(outputResolutionError(wide, "720p")).toBeUndefined();
		expect(outputResolutionError(wide, "4k")).toContain("8192 px limit");
	});
});

test("tier sizes keep the canvas aspect; other sizes do not", () => {
	const odd = { width: 250, height: 154 };
	expect(keepsCanvasAspect(odd, outputSizeForResolution(odd, "720p"))).toBe(
		true
	);
	const wide = { width: 320, height: 180 };
	expect(keepsCanvasAspect(wide, { width: 1280, height: 720 })).toBe(true);
	expect(keepsCanvasAspect(wide, { width: 640, height: 640 })).toBe(false);
	expect(keepsCanvasAspect(wide, { width: 1080, height: 1920 })).toBe(false);
	expect(keepsCanvasAspect(wide, { width: 1280, height: 724 })).toBe(false);
});
