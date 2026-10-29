import { describe, expect, test } from "bun:test";
import {
	fadeThroughExprs,
	isRevealTransition,
	isShapedReveal,
	newRevealTransition,
	pushExitOf,
	type RevealTransition,
	revealBlurExpr,
	revealCoverage,
	revealFieldExpr,
	revealOffsetExpr,
	revealProgress,
	revealScaleExpr,
	revealShape,
	revealTransitionInfo,
	revealTransitions,
	shapeContains,
} from "./reveal-transitions.ts";
import { evaluate } from "./transition-expr.ts";

const W = 160;
const H = 90;
const hard = (type: RevealTransition) => ({
	...newRevealTransition(type, 1),
	softness: 0,
});
const grid: [number, number][] = [];
for (let x = 2; x < W; x += 9) {
	for (let y = 2; y < H; y += 7) {
		grid.push([x, y]);
	}
}

describe("reveal transitions", () => {
	test("all 24 types have a label and a group", () => {
		expect(revealTransitions).toHaveLength(24);
		for (const type of revealTransitions) {
			expect(revealTransitionInfo[type].label.length).toBeGreaterThan(0);
			expect(isRevealTransition(type)).toBe(true);
		}
		expect(isRevealTransition("spiral")).toBe(false);
	});

	test("progress is eased, clamped and symmetric about the midpoint", () => {
		const transition = hard("dissolve");
		expect(revealProgress(transition, -1)).toBe(0);
		expect(revealProgress(transition, 0)).toBe(0);
		expect(revealProgress(transition, 0.5)).toBeCloseTo(0.5);
		expect(revealProgress(transition, 0.25)).toBeLessThan(0.25);
		expect(
			revealProgress(transition, 0.25) + revealProgress(transition, 0.75)
		).toBeCloseTo(1);
		expect(revealProgress(transition, 1)).toBe(1);
		expect(revealProgress(transition, 9)).toBe(1);
	});

	test("every shaped reveal hides everything at 0 and shows everything at the end", () => {
		for (const type of revealTransitions.filter(isShapedReveal)) {
			for (const softness of [0, 0.5, 1]) {
				const transition = { ...hard(type), softness };
				for (const [x, y] of grid) {
					expect(revealCoverage(transition, 0, { h: H, w: W, x, y })).toBe(0);
					expect(revealCoverage(transition, 1, { h: H, w: W, x, y })).toBe(1);
				}
			}
		}
	});

	test("shaped coverage grows monotonically with time", () => {
		for (const type of revealTransitions.filter(isShapedReveal)) {
			const transition = { ...hard(type), softness: 0.3 };
			for (const [x, y] of grid) {
				let last = 0;
				for (let t = 0; t <= 1; t += 0.1) {
					const value = revealCoverage(transition, t, { h: H, w: W, x, y });
					expect(value).toBeGreaterThanOrEqual(last - 1e-9);
					last = value;
				}
			}
		}
	});

	test("fields are within 0..1 over the frame", () => {
		for (const type of revealTransitions.filter(isShapedReveal)) {
			const field = revealFieldExpr(type);
			expect(field).toBeDefined();
			for (const [x, y] of grid) {
				const value = evaluate(field ?? 0, { h: H, w: W, x, y });
				expect(value).toBeGreaterThanOrEqual(-1e-9);
				expect(value).toBeLessThanOrEqual(1 + 1e-9);
			}
		}
	});

	test("wipes start at the named edge", () => {
		const at = (type: RevealTransition, x: number, y: number) =>
			revealCoverage(hard(type), 0.5, { h: H, w: W, x, y });
		expect(at("wipe-left", 10, 45)).toBe(1);
		expect(at("wipe-left", 150, 45)).toBe(0);
		expect(at("wipe-right", 150, 45)).toBe(1);
		expect(at("wipe-up", 80, 5)).toBe(1);
		expect(at("wipe-up", 80, 85)).toBe(0);
		expect(at("wipe-down", 80, 85)).toBe(1);
		expect(at("circle-open", 80, 45)).toBe(1);
		expect(at("circle-close", 80, 45)).toBe(0);
		expect(at("circle-close", 1, 1)).toBe(1);
		expect(at("diag-tl", 5, 5)).toBe(1);
		expect(at("diag-br", 155, 85)).toBe(1);
	});

	test("the clock wipe sweeps clockwise from 12 o'clock", () => {
		const transition = hard("radial");
		const point = { h: H, w: W };
		// Quarter of the way: the top-right quadrant is revealed, the left is not.
		expect(revealProgress(transition, 0.3)).toBeGreaterThan(0.2);
		const t = 0.38; // progress just above 0.25
		expect(revealProgress(transition, t)).toBeGreaterThan(0.25);
		expect(revealCoverage(transition, t, { ...point, x: 120, y: 20 })).toBe(1);
		expect(revealCoverage(transition, t, { ...point, x: 40, y: 20 })).toBe(0);
		expect(revealCoverage(transition, t, { ...point, x: 120, y: 70 })).toBe(0);
	});

	test("softness widens the edge into a ramp", () => {
		const soft = { ...hard("wipe-left"), softness: 1 };
		const values = [60, 70, 80, 90].map((x) =>
			revealCoverage(soft, 0.5, { h: H, w: W, x, y: 45 })
		);
		expect(values.some((value) => value > 0 && value < 1)).toBe(true);
		expect(values[0]).toBeGreaterThan(values[3] ?? 1);
	});

	test("preview shapes match the render coverage away from the edge", () => {
		const aspect = W / H;
		for (const type of revealTransitions.filter(isShapedReveal)) {
			const transition = hard(type);
			for (const t of [0.15, 0.4, 0.6, 0.85]) {
				const shape = revealShape(type, revealProgress(transition, t), aspect);
				for (const [x, y] of grid) {
					const coverage = revealCoverage(transition, t, { h: H, w: W, x, y });
					const nearEdge = [-2, 2].some((offset) =>
						[
							[x + offset, y],
							[x, y + offset],
						].some(
							([px, py]) =>
								Math.abs(
									revealCoverage(transition, t, {
										h: H,
										w: W,
										x: px ?? 0,
										y: py ?? 0,
									}) - coverage
								) > 0.5
						)
					);
					if (nearEdge) {
						continue;
					}
					expect({
						type,
						t,
						x,
						y,
						inside: shapeContains(shape, x / W, y / H, aspect),
					}).toEqual({
						inside: coverage > 0.5,
						t,
						type,
						x,
						y,
					});
				}
			}
		}
	});

	test("non-shaped reveals: dissolve ramps, slides move, zoom never grows", () => {
		const dissolve = hard("dissolve");
		expect(
			revealCoverage(dissolve, 0.5, { h: H, w: W, x: 1, y: 1 })
		).toBeCloseTo(0.5);
		expect(revealShape("dissolve", 0.5)).toEqual({ kind: "full" });
		const slide = hard("slide-left");
		expect(revealCoverage(slide, 0, { h: H, w: W, x: 1, y: 1 })).toBe(1);
		expect(evaluate(revealOffsetExpr(slide, "x"), { t: 0 })).toBe(1);
		expect(evaluate(revealOffsetExpr(slide, "x"), { t: 1 })).toBe(0);
		expect(evaluate(revealOffsetExpr(hard("slide-up"), "y"), { t: 0 })).toBe(1);
		expect(evaluate(revealOffsetExpr(hard("push-right"), "x"), { t: 0 })).toBe(
			-1
		);
		expect(revealOffsetExpr(hard("wipe-left"), "x")).toBe(0);
		const zoom = revealScaleExpr(hard("zoom"));
		expect(evaluate(zoom, { t: 0 })).toBeCloseTo(0.6);
		expect(evaluate(zoom, { t: 1 })).toBe(1);
		expect(revealScaleExpr(hard("dissolve"))).toBe(1);
		expect(evaluate(revealBlurExpr(hard("blur")), { t: 0 })).toBe(24);
		expect(evaluate(revealBlurExpr(hard("blur")), { t: 1 })).toBe(0);
	});

	test("pushes pair with an exit slide in the same direction", () => {
		expect(pushExitOf("push-left")).toBe("slide-left");
		expect(pushExitOf("push-right")).toBe("slide-right");
		expect(pushExitOf("slide-left")).toBeUndefined();
	});

	test("fades through a color cover first, then tint out", () => {
		const fade = fadeThroughExprs(hard("fade-white"));
		expect(fade?.color).toBe(255);
		const at = (t: number) => ({
			coverage: evaluate(fade?.coverage ?? 0, { t }),
			tint: evaluate(fade?.tint ?? 0, { t }),
		});
		expect(at(0)).toEqual({ coverage: 0, tint: 1 });
		expect(at(0.5)).toEqual({ coverage: 1, tint: 1 });
		expect(at(1)).toEqual({ coverage: 1, tint: 0 });
		expect(fadeThroughExprs(hard("fade-black"))?.color).toBe(0);
		expect(fadeThroughExprs(hard("dissolve"))).toBeUndefined();
	});
});
