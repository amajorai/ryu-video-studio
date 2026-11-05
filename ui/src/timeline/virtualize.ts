import { type Segment, segmentDuration } from "../../../shared/project.ts";

/**
 * Timeline clip virtualization (W4-Q1). Long timelines mount only the clips
 * in the visible time window plus an overscan on both sides; selected clips
 * stay mounted so focus, drags and keyboard nudges never lose their element.
 *
 * Pure helpers: a per-lane index (clips by start with a running reach, so a
 * window query is two binary searches plus the clips it returns) and the
 * window math from the scroll viewport.
 */

/** Timelines with fewer clips than this mount every clip. */
export const VIRTUALIZE_MIN_CLIPS = 100;
/** Extra pixels mounted on each side of the viewport. */
export const VIRTUALIZE_OVERSCAN_PX = 800;
/**
 * Scroll positions are bucketed to this many pixels, so scrolling within a
 * bucket does not re-render the lanes. Must not exceed the overscan.
 */
export const VIRTUALIZE_SCROLL_BUCKET_PX = 400;

/**
 * Viewport width assumed before the first measurement, so the first render
 * of a long timeline already mounts a window instead of every clip.
 */
export const VIRTUALIZE_FALLBACK_WIDTH_PX = 2560;

/** A span of timeline seconds. */
export interface TimeWindow {
	end: number;
	start: number;
}

/** One lane's clips ordered by start, with the furthest end seen so far. */
export interface LaneIndex {
	/** `reach[i]` is the latest end among `segments[0..i]`. */
	reach: number[];
	segments: Segment[];
	starts: number[];
}

/** Index one lane's clips (any order) for window queries. */
export function laneIndex(segments: readonly Segment[]): LaneIndex {
	const ordered = [...segments].sort(
		(a, b) => a.start - b.start || a.id.localeCompare(b.id)
	);
	const reach: number[] = [];
	let furthest = Number.NEGATIVE_INFINITY;
	for (const segment of ordered) {
		furthest = Math.max(furthest, segment.start + segmentDuration(segment));
		reach.push(furthest);
	}
	return {
		reach,
		segments: ordered,
		starts: ordered.map((segment) => segment.start),
	};
}

/** Clips grouped by track, each lane indexed. */
export function laneIndexes(
	segments: readonly Segment[]
): Map<number, LaneIndex> {
	const byTrack = new Map<number, Segment[]>();
	for (const segment of segments) {
		const lane = byTrack.get(segment.track);
		if (lane) {
			lane.push(segment);
		} else {
			byTrack.set(segment.track, [segment]);
		}
	}
	const indexes = new Map<number, LaneIndex>();
	for (const [track, lane] of byTrack) {
		indexes.set(track, laneIndex(lane));
	}
	return indexes;
}

/** First index whose value is ≥ `target` in an ascending list. */
function firstAtLeast(values: readonly number[], target: number): number {
	let low = 0;
	let high = values.length;
	while (low < high) {
		const middle = (low + high) >>> 1;
		if ((values[middle] ?? 0) < target) {
			low = middle + 1;
		} else {
			high = middle;
		}
	}
	return low;
}

/** First index whose value is > `target` in an ascending list. */
function firstAbove(values: readonly number[], target: number): number {
	let low = 0;
	let high = values.length;
	while (low < high) {
		const middle = (low + high) >>> 1;
		if ((values[middle] ?? 0) <= target) {
			low = middle + 1;
		} else {
			high = middle;
		}
	}
	return low;
}

/**
 * The lane's clips that overlap `window` (inclusive edges), plus any clip in
 * `keep`, in start order. Without a window every clip is returned.
 */
export function clipsInWindow(
	lane: LaneIndex,
	window: TimeWindow | null,
	keep: ReadonlySet<string> = new Set()
): Segment[] {
	if (!window) {
		return lane.segments;
	}
	const first = firstAtLeast(lane.reach, window.start);
	const last = firstAbove(lane.starts, window.end);
	const visible: Segment[] = [];
	for (const [index, segment] of lane.segments.entries()) {
		const inside =
			index >= first &&
			index < last &&
			segment.start + segmentDuration(segment) >= window.start;
		if (inside || keep.has(segment.id)) {
			visible.push(segment);
		}
		if (index >= last && keep.size === 0) {
			break;
		}
	}
	return visible;
}

/** The scroll offset rounded down to its bucket. */
export function scrollBucket(
	scrollLeft: number,
	bucketPx = VIRTUALIZE_SCROLL_BUCKET_PX
): number {
	return Math.max(0, Math.floor(scrollLeft / bucketPx) * bucketPx);
}

/**
 * The mounted time window: the viewport from the bucketed scroll offset,
 * widened by one bucket (scrolling inside the bucket stays covered) and the
 * overscan on both sides. Before the viewport is measured (`undefined`)
 * the fallback width stands in. `null` when the measured viewport has no
 * width (no layout, as in tests) or the timeline is short, so every clip
 * mounts.
 */
export function visibleTimeWindow({
	clipCount,
	...viewport
}: ViewportWindowInput & { clipCount: number }): TimeWindow | null {
	if (clipCount < VIRTUALIZE_MIN_CLIPS) {
		return null;
	}
	return viewportTimeWindow(viewport);
}

/** The scroll viewport a time window is taken from. */
export interface ViewportWindowInput {
	bucketPx?: number;
	/** Pixels from the scrolled content's left edge to time 0. */
	lanesOffset: number;
	overscanPx?: number;
	/** Bucketed scroll offset of the viewport. */
	scrollLeft: number;
	/** Measured viewport width; `undefined` before the first measurement. */
	viewportWidth: number | undefined;
	/** Pixels per second. */
	zoom: number;
}

/**
 * The time window around the viewport (bucketed scroll offset, one extra
 * bucket and the overscan on both sides), whatever the clip count. `null`
 * when the measured viewport has no width or the zoom is not positive.
 */
export function viewportTimeWindow({
	lanesOffset,
	overscanPx = VIRTUALIZE_OVERSCAN_PX,
	bucketPx = VIRTUALIZE_SCROLL_BUCKET_PX,
	scrollLeft,
	viewportWidth,
	zoom,
}: ViewportWindowInput): TimeWindow | null {
	const width = viewportWidth ?? VIRTUALIZE_FALLBACK_WIDTH_PX;
	if (!(width > 0 && zoom > 0)) {
		return null;
	}
	const left = scrollLeft - lanesOffset - overscanPx;
	const right = scrollLeft + width + bucketPx - lanesOffset + overscanPx;
	return {
		end: right / zoom,
		start: Math.max(0, left / zoom),
	};
}

/**
 * Clips wider than this (pixels) draw their filmstrip and waveform only
 * around the viewport (`clipDrawSpan`); narrower clips draw whole.
 */
export const CLIP_DRAW_WINDOW_MIN_PX = 4096;

/** The widest clip of a timeline in pixels at `zoom`. */
export function widestClipPx(segments: readonly Segment[], zoom: number) {
	let widest = 0;
	for (const segment of segments) {
		widest = Math.max(widest, segmentDuration(segment));
	}
	return widest * zoom;
}

/** A clip-local span in pixels from the clip's left edge. */
export interface ClipPixelSpan {
	from: number;
	to: number;
}

/**
 * The part of a clip a filmstrip or waveform draws: the whole clip without
 * a window, otherwise its overlap with `window` in pixels from the clip's
 * left edge (empty when they do not overlap).
 */
export function clipDrawSpan(
	segment: Pick<Segment, "sourceIn" | "sourceOut" | "speed" | "start">,
	window: TimeWindow | null | undefined,
	zoom: number
): ClipPixelSpan {
	const width = ((segment.sourceOut - segment.sourceIn) / segment.speed) * zoom;
	if (!window) {
		return { from: 0, to: width };
	}
	const from = Math.min(
		width,
		Math.max(0, (window.start - segment.start) * zoom)
	);
	const to = Math.max(
		from,
		Math.min(width, (window.end - segment.start) * zoom)
	);
	return { from, to };
}
