/**
 * Preview stage: entry, exit and reveal transitions, clip animations and
 * fades. Mirrors `sidecar/src/render-stages/transitions.ts`; both evaluate the
 * curves in `shared/transitions.ts`, `shared/reveal-transitions.ts` and
 * `shared/clip-animation.ts`.
 */
import { type Segment, segmentDuration } from "../../../../shared/project.ts";
import {
	fadeThroughExprs,
	type RevealShape,
	revealProgress,
	revealShape,
} from "../../../../shared/reveal-transitions.ts";
import { evaluate } from "../../../../shared/transition-expr.ts";
import {
	clipMotionAt,
	entryOpacity,
	entryScale,
	entryShift,
} from "../../../../shared/transitions.ts";
import type { PreviewStyle } from "../preview-style.ts";

export interface EntryTransitionState {
	/** Gaussian blur in pixels of a 1080-line frame (blur moves and dissolves). */
	blur?: number;
	opacity: number;
	/** Extra rotation in degrees (spin, wobble). */
	rotation?: number;
	scale: number;
	/** Translation in output-frame widths. */
	shiftX: number;
	/** Translation in output-frame heights. */
	shiftY: number;
}

/**
 * Whole-frame motion of the clip at `elapsed` seconds: the legacy entry
 * transition, then reveal zoom/slide/push/dissolve, the exit transition and
 * the clip animation. Shaped reveals and fades through a color are per-pixel
 * (`revealStyle`), so they are not part of `opacity`.
 */
export function entryTransitionState(
	segment: Segment,
	elapsed: number
): EntryTransitionState {
	const legacy = {
		opacity: entryOpacity(segment, elapsed),
		scale: entryScale(segment, elapsed),
		shiftX: entryShift(segment, elapsed, "x"),
		shiftY: entryShift(segment, elapsed, "y"),
	};
	if (!(segment.transitionIn || segment.exitTransition || segment.animation)) {
		return legacy;
	}
	const motion = clipMotionAt(segment, elapsed);
	const fade = segment.transitionIn
		? fadeThroughExprs(segment.transitionIn)
		: undefined;
	const coverage = fade ? evaluate(fade.coverage, { t: elapsed }) : 1;
	return {
		blur: motion.blur,
		opacity: legacy.opacity * motion.opacity * coverage,
		rotation: motion.rotation,
		scale: legacy.scale * motion.scale,
		shiftX: legacy.shiftX + motion.shiftX,
		shiftY: legacy.shiftY + motion.shiftY,
	};
}

/**
 * Fade-in/fade-out multiplier, capped at 1 but not floored: callers clamp at
 * 0 themselves (outside the clip it goes negative).
 */
export function fadeFactor(segment: Segment, elapsed: number): number {
	return Math.min(
		1,
		segment.fadeIn ? elapsed / segment.fadeIn : 1,
		segment.fadeOut ? (segmentDuration(segment) - elapsed) / segment.fadeOut : 1
	);
}

const percent = (fraction: number) => `${Math.round(fraction * 1e6) / 1e4}%`;

/** CSS for a reveal shape: a `clip-path`, or a mask for the inverted circle. */
export function revealShapeCss(shape: RevealShape): PreviewStyle {
	switch (shape.kind) {
		case "full":
			return {};
		case "none":
			return { clipPath: "inset(50% 50% 50% 50%)" };
		case "inset":
			return {
				clipPath: `inset(${percent(shape.top)} ${percent(shape.right)} ${percent(shape.bottom)} ${percent(shape.left)})`,
			};
		case "circle":
			// CSS circle percentages are of the normalized diagonal (√2/2 of it is
			// the half diagonal the shared field uses).
			return {
				clipPath: `circle(${percent(shape.radius * Math.SQRT1_2)} at 50% 50%)`,
			};
		case "outside-circle": {
			const edge = percent(shape.radius);
			const gradient = `radial-gradient(circle farthest-corner at 50% 50%, transparent ${edge}, #000 ${edge})`;
			return { maskImage: gradient, WebkitMaskImage: gradient };
		}
		case "polygon":
			return {
				clipPath: `polygon(${shape.points.map(([x, y]) => `${percent(x)} ${percent(y)}`).join(", ")})`,
			};
		default:
			return {};
	}
}

/**
 * Per-pixel reveal styling at `elapsed` seconds: the shaped reveal as a hard
 * edged `clip-path`/mask, and a fade through a color as a brightness filter
 * (`brightness(0)` for black; white is approximated with `brightness` above 1
 * plus `contrast`). `aspect` is the rendered frame's width/height.
 *
 * W2 froze `preview-style.ts`, which composes only the whole-frame
 * `EntryTransitionState`; integration (W5) spreads this into the media layer
 * style, as it does `maskStyle`.
 */
export function revealStyle(
	segment: Segment,
	elapsed: number,
	aspect = 16 / 9
): PreviewStyle {
	const reveal = segment.transitionIn;
	if (!reveal || elapsed >= reveal.duration) {
		return {};
	}
	const fade = fadeThroughExprs(reveal);
	if (fade) {
		const tint = evaluate(fade.tint, { t: elapsed });
		return tint <= 0
			? {}
			: {
					filter:
						fade.color === 0
							? `brightness(${1 - tint})`
							: `brightness(${1 + 9 * tint}) contrast(${1 - tint})`,
				};
	}
	return revealShapeCss(
		revealShape(
			reveal.type,
			revealProgress(reveal, Math.max(0, elapsed)),
			aspect
		)
	);
}
