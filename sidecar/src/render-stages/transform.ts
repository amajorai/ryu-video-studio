import {
	animatedValue,
	animationExpression,
	type Project,
	type Segment,
} from "../../../shared/project.ts";
import {
	fitModeOf,
	hasUniformBox,
	maxScaleOf,
} from "../../../shared/transform.ts";

/**
 * Placement of one clip (W2-V2): its box on the canvas (`scale`, then
 * `scaleX`/`scaleY`), how the media sits in the box (`fit`), rotation, the
 * transparent pad and the overlay position. Clips without scale X/Y or a fit
 * mode keep the legacy filter strings byte for byte.
 */

/** Even pixel size expressions of the clip box, before the entry scale. */
export function scaledSize(
	segment: Segment,
	project: Project
): { h: string; w: string } {
	const scale = animationExpression(segment, "scale");
	if (hasUniformBox(segment)) {
		return {
			h: `2*max(1,round(${project.height}*(${scale})/2))`,
			w: `2*max(1,round(${project.width}*(${scale})/2))`,
		};
	}
	const scaleX = animationExpression(segment, "scaleX");
	const scaleY = animationExpression(segment, "scaleY");
	return {
		h: `2*max(1,round(${project.height}*(${scale})*(${scaleY})/2))`,
		w: `2*max(1,round(${project.width}*(${scale})*(${scaleX})/2))`,
	};
}

/**
 * Whether the clip is resized to its box before it rotates. `fill` and
 * `stretch` change the media's shape, which must happen before rotation or a
 * rotated clip shears into a parallelogram. `fit` scales uniformly, so it
 * keeps the legacy rotate-then-scale order.
 */
export function boxBeforeRotation(segment: Segment): boolean {
	return fitModeOf(segment) !== "fit";
}

/** Whether the clip rotates at any time. */
function rotates(segment: Segment): boolean {
	return (
		segment.rotation !== 0 ||
		segment.keyframes.some((frame) => frame.property === "rotation")
	);
}

const rotationAngle = (segment: Segment) =>
	`a='(${animationExpression(segment, "rotation")})*PI/180'`;

/**
 * Rotation about the clip center with a transparent fill. Clips resized
 * before rotation rotate inside `scaleFilters` instead, so this stage passes
 * them through unchanged.
 */
export function rotateFilter(segment: Segment): string {
	if (boxBeforeRotation(segment)) {
		return "null";
	}
	return `rotate=${rotationAngle(segment)}:ow=iw:oh=ih:fillcolor=black@0`;
}

const ratio = (value: number) => Number(value.toFixed(6));
const evenCeil = (value: number) => Math.ceil(value / 2) * 2;

/** Whether the box changes shape over time (keyframed scale X or Y). */
function boxShapeAnimates(segment: Segment): boolean {
	return segment.keyframes.some(
		(frame) => frame.property === "scaleX" || frame.property === "scaleY"
	);
}

/** Aspect of the box at the clip's first frame. */
function firstBoxAspect(segment: Segment, project: Project): number {
	return ratio(
		(project.width * animatedValue(segment, "scaleX", 0)) /
			(project.height * animatedValue(segment, "scaleY", 0))
	);
}

/**
 * Centred crop to the box aspect for `fill`. FFmpeg evaluates crop sizes once,
 * so the aspect uses the scale X/Y values at the clip's first frame.
 */
export function fillCropFilter(segment: Segment, project: Project): string {
	const aspect = firstBoxAspect(segment, project);
	return `crop=w='min(iw,ih*${aspect})':h='min(ih,iw/${aspect})'`;
}

/** The largest entry-transition zoom (`shared/transitions.ts`). */
const maxEntryScale = (segment: Segment) =>
	segment.entryTransition === "zoom-out" ? 1.15 : 1;

/**
 * Upper bound of the scaled clip's size for clips resized before rotation:
 * the largest box including the entry zoom, widened for `fill` with a
 * keyframed box, which covers the box without distortion and may overflow
 * it on one axis.
 */
export function maxContentSize(
	segment: Segment,
	project: Project
): { height: number; width: number } {
	const scale =
		Math.max(1, maxScaleOf(segment, "scale")) * maxEntryScale(segment);
	const width =
		project.width * scale * Math.max(1, maxScaleOf(segment, "scaleX"));
	const height =
		project.height * scale * Math.max(1, maxScaleOf(segment, "scaleY"));
	if (fitModeOf(segment) === "fill" && boxShapeAnimates(segment)) {
		// The crop's whole-pixel size can make the real aspect differ slightly
		// from the rounded one, so the covering axis keeps a 2 px margin.
		const aspect = firstBoxAspect(segment, project);
		return {
			height: Math.max(height, Math.ceil(width / aspect) + 2),
			width: Math.max(width, Math.ceil(height * aspect) + 2),
		};
	}
	return { height, width };
}

/** Square side that holds the scaled clip at any rotation. */
function rotatedSide(segment: Segment, project: Project): number {
	const { height, width } = maxContentSize(segment, project);
	return evenCeil(Math.hypot(width, height));
}

/**
 * Fit the clip into its box, multiplied by the entry-scale expression.
 *
 * - `fit`: aspect-preserving scale (after the rotate stage, legacy order).
 * - `stretch`: scale to the box, then rotate.
 * - `fill`: centred crop to the box aspect, scale to the box, then rotate.
 *   With a keyframed box the crop keeps its first-frame shape and the scale
 *   covers the box (`increase`) instead of distorting the picture.
 */
export function scaleFilters(
	segment: Segment,
	project: Project,
	entryScale: string
): string[] {
	const { h, w } = scaledSize(segment, project);
	const mode = fitModeOf(segment);
	let aspect = "disable";
	if (mode === "fit") {
		aspect = "decrease";
	} else if (mode === "fill" && boxShapeAnimates(segment)) {
		aspect = "increase";
	}
	return [
		...(mode === "fill" ? [fillCropFilter(segment, project)] : []),
		`scale='${w}*${entryScale}':'${h}*${entryScale}':force_original_aspect_ratio=${aspect}:eval=frame`,
		"setsar=1",
		...(boxBeforeRotation(segment) && rotates(segment)
			? boxRotation(segment, project)
			: []),
	];
}

const padTo = (width: number, height: number) =>
	`pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black@0:eval=frame`;

/**
 * Rotation of an already-sized box. `rotate` reads its input size once, while
 * the scale above changes size per frame (keyframes, entry zoom), so the box
 * is first centred on a fixed transparent frame.
 */
function boxRotation(segment: Segment, project: Project): string[] {
	const size = maxContentSize(segment, project);
	const side = rotatedSide(segment, project);
	return [
		padTo(evenCeil(size.width), evenCeil(size.height)),
		`rotate=${rotationAngle(segment)}:ow=${side}:oh=${side}:fillcolor=black@0`,
	];
}

/** Transparent canvas large enough for the largest keyframed box. */
export function padFilter(segment: Segment, project: Project): string {
	let width: number;
	let height: number;
	if (boxBeforeRotation(segment)) {
		const size = maxContentSize(segment, project);
		const side = rotates(segment) ? rotatedSide(segment, project) : 0;
		width = Math.max(side, evenCeil(size.width));
		height = Math.max(side, evenCeil(size.height));
	} else {
		const maxScale = Math.max(1, maxScaleOf(segment, "scale"));
		const maxScaleX = Math.max(1, maxScaleOf(segment, "scaleX"));
		const maxScaleY = Math.max(1, maxScaleOf(segment, "scaleY"));
		width = evenCeil(project.width * maxScale * maxScaleX);
		height = evenCeil(project.height * maxScale * maxScaleY);
	}
	return padTo(width, height);
}

/** Overlay position expressions relative to the canvas center. */
export function overlayPosition(
	segment: Segment,
	entryOffset: (axis: "x" | "y") => string
): { x: string; y: string } {
	const elapsed = `(t-${segment.start})`;
	return {
		x: `(W-w)/2+(${animationExpression(segment, "x", elapsed)})*W/2+(${entryOffset("x")})*W`,
		y: `(H-h)/2+(${animationExpression(segment, "y", elapsed)})*H/2+(${entryOffset("y")})*H`,
	};
}
