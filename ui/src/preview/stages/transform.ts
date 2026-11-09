/**
 * Preview stage: position, scale X/Y, fit, rotation and flips (W2-V2).
 * Mirrors `sidecar/src/render-stages/{flip,transform}.ts`. Entry-transition
 * offsets come from the transitions stage so both stages can change
 * independently.
 *
 * The transform list is applied right to left, in render order: flip, then
 * rotate and the box scale, then translate. A uniform scale is listed before
 * the rotation (the legacy string, byte for byte); a non-uniform box scale
 * (stretch) is applied before the rotation so the rotated box is not sheared.
 */
import { isAnimated } from "../../../../shared/animation.ts";
import { animatedValue, type Segment } from "../../../../shared/project.ts";
import {
	fitModeOf,
	fittedSize,
	flipFactors,
	objectFitFor,
	previewScaleFactors,
	type Size,
} from "../../../../shared/transform.ts";
import type { EntryTransitionState } from "./transitions.ts";

/** Media and canvas sizes; with them, fill and stretch preview exactly. */
export interface TransformMediaSize {
	canvas: Size;
	media: Size;
}

const formatScale = (x: number, y: number) =>
	x === y ? `scale(${x})` : `scale(${x}, ${y})`;

const CROP_PROPERTIES = [
	"cropBottom",
	"cropLeft",
	"cropRight",
	"cropTop",
] as const;

/**
 * The clip's fixed crop when the render re-fits it: a static crop cuts the
 * source before it is fitted into the box, so the kept window is what fit
 * and fill size. Animated crop edges only hide the clip (both in the render
 * and the preview), so they never re-fit. `undefined` when nothing re-fits.
 */
export function staticCrop(segment: Segment): Segment["crop"] | undefined {
	if (CROP_PROPERTIES.some((property) => isAnimated(segment, property))) {
		return;
	}
	const { bottom, left, right, top } = segment.crop;
	if (!(left || right || top || bottom)) {
		return;
	}
	const width = 1 - left - right;
	const height = 1 - top - bottom;
	if (width <= 0 || height <= 0) {
		return;
	}
	return segment.crop;
}

/** Whether both sizes are known, so the preview can size the media exactly. */
const knownSizes = (media: TransformMediaSize | undefined) =>
	media !== undefined &&
	media.media.width > 0 &&
	media.media.height > 0 &&
	media.canvas.width > 0 &&
	media.canvas.height > 0;

export function transformCss(
	segment: Segment,
	elapsed: number,
	entry: EntryTransitionState,
	media?: TransformMediaSize
): string {
	const x = animatedValue(segment, "x", elapsed) * 50 + entry.shiftX * 100;
	const y = animatedValue(segment, "y", elapsed) * 50 + entry.shiftY * 100;
	const sized = media && knownSizes(media) ? media : undefined;
	const crop = sized ? staticCrop(segment) : undefined;
	// With a static crop the render fits the kept window, so size that
	// window instead of the whole source.
	const fitted =
		sized && crop
			? {
					canvas: sized.canvas,
					media: {
						height: sized.media.height * (1 - crop.top - crop.bottom),
						width: sized.media.width * (1 - crop.left - crop.right),
					},
				}
			: media;
	const factors = previewScaleFactors(
		fitModeOf(segment),
		{
			scale: animatedValue(segment, "scale", elapsed) * entry.scale,
			scaleX: animatedValue(segment, "scaleX", elapsed),
			scaleY: animatedValue(segment, "scaleY", elapsed),
		},
		fitted
	);
	// Spin and wobble transitions/animations add to the clip's own rotation.
	const rotation =
		animatedValue(segment, "rotation", elapsed) + (entry.rotation ?? 0);
	const flip = flipFactors(segment);
	const mirror =
		flip.x === 1 && flip.y === 1 ? "" : ` ${formatScale(flip.x, flip.y)}`;
	if (!(sized && crop && fitted)) {
		const box = formatScale(factors.x, factors.y);
		// A non-uniform box is sized before it rotates (as the render resizes
		// stretch and fill before rotating), so the rotated box keeps its
		// corners.
		const placement =
			factors.x === factors.y
				? `${box} rotate(${rotation}deg)`
				: `rotate(${rotation}deg) ${box}`;
		return `translate(${x}%, ${y}%) ${placement}${mirror}`;
	}
	// The element still shows the whole source (`object-fit: contain`) with
	// the window masked by the crop inset. Move the window's centre to the
	// element centre, then scale it from its contained size on the element to
	// the size the render draws it at; the flip mirrors the cropped picture.
	const whole = fittedSize("fit", sized.media, sized.canvas);
	const window = fittedSize("fit", fitted.media, sized.canvas);
	const keptWidth = 1 - crop.left - crop.right;
	const keptHeight = 1 - crop.top - crop.bottom;
	const zoomX = (window.width * factors.x) / (whole.width * keptWidth);
	const zoomY = (window.height * factors.y) / (whole.height * keptHeight);
	const centreX =
		((whole.width / sized.canvas.width) * (crop.left - crop.right) * 100) / 2;
	const centreY =
		((whole.height / sized.canvas.height) * (crop.top - crop.bottom) * 100) / 2;
	const box = formatScale(zoomX, zoomY);
	const recentre = ` translate(${-centreX}%, ${-centreY}%)`;
	return `translate(${x}%, ${y}%) rotate(${rotation}deg) ${box}${mirror}${recentre}`;
}

/**
 * The `object-fit` for a media element whose transform was computed without
 * media sizes: `cover` for fill and `fill` for stretch make those modes exact
 * for uniform boxes. When `transformCss` receives media sizes, keep the
 * stylesheet's `contain`, because its factors are relative to contain.
 */
export function mediaObjectFit(segment: Segment): "contain" | "cover" | "fill" {
	return objectFitFor(fitModeOf(segment));
}
