/**
 * Clip in/out/loop animations (W2-V10). Each preset is a set of `Expr`
 * curves over clip-local seconds `t` that the render prints as FFmpeg
 * expressions and the preview evaluates, so both play the same motion.
 *
 * Scale curves never exceed 1: the transform stage sizes the transparent pad
 * for the clip's own scale, so a growing animation would overflow it.
 */

import type { z } from "zod";
import type { Segment } from "./project.ts";
import type {
	ClipAnimation,
	clipAnimationInSchema,
	clipAnimationLoopSchema,
} from "./schema/transition.ts";
import {
	abs,
	add,
	cos,
	div,
	type Expr,
	easeOut,
	evaluate,
	max,
	min,
	mul,
	sin,
	smooth,
	sub,
	unit,
} from "./transition-expr.ts";

export type ClipAnimationMove = z.infer<typeof clipAnimationInSchema>;
export type ClipAnimationLoop = z.infer<typeof clipAnimationLoopSchema>;

export const clipAnimationMoves: readonly ClipAnimationMove[] = [
	"fade",
	"pop",
	"bounce",
	"spin",
	"zoom",
	"slide-left",
	"slide-right",
	"slide-up",
	"slide-down",
	"blur",
];
export const clipAnimationLoops: readonly ClipAnimationLoop[] = [
	"none",
	"pulse",
	"wobble",
	"float",
	"spin",
	"shake",
];

export const clipAnimationMoveLabels: Record<ClipAnimationMove, string> = {
	blur: "Blur",
	bounce: "Bounce",
	fade: "Fade",
	pop: "Pop",
	"slide-down": "Slide down",
	"slide-left": "Slide left",
	"slide-right": "Slide right",
	"slide-up": "Slide up",
	spin: "Spin",
	zoom: "Zoom",
};
export const clipAnimationLoopLabels: Record<ClipAnimationLoop, string> = {
	float: "Float",
	none: "None",
	pulse: "Pulse",
	shake: "Shake",
	spin: "Spin",
	wobble: "Wobble",
};

export const isClipAnimationMove = (
	value: string
): value is ClipAnimationMove =>
	(clipAnimationMoves as readonly string[]).includes(value);
export const isClipAnimationLoop = (
	value: string
): value is ClipAnimationLoop =>
	(clipAnimationLoops as readonly string[]).includes(value);

export const DEFAULT_ANIMATION_DURATION = 0.5;
export const DEFAULT_LOOP_PERIOD = 1;

export const animationInDurationOf = (animation: ClipAnimation): number =>
	animation.inDuration ?? DEFAULT_ANIMATION_DURATION;
export const animationOutDurationOf = (animation: ClipAnimation): number =>
	animation.outDuration ?? DEFAULT_ANIMATION_DURATION;
export const animationLoopPeriodOf = (animation: ClipAnimation): number =>
	animation.loopPeriod ?? DEFAULT_LOOP_PERIOD;

/** Animation curves over clip-local seconds `t`. */
export interface AnimationCurves {
	/** Gaussian sigma in pixels of a 1080-line frame. */
	blur: Expr;
	opacity: Expr;
	/** Degrees, clockwise. */
	rotation: Expr;
	scale: Expr;
	/** Canvas widths. */
	shiftX: Expr;
	/** Canvas heights (positive is down). */
	shiftY: Expr;
}

const still: AnimationCurves = {
	blur: 0,
	opacity: 1,
	rotation: 0,
	scale: 1,
	shiftX: 0,
	shiftY: 0,
};

/** Largest blur of the blur move, in 1080-line pixels. */
export const ANIMATION_BLUR = 20;
const SLIDE_DISTANCE = 0.25;

const slideVectors: Partial<Record<ClipAnimationMove, [number, number]>> = {
	"slide-down": [0, -1],
	"slide-left": [1, 0],
	"slide-right": [-1, 0],
	"slide-up": [0, 1],
};

/**
 * One move at raw progress `progress` (0 = hidden end, 1 = settled).
 * `leaving` flips the travel of slides and spins so an out-move continues
 * in the named direction instead of playing the in-move backwards.
 */
function moveCurves(
	move: ClipAnimationMove,
	progress: Expr,
	leaving: boolean
): AnimationCurves {
	const eased = smooth(progress);
	const remaining = sub(1, eased);
	const travel = leaving ? -1 : 1;
	switch (move) {
		case "fade":
			return { ...still, opacity: eased };
		case "pop":
			return {
				...still,
				opacity: unit(mul(progress, 3)),
				scale: add(0.3, mul(0.7, easeOut(progress))),
			};
		case "bounce": {
			const rest = sub(1, progress);
			return {
				...still,
				opacity: unit(mul(progress, 5)),
				shiftY: mul(-0.3, rest, rest, abs(cos(mul(2.5 * Math.PI, progress)))),
			};
		}
		case "spin":
			return {
				...still,
				opacity: eased,
				rotation: mul(-180 * travel, remaining),
				scale: add(0.5, mul(0.5, eased)),
			};
		case "zoom":
			return { ...still, opacity: eased, scale: add(0.6, mul(0.4, eased)) };
		case "blur":
			return { ...still, blur: mul(ANIMATION_BLUR, remaining), opacity: eased };
		default: {
			const [x, y] = slideVectors[move] ?? [0, 0];
			return {
				...still,
				opacity: eased,
				shiftX: mul(SLIDE_DISTANCE * x * travel, remaining),
				shiftY: mul(SLIDE_DISTANCE * y * travel, remaining),
			};
		}
	}
}

function loopCurves(loop: ClipAnimationLoop, period: number): AnimationCurves {
	const phase = mul(div("t", period), 2 * Math.PI);
	switch (loop) {
		case "pulse":
			return { ...still, scale: sub(1, mul(0.03, sub(1, cos(phase)))) };
		case "wobble":
			return { ...still, rotation: mul(5, sin(phase)) };
		case "float":
			return { ...still, shiftY: mul(-0.015, sin(phase)) };
		case "spin":
			return { ...still, rotation: mul(360, div("t", period)) };
		case "shake":
			return {
				...still,
				shiftX: mul(
					0.008,
					add(sin(mul(3, phase)), mul(0.5, sin(mul(7.1, phase))))
				),
				shiftY: mul(
					0.008,
					add(cos(mul(5, phase)), mul(0.5, sin(add(mul(2.3, phase), 1))))
				),
			};
		default:
			return still;
	}
}

function combine(parts: AnimationCurves[]): AnimationCurves {
	return parts.reduce<AnimationCurves>(
		(sum, part) => ({
			blur: isZero(sum.blur) ? part.blur : max(sum.blur, part.blur),
			opacity: mul(sum.opacity, part.opacity),
			rotation: add(sum.rotation, part.rotation),
			scale: mul(sum.scale, part.scale),
			shiftX: add(sum.shiftX, part.shiftX),
			shiftY: add(sum.shiftY, part.shiftY),
		}),
		still
	);
}

const isZero = (expr: Expr) => expr === 0;
const isOne = (expr: Expr) => expr === 1;

/**
 * The clip's animation curves. `length` is the clip's timeline duration
 * (the out-move plays over its last `outDuration` seconds). A clip without
 * `animation` gets constant curves.
 */
export function animationCurves(
	animation: ClipAnimation | undefined,
	length: number
): AnimationCurves {
	if (!animation) {
		return still;
	}
	const parts: AnimationCurves[] = [];
	const inDuration = animationInDurationOf(animation);
	if (animation.in && inDuration > 0) {
		parts.push(moveCurves(animation.in, unit(div("t", inDuration)), false));
	}
	const outDuration = animationOutDurationOf(animation);
	if (animation.out && outDuration > 0) {
		parts.push(
			moveCurves(animation.out, unit(div(sub(length, "t"), outDuration)), true)
		);
	}
	if (animation.loop && animation.loop !== "none") {
		parts.push(loopCurves(animation.loop, animationLoopPeriodOf(animation)));
	}
	const curves = combine(parts);
	return isOne(curves.scale)
		? curves
		: { ...curves, scale: min(curves.scale, 1) };
}

export const segmentAnimationCurves = (
	segment: Segment,
	length: number
): AnimationCurves => animationCurves(segment.animation, length);

export interface AnimationFrame {
	blur: number;
	opacity: number;
	rotation: number;
	scale: number;
	shiftX: number;
	shiftY: number;
}

/** Evaluate the curves at clip-local `elapsed` seconds. */
export function animationFrameAt(
	curves: AnimationCurves,
	elapsed: number
): AnimationFrame {
	const env = { t: elapsed };
	return {
		blur: evaluate(curves.blur, env),
		opacity: evaluate(curves.opacity, env),
		rotation: evaluate(curves.rotation, env),
		scale: evaluate(curves.scale, env),
		shiftX: evaluate(curves.shiftX, env),
		shiftY: evaluate(curves.shiftY, env),
	};
}

/**
 * The windows (clip-local seconds) where in/out moves change the clip, so
 * per-pixel filters can be limited to them with `enable`.
 */
export function animationWindows(
	animation: ClipAnimation | undefined,
	length: number
): [number, number][] {
	if (!animation) {
		return [];
	}
	const windows: [number, number][] = [];
	const inDuration = animationInDurationOf(animation);
	if (animation.in && inDuration > 0) {
		windows.push([0, Math.min(length, inDuration)]);
	}
	const outDuration = animationOutDurationOf(animation);
	if (animation.out && outDuration > 0) {
		windows.push([Math.max(0, length - outDuration), length]);
	}
	return windows;
}
