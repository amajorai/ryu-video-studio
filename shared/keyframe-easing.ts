/**
 * Keyframe easing math shared by the preview (JS) and the render (FFmpeg
 * expressions), so both sample the same curve.
 *
 * A keyframe's `interpolation` shapes the interval from that keyframe to the
 * next one. Every non-hold easing is a cubic Bezier in the CSS
 * `cubic-bezier(x1, y1, x2, y2)` sense: progress `u` (0..1 of the interval's
 * time) maps to eased progress `y` (0..1 of the value change, overshooting
 * when a `y` control point leaves 0..1).
 */

export type KeyframeEasing =
	| "linear"
	| "hold"
	| "ease-in"
	| "ease-out"
	| "ease-in-out"
	| "bezier";

/** CSS-style cubic Bezier control points `(x1, y1, x2, y2)`. */
export type BezierControls = [number, number, number, number];

/** `ease` from CSS; used when a `bezier` keyframe somehow lacks controls. */
export const DEFAULT_KEYFRAME_BEZIER: BezierControls = [0.25, 0.1, 0.25, 1];

const third = 1 / 3;
const twoThirds = 2 / 3;

/**
 * The polynomial easings are exact cubic Beziers whose time controls are
 * evenly spaced (`x(s) = s`): ease-in `u²`, ease-out `1-(1-u)²` and
 * ease-in-out `3u²-2u³`. Linear is the straight line.
 */
const polynomialControls: Record<
	"linear" | "ease-in" | "ease-out" | "ease-in-out",
	BezierControls
> = {
	linear: [third, third, twoThirds, twoThirds],
	"ease-in": [third, 0, twoThirds, third],
	"ease-out": [third, twoThirds, twoThirds, 1],
	"ease-in-out": [third, 0, twoThirds, 1],
};

/** Bezier controls of an easing, or `null` for hold (a step). */
export function easingControls(
	kind: KeyframeEasing,
	bezier?: BezierControls
): BezierControls | null {
	if (kind === "hold") {
		return null;
	}
	if (kind === "bezier") {
		return bezier ?? DEFAULT_KEYFRAME_BEZIER;
	}
	return polynomialControls[kind];
}

const clampUnit = (u: number) => Math.min(1, Math.max(0, u));

function bezierCoordinate(s: number, p1: number, p2: number): number {
	const inverse = 1 - s;
	return 3 * inverse * inverse * s * p1 + 3 * inverse * s * s * p2 + s * s * s;
}

function bezierSlope(s: number, p1: number, p2: number): number {
	const inverse = 1 - s;
	return (
		3 * inverse * inverse * p1 +
		6 * inverse * s * (p2 - p1) +
		3 * s * s * (1 - p2)
	);
}

/**
 * The curve parameter `s` whose time coordinate is `u`. Newton iteration from
 * `s = u`, falling back to bisection where the slope is flat; `x1, x2` in
 * 0..1 keep `x(s)` monotonic, so the root is unique.
 */
export function bezierParameter(controls: BezierControls, u: number): number {
	const [x1, , x2] = controls;
	const target = clampUnit(u);
	let s = target;
	for (let i = 0; i < 8; i++) {
		const error = bezierCoordinate(s, x1, x2) - target;
		if (Math.abs(error) < 1e-12) {
			return s;
		}
		const slope = bezierSlope(s, x1, x2);
		if (Math.abs(slope) < 1e-6) {
			break;
		}
		s = clampUnit(s - error / slope);
	}
	let low = 0;
	let high = 1;
	s = target;
	for (let i = 0; i < 60; i++) {
		const x = bezierCoordinate(s, x1, x2);
		if (Math.abs(x - target) < 1e-12) {
			return s;
		}
		if (x < target) {
			low = s;
		} else {
			high = s;
		}
		s = (low + high) / 2;
	}
	return s;
}

/** Eased progress of a CSS cubic Bezier at time progress `u`. */
export function cubicBezierProgress(
	controls: BezierControls,
	u: number
): number {
	const [, y1, , y2] = controls;
	return bezierCoordinate(bezierParameter(controls, u), y1, y2);
}

/**
 * Eased progress at `u` (clamped to 0..1). Hold stays at 0 until the next
 * keyframe; the polynomial easings use their closed forms; `bezier` solves
 * the CSS curve.
 */
export function easedProgress(
	kind: KeyframeEasing,
	u: number,
	bezier?: BezierControls
): number {
	const t = clampUnit(u);
	switch (kind) {
		case "linear":
			return t;
		case "hold":
			return t < 1 ? 0 : 1;
		case "ease-in":
			return t * t;
		case "ease-out":
			return 1 - (1 - t) * (1 - t);
		case "ease-in-out":
			return t * t * (3 - 2 * t);
		default:
			return cubicBezierProgress(bezier ?? DEFAULT_KEYFRAME_BEZIER, t);
	}
}

/**
 * One piece of the piecewise cubic that approximates a Bezier easing:
 * `y = c0 + v*(c1 + v*(c2 + v*c3))` with `v = (u - from)/(to - from)`.
 */
export interface EasingPiece {
	coefficients: readonly [number, number, number, number];
	from: number;
	to: number;
}

/** Cubic through the curve at the piece's ends and thirds (Newton form). */
function fitPiece(
	controls: BezierControls,
	from: number,
	to: number
): EasingPiece {
	const width = to - from;
	const [y0, y1, y2, y3] = [0, third, twoThirds, 1].map((v) =>
		cubicBezierProgress(controls, from + v * width)
	) as [number, number, number, number];
	const d1 = y1 - y0;
	const d2 = y2 - 2 * y1 + y0;
	const d3 = y3 - 3 * y2 + 3 * y1 - y0;
	// p(s) for s = 3v at nodes 0..3, expanded to powers of v.
	return {
		coefficients: [
			y0,
			3 * (d1 - d2 / 2 + d3 / 3),
			9 * (d2 / 2 - d3 / 2),
			4.5 * d3,
		],
		from,
		to,
	};
}

export function evaluatePiece(piece: EasingPiece, u: number): number {
	const v = (u - piece.from) / (piece.to - piece.from);
	const [c0, c1, c2, c3] = piece.coefficients;
	return c0 + v * (c1 + v * (c2 + v * c3));
}

function pieceError(controls: BezierControls, piece: EasingPiece): number {
	let worst = 0;
	for (let i = 1; i < 24; i++) {
		const u = piece.from + ((piece.to - piece.from) * i) / 24;
		worst = Math.max(
			worst,
			Math.abs(evaluatePiece(piece, u) - cubicBezierProgress(controls, u))
		);
	}
	return worst;
}

/** Tolerance of the render's piecewise fit, in units of eased progress. */
export const BEZIER_FIT_TOLERANCE = 0.002;
/** Most cubic pieces one Bezier interval's fit may use. */
export const MAX_BEZIER_PIECES = 32;

/**
 * Fit a Bezier easing with four cubic pieces (fewer when `maxPieces` is
 * below four), halving the worst piece until every piece is within
 * `tolerance` or `maxPieces` (at most 32) exist. The result is
 * deterministic for the same arguments.
 */
export function bezierPieces(
	controls: BezierControls,
	tolerance = BEZIER_FIT_TOLERANCE,
	maxPieces = MAX_BEZIER_PIECES
): EasingPiece[] {
	const limit = Math.min(MAX_BEZIER_PIECES, Math.max(1, Math.floor(maxPieces)));
	const initial = Math.min(4, limit);
	const pieces = Array.from({ length: initial }, (_, index) =>
		fitPiece(controls, index / initial, (index + 1) / initial)
	);
	while (pieces.length < limit) {
		let worstIndex = -1;
		let worstError = tolerance;
		for (const [index, piece] of pieces.entries()) {
			const error = pieceError(controls, piece);
			if (error > worstError) {
				worstError = error;
				worstIndex = index;
			}
		}
		const worst = pieces[worstIndex];
		if (!worst) {
			break;
		}
		const middle = (worst.from + worst.to) / 2;
		pieces.splice(
			worstIndex,
			1,
			fitPiece(controls, worst.from, middle),
			fitPiece(controls, middle, worst.to)
		);
	}
	return pieces;
}

/** Fixed-point number text for FFmpeg (never exponent notation). */
export function expressionNumber(value: number): string {
	const rounded = Number(value.toFixed(9));
	const text = Object.is(rounded, -0) ? "0" : String(rounded);
	return text.includes("e")
		? rounded.toLocaleString("en-US", {
				maximumFractionDigits: 9,
				useGrouping: false,
			})
		: text;
}

const signed = (value: number) => {
	const text = expressionNumber(value);
	return text.startsWith("-") ? `(${text})` : text;
};

function pieceExpression(piece: EasingPiece, u: string): string {
	const [c0, c1, c2, c3] = piece.coefficients;
	const v =
		piece.from === 0
			? `(${u})/${expressionNumber(piece.to)}`
			: `((${u})-${expressionNumber(piece.from)})/${expressionNumber(piece.to - piece.from)}`;
	return `${signed(c0)}+${v}*(${signed(c1)}+${v}*(${signed(c2)}+${v}*${signed(c3)}))`;
}

/**
 * FFmpeg expression of eased progress for the progress expression `u`, which
 * the caller keeps within 0..1. Hold is a constant 0 (the interval ends where
 * the next keyframe takes over); Bezier curves use the piecewise cubic fit
 * with at most `maxPieces` pieces (see `bezierPieces`).
 */
export function easingExpression(
	kind: Exclude<KeyframeEasing, "linear">,
	u: string,
	bezier?: BezierControls,
	maxPieces = MAX_BEZIER_PIECES
): string {
	switch (kind) {
		case "hold":
			return "0";
		case "ease-in":
			return `(${u})*(${u})`;
		case "ease-out":
			return `1-(1-(${u}))*(1-(${u}))`;
		case "ease-in-out":
			return `(${u})*(${u})*(3-2*(${u}))`;
		default: {
			const pieces = bezierPieces(
				bezier ?? DEFAULT_KEYFRAME_BEZIER,
				BEZIER_FIT_TOLERANCE,
				maxPieces
			);
			let result = pieceExpression(pieces.at(-1) as EasingPiece, u);
			for (let i = pieces.length - 2; i >= 0; i--) {
				const piece = pieces[i] as EasingPiece;
				result = `if(lt(${u},${expressionNumber(piece.to)}),${pieceExpression(piece, u)},${result})`;
			}
			return result;
		}
	}
}

function lerp(
	a: readonly [number, number],
	b: readonly [number, number],
	t: number
): [number, number] {
	return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

/** The named easing whose controls equal `controls`, if any. */
export function namedEasing(
	controls: BezierControls
): Exclude<KeyframeEasing, "hold" | "bezier"> | undefined {
	for (const [kind, preset] of Object.entries(polynomialControls)) {
		if (
			preset.every(
				(value, index) => Math.abs(value - (controls[index] ?? 0)) < 1e-6
			)
		) {
			return kind as Exclude<KeyframeEasing, "hold" | "bezier">;
		}
	}
	return undefined;
}

const controlNumber = (value: number) => Number(value.toFixed(6));

const clamp = (value: number, min: number, max: number) =>
	Math.min(max, Math.max(min, value));

/**
 * Normalize a sub-curve to the unit box, clamped to the schema's control
 * bounds; `exact` is false when clamping changed it. Null when degenerate.
 */
function normalizedControls(
	points: readonly (readonly [number, number])[]
): { controls: BezierControls; exact: boolean } | null {
	const [p0, p1, p2, p3] = points as [
		readonly [number, number],
		readonly [number, number],
		readonly [number, number],
		readonly [number, number],
	];
	const width = p3[0] - p0[0];
	const height = p3[1] - p0[1];
	if (width < 1e-9 || Math.abs(height) < 1e-9) {
		return null;
	}
	const raw = [
		(p1[0] - p0[0]) / width,
		(p1[1] - p0[1]) / height,
		(p2[0] - p0[0]) / width,
		(p2[1] - p0[1]) / height,
	] as const;
	const controls: BezierControls = [
		controlNumber(clamp(raw[0], 0, 1)),
		controlNumber(clamp(raw[1], -1, 2)),
		controlNumber(clamp(raw[2], 0, 1)),
		controlNumber(clamp(raw[3], -1, 2)),
	];
	const exact = controls.every(
		(value, index) => Math.abs(value - (raw[index] ?? 0)) < 1e-6
	);
	return { controls, exact };
}

/** A curve shape: an easing kind plus Bezier controls for `bezier`. */
export interface EasingCurve {
	bezier?: BezierControls;
	kind: KeyframeEasing;
}

type Point = readonly [number, number];

/** de Casteljau split of a cubic at parameter `s`. */
function splitPoints(
	points: readonly [Point, Point, Point, Point],
	s: number
): {
	left: [Point, Point, Point, Point];
	right: [Point, Point, Point, Point];
} {
	const [p0, p1, p2, p3] = points;
	const a = lerp(p0, p1, s);
	const b = lerp(p1, p2, s);
	const c = lerp(p2, p3, s);
	const d = lerp(a, b, s);
	const e = lerp(b, c, s);
	const f = lerp(d, e, s);
	return { left: [p0, a, d, f], right: [f, e, c, p3] };
}

/**
 * The part of an eased interval between time progress `from` and `to`
 * (0 <= from < to <= 1), re-normalized to its own unit box. Bezier-shaped
 * easings are cut exactly by de Casteljau subdivision. Linear and hold keep
 * their kind. When the exact part's controls leave the schema bounds, the
 * closer of the clamped controls and the original easing is used (the
 * values at both ends stay exact either way).
 */
export function subEasing(
	curve: EasingCurve,
	from: number,
	to: number
): EasingCurve {
	const { bezier, kind } = curve;
	const controls = easingControls(kind, bezier);
	if (!controls || kind === "linear" || (from <= 1e-9 && to >= 1 - 1e-9)) {
		return curve;
	}
	const start = easedProgress(kind, from, bezier);
	const rise = easedProgress(kind, to, bezier) - start;
	const s1 = from <= 1e-9 ? 0 : bezierParameter(controls, from);
	const s2 = to >= 1 - 1e-9 ? 1 : bezierParameter(controls, to);
	let points: [Point, Point, Point, Point] = [
		[0, 0],
		[controls[0], controls[1]],
		[controls[2], controls[3]],
		[1, 1],
	];
	if (s1 > 0) {
		points = splitPoints(points, s1).right;
	}
	if (s2 < 1) {
		points = splitPoints(points, (s2 - s1) / (1 - s1)).left;
	}
	const normalized = normalizedControls(points);
	if (!normalized || Math.abs(rise) < 1e-9) {
		return curve;
	}
	const named = namedEasing(normalized.controls);
	const fitted: EasingCurve = named
		? { kind: named }
		: { bezier: normalized.controls, kind: "bezier" };
	if (normalized.exact) {
		return fitted;
	}
	const truth = (v: number) =>
		(easedProgress(kind, from + v * (to - from), bezier) - start) / rise;
	const misfit = (candidate: EasingCurve) => {
		let worst = 0;
		for (let i = 1; i < 32; i++) {
			worst = Math.max(
				worst,
				Math.abs(
					easedProgress(candidate.kind, i / 32, candidate.bezier) -
						truth(i / 32)
				)
			);
		}
		return worst;
	};
	return misfit(fitted) <= misfit(curve) ? fitted : curve;
}

/** The two halves of an eased interval split at time progress `u`. */
export interface EasingSplit {
	left: EasingCurve;
	/** Eased progress at the split, so the boundary value is exact. */
	progress: number;
	right: EasingCurve;
}

/** Split an eased interval at time progress `u` (0 < u < 1); see `subEasing`. */
export function splitEasing(
	kind: KeyframeEasing,
	u: number,
	bezier?: BezierControls
): EasingSplit {
	const curve: EasingCurve = bezier ? { bezier, kind } : { kind };
	return {
		left: subEasing(curve, 0, u),
		progress: easedProgress(kind, u, bezier),
		right: subEasing(curve, u, 1),
	};
}
