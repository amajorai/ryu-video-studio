import { describe, expect, test } from "bun:test";
import {
	type Asset,
	newSegment,
	type Segment,
} from "../../../../shared/project.ts";
import {
	isShapedReveal,
	revealProgress,
	revealShape,
	revealTransitions,
} from "../../../../shared/reveal-transitions.ts";
import { clipMotionAt } from "../../../../shared/transitions.ts";
import {
	entryTransitionState,
	revealShapeCss,
	revealStyle,
} from "./transitions.ts";

const video: Asset = {
	createdAt: "2026-01-01T00:00:00.000Z",
	duration: 10,
	hasAudio: false,
	height: 1080,
	id: "00000000-0000-4000-8000-000000000001",
	kind: "video",
	name: "Clip",
	width: 1920,
};
const clip = (patch: Partial<Segment> = {}): Segment => ({
	...newSegment(video, 2),
	sourceOut: 4,
	...patch,
});

describe("preview transition stage", () => {
	test("legacy clips keep the four-field state", () => {
		expect(entryTransitionState(clip(), 1)).toEqual({
			opacity: 1,
			scale: 1,
			shiftX: 0,
			shiftY: 0,
		});
	});

	test("sampled preview motion equals the render curves", () => {
		const animated = clip({
			animation: { in: "spin", loop: "shake", out: "slide-up" },
			exitDuration: 0.6,
			exitTransition: "zoom-out",
			transitionIn: { duration: 1, softness: 0, type: "zoom" },
		});
		for (let t = 0; t <= 4; t += 0.25) {
			const motion = clipMotionAt(animated, t);
			const state = entryTransitionState(animated, t);
			expect(state.opacity).toBeCloseTo(motion.opacity);
			expect(state.scale).toBeCloseTo(motion.scale);
			expect(state.shiftX).toBeCloseTo(motion.shiftX);
			expect(state.shiftY).toBeCloseTo(motion.shiftY);
			expect(state.rotation ?? 0).toBeCloseTo(motion.rotation);
			expect(state.blur ?? 0).toBeCloseTo(motion.blur);
		}
	});

	test("fades through a color hide the clip for the first half", () => {
		const fade = clip({
			transitionIn: { duration: 1, softness: 0, type: "fade-black" },
		});
		expect(entryTransitionState(fade, 0).opacity).toBe(0);
		expect(entryTransitionState(fade, 0.6).opacity).toBe(1);
		expect(revealStyle(fade, 0.2)).toEqual({ filter: "brightness(0)" });
		expect(revealStyle(fade, 1)).toEqual({});
		const white = clip({
			transitionIn: { duration: 1, softness: 0, type: "fade-white" },
		});
		expect(revealStyle(white, 0.2).filter).toContain("contrast(0)");
	});

	test("shaped reveals become clip paths from the shared shape", () => {
		const wipe = clip({
			transitionIn: { duration: 1, softness: 0, type: "wipe-left" },
		});
		expect(revealStyle(wipe, 0.5)).toEqual({ clipPath: "inset(0% 50% 0% 0%)" });
		expect(revealStyle(wipe, 2)).toEqual({});
		expect(revealStyle(clip(), 0.5)).toEqual({});
		expect(revealShapeCss({ kind: "circle", radius: 1 })).toEqual({
			clipPath: "circle(70.7107% at 50% 50%)",
		});
		expect(revealShapeCss({ kind: "none" })).toEqual({
			clipPath: "inset(50% 50% 50% 50%)",
		});
		const outside = revealShapeCss({ kind: "outside-circle", radius: 0.4 });
		expect(outside.maskImage).toContain("transparent 40%, #000 40%");
		for (const type of revealTransitions.filter(isShapedReveal)) {
			const transition = { duration: 1, softness: 0, type };
			const shape = revealShape(type, revealProgress(transition, 0.4));
			expect(Object.keys(revealShapeCss(shape)).length).toBeGreaterThan(0);
		}
	});
});
