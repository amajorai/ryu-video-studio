import type { PreviewQuality } from "../editor/store.ts";

/**
 * Preview quality and playback-rate math. Quality only changes how the
 * preview draws (the canvas scale for GPU passes, and proxy choice); exports
 * always use the original media at full resolution.
 */

export const PREVIEW_QUALITIES: readonly PreviewQuality[] = [
	"full",
	"half",
	"quarter",
];

export const PREVIEW_QUALITY_LABELS: Record<PreviewQuality, string> = {
	full: "Full",
	half: "Half",
	quarter: "Quarter",
};

const QUALITY_SCALE: Record<PreviewQuality, number> = {
	full: 1,
	half: 0.5,
	quarter: 0.25,
};

/** Resolution multiplier the preview canvas uses for a quality. */
export function previewQualityScale(quality: PreviewQuality): number {
	return QUALITY_SCALE[quality];
}

export function isPreviewQuality(value: string): value is PreviewQuality {
	return (PREVIEW_QUALITIES as readonly string[]).includes(value);
}

/**
 * Backing-store size for a preview canvas drawing a `width` × `height`
 * project at `quality`. Never below one pixel on either axis.
 */
export function previewCanvasSize(
	width: number,
	height: number,
	quality: PreviewQuality
): { height: number; width: number } {
	const scale = previewQualityScale(quality);
	return {
		height: Math.max(1, Math.round(height * scale)),
		width: Math.max(1, Math.round(width * scale)),
	};
}

export const MIN_PLAYBACK_RATE = 0.25;
export const MAX_PLAYBACK_RATE = 10;

/** Rates offered by the preview playback-rate menu. */
export const PLAYBACK_RATES = [
	0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4, 8, 10,
] as const;

/** Clamp a requested timeline playback rate to the supported 0.25-10x range. */
export function clampPlaybackRate(rate: number): number {
	if (!Number.isFinite(rate)) {
		return 1;
	}
	return Math.min(MAX_PLAYBACK_RATE, Math.max(MIN_PLAYBACK_RATE, rate));
}

/** The range browsers accept for `HTMLMediaElement.playbackRate`. */
export const MEDIA_ELEMENT_MIN_RATE = 1 / 16;
export const MEDIA_ELEMENT_MAX_RATE = 16;

/**
 * `playbackRate` for a clip's media element: the timeline rate times the
 * clip's own speed, clamped to what browsers can play. Non-positive or
 * non-finite clip speeds count as 1x.
 */
export function mediaElementPlaybackRate(
	timelineRate: number,
	clipSpeed = 1
): number {
	const speed = Number.isFinite(clipSpeed) && clipSpeed > 0 ? clipSpeed : 1;
	const rate = clampPlaybackRate(timelineRate) * speed;
	return Math.min(
		MEDIA_ELEMENT_MAX_RATE,
		Math.max(MEDIA_ELEMENT_MIN_RATE, rate)
	);
}

/** "0.25x", "1x", "10x". */
export function playbackRateLabel(rate: number): string {
	return `${Number(rate.toFixed(2))}x`;
}
