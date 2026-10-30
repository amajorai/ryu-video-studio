import { describe, expect, test } from "bun:test";
import { newProject, segmentSchema } from "../../../../shared/project.ts";
import { mediaLayerFixtures } from "../__fixtures__/media-layer-segments.ts";
import { blendStyle } from "./blend.ts";
import { cropInsetCss } from "./crop.ts";
import { effectFilterCss, vignetteAmount } from "./effects.ts";
import { basicFilterCss } from "./filter-basic.ts";
import { keyStyle } from "./key.ts";
import { edgeRadiusCss, edgeSoftnessFilterCss, maskStyle } from "./mask.ts";
import { transformCss } from "./transform.ts";
import { entryTransitionState, fadeFactor } from "./transitions.ts";
import {
	previewSegmentAudible,
	previewSegmentVisible,
	segmentActiveAt,
} from "./visibility.ts";

const segments = mediaLayerFixtures.map((fixture) =>
	segmentSchema.parse(fixture.segment)
);
const byName = (name: string) => {
	const index = mediaLayerFixtures.findIndex((entry) => entry.name === name);
	const segment = segments[index];
	if (!segment) {
		throw new Error(`missing fixture ${name}`);
	}
	return segment;
};

describe("identity stages", () => {
	test("blend, mask and key add no CSS yet", () => {
		for (const segment of segments) {
			expect(blendStyle(segment, 0)).toEqual({});
			expect(maskStyle(segment, 0)).toEqual({});
			expect(keyStyle(segment, 0)).toEqual({});
		}
	});

	test("every clip is visible; audibility follows the track", () => {
		const project = newProject();
		const segment = byName("plain clip mid-way");
		expect(previewSegmentVisible(project, segment)).toBe(true);
		expect(previewSegmentAudible(project, segment)).toBe(true);
		project.trackSettings = [
			{ locked: false, muted: true, name: "V1", solo: false, track: 0 },
		];
		expect(previewSegmentAudible(project, segment)).toBe(false);
	});
});

describe("current-behaviour stages", () => {
	test("active window is half-open and speed-aware", () => {
		const segment = byName("grayscale fading out on an upper track");
		expect(segmentActiveAt(segment, 1.99)).toBe(false);
		expect(segmentActiveAt(segment, 2)).toBe(true);
		expect(segmentActiveAt(segment, 6.99)).toBe(true);
		expect(segmentActiveAt(segment, 7)).toBe(false);
	});

	test("crop, edges and filters", () => {
		const cropped = byName("crop with rounded soft edges");
		expect(cropInsetCss(cropped, 0)).toBe("15% 20% 5% 10%");
		expect(edgeRadiusCss(cropped, 0)).toBe("25%");
		expect(edgeSoftnessFilterCss(cropped, 0)).toBe(" blur(6px)");
		expect(edgeSoftnessFilterCss(byName("plain clip mid-way"), 0)).toBe("");
		const graded = byName("sepia with a colour grade");
		expect(effectFilterCss(graded, 0)).toBe("sepia(1) ");
		expect(basicFilterCss(graded, 0)).toBe(
			"brightness(1.4) contrast(1.3) saturate(0.84) hue-rotate(-7.5deg)"
		);
		const stacked = byName("legacy blur with an effect stack");
		expect(effectFilterCss(stacked, 0)).toBe(
			"blur(2px) blur(1.00px) contrast(1.060) sepia(0.4)"
		);
		expect(vignetteAmount(stacked, 0)).toBe(0.6);
		expect(vignetteAmount(graded, 0)).toBe(0);
	});

	test("transitions feed the transform", () => {
		const sliding = byName("slide-left entry transition");
		const entry = entryTransitionState(sliding, 0.25);
		expect(entry).toEqual({ opacity: 1, scale: 1, shiftX: 0.75, shiftY: 0 });
		expect(transformCss(sliding, 0.25, entry)).toBe(
			"translate(85%, 0%) scale(1) rotate(0deg)"
		);
		const fading = byName("crossfade entry with fades");
		expect(fadeFactor(fading, 0.3)).toBeCloseTo(0.3);
		expect(fadeFactor(fading, 9)).toBeCloseTo(0.5);
		expect(fadeFactor(fading, 11)).toBeLessThan(0);
	});
});
