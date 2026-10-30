import { describe, expect, test } from "bun:test";
import {
	ANIMATION_BLUR,
	animationCurves,
	animationFrameAt,
	animationInDurationOf,
	animationLoopPeriodOf,
	animationOutDurationOf,
	animationWindows,
	clipAnimationLoops,
	clipAnimationMoves,
	isClipAnimationLoop,
	isClipAnimationMove,
} from "./clip-animation.ts";
import type { ClipAnimation } from "./schema/transition.ts";

const LENGTH = 4;
const frame = (animation: ClipAnimation | undefined, at: number) =>
	animationFrameAt(animationCurves(animation, LENGTH), at);

const settled = {
	blur: 0,
	opacity: 1,
	rotation: 0,
	scale: 1,
	shiftX: 0,
	shiftY: 0,
};

describe("clip animations", () => {
	test("a clip without animation is still", () => {
		expect(animationCurves(undefined, LENGTH)).toEqual(settled);
		expect(animationWindows(undefined, LENGTH)).toEqual([]);
	});

	test("accessors default absent durations", () => {
		expect(animationInDurationOf({})).toBe(0.5);
		expect(animationOutDurationOf({ outDuration: 2 })).toBe(2);
		expect(animationLoopPeriodOf({})).toBe(1);
		expect(isClipAnimationMove("pop")).toBe(true);
		expect(isClipAnimationMove("none")).toBe(false);
		expect(isClipAnimationLoop("none")).toBe(true);
	});

	test("every in-move settles at its duration and every out-move at its start", () => {
		for (const move of clipAnimationMoves) {
			const into = { in: move, inDuration: 1 };
			const settledIn = frame(into, 1);
			expect(settledIn.opacity).toBeCloseTo(1);
			expect(settledIn.scale).toBeCloseTo(1);
			expect(settledIn.rotation).toBeCloseTo(0);
			expect(settledIn.shiftX).toBeCloseTo(0);
			expect(settledIn.shiftY).toBeCloseTo(0);
			expect(settledIn.blur).toBeCloseTo(0);
			const outOf = { out: move, outDuration: 1 };
			expect(frame(outOf, LENGTH - 1).opacity).toBeCloseTo(1);
			expect(frame(outOf, 2).scale).toBeCloseTo(1);
		}
	});

	test("moves start hidden or displaced", () => {
		expect(frame({ in: "fade" }, 0).opacity).toBe(0);
		expect(frame({ in: "pop" }, 0).scale).toBeCloseTo(0.3);
		expect(frame({ in: "zoom" }, 0).scale).toBeCloseTo(0.6);
		expect(frame({ in: "spin" }, 0).rotation).toBeCloseTo(-180);
		expect(frame({ in: "bounce" }, 0).shiftY).toBeCloseTo(-0.3);
		expect(frame({ in: "blur" }, 0).blur).toBe(ANIMATION_BLUR);
		expect(frame({ in: "slide-left" }, 0).shiftX).toBeCloseTo(0.25);
		expect(frame({ in: "slide-up" }, 0).shiftY).toBeCloseTo(0.25);
	});

	test("out-moves continue in the named direction", () => {
		const end = frame({ out: "slide-left", outDuration: 1 }, LENGTH);
		expect(end.shiftX).toBeCloseTo(-0.25);
		expect(end.opacity).toBe(0);
		expect(frame({ out: "slide-down" }, LENGTH).shiftY).toBeCloseTo(0.25);
		expect(frame({ out: "spin" }, LENGTH).rotation).toBeCloseTo(180);
	});

	test("bounce touches down twice before it settles", () => {
		const touches = [0.2, 0.6].map(
			(at) => frame({ in: "bounce", inDuration: 1 }, at).shiftY
		);
		for (const value of touches) {
			expect(Math.abs(value)).toBeLessThan(1e-9);
		}
		expect(frame({ in: "bounce", inDuration: 1 }, 0.4).shiftY).toBeLessThan(0);
	});

	test("loops repeat with their period and never grow the clip", () => {
		for (const loop of clipAnimationLoops) {
			const animation = { loop, loopPeriod: 0.8 };
			const a = frame(animation, 0.3);
			const b = frame(animation, 1.1);
			if (loop !== "spin") {
				expect(a.scale).toBeCloseTo(b.scale);
				expect(a.rotation).toBeCloseTo(b.rotation);
				expect(a.shiftX).toBeCloseTo(b.shiftX);
				expect(a.shiftY).toBeCloseTo(b.shiftY);
			}
			for (let t = 0; t <= LENGTH; t += 0.05) {
				expect(frame(animation, t).scale).toBeLessThanOrEqual(1 + 1e-12);
			}
		}
		expect(frame({ loop: "spin", loopPeriod: 2 }, 1).rotation).toBeCloseTo(180);
		expect(frame({ loop: "pulse" }, 0.5).scale).toBeCloseTo(0.94);
		expect(frame({ loop: "wobble" }, 0.25).rotation).toBeCloseTo(5);
	});

	test("in, out and loop compose", () => {
		const animation: ClipAnimation = {
			in: "fade",
			inDuration: 1,
			loop: "pulse",
			out: "zoom",
			outDuration: 1,
		};
		const middle = frame(animation, 0.5);
		expect(middle.opacity).toBeCloseTo(0.5);
		const late = frame(animation, 3.5);
		expect(late.opacity).toBeCloseTo(0.5);
		expect(late.scale).toBeLessThan(0.9);
		expect(animationWindows(animation, LENGTH)).toEqual([
			[0, 1],
			[3, 4],
		]);
	});

	test("zero durations disable a move", () => {
		expect(frame({ in: "fade", inDuration: 0 }, 0)).toEqual(settled);
		expect(animationWindows({ in: "fade", inDuration: 0 }, LENGTH)).toEqual([]);
	});
});
