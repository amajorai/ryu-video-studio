import type { Segment } from "../../../shared/project.ts";
import { flipOf } from "../../../shared/transform.ts";

/**
 * Horizontal and vertical flips (W2-V2). They mirror the cropped source
 * before colour, effects, masks and rotation, so a flipped clip still rotates
 * the way its `rotation` says. Unflipped clips add no filter.
 */
export function flipFilters(segment: Segment): string[] {
	const { horizontal, vertical } = flipOf(segment);
	return [...(horizontal ? ["hflip"] : []), ...(vertical ? ["vflip"] : [])];
}
