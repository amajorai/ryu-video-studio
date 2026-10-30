/**
 * Preview stage: crop. Mirrors `sidecar/src/render-stages/crop.ts`; returns
 * the `inset()` offsets (top, right, bottom, left) used in the clip path.
 * Keyframed edges follow their eased curve at `elapsed` clip seconds; like
 * the render, an animated edge hides the clip rather than re-fitting it.
 */
import { animatedValue } from "../../../../shared/animation.ts";
import type { Segment } from "../../../../shared/project.ts";
import { fittedSize } from "../../../../shared/transform.ts";
import { staticCrop, type TransformMediaSize } from "./transform.ts";

type CropProperty = "cropBottom" | "cropLeft" | "cropRight" | "cropTop";

/** An edge's crop at `elapsed`, clamped to the schema range. */
const edgeAt = (segment: Segment, property: CropProperty, elapsed: number) =>
	Math.min(0.9, Math.max(0, animatedValue(segment, property, elapsed)));

/**
 * With the media and canvas sizes known, a static crop is measured on the
 * contained picture rather than the element (they differ when the media's
 * aspect is not the canvas's), matching the window `transformCss` re-fits.
 */
export function cropInsetCss(
	segment: Segment,
	elapsed: number,
	media?: TransformMediaSize
): string {
	const top = edgeAt(segment, "cropTop", elapsed);
	const right = edgeAt(segment, "cropRight", elapsed);
	const bottom = edgeAt(segment, "cropBottom", elapsed);
	const left = edgeAt(segment, "cropLeft", elapsed);
	const cropped = top > 0 || right > 0 || bottom > 0 || left > 0;
	if (
		cropped &&
		media &&
		media.media.width > 0 &&
		media.media.height > 0 &&
		media.canvas.width > 0 &&
		media.canvas.height > 0
	) {
		// The render crops the source, so every edge (fixed or keyframed) is
		// measured on the contained picture, not on the letterboxed element.
		// A fixed crop also re-fits in `transformCss`; a keyframed one only
		// hides, as in the render.
		const crop = staticCrop(segment) ?? { bottom, left, right, top };
		const whole = fittedSize("fit", media.media, media.canvas);
		const shareX = whole.width / media.canvas.width;
		const shareY = whole.height / media.canvas.height;
		const edge = (share: number, value: number) =>
			((1 - share) / 2 + value * share) * 100;
		return `${edge(shareY, crop.top)}% ${edge(shareX, crop.right)}% ${edge(shareY, crop.bottom)}% ${edge(shareX, crop.left)}%`;
	}
	return `${top * 100}% ${right * 100}% ${bottom * 100}% ${left * 100}%`;
}
