/**
 * Preview zoom and pan math. A numeric zoom is project pixels to screen
 * pixels (1 = 100%, one project pixel per CSS pixel); "fit" shows the whole
 * frame. The viewport scales the fitted frame by `viewportScale` and offsets
 * it by a clamped pan in screen pixels.
 */

export type PreviewZoom = "fit" | number;

export interface Size {
	height: number;
	width: number;
}

export interface Pan {
	x: number;
	y: number;
}

export const MIN_PREVIEW_ZOOM = 0.25;
export const MAX_PREVIEW_ZOOM = 4;

/** Zoom levels offered by the preview zoom menu, after "Fit". */
export const PREVIEW_ZOOM_LEVELS = [0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4] as const;

export const NO_PAN: Pan = { x: 0, y: 0 };

export function clampPreviewZoom(zoom: number): number {
	if (!Number.isFinite(zoom)) {
		return 1;
	}
	return Math.min(MAX_PREVIEW_ZOOM, Math.max(MIN_PREVIEW_ZOOM, zoom));
}

/** "Fit" or a percentage such as "25%" or "150%". */
export function previewZoomLabel(zoom: PreviewZoom): string {
	return zoom === "fit"
		? "Fit"
		: `${Math.round(clampPreviewZoom(zoom) * 100)}%`;
}

const validSize = (size: Size) =>
	size.width > 0 &&
	size.height > 0 &&
	Number.isFinite(size.width) &&
	Number.isFinite(size.height);

/**
 * Screen pixels per project pixel when the frame fits the stage (the same
 * rule as the frame's CSS: the largest size that fits both axes).
 */
export function fitScale(stage: Size, frame: Size): number {
	if (!(validSize(stage) && validSize(frame))) {
		return 1;
	}
	return Math.min(stage.width / frame.width, stage.height / frame.height);
}

/** Screen pixels per project pixel at `zoom`. */
export function zoomScale(zoom: PreviewZoom, stage: Size, frame: Size): number {
	return zoom === "fit" ? fitScale(stage, frame) : clampPreviewZoom(zoom);
}

/**
 * CSS scale applied to the fitted frame so it shows at `zoom`. Fit, or an
 * unmeasured stage, is 1 (no transform).
 */
export function viewportScale(
	zoom: PreviewZoom,
	stage: Size,
	frame: Size
): number {
	if (zoom === "fit" || !(validSize(stage) && validSize(frame))) {
		return 1;
	}
	return clampPreviewZoom(zoom) / fitScale(stage, frame);
}

/** On-screen size of the frame at `zoom`. */
export function displayedFrameSize(
	zoom: PreviewZoom,
	stage: Size,
	frame: Size
): Size {
	const scale = zoomScale(zoom, stage, frame);
	return { height: frame.height * scale, width: frame.width * scale };
}

/** Furthest the frame may pan on each axis: zero when it fits that axis. */
export function panLimits(zoom: PreviewZoom, stage: Size, frame: Size): Pan {
	if (zoom === "fit" || !(validSize(stage) && validSize(frame))) {
		return NO_PAN;
	}
	const shown = displayedFrameSize(zoom, stage, frame);
	return {
		x: Math.max(0, (shown.width - stage.width) / 2),
		y: Math.max(0, (shown.height - stage.height) / 2),
	};
}

/** Whether the zoomed frame overflows the stage, so panning moves it. */
export function canPan(zoom: PreviewZoom, stage: Size, frame: Size): boolean {
	const limits = panLimits(zoom, stage, frame);
	return limits.x > 0 || limits.y > 0;
}

const clampAxis = (value: number, limit: number) =>
	limit === 0 ? 0 : Math.min(limit, Math.max(-limit, value));

/** Keep a pan offset inside the limits so the frame always covers the stage edge it overflows. */
export function clampPan(
	pan: Pan,
	zoom: PreviewZoom,
	stage: Size,
	frame: Size
): Pan {
	const limits = panLimits(zoom, stage, frame);
	return { x: clampAxis(pan.x, limits.x), y: clampAxis(pan.y, limits.y) };
}

/** Next zoom level in `direction` from the current zoom (fit resolves to its scale first). */
export function stepPreviewZoom(
	zoom: PreviewZoom,
	direction: 1 | -1,
	stage: Size,
	frame: Size
): number {
	const current = zoomScale(zoom, stage, frame);
	const levels =
		direction === 1
			? PREVIEW_ZOOM_LEVELS.filter((level) => level > current + 1e-6)
			: PREVIEW_ZOOM_LEVELS.filter((level) => level < current - 1e-6);
	const next = direction === 1 ? levels[0] : levels.at(-1);
	return next ?? (direction === 1 ? MAX_PREVIEW_ZOOM : MIN_PREVIEW_ZOOM);
}

/** The CSS transform for a scale and pan; `undefined` when it is the identity. */
export function viewportTransform(scale: number, pan: Pan): string | undefined {
	if (scale === 1 && pan.x === 0 && pan.y === 0) {
		return;
	}
	return `translate(${pan.x}px, ${pan.y}px) scale(${scale})`;
}
