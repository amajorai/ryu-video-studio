import { describe, expect, test } from "bun:test";
import {
	canPan,
	clampPan,
	clampPreviewZoom,
	displayedFrameSize,
	fitScale,
	NO_PAN,
	panLimits,
	previewZoomLabel,
	stepPreviewZoom,
	viewportScale,
	viewportTransform,
	zoomScale,
} from "./viewport-math.ts";

const stage = { height: 540, width: 960 };
const frame = { height: 1080, width: 1920 };
const tall = { height: 1920, width: 1080 };

describe("preview zoom math", () => {
	test("fit uses the largest scale that fits both axes", () => {
		expect(fitScale(stage, frame)).toBe(0.5);
		expect(fitScale(stage, tall)).toBeCloseTo(540 / 1920);
		expect(fitScale({ height: 0, width: 0 }, frame)).toBe(1);
	});

	test("numeric zoom is project pixels to screen pixels, clamped to 25-400%", () => {
		expect(zoomScale(1, stage, frame)).toBe(1);
		expect(zoomScale("fit", stage, frame)).toBe(0.5);
		expect(clampPreviewZoom(0.1)).toBe(0.25);
		expect(clampPreviewZoom(9)).toBe(4);
		expect(clampPreviewZoom(Number.NaN)).toBe(1);
	});

	test("the viewport scale is relative to the fitted frame", () => {
		expect(viewportScale("fit", stage, frame)).toBe(1);
		expect(viewportScale(1, stage, frame)).toBe(2);
		expect(viewportScale(0.25, stage, frame)).toBe(0.5);
		// Unmeasured stage: no transform rather than a guess.
		expect(viewportScale(2, { height: 0, width: 0 }, frame)).toBe(1);
		expect(displayedFrameSize(1, stage, frame)).toEqual(frame);
	});

	test("labels", () => {
		expect(previewZoomLabel("fit")).toBe("Fit");
		expect(previewZoomLabel(0.25)).toBe("25%");
		expect(previewZoomLabel(1.5)).toBe("150%");
		expect(previewZoomLabel(10)).toBe("400%");
	});

	test("stepping walks the menu levels from the current scale", () => {
		expect(stepPreviewZoom("fit", 1, stage, frame)).toBe(0.75);
		expect(stepPreviewZoom("fit", -1, stage, frame)).toBe(0.25);
		expect(stepPreviewZoom(4, 1, stage, frame)).toBe(4);
		expect(stepPreviewZoom(0.25, -1, stage, frame)).toBe(0.25);
		expect(stepPreviewZoom(1, 1, stage, frame)).toBe(1.5);
	});
});

describe("preview pan math", () => {
	test("panning is only possible on an overflowing axis", () => {
		expect(panLimits("fit", stage, frame)).toEqual(NO_PAN);
		expect(canPan("fit", stage, frame)).toBe(false);
		expect(canPan(0.5, stage, frame)).toBe(false);
		expect(panLimits(1, stage, frame)).toEqual({ x: 480, y: 270 });
		expect(canPan(1, stage, frame)).toBe(true);
		// A tall frame at 50% overflows vertically only.
		expect(panLimits(0.5, stage, tall)).toEqual({ x: 0, y: 210 });
	});

	test("pans are clamped so the frame keeps covering the stage", () => {
		expect(clampPan({ x: 999, y: -999 }, 1, stage, frame)).toEqual({
			x: 480,
			y: -270,
		});
		expect(clampPan({ x: 50, y: 50 }, "fit", stage, frame)).toEqual(NO_PAN);
		expect(clampPan({ x: 50, y: 50 }, 0.5, stage, tall)).toEqual({
			x: 0,
			y: 50,
		});
	});

	test("the identity transform is omitted", () => {
		expect(viewportTransform(1, NO_PAN)).toBeUndefined();
		expect(viewportTransform(2, { x: -10, y: 5 })).toBe(
			"translate(-10px, 5px) scale(2)"
		);
	});
});
