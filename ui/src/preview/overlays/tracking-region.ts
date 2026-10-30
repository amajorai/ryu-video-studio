import {
	MIN_TRACK_REGION,
	type TrackRegion,
} from "../../../../shared/tracking.ts";

/** Keep a region inside the frame after one field changed. */
export function clampRegion(region: TrackRegion): TrackRegion {
	const width = Math.min(1, Math.max(MIN_TRACK_REGION, region.width));
	const height = Math.min(1, Math.max(MIN_TRACK_REGION, region.height));
	return {
		height,
		width,
		x: Math.min(1 - width, Math.max(0, region.x)),
		y: Math.min(1 - height, Math.max(0, region.y)),
	};
}

/** A point in canvas fractions (0..1 on each axis, clamped to the frame). */
export interface FramePoint {
	x: number;
	y: number;
}

const unit = (value: number) => Math.min(1, Math.max(0, value));

/** The frame point under a client position, given the frame's client rect. */
export function framePointAt(
	rect: Pick<DOMRect, "height" | "left" | "top" | "width">,
	clientX: number,
	clientY: number
): FramePoint {
	return {
		x: rect.width > 0 ? unit((clientX - rect.left) / rect.width) : 0,
		y: rect.height > 0 ? unit((clientY - rect.top) / rect.height) : 0,
	};
}

/** The region spanned by a drag from `from` to `to`, in either direction. */
export function regionBetween(from: FramePoint, to: FramePoint): TrackRegion {
	const x = Math.min(from.x, to.x);
	const y = Math.min(from.y, to.y);
	return clampRegion({
		height: Math.abs(to.y - from.y),
		width: Math.abs(to.x - from.x),
		x,
		y,
	});
}

/** `region` moved by a frame-fraction delta, kept inside the frame. */
export function movedRegion(
	region: TrackRegion,
	dx: number,
	dy: number
): TrackRegion {
	return clampRegion({ ...region, x: region.x + dx, y: region.y + dy });
}
