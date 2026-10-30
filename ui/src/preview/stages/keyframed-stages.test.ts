import { describe, expect, test } from "bun:test";
import { animatedValue } from "../../../../shared/animation.ts";
import {
	type Keyframe,
	newSegment,
	type Segment,
} from "../../../../shared/project.ts";
import { testVideo } from "../../editor/test-runtime.ts";
import { cropInsetCss } from "./crop.ts";
import { basicFilterCss } from "./filter-basic.ts";

function clip(keyframes: Omit<Keyframe, "id">[], patch: Partial<Segment> = {}) {
	return {
		...newSegment(testVideo("clip.mp4", 10)),
		...patch,
		keyframes: keyframes.map((frame) => ({
			...frame,
			id: crypto.randomUUID(),
		})),
	};
}

describe("keyframed preview crop", () => {
	test("edges follow their eased curves", () => {
		const segment = clip(
			[
				{ interpolation: "ease-in", property: "cropLeft", time: 0, value: 0 },
				{ property: "cropLeft", time: 2, value: 0.4 },
				{ interpolation: "hold", property: "cropBottom", time: 0, value: 0.2 },
				{ property: "cropBottom", time: 1, value: 0 },
			],
			{ crop: { bottom: 0, left: 0, right: 0.1, top: 0.05 } }
		);
		expect(cropInsetCss(segment, 1)).toBe("5% 10% 0% 10%");
		expect(cropInsetCss(segment, 0.5)).toBe("5% 10% 20% 2.5%");
	});

	test("eased overshoot is clamped to the crop range", () => {
		const segment = clip([
			{
				bezier: [0.68, -0.6, 0.32, 1.6],
				interpolation: "bezier",
				property: "cropTop",
				time: 0,
				value: 0,
			},
			{ property: "cropTop", time: 2, value: 0.9 },
		]);
		for (let i = 0; i <= 20; i++) {
			const [top] = cropInsetCss(segment, i / 10).split(" ");
			const percent = Number(top?.replace("%", ""));
			expect(percent).toBeGreaterThanOrEqual(0);
			expect(percent).toBeLessThanOrEqual(90);
		}
	});
});

describe("keyframed preview color", () => {
	test("brightness, exposure, contrast and temperature animate", () => {
		const segment = clip(
			[
				{
					interpolation: "ease-out",
					property: "brightness",
					time: 0,
					value: 0,
				},
				{ property: "brightness", time: 2, value: 0.4 },
				{ property: "exposure", time: 0, value: 0.3 },
				{ property: "contrast", time: 0, value: 1 },
				{ property: "contrast", time: 2, value: 2 },
				{ property: "temperature", time: 0, value: 0 },
				{ property: "temperature", time: 2, value: 1 },
			],
			{ colorGrade: { exposure: 0, temperature: 0, tint: 0, vibrance: 0 } }
		);
		const brightness = 1 + animatedValue(segment, "brightness", 1) + 0.1;
		expect(basicFilterCss(segment, 1)).toBe(
			`brightness(${brightness}) contrast(1.5) saturate(1) hue-rotate(-3deg)`
		);
	});

	test("negative eased values are clamped for CSS", () => {
		const segment = clip([
			{
				bezier: [0.68, -0.6, 0.32, 1.6],
				interpolation: "bezier",
				property: "saturation",
				time: 0,
				value: 0,
			},
			{ property: "saturation", time: 2, value: 3 },
		]);
		expect(basicFilterCss(segment, 0.3)).toContain("saturate(0)");
	});
});
