import { describe, expect, test } from "bun:test";
import { compileFfmpegExpression } from "./ffmpeg-expression-eval.ts";
import {
	type BezierControls,
	bezierPieces,
	cubicBezierProgress,
	type EasingPiece,
	easedProgress,
	easingControls,
	easingExpression,
	evaluatePiece,
	expressionNumber,
	namedEasing,
	splitEasing,
} from "./keyframe-easing.ts";

const samples = Array.from({ length: 51 }, (_, index) => index / 50);

/** Presets the graph editor offers, plus extreme schema corners. */
const curves: BezierControls[] = [
	[0.25, 0.1, 0.25, 1],
	[0.42, 0, 1, 1],
	[0, 0, 0.58, 1],
	[0.42, 0, 0.58, 1],
	[0.34, 1.56, 0.64, 1],
	[0.68, -0.6, 0.32, 1.6],
	[0, 1, 1, 0],
	[0, 2, 1, -1],
	[1, 0, 0, 1],
	[0, 0, 1, 1],
];

describe("easedProgress", () => {
	test("polynomial easings match their closed forms", () => {
		for (const u of samples) {
			expect(easedProgress("linear", u)).toBeCloseTo(u, 12);
			expect(easedProgress("ease-in", u)).toBeCloseTo(u * u, 12);
			expect(easedProgress("ease-out", u)).toBeCloseTo(1 - (1 - u) ** 2, 12);
			expect(easedProgress("ease-in-out", u)).toBeCloseTo(
				3 * u * u - 2 * u ** 3,
				12
			);
		}
	});

	test("hold stays at the start value until the next keyframe", () => {
		expect(easedProgress("hold", 0)).toBe(0);
		expect(easedProgress("hold", 0.999)).toBe(0);
		expect(easedProgress("hold", 1)).toBe(1);
	});

	test("progress is clamped outside the interval", () => {
		expect(easedProgress("ease-in", -1)).toBe(0);
		expect(easedProgress("ease-out", 2)).toBe(1);
	});

	test("polynomial easings are exactly their Bezier controls", () => {
		for (const kind of [
			"linear",
			"ease-in",
			"ease-out",
			"ease-in-out",
		] as const) {
			const controls = easingControls(kind);
			expect(controls).not.toBeNull();
			for (const u of samples) {
				expect(cubicBezierProgress(controls as BezierControls, u)).toBeCloseTo(
					easedProgress(kind, u),
					9
				);
			}
		}
		expect(easingControls("hold")).toBeNull();
	});

	test("Bezier solving hits CSS reference values and endpoints", () => {
		// CSS `ease` at 50% time is ~0.8024 progress.
		expect(cubicBezierProgress([0.25, 0.1, 0.25, 1], 0.5)).toBeCloseTo(
			0.802_403_387_739_911_2,
			6
		);
		for (const curve of curves) {
			expect(cubicBezierProgress(curve, 0)).toBeCloseTo(0, 9);
			expect(cubicBezierProgress(curve, 1)).toBeCloseTo(1, 9);
		}
	});

	test("Bezier overshoot leaves the 0..1 progress range", () => {
		const back: BezierControls = [0.34, 1.56, 0.64, 1];
		expect(
			Math.max(...samples.map((u) => cubicBezierProgress(back, u)))
		).toBeGreaterThan(1);
	});
});

describe("render expressions", () => {
	test("each easing expression equals the JS curve at 50 points", () => {
		for (const kind of ["ease-in", "ease-out", "ease-in-out"] as const) {
			const run = compileFfmpegExpression(easingExpression(kind, "u"));
			for (const u of samples) {
				expect(run({ u })).toBeCloseTo(easedProgress(kind, u), 9);
			}
		}
		expect(easingExpression("hold", "u")).toBe("0");
	});

	test("Bezier piecewise cubic fit stays within 1% everywhere", () => {
		for (const curve of curves) {
			const run = compileFfmpegExpression(
				easingExpression("bezier", "u", curve)
			);
			let worst = 0;
			for (let i = 0; i <= 1000; i++) {
				const u = i / 1000;
				worst = Math.max(
					worst,
					Math.abs(run({ u }) - cubicBezierProgress(curve, u))
				);
			}
			expect(worst).toBeLessThan(0.01);
		}
	});

	test("the fit uses at least four pieces, more only for steep curves", () => {
		expect(bezierPieces([0.42, 0, 0.58, 1])).toHaveLength(4);
		const steep = bezierPieces([0, 2, 1, -1]);
		expect(steep.length).toBeGreaterThan(4);
		expect(steep.length).toBeLessThanOrEqual(32);
		expect(steep[0]?.from).toBe(0);
		expect(steep.at(-1)?.to).toBe(1);
	});

	test("a piece limit caps the fit and keeps the ends exact", () => {
		const steep: BezierControls = [0, 2, 1, -1];
		for (const limit of [1, 2, 3, 6]) {
			const pieces = bezierPieces(steep, 0.002, limit);
			expect(pieces).toHaveLength(limit);
			expect(pieces[0]?.from).toBe(0);
			expect(pieces.at(-1)?.to).toBe(1);
			expect(evaluatePiece(pieces[0] as EasingPiece, 0)).toBeCloseTo(0, 9);
			expect(evaluatePiece(pieces.at(-1) as EasingPiece, 1)).toBeCloseTo(1, 9);
		}
		expect(bezierPieces(steep, 0.002, 0)).toHaveLength(1);
		expect(bezierPieces(steep, 0.002, 500).length).toBeLessThanOrEqual(32);
	});

	test("the fit is deterministic", () => {
		const curve: BezierControls = [0.68, -0.6, 0.32, 1.6];
		expect(easingExpression("bezier", "u", curve)).toBe(
			easingExpression("bezier", "u", curve)
		);
	});

	test("numbers never use exponent notation", () => {
		expect(expressionNumber(1e-12)).toBe("0");
		expect(expressionNumber(-0)).toBe("0");
		expect(expressionNumber(0.123_456_789_123_4)).toBe("0.123456789");
		expect(expressionNumber(1e21)).not.toContain("e");
	});
});

describe("splitEasing", () => {
	/** Worst distance between the two halves and the original curve. */
	const splitError = (
		kind: Parameters<typeof splitEasing>[0],
		u: number,
		bezier?: BezierControls
	) => {
		const split = splitEasing(kind, u, bezier);
		const value = (t: number) => easedProgress(kind, t, bezier);
		let worst = Math.abs(split.progress - value(u));
		for (const v of samples) {
			const left =
				split.progress * easedProgress(split.left.kind, v, split.left.bezier);
			const right =
				split.progress +
				(1 - split.progress) *
					easedProgress(split.right.kind, v, split.right.bezier);
			worst = Math.max(
				worst,
				Math.abs(left - value(v * u)),
				Math.abs(right - value(u + v * (1 - u)))
			);
		}
		return worst;
	};

	test("subdivides polynomial easings exactly", () => {
		expect(splitError("ease-in", 0.5)).toBeLessThan(1e-5);
		expect(splitError("ease-out", 0.3)).toBeLessThan(1e-5);
		expect(splitError("ease-in-out", 0.7)).toBeLessThan(1e-5);
	});

	test("an ease-in half is still ease-in on the left", () => {
		expect(splitEasing("ease-in", 0.5).left).toEqual({ kind: "ease-in" });
	});

	test("subdivides Bezier curves exactly", () => {
		expect(splitError("bezier", 0.4, [0.25, 0.1, 0.25, 1])).toBeLessThan(1e-5);
		expect(splitError("bezier", 0.25, [0.42, 0, 0.58, 1])).toBeLessThan(1e-5);
	});

	test("linear and hold halves keep their kind", () => {
		expect(splitEasing("linear", 0.5)).toEqual({
			left: { kind: "linear" },
			progress: 0.5,
			right: { kind: "linear" },
		});
		expect(splitEasing("hold", 0.5)).toEqual({
			left: { kind: "hold" },
			progress: 0,
			right: { kind: "hold" },
		});
	});

	test("an unrepresentable half keeps the original curve", () => {
		// The overshoot returns to the split value, so a half has no rise.
		const curve: BezierControls = [0, 2, 1, -1];
		const split = splitEasing("bezier", 0.5, curve);
		for (const half of [split.left, split.right]) {
			if (half.kind === "bezier") {
				const [x1, y1, x2, y2] = half.bezier as BezierControls;
				expect(x1).toBeGreaterThanOrEqual(0);
				expect(x2).toBeLessThanOrEqual(1);
				expect(y1).toBeGreaterThanOrEqual(-1);
				expect(y2).toBeLessThanOrEqual(2);
			}
		}
	});

	test("namedEasing recognises preset controls", () => {
		expect(namedEasing([1 / 3, 0, 2 / 3, 1])).toBe("ease-in-out");
		expect(namedEasing([0.25, 0.1, 0.25, 1])).toBeUndefined();
	});
});
