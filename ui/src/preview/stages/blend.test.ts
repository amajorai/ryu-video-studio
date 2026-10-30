import { describe, expect, test } from "bun:test";
import { blendModes, blendPreviewGaps } from "../../../../shared/blend.ts";
import {
	newSegment,
	type Segment,
	segmentSchema,
} from "../../../../shared/project.ts";
import { mediaLayerStyle } from "../preview-style.ts";
import {
	blendPreviewContextOf,
	blendStyle,
	clipBackgroundBlendStyle,
	layerBlendStyle,
} from "./blend.ts";

const segment: Segment = segmentSchema.parse(
	newSegment({
		createdAt: "2026-01-01T00:00:00.000Z",
		duration: 4,
		hasAudio: false,
		height: 1080,
		id: "00000000-0000-4000-8000-000000000001",
		kind: "video",
		name: "Clip",
		width: 1920,
	})
);

describe("blend preview stage", () => {
	test("legacy and normal clips add no CSS", () => {
		expect(blendStyle(segment, 0)).toEqual({});
		expect(blendStyle({ ...segment, blendMode: "normal" }, 1)).toEqual({});
		expect(
			"mixBlendMode" in mediaLayerStyle(segment, 0, { active: true })
		).toBe(false);
	});

	test("blended clips set mix-blend-mode on the media layer", () => {
		expect(blendStyle({ ...segment, blendMode: "screen" }, 0)).toEqual({
			mixBlendMode: "screen",
		});
		expect(
			mediaLayerStyle({ ...segment, blendMode: "multiply" }, 0, {
				active: true,
			}).mixBlendMode
		).toBe("multiply");
	});

	test("modes without CSS fall back, add uses plus-lighter", () => {
		expect(layerBlendStyle({ blendMode: "add" })).toEqual({
			mixBlendMode: "plus-lighter",
		});
		expect(layerBlendStyle({ blendMode: "subtract" })).toEqual({
			mixBlendMode: "difference",
		});
		expect(layerBlendStyle({ blendMode: "linear-light" })).toEqual({
			mixBlendMode: "hard-light",
		});
		expect(layerBlendStyle({ blendMode: "pin-light" })).toEqual({
			mixBlendMode: "hard-light",
		});
		for (const mode of ["hue", "saturation", "color", "luminosity"] as const) {
			expect(layerBlendStyle({ blendMode: mode })).toEqual({
				mixBlendMode: mode,
			});
		}
	});

	test("titles and graphics share the same mapping", () => {
		for (const mode of blendModes) {
			const style = layerBlendStyle({ blendMode: mode });
			expect(Object.keys(style)).toEqual(
				mode === "normal" ? [] : ["mixBlendMode"]
			);
		}
	});

	test("a clip background blends with the same mode as its clip", () => {
		const white = { color: "#ffffff", type: "color" } as const;
		for (const mode of blendModes) {
			const blended = { ...segment, background: white, blendMode: mode };
			const media = mediaLayerStyle(blended, 0, { active: true });
			expect(clipBackgroundBlendStyle(blended)).toEqual(blendStyle(blended, 0));
			expect(clipBackgroundBlendStyle(blended).mixBlendMode).toBe(
				media.mixBlendMode
			);
		}
		expect(clipBackgroundBlendStyle(segment)).toEqual({});
	});

	test("the preview context flags backgrounds and partial opacity", () => {
		expect(blendPreviewContextOf(null, segment)).toEqual({
			clipBackground: false,
			partlyTransparent: false,
		});
		const filled = {
			...segment,
			background: { color: "#ffffff", type: "color" } as const,
			blendMode: "multiply" as const,
		};
		expect(blendPreviewContextOf({}, filled).clipBackground).toBe(true);
		expect(
			blendPreviewGaps("multiply", blendPreviewContextOf({}, filled))
		).toEqual(["clip-background"]);
		// The project blur fill applies to base-track clips.
		expect(
			blendPreviewContextOf(
				{ background: { amount: 0.5, dim: 0, type: "blur" } },
				segment
			).clipBackground
		).toBe(segment.track === 0);
		for (const partial of [
			{ opacity: 0.5 },
			{ fadeIn: 0.5 },
			{ fadeOut: 0.5 },
			{ entryTransition: "crossfade" as const },
		]) {
			expect(
				blendPreviewContextOf(null, { ...segment, ...partial })
					.partlyTransparent
			).toBe(true);
		}
		const keyed: Segment = {
			...segment,
			keyframes: [
				{
					id: "00000000-0000-4000-8000-0000000000a1",
					property: "opacity",
					time: 1,
					value: 0.2,
				},
			] as Segment["keyframes"],
		};
		expect(blendPreviewContextOf(null, keyed).partlyTransparent).toBe(true);
		expect(blendPreviewGaps("add", blendPreviewContextOf(null, keyed))).toEqual(
			["add-opacity"]
		);
	});
});
