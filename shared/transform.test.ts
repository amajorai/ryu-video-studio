import { describe, expect, test } from "bun:test";
import { type Asset, newSegment, segmentSchema } from "./project.ts";
import {
	clipBox,
	clipContentSize,
	fillCrop,
	fillCropWithin,
	fitModeOf,
	fittedSize,
	flipFactors,
	flipOf,
	hasUniformBox,
	maxScaleOf,
	objectFitFor,
	previewScaleFactors,
} from "./transform.ts";

const video: Asset = {
	createdAt: "2026-01-01T00:00:00.000Z",
	duration: 4,
	hasAudio: false,
	height: 1080,
	id: "00000000-0000-4000-8000-000000000001",
	kind: "video",
	name: "Clip",
	width: 1920,
};

const uniform = { scale: 1, scaleX: 1, scaleY: 1 };
const landscape = { height: 1080, width: 1920 };
const portrait = { height: 1920, width: 1080 };

describe("accessors", () => {
	test("legacy clips fit, are unflipped and have a uniform box", () => {
		const segment = newSegment(video);
		expect(fitModeOf(segment)).toBe("fit");
		expect(flipOf(segment)).toEqual({ horizontal: false, vertical: false });
		expect(flipFactors(segment)).toEqual({ x: 1, y: 1 });
		expect(hasUniformBox(segment)).toBe(true);
		expect(maxScaleOf(segment, "scaleX")).toBe(1);
	});
	test("flags and scale channels are read through", () => {
		const segment = segmentSchema.parse({
			...newSegment(video),
			fit: "stretch",
			flipH: true,
			keyframes: [
				{
					id: "00000000-0000-4000-8000-000000000002",
					property: "scaleY",
					time: 1,
					value: 2.5,
				},
			],
			scaleX: 0.5,
		});
		expect(fitModeOf(segment)).toBe("stretch");
		expect(flipFactors(segment)).toEqual({ x: -1, y: 1 });
		expect(hasUniformBox(segment)).toBe(false);
		expect(maxScaleOf(segment, "scaleX")).toBe(0.5);
		expect(maxScaleOf(segment, "scaleY")).toBe(2.5);
		expect(hasUniformBox({ ...segment, keyframes: [], scaleX: 1 })).toBe(true);
	});
});

describe("fillCrop", () => {
	test("16:9 media covering a 9:16 frame crops the sides", () => {
		const crop = fillCrop(1920, 1080, 1080, 1920);
		expect(crop.top).toBe(0);
		expect(crop.bottom).toBe(0);
		expect(crop.left).toBe(crop.right);
		// Kept width is (9/16) / (16/9) = 81/256 of the source.
		expect(1 - crop.left - crop.right).toBeCloseTo(81 / 256, 5);
	});
	test("9:16 media covering a 16:9 frame crops top and bottom", () => {
		const crop = fillCrop(1080, 1920, 1920, 1080);
		expect(crop.left).toBe(0);
		expect(crop.top).toBe(crop.bottom);
		expect(1 - crop.top - crop.bottom).toBeCloseTo(81 / 256, 5);
	});
	test("matching aspects and degenerate sizes crop nothing", () => {
		const none = { bottom: 0, left: 0, right: 0, top: 0 };
		expect(fillCrop(1280, 720, 1920, 1080)).toEqual(none);
		expect(fillCrop(0, 720, 1920, 1080)).toEqual(none);
		expect(fillCrop(1280, 720, 1920, 0)).toEqual(none);
	});
	test("merges with a user crop and stays within the crop schema", () => {
		const merged = fillCropWithin(
			{ bottom: 0, left: 0.25, right: 0, top: 0 },
			1920,
			1080,
			1080,
			1920
		);
		// The 1440x1080 remainder covers 9:16 with 607.5 px of width.
		expect(merged.left).toBeCloseTo(0.25 + ((1 - 607.5 / 1440) / 2) * 0.75, 5);
		expect((1 - merged.left - merged.right) * 1920).toBeCloseTo(607.5, 3);
		expect(merged.top).toBe(0);
		const extreme = fillCropWithin(
			{ bottom: 0, left: 0.85, right: 0, top: 0 },
			3840,
			100,
			100,
			3840
		);
		expect(extreme.left).toBeLessThanOrEqual(0.9);
		expect(extreme.left + extreme.right).toBeLessThan(1);
	});
});

describe("box geometry", () => {
	test("fit letterboxes without distortion; fill and stretch take the box", () => {
		const box = { height: 1080, width: 960 };
		expect(fittedSize("fit", landscape, box)).toEqual({
			height: 540,
			width: 960,
		});
		expect(fittedSize("fill", landscape, box)).toEqual(box);
		expect(fittedSize("stretch", landscape, box)).toEqual(box);
		expect(fittedSize("fit", { height: 0, width: 0 }, box)).toEqual({
			height: 0,
			width: 0,
		});
	});
	test("the box multiplies scale by scale X and Y", () => {
		expect(clipBox(landscape, { scale: 0.5, scaleX: 2, scaleY: 0.5 })).toEqual({
			height: 270,
			width: 1920,
		});
	});
	test("content size honours the user crop", () => {
		const segment = {
			...newSegment(video),
			crop: { bottom: 0, left: 0.25, right: 0.25, top: 0 },
		};
		expect(clipContentSize(segment, landscape, landscape, uniform)).toEqual({
			height: 1080,
			width: 960,
		});
		expect(
			clipContentSize(
				{ ...segment, fit: "fill" },
				landscape,
				landscape,
				uniform
			)
		).toEqual(landscape);
	});
});

describe("preview scale factors", () => {
	test("uniform boxes reproduce the legacy scale", () => {
		for (const mode of ["fit", "fill", "stretch"] as const) {
			expect(previewScaleFactors(mode, { ...uniform, scale: 1.5 })).toEqual({
				exact: true,
				x: 1.5,
				y: 1.5,
			});
		}
	});
	test("stretch scales each axis; fit and fill stay uniform", () => {
		const scales = { scale: 1, scaleX: 0.5, scaleY: 1 };
		expect(previewScaleFactors("stretch", scales)).toEqual({
			exact: true,
			x: 0.5,
			y: 1,
		});
		expect(previewScaleFactors("fit", scales)).toEqual({
			exact: false,
			x: 0.5,
			y: 0.5,
		});
		expect(previewScaleFactors("fill", scales).x).toBe(1);
		expect(previewScaleFactors("fill", scales).exact).toBe(false);
	});
	test("known media dimensions give exact factors", () => {
		const media = { canvas: landscape, media: portrait };
		// Portrait media fits a full canvas at 607.5 px wide; stretched it spans 1920.
		const stretch = previewScaleFactors("stretch", uniform, media);
		expect(stretch.x).toBeCloseTo(1920 / 607.5, 6);
		expect(stretch.y).toBe(1);
		// Fill covers the width: the uniform factor is 1920 / 607.5 and the
		// overflow is hidden by the canvas.
		const fill = previewScaleFactors("fill", uniform, media);
		expect(fill.x).toBeCloseTo(1920 / 607.5, 6);
		expect(fill.exact).toBe(true);
		const small = previewScaleFactors(
			"fill",
			{ ...uniform, scale: 0.5 },
			media
		);
		expect(small.exact).toBe(false);
		const fit = previewScaleFactors(
			"fit",
			{ scale: 1, scaleX: 0.25, scaleY: 1 },
			media
		);
		// A 480x1080 box holds the 9:16 media at 480 px wide.
		expect(fit.x).toBeCloseTo(480 / 607.5, 6);
		expect(fit.y).toBe(fit.x);
	});
	test("a non-uniform fit box without media sizes is not exact", () => {
		// A 16:9 clip in a 9:16 project with Scale Y 0.5: the render keeps it
		// full width, which the canvas-shaped guess cannot know.
		const scales = { scale: 1, scaleX: 1, scaleY: 0.5 };
		const guess = previewScaleFactors("fit", scales);
		expect(guess.exact).toBe(false);
		const known = previewScaleFactors("fit", scales, {
			canvas: portrait,
			media: landscape,
		});
		expect(known).toEqual({ exact: true, x: 1, y: 1 });
		const content = clipContentSize(
			{ crop: { bottom: 0, left: 0, right: 0, top: 0 } },
			landscape,
			portrait,
			scales
		);
		expect(content.width).toBe(1080);
		expect(content.height).toBeCloseTo(607.5, 6);
	});
	test("object-fit mirrors the fit mode", () => {
		expect(objectFitFor("fit")).toBe("contain");
		expect(objectFitFor("fill")).toBe("cover");
		expect(objectFitFor("stretch")).toBe("fill");
	});
});
