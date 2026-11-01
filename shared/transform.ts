/**
 * Flip, non-uniform scale and fit modes (W2-V2), shared by the render stage
 * (`sidecar/src/render-stages/{flip,transform}.ts`), the preview stage
 * (`ui/src/preview/stages/transform.ts`) and layout code that needs the same
 * geometry (`fillCrop` for layout cells).
 *
 * Geometry model ("box" semantics):
 *
 * - The clip's box is the canvas multiplied by `scale`, then its width by
 *   `scaleX` and its height by `scaleY`.
 * - `fit` (the default) letterboxes the (user-cropped) media inside the box
 *   without distortion, `fill` crops it to cover the box without distortion,
 *   and `stretch` distorts it to exactly the box.
 * - Flips mirror the source before rotation, so a flipped clip still rotates
 *   in the direction its `rotation` says.
 *
 * Every function is pure and deterministic. Optional fields are read through
 * the accessors here or in `schema/defaults.ts`, so legacy clips behave as
 * before.
 */
import type { Crop, Segment } from "./project.ts";
import { scaleXOf, scaleYOf } from "./schema/defaults.ts";

export const fitModes = ["fit", "fill", "stretch"] as const;
export type FitMode = (typeof fitModes)[number];

/** The effective fit mode (absent means `fit`, today's letterbox behaviour). */
export const fitModeOf = (segment: Pick<Segment, "fit">): FitMode =>
	segment.fit ?? "fit";

/** Whether the clip is mirrored horizontally and vertically. */
export function flipOf(segment: Pick<Segment, "flipH" | "flipV">): {
	horizontal: boolean;
	vertical: boolean;
} {
	return {
		horizontal: segment.flipH === true,
		vertical: segment.flipV === true,
	};
}

/** Sign multipliers for each axis: -1 when that axis is flipped. */
export function flipFactors(segment: Pick<Segment, "flipH" | "flipV">): {
	x: 1 | -1;
	y: 1 | -1;
} {
	const { horizontal, vertical } = flipOf(segment);
	return { x: horizontal ? -1 : 1, y: vertical ? -1 : 1 };
}

/**
 * True when the clip's box is the plain uniform `scale` box: no scale X/Y
 * value and no scale X/Y keyframes. Such clips keep the legacy render chain.
 */
export function hasUniformBox(
	segment: Pick<Segment, "keyframes" | "scaleX" | "scaleY">
): boolean {
	return (
		scaleXOf(segment) === 1 &&
		scaleYOf(segment) === 1 &&
		!segment.keyframes.some(
			(frame) => frame.property === "scaleX" || frame.property === "scaleY"
		)
	);
}

/** Largest value a scale channel reaches: its static value or any keyframe. */
export function maxScaleOf(
	segment: Pick<Segment, "keyframes" | "scale" | "scaleX" | "scaleY">,
	property: "scale" | "scaleX" | "scaleY"
): number {
	let base = segment.scale;
	if (property === "scaleX") {
		base = scaleXOf(segment);
	} else if (property === "scaleY") {
		base = scaleYOf(segment);
	}
	return Math.max(
		base,
		...segment.keyframes
			.filter((frame) => frame.property === property)
			.map((frame) => frame.value)
	);
}

export interface Size {
	height: number;
	width: number;
}

const round6 = (value: number) => Number(value.toFixed(6));

/**
 * Size the media is drawn at inside a `box` for a fit mode. `fill` and
 * `stretch` always occupy the box; `fill` crops (see `fillCrop`) and
 * `stretch` distorts.
 */
export function fittedSize(mode: FitMode, media: Size, box: Size): Size {
	if (mode !== "fit") {
		return { height: box.height, width: box.width };
	}
	if (media.width <= 0 || media.height <= 0) {
		return { height: 0, width: 0 };
	}
	const factor = Math.min(box.width / media.width, box.height / media.height);
	return { height: media.height * factor, width: media.width * factor };
}

/**
 * Centred crop edges, normalized to the asset, that make an
 * `assetWidth`×`assetHeight` frame cover the aspect of
 * `targetWidth`×`targetHeight`. Only the overflowing axis is cropped.
 * Degenerate sizes return no crop.
 */
export function fillCrop(
	assetWidth: number,
	assetHeight: number,
	targetWidth: number,
	targetHeight: number
): Crop {
	const none: Crop = { bottom: 0, left: 0, right: 0, top: 0 };
	if (
		!(assetWidth > 0 && assetHeight > 0 && targetWidth > 0 && targetHeight > 0)
	) {
		return none;
	}
	const assetAspect = assetWidth / assetHeight;
	const targetAspect = targetWidth / targetHeight;
	if (assetAspect > targetAspect) {
		const edge = round6((1 - targetAspect / assetAspect) / 2);
		return { ...none, left: edge, right: edge };
	}
	if (assetAspect < targetAspect) {
		const edge = round6((1 - assetAspect / targetAspect) / 2);
		return { ...none, bottom: edge, top: edge };
	}
	return none;
}

/** Schema bounds of one crop edge (`cropSchema`: 0..0.9, opposite edges < 1). */
const MAX_CROP_EDGE = 0.9;

/**
 * Merge a cover crop for `target` into an existing user crop: the user crop
 * is applied first, and the cover crop is centred inside what remains. The
 * result is normalized to the full asset and stays within `cropSchema`.
 */
export function fillCropWithin(
	crop: Crop,
	assetWidth: number,
	assetHeight: number,
	targetWidth: number,
	targetHeight: number
): Crop {
	const keptWidth = 1 - crop.left - crop.right;
	const keptHeight = 1 - crop.top - crop.bottom;
	const cover = fillCrop(
		assetWidth * keptWidth,
		assetHeight * keptHeight,
		targetWidth,
		targetHeight
	);
	const edge = (value: number) => Math.min(MAX_CROP_EDGE, round6(value));
	return {
		bottom: edge(crop.bottom + cover.bottom * keptHeight),
		left: edge(crop.left + cover.left * keptWidth),
		right: edge(crop.right + cover.right * keptWidth),
		top: edge(crop.top + cover.top * keptHeight),
	};
}

/** Box of a clip on the canvas: canvas × scale, then × scaleX / × scaleY. */
export function clipBox(
	canvas: Size,
	scales: { scale: number; scaleX: number; scaleY: number }
): Size {
	return {
		height: canvas.height * scales.scale * scales.scaleY,
		width: canvas.width * scales.scale * scales.scaleX,
	};
}

/**
 * Size the user-cropped media occupies on the canvas for the given scales.
 * Rotation is ignored (it turns the drawn rectangle about its centre).
 */
export function clipContentSize(
	segment: Pick<Segment, "crop" | "fit">,
	media: Size,
	canvas: Size,
	scales: { scale: number; scaleX: number; scaleY: number }
): Size {
	const cropped: Size = {
		height: media.height * (1 - segment.crop.top - segment.crop.bottom),
		width: media.width * (1 - segment.crop.left - segment.crop.right),
	};
	return fittedSize(fitModeOf(segment), cropped, clipBox(canvas, scales));
}

/**
 * CSS scale factors that turn a media element drawn with `object-fit:
 * contain` over the whole canvas into the clip's content size.
 *
 * Without media dimensions the media is assumed to share the canvas aspect,
 * and a non-uniform `fit`/`fill` box is reported as not exact.
 * `fill` uses the uniform cover factor, which is exact when the box reaches
 * past the canvas on the cropped axis (CSS cannot crop the overflow inside a
 * smaller box), so the result says whether it is exact for a centred clip.
 */
export function previewScaleFactors(
	mode: FitMode,
	scales: { scale: number; scaleX: number; scaleY: number },
	media?: { canvas: Size; media: Size }
): { exact: boolean; x: number; y: number } {
	const { scale, scaleX, scaleY } = scales;
	if (mode === "fit" && scaleX === scaleY) {
		// Contain in a canvas-aspect box is the legacy uniform scale.
		return { exact: true, x: scale * scaleX, y: scale * scaleX };
	}
	if (mode === "stretch") {
		if (!media) {
			return { exact: true, x: scale * scaleX, y: scale * scaleY };
		}
		const base = fittedSize("fit", media.media, media.canvas);
		const box = clipBox(media.canvas, scales);
		if (base.width <= 0 || base.height <= 0) {
			return { exact: false, x: scale * scaleX, y: scale * scaleY };
		}
		return {
			exact: true,
			x: box.width / base.width,
			y: box.height / base.height,
		};
	}
	if (!media) {
		// The media's shape decides which axis limits a non-uniform box, so
		// without it the uniform factor is only a guess.
		const factor =
			scale * (mode === "fit" ? Math.min : Math.max)(scaleX, scaleY);
		return { exact: scaleX === scaleY, x: factor, y: factor };
	}
	const base = fittedSize("fit", media.media, media.canvas);
	if (base.width <= 0 || base.height <= 0) {
		return { exact: false, x: scale, y: scale };
	}
	const box = clipBox(media.canvas, scales);
	if (mode === "fit") {
		const drawn = fittedSize("fit", media.media, box);
		const factor = drawn.width / base.width;
		return { exact: true, x: factor, y: factor };
	}
	const factor = Math.max(box.width / base.width, box.height / base.height);
	const epsilon = 1e-6;
	// Overflow past the box is only hidden where the box spans the canvas.
	const widthHidden =
		base.width * factor <= box.width + epsilon ||
		box.width >= media.canvas.width - epsilon;
	const heightHidden =
		base.height * factor <= box.height + epsilon ||
		box.height >= media.canvas.height - epsilon;
	return { exact: widthHidden && heightHidden, x: factor, y: factor };
}

/** The CSS `object-fit` that matches a fit mode on a canvas-sized element. */
export function objectFitFor(mode: FitMode): "contain" | "cover" | "fill" {
	if (mode === "fill") {
		return "cover";
	}
	return mode === "stretch" ? "fill" : "contain";
}
