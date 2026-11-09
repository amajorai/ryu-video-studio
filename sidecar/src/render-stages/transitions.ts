import {
	animationInDurationOf,
	animationOutDurationOf,
	animationWindows,
} from "../../../shared/clip-animation.ts";
import type { Segment } from "../../../shared/project.ts";
import { segmentDuration } from "../../../shared/project.ts";
import {
	fadeThroughExprs,
	isShapedReveal,
	revealCoverageExpr,
} from "../../../shared/reveal-transitions.ts";
import {
	type Expr,
	evaluate,
	formatNumber,
	isConstant,
	toFfmpeg,
} from "../../../shared/transition-expr.ts";
import {
	clipMotion,
	entryExpression,
	entryScaleExpression,
	exitDurationOf,
	exitFades,
} from "../../../shared/transitions.ts";

/**
 * Transitions and clip animations (W2-V10). Clips without `transitionIn`,
 * `exitTransition` or `animation` keep the legacy strings byte for byte.
 *
 * Inside the clip chain `t`/`T` are clip-local seconds (the chain is retimed
 * to the clip start only after this stage); the overlay runs on timeline
 * time, so offsets use `t-start` there.
 */

/** Alpha fades: the crossfade entry, the clip fades, then a fading exit. */
export function fadeFilters(segment: Segment, length: number): string[] {
	// Bounded by `length` so `st` is never negative (FFmpeg cannot parse it).
	const exit = exitFades(segment)
		? Math.min(exitDurationOf(segment), length)
		: 0;
	return [
		segment.entryTransition === "crossfade" && segment.entryDuration > 0
			? `fade=t=in:st=0:d=${segment.entryDuration}:alpha=1`
			: "",
		segment.fadeIn > 0 ? `fade=t=in:st=0:d=${segment.fadeIn}:alpha=1` : "",
		segment.fadeOut > 0
			? `fade=t=out:st=${length - segment.fadeOut}:d=${segment.fadeOut}:alpha=1`
			: "",
		exit > 0
			? `fade=t=out:st=${formatNumber(Math.max(0, length - exit))}:d=${formatNumber(exit)}:alpha=1`
			: "",
	].filter(Boolean);
}

const pixelNames = { h: "H", t: "T", w: "W", x: "X", y: "Y" } as const;
const clipNames = { t: "t" } as const;

/** `enable` for a set of clip-local windows. */
function enableWindows(windows: [number, number][]): string {
	return windows
		.map(([from, to]) => `between(t,${formatNumber(from)},${formatNumber(to)})`)
		.join("+");
}

/** Number of constant-sigma steps a blur ramp is rendered in. */
export const BLUR_STEPS = 8;
/** Reference frame height the blur sigmas are given in. */
const BLUR_REFERENCE_HEIGHT = 1080;

/**
 * A time-varying blur as stepped `gblur` filters: each step holds the curve's
 * value at its midpoint over one slice of `window` (`gblur` sigma is not an
 * expression; stepping with `enable` needs no `sendcmd` instance names).
 */
function blurSteps(
	blur: Expr,
	window: [number, number],
	frameHeight: number
): string[] {
	const [from, to] = window;
	const step = (to - from) / BLUR_STEPS;
	const filters: string[] = [];
	for (let index = 0; index < BLUR_STEPS; index++) {
		const start = from + index * step;
		const sigma =
			(evaluate(blur, { t: start + step / 2 }) * frameHeight) /
			BLUR_REFERENCE_HEIGHT;
		if (sigma >= 0.1) {
			filters.push(
				`gblur=sigma=${formatNumber(sigma)}:enable='between(t,${formatNumber(start)},${formatNumber(start + step)})'`
			);
		}
	}
	return filters;
}

/** Merge overlapping windows so a blur is never applied twice. */
function mergeWindows(windows: [number, number][]): [number, number][] {
	const merged: [number, number][] = [];
	for (const [from, to] of [...windows].sort((a, b) => a[0] - b[0])) {
		const last = merged.at(-1);
		if (last && from <= last[1]) {
			last[1] = Math.max(last[1], to);
		} else {
			merged.push([from, to]);
		}
	}
	return merged;
}

/** Where the blur curve is non-zero: blur moves and the blur dissolve. */
function blurWindows(segment: Segment, length: number): [number, number][] {
	const { animation, transitionIn } = segment;
	const windows: [number, number][] = [];
	if (animation?.in === "blur" && animationInDurationOf(animation) > 0) {
		windows.push([0, Math.min(length, animationInDurationOf(animation))]);
	}
	if (animation?.out === "blur" && animationOutDurationOf(animation) > 0) {
		windows.push([
			Math.max(0, length - animationOutDurationOf(animation)),
			length,
		]);
	}
	if (transitionIn?.type === "blur") {
		windows.push([0, Math.min(length, transitionIn.duration)]);
	}
	return mergeWindows(windows);
}

/**
 * Stepped `gblur` filters for the blur dissolve and blur moves. Sigmas are
 * given for a 1080-line frame and scaled to `frameHeight`.
 */
export function blurFilters(
	segment: Segment,
	length: number,
	frameHeight = BLUR_REFERENCE_HEIGHT
): string[] {
	const { blur } = clipMotion(segment, length);
	if (isConstant(blur, 0)) {
		return [];
	}
	return blurWindows(segment, length).flatMap((window) =>
		blurSteps(blur, window, frameHeight)
	);
}

/** Per-pixel reveal: shaped alpha, or a fade through black or white. */
function revealPixelFilter(segment: Segment, length: number): string[] {
	const reveal = segment.transitionIn;
	if (!reveal) {
		return [];
	}
	const enable = `enable='between(t,0,${formatNumber(Math.min(length, reveal.duration))})'`;
	const fade = fadeThroughExprs(reveal);
	if (fade) {
		const tint = toFfmpeg(fade.tint, pixelNames);
		const coverage = toFfmpeg(fade.coverage, pixelNames);
		const channel = (name: string) =>
			`${name}(X,Y)*(1-${tint})+${fade.color}*${tint}`;
		return [
			`geq=r='${channel("r")}':g='${channel("g")}':b='${channel("b")}':a='alpha(X,Y)*${coverage}':${enable}`,
		];
	}
	if (!isShapedReveal(reveal.type)) {
		return [];
	}
	const coverage = toFfmpeg(revealCoverageExpr(reveal), pixelNames);
	return [
		`geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='alpha(X,Y)*${coverage}':${enable}`,
	];
}

/**
 * Reveal transitions against the previous clip on the same track, plus the
 * clip animation's per-frame work: blur steps, rotation, and the combined
 * whole-frame alpha (dissolve, animation opacity). Zoom and offsets are in
 * `entryScale`/`entryOffset`; the exit fade is in `fadeFilters`.
 *
 * `previous` is the clip the reveal plays over; the incoming clip's alpha
 * alone produces the transition, so it only needs to exist (validation
 * guarantees the overlap).
 */
export function revealFilters(
	segment: Segment,
	_previous: Segment | undefined,
	length: number,
	frameHeight = BLUR_REFERENCE_HEIGHT
): string[] {
	if (!(segment.transitionIn || segment.animation)) {
		return [];
	}
	const motion = clipMotion(segment, length);
	const filters = blurFilters(segment, length, frameHeight);
	if (!isConstant(motion.rotation, 0)) {
		filters.push(
			`rotate=a='(${toFfmpeg(motion.rotation, clipNames)})*PI/180':ow=iw:oh=ih:fillcolor=black@0`
		);
	}
	// Exit fades are already in `fadeFilters`; the rest of the alpha is here.
	const { exitTransition: _exit, ...withoutExit } = segment;
	const alpha = clipMotion(withoutExit, length).opacity;
	if (!isConstant(alpha, 1)) {
		filters.push(
			`geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='alpha(X,Y)*${toFfmpeg(alpha, pixelNames)}'${alphaEnable(segment, length)}`
		);
	}
	filters.push(...revealPixelFilter(segment, length));
	return filters;
}

/**
 * The alpha only changes during the reveal and the in/out moves, so the
 * per-pixel `geq` is limited to them (a loop never changes alpha).
 */
function alphaEnable(segment: Segment, length: number): string {
	const windows = animationWindows(segment.animation, length);
	if (segment.transitionIn && !isShapedReveal(segment.transitionIn.type)) {
		windows.push([0, Math.min(length, segment.transitionIn.duration)]);
	}
	return windows.length > 0 ? `:enable='${enableWindows(windows)}'` : "";
}

const legacyEntryScale = (segment: Segment) =>
	entryScaleExpression(segment, `t-${segment.start}`);

/** Entry zoom factor expression applied to the scaled size. */
export function entryScale(segment: Segment): string {
	const legacy = legacyEntryScale(segment);
	if (!(segment.transitionIn || segment.animation || segment.exitTransition)) {
		return legacy;
	}
	const motion = clipMotion(segment, segmentDuration(segment));
	if (isConstant(motion.scale, 1)) {
		return legacy;
	}
	const scale = toFfmpeg(motion.scale, clipNames);
	return legacy === "1" ? scale : `${legacy}*${scale}`;
}

/** Entry slide offset expression, in canvas widths or heights. */
export function entryOffset(segment: Segment, axis: "x" | "y"): string {
	const legacy = entryExpression(segment, axis, `t-${segment.start}`);
	if (!(segment.transitionIn || segment.animation || segment.exitTransition)) {
		return legacy;
	}
	const motion = clipMotion(segment, segmentDuration(segment));
	const shift = axis === "x" ? motion.shiftX : motion.shiftY;
	if (isConstant(shift, 0)) {
		return legacy;
	}
	const offset = toFfmpeg(shift, { t: `(t-${segment.start})` });
	return legacy === "0" ? offset : `${legacy}+${offset}`;
}
