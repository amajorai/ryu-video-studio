/**
 * Reveal transitions (W2-V10): the incoming clip of a cut is drawn over the
 * end of its same-track predecessor and revealed by a time-varying alpha,
 * offset, zoom or blur. Every curve is an `Expr` (`./transition-expr.ts`), so
 * the FFmpeg render and the CSS preview evaluate one definition.
 *
 * Shaped reveals use a "field" `f(x, y)` in 0..1 over the frame: a pixel is
 * revealed once the eased progress passes its field value, with a soft band
 * whose width follows `softness`. Wipes are named after the edge the reveal
 * starts from (`wipe-left` uncovers the left side first).
 */
import type { RevealTransition, TransitionIn } from "./schema/transition.ts";
import { revealTransitionSchema } from "./schema/transition.ts";
import {
	abs,
	add,
	atan2,
	div,
	type Expr,
	evaluate,
	hypot,
	lt,
	max,
	mul,
	smooth,
	sub,
	unit,
} from "./transition-expr.ts";

export type { RevealTransition, TransitionIn } from "./schema/transition.ts";

export const revealTransitions = revealTransitionSchema.options;

export const isRevealTransition = (value: string): value is RevealTransition =>
	(revealTransitions as readonly string[]).includes(value);

export type RevealGroup = "dissolve" | "wipe" | "shape" | "motion";

export const revealGroupLabels: Record<RevealGroup, string> = {
	dissolve: "Dissolves",
	motion: "Motion",
	shape: "Shapes",
	wipe: "Wipes",
};

export const revealTransitionInfo: Record<
	RevealTransition,
	{ group: RevealGroup; label: string }
> = {
	"barn-h": { group: "wipe", label: "Barn doors (horizontal)" },
	"barn-v": { group: "wipe", label: "Barn doors (vertical)" },
	blur: { group: "dissolve", label: "Blur dissolve" },
	"circle-close": { group: "shape", label: "Circle close" },
	"circle-open": { group: "shape", label: "Circle open" },
	"diag-br": { group: "wipe", label: "Diagonal from bottom right" },
	"diag-tl": { group: "wipe", label: "Diagonal from top left" },
	dissolve: { group: "dissolve", label: "Dissolve" },
	"fade-black": { group: "dissolve", label: "Fade through black" },
	"fade-white": { group: "dissolve", label: "Fade through white" },
	iris: { group: "shape", label: "Iris (diamond)" },
	"push-left": { group: "motion", label: "Push left" },
	"push-right": { group: "motion", label: "Push right" },
	radial: { group: "shape", label: "Clock wipe" },
	"rect-open": { group: "shape", label: "Box open" },
	"slide-down": { group: "motion", label: "Slide down" },
	"slide-left": { group: "motion", label: "Slide left" },
	"slide-right": { group: "motion", label: "Slide right" },
	"slide-up": { group: "motion", label: "Slide up" },
	"wipe-down": { group: "wipe", label: "Wipe from bottom" },
	"wipe-left": { group: "wipe", label: "Wipe from left" },
	"wipe-right": { group: "wipe", label: "Wipe from right" },
	"wipe-up": { group: "wipe", label: "Wipe from top" },
	zoom: { group: "motion", label: "Zoom in" },
};

export const DEFAULT_REVEAL_DURATION = 0.5;
export const DEFAULT_REVEAL_SOFTNESS = 0.1;

/** A transition with the default duration and softness. */
export const newRevealTransition = (
	type: RevealTransition,
	duration = DEFAULT_REVEAL_DURATION
): TransitionIn => ({ duration, softness: DEFAULT_REVEAL_SOFTNESS, type });

/** Eased 0..1 progress of a reveal at clip-local time `t`. */
export const revealProgressExpr = (transition: TransitionIn): Expr =>
	smooth(unit(div("t", transition.duration)));

export const revealProgress = (
	transition: TransitionIn,
	elapsed: number
): number => evaluate(revealProgressExpr(transition), { t: elapsed });

const u: Expr = div("x", "w");
const v: Expr = div("y", "h");
const fromCenterU = abs(sub(u, 0.5));
const fromCenterV = abs(sub(v, 0.5));
const dx = sub("x", div("w", 2));
const dy = sub("y", div("h", 2));
const radius = hypot(dx, dy);
const halfDiagonal = div(hypot("w", "h"), 2);
/** Clockwise angle from 12 o'clock in 0..2π. */
const clockAngle = atan2(dx, sub(0, dy));
const sweep = div(
	add(clockAngle, mul(2 * Math.PI, lt(clockAngle, 0))),
	2 * Math.PI
);

const fields: Partial<Record<RevealTransition, Expr>> = {
	"barn-h": mul(fromCenterU, 2),
	"barn-v": mul(fromCenterV, 2),
	"circle-close": sub(1, div(radius, halfDiagonal)),
	"circle-open": div(radius, halfDiagonal),
	"diag-br": sub(1, div(add(u, v), 2)),
	"diag-tl": div(add(u, v), 2),
	iris: add(fromCenterU, fromCenterV),
	radial: sweep,
	"rect-open": mul(max(fromCenterU, fromCenterV), 2),
	"wipe-down": sub(1, v),
	"wipe-left": u,
	"wipe-right": sub(1, u),
	"wipe-up": v,
};

/** Whether the type reveals by a shape over the frame (needs a per-pixel alpha). */
export const isShapedReveal = (type: RevealTransition): boolean =>
	fields[type] !== undefined;

/** Field 0..1 for shaped reveals, in pixel coordinates `x, y` of a `w × h` frame. */
export const revealFieldExpr = (type: RevealTransition): Expr | undefined =>
	fields[type];

/** Width of the soft edge in field units. */
export const softBand = (softness: number): number =>
	Math.max(0.002, 0.3 * softness);

const dissolving: ReadonlySet<RevealTransition> = new Set([
	"dissolve",
	"zoom",
	"blur",
]);

/**
 * Alpha multiplier 0..1 of the incoming clip at time `t` and pixel `x, y`.
 * Shaped reveals sweep a soft edge across the field; dissolves, zoom and
 * blur ramp the whole frame; slides, pushes and fades through a color return
 * a constant 1 (they move the clip or tint it instead).
 */
export function revealCoverageExpr(transition: TransitionIn): Expr {
	const progress = revealProgressExpr(transition);
	const field = fields[transition.type];
	if (field !== undefined) {
		const band = softBand(transition.softness);
		return unit(div(sub(mul(progress, 1 + band), field), band));
	}
	return dissolving.has(transition.type) ? progress : 1;
}

export function revealCoverage(
	transition: TransitionIn,
	elapsed: number,
	point: { h: number; w: number; x: number; y: number }
): number {
	return evaluate(revealCoverageExpr(transition), { ...point, t: elapsed });
}

/**
 * Fades through a color: the first half covers the outgoing clip with the
 * color, the second half fades the incoming picture up out of it. The
 * incoming layer's pixel is `mix(picture, color, tint)` at alpha `coverage`.
 */
export interface FadeThroughExprs {
	/** 0 for black, 255 for white (8-bit RGBA). */
	color: number;
	coverage: Expr;
	tint: Expr;
}

export function fadeThroughExprs(
	transition: TransitionIn
): FadeThroughExprs | undefined {
	if (transition.type !== "fade-black" && transition.type !== "fade-white") {
		return;
	}
	const progress = revealProgressExpr(transition);
	return {
		color: transition.type === "fade-white" ? 255 : 0,
		coverage: unit(mul(progress, 2)),
		tint: unit(sub(2, mul(progress, 2))),
	};
}

const slideDirections: Partial<Record<RevealTransition, [number, number]>> = {
	"push-left": [1, 0],
	"push-right": [-1, 0],
	"slide-down": [0, -1],
	"slide-left": [1, 0],
	"slide-right": [-1, 0],
	"slide-up": [0, 1],
};

/**
 * Offset of the incoming clip in canvas widths/heights for slides and
 * pushes: `slide-left` enters from the right and moves left, like the
 * legacy entry slide.
 */
export function revealOffsetExpr(
	transition: TransitionIn,
	axis: "x" | "y"
): Expr {
	const direction = slideDirections[transition.type];
	const sign = direction?.[axis === "x" ? 0 : 1] ?? 0;
	if (sign === 0) {
		return 0;
	}
	return mul(sign, sub(1, revealProgressExpr(transition)));
}

/** The exit slide a push gives the outgoing clip so both move together. */
export function pushExitOf(
	type: RevealTransition
): "slide-left" | "slide-right" | undefined {
	if (type === "push-left") {
		return "slide-left";
	}
	if (type === "push-right") {
		return "slide-right";
	}
	return;
}

/** Zoom grows the incoming clip from 60% while it dissolves in (never above 1). */
export function revealScaleExpr(transition: TransitionIn): Expr {
	if (transition.type !== "zoom") {
		return 1;
	}
	return add(0.6, mul(0.4, revealProgressExpr(transition)));
}

/** Largest blur, in pixels of a 1080-line frame. */
export const REVEAL_BLUR = 24;

/** Gaussian blur sigma (1080-line pixels) for the blur dissolve. */
export function revealBlurExpr(transition: TransitionIn): Expr {
	if (transition.type !== "blur") {
		return 0;
	}
	return mul(REVEAL_BLUR, sub(1, revealProgressExpr(transition)));
}

/**
 * Preview geometry of a shaped reveal with a hard edge, in fractions of the
 * element box. `aspect` (width/height) is needed for circles and the clock
 * sweep, whose fields are measured in pixels.
 */
export type RevealShape =
	| { kind: "full" }
	| { kind: "none" }
	| { bottom: number; kind: "inset"; left: number; right: number; top: number }
	| { kind: "circle"; radius: number }
	| { kind: "outside-circle"; radius: number }
	| { kind: "polygon"; points: [number, number][] };

const insetShape = (
	top: number,
	right: number,
	bottom: number,
	left: number
): RevealShape => ({ bottom, kind: "inset", left, right, top });

function clockPolygon(progress: number, aspect: number): [number, number][] {
	const reach = Math.hypot(aspect, 1) * 2;
	const steps = Math.max(2, Math.ceil(progress * 72));
	const points: [number, number][] = [[0.5, 0.5]];
	for (let step = 0; step <= steps; step++) {
		const angle = (progress * 2 * Math.PI * step) / steps;
		points.push([
			0.5 + (Math.sin(angle) * reach) / aspect,
			0.5 - Math.cos(angle) * reach,
		]);
	}
	return points;
}

/** Revealed area of the incoming clip at eased progress `progress`. */
export function revealShape(
	type: RevealTransition,
	progress: number,
	aspect = 16 / 9
): RevealShape {
	if (!isShapedReveal(type) || progress >= 1) {
		return { kind: "full" };
	}
	if (progress <= 0) {
		return { kind: "none" };
	}
	const rest = 1 - progress;
	const half = rest / 2;
	switch (type) {
		case "wipe-left":
			return insetShape(0, rest, 0, 0);
		case "wipe-right":
			return insetShape(0, 0, 0, rest);
		case "wipe-up":
			return insetShape(0, 0, rest, 0);
		case "wipe-down":
			return insetShape(rest, 0, 0, 0);
		case "barn-h":
			return insetShape(0, half, 0, half);
		case "barn-v":
			return insetShape(half, 0, half, 0);
		case "rect-open":
			return insetShape(half, half, half, half);
		case "circle-open":
			return { kind: "circle", radius: progress };
		case "circle-close":
			return { kind: "outside-circle", radius: rest };
		case "iris":
			return {
				kind: "polygon",
				points: [
					[0.5, 0.5 - progress],
					[0.5 + progress, 0.5],
					[0.5, 0.5 + progress],
					[0.5 - progress, 0.5],
				],
			};
		case "diag-tl":
			return {
				kind: "polygon",
				points: [
					[0, 0],
					[2 * progress, 0],
					[0, 2 * progress],
				],
			};
		case "diag-br":
			return {
				kind: "polygon",
				points: [
					[1, 1],
					[1, 1 - 2 * progress],
					[1 - 2 * progress, 1],
				],
			};
		case "radial":
			return { kind: "polygon", points: clockPolygon(progress, aspect) };
		default:
			return { kind: "full" };
	}
}

function insidePolygon(points: [number, number][], x: number, y: number) {
	let inside = false;
	for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
		const [xi, yi] = points[i] ?? [0, 0];
		const [xj, yj] = points[j] ?? [0, 0];
		if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
			inside = !inside;
		}
	}
	return inside;
}

/**
 * Whether the point (fractions `u, v` of the box) is revealed. Circle radii
 * are fractions of the half diagonal, as in CSS `circle(<r>%)` scaled by
 * √2 / 2 (the reference box's normalized diagonal).
 */
export function shapeContains(
	shape: RevealShape,
	u: number,
	v: number,
	aspect = 16 / 9
): boolean {
	switch (shape.kind) {
		case "full":
			return true;
		case "none":
			return false;
		case "inset":
			return (
				u >= shape.left &&
				u <= 1 - shape.right &&
				v >= shape.top &&
				v <= 1 - shape.bottom
			);
		case "circle":
		case "outside-circle": {
			const distance =
				Math.hypot((u - 0.5) * aspect, v - 0.5) / (Math.hypot(aspect, 1) / 2);
			return shape.kind === "circle"
				? distance <= shape.radius
				: distance >= shape.radius;
		}
		case "polygon":
			return insidePolygon(shape.points, u, v);
		default:
			return true;
	}
}
