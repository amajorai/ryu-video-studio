import { describe, expect, test } from "bun:test";
import { animatedValue } from "../../../../shared/animation.ts";
import { type Keyframe, newSegment } from "../../../../shared/project.ts";
import { testVideo } from "../../editor/test-runtime.ts";
import {
	addKeyframeAt,
	audioKeyframeProperties,
	keyframeClipboard,
	propertyKeyframes,
	setKeyframeClipboard,
	visualKeyframeProperties,
	withBezierControl,
	withInterpolation,
} from "./keyframe-list.ts";

const frame = (keyframe: Omit<Keyframe, "id">): Keyframe => ({
	...keyframe,
	id: crypto.randomUUID(),
});

function clip() {
	const segment = newSegment(testVideo("clip.mp4", 10));
	segment.keyframes = [
		frame({ interpolation: "ease-in", property: "x", time: 0, value: 0 }),
		frame({ property: "x", time: 2, value: 1 }),
		frame({ property: "opacity", time: 1, value: 0.5 }),
	];
	return segment;
}

describe("keyframe list editing", () => {
	test("offers the rendered visual properties and volume", () => {
		const visual = visualKeyframeProperties.map((option) => option.property);
		expect(visual).toContain("cropLeft");
		expect(visual).toContain("temperature");
		expect(visual).not.toContain("effectAmount");
		expect(audioKeyframeProperties.map((option) => option.property)).toEqual([
			"volume",
		]);
	});

	test("lists one property's untargeted keyframes in time order", () => {
		const segment = clip();
		segment.keyframes.reverse();
		expect(propertyKeyframes(segment, "x").map((item) => item.time)).toEqual([
			0, 2,
		]);
	});

	test("adding a keyframe keeps the curve's current value and easing", () => {
		const segment = clip();
		const keyframes = addKeyframeAt(segment, "x", 1);
		const added = keyframes.find(
			(item) => item.property === "x" && item.time === 1
		);
		expect(added?.value).toBeCloseTo(animatedValue(segment, "x", 1));
		// The right half of an ease-in interval is a custom curve.
		expect(added?.interpolation).toBe("bezier");
		const replaced = addKeyframeAt({ ...segment, keyframes }, "x", 1);
		expect(replaced.filter((item) => item.property === "x")).toHaveLength(3);
	});

	test("adding a keyframe inside an eased interval never changes the animation", () => {
		const curves: Pick<Keyframe, "bezier" | "interpolation">[] = [
			{ interpolation: "ease-in" },
			{ interpolation: "ease-out" },
			{ interpolation: "ease-in-out" },
			{ bezier: [0.25, 0.1, 0.25, 1], interpolation: "bezier" },
			{ bezier: [0.42, 0, 0.58, 1], interpolation: "bezier" },
			{ interpolation: "hold" },
		];
		for (const curve of curves) {
			for (const at of [0.5, 1, 1.37]) {
				const segment = newSegment(testVideo("clip.mp4", 10));
				segment.keyframes = [
					frame({ ...curve, property: "opacity", time: 0, value: 0 }),
					frame({ property: "opacity", time: 2, value: 1 }),
				];
				const edited = {
					...segment,
					keyframes: addKeyframeAt(segment, "opacity", at),
				};
				expect(propertyKeyframes(edited, "opacity")).toHaveLength(3);
				for (let i = 0; i <= 40; i++) {
					const time = i * 0.05;
					expect(animatedValue(edited, "opacity", time)).toBeCloseTo(
						animatedValue(segment, "opacity", time),
						4
					);
				}
			}
		}
	});

	test("an overshooting curve keeps its keyframe values when split", () => {
		const segment = newSegment(testVideo("clip.mp4", 10));
		segment.keyframes = [
			frame({
				bezier: [0.6, -0.4, 0.3, 1.4],
				interpolation: "bezier",
				property: "opacity",
				time: 0,
				value: 0,
			}),
			frame({ property: "opacity", time: 2, value: 1 }),
		];
		const edited = {
			...segment,
			keyframes: addKeyframeAt(segment, "opacity", 1),
		};
		// Exact at the keyframes; in between, a sub-curve whose controls leave
		// the schema bounds is the closest allowed fit.
		for (const time of [0, 1, 2]) {
			expect(animatedValue(edited, "opacity", time)).toBeCloseTo(
				animatedValue(segment, "opacity", time),
				5
			);
		}
		for (let i = 0; i <= 40; i++) {
			expect(
				Math.abs(
					animatedValue(edited, "opacity", i * 0.05) -
						animatedValue(segment, "opacity", i * 0.05)
				)
			).toBeLessThan(0.02);
		}
	});

	test("interpolation changes add or drop Bezier controls", () => {
		const segment = clip();
		const id = segment.keyframes[0]?.id as string;
		const bezier = withInterpolation(segment.keyframes, id, "bezier");
		expect(bezier[0]).toMatchObject({
			bezier: [0.25, 0.1, 0.25, 1],
			interpolation: "bezier",
		});
		const edited = withBezierControl(bezier, id, 1, 0.6);
		expect(edited[0]?.bezier).toEqual([0.25, 0.6, 0.25, 1]);
		expect(withInterpolation(edited, id, "bezier")[0]?.bezier).toEqual([
			0.25, 0.6, 0.25, 1,
		]);
		const hold = withInterpolation(edited, id, "hold");
		expect(hold[0]?.bezier).toBeUndefined();
		expect(hold[0]?.interpolation).toBe("hold");
	});

	test("the clipboard store is shared", () => {
		setKeyframeClipboard({ items: [], span: 0 });
		expect(keyframeClipboard()).toEqual({ items: [], span: 0 });
		setKeyframeClipboard(null);
		expect(keyframeClipboard()).toBeNull();
	});
});
