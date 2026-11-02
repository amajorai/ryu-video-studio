import { describe, expect, test } from "bun:test";
import {
	clampPlaybackRate,
	isPreviewQuality,
	MEDIA_ELEMENT_MAX_RATE,
	mediaElementPlaybackRate,
	PLAYBACK_RATES,
	playbackRateLabel,
	previewCanvasSize,
	previewQualityScale,
} from "./quality.ts";

describe("preview quality", () => {
	test("scales the canvas by quality", () => {
		expect(previewQualityScale("full")).toBe(1);
		expect(previewQualityScale("half")).toBe(0.5);
		expect(previewQualityScale("quarter")).toBe(0.25);
		expect(previewCanvasSize(1920, 1080, "half")).toEqual({
			height: 540,
			width: 960,
		});
		expect(previewCanvasSize(1, 1, "quarter")).toEqual({ height: 1, width: 1 });
	});

	test("recognises quality values", () => {
		expect(isPreviewQuality("half")).toBe(true);
		expect(isPreviewQuality("eighth")).toBe(false);
	});
});

describe("playback rate", () => {
	test("the menu spans 0.25-10x", () => {
		expect(PLAYBACK_RATES[0]).toBe(0.25);
		expect(PLAYBACK_RATES.at(-1)).toBe(10);
		expect(PLAYBACK_RATES).toContain(1);
	});

	test("clamps timeline rates", () => {
		expect(clampPlaybackRate(0.1)).toBe(0.25);
		expect(clampPlaybackRate(20)).toBe(10);
		expect(clampPlaybackRate(Number.POSITIVE_INFINITY)).toBe(1);
		expect(clampPlaybackRate(2)).toBe(2);
	});

	test("media elements get rate x clip speed, clamped to the browser's 16x", () => {
		expect(mediaElementPlaybackRate(2, 1.5)).toBe(3);
		expect(mediaElementPlaybackRate(10, 4)).toBe(MEDIA_ELEMENT_MAX_RATE);
		expect(mediaElementPlaybackRate(0.25, 0.1)).toBeCloseTo(1 / 16);
		expect(mediaElementPlaybackRate(2, 0)).toBe(2);
		expect(mediaElementPlaybackRate(2, Number.NaN)).toBe(2);
	});

	test("labels", () => {
		expect(playbackRateLabel(0.25)).toBe("0.25x");
		expect(playbackRateLabel(1)).toBe("1x");
		expect(playbackRateLabel(10)).toBe("10x");
	});
});
