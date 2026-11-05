import {
	type Project,
	type Segment,
	segmentDuration,
	trackSettingFor,
} from "./project.ts";

/** Half a millisecond: clips starting this close to a time count as at it. */
const TIME_EPSILON = 0.0005;

export interface SelectionScope {
	/** Restrict the selection to one track; absent means every track. */
	track?: number;
}

const selectable = (
	project: Project,
	segment: Segment,
	scope: SelectionScope
) =>
	(scope.track === undefined || segment.track === scope.track) &&
	!trackSettingFor(project, segment.track).locked;

/** Timeline order: earliest first, then lowest track. */
const timelineOrder = (a: Segment, b: Segment) =>
	a.start - b.start || a.track - b.track;

/**
 * Clips that start at or after `time` (track select forward). Locked tracks
 * are skipped because nothing selected there could be edited.
 */
export function selectForward(
	project: Project,
	time: number,
	scope: SelectionScope = {}
): string[] {
	return project.segments
		.filter(
			(segment) =>
				segment.start >= time - TIME_EPSILON &&
				selectable(project, segment, scope)
		)
		.sort(timelineOrder)
		.map((segment) => segment.id);
}

/** Every clip, or every clip on one track, outside locked tracks. */
export function selectAll(
	project: Project,
	scope: SelectionScope = {}
): string[] {
	return project.segments
		.filter((segment) => selectable(project, segment, scope))
		.sort(timelineOrder)
		.map((segment) => segment.id);
}

/**
 * `ids` plus every clip sharing a link group with one of them, in project
 * order. Unknown ids are dropped.
 */
export function withLinkedPartners(
	project: Pick<Project, "segments">,
	ids: Iterable<string>
): string[] {
	const wanted = new Set(ids);
	const groups = new Set<string>();
	for (const segment of project.segments) {
		if (wanted.has(segment.id) && segment.linkGroupId) {
			groups.add(segment.linkGroupId);
		}
	}
	return project.segments
		.filter(
			(segment) =>
				wanted.has(segment.id) ||
				(segment.linkGroupId !== undefined && groups.has(segment.linkGroupId))
		)
		.map((segment) => segment.id);
}

/** An axis-aligned rectangle in timeline-content pixels. */
export interface TimelineRect {
	bottom: number;
	left: number;
	right: number;
	top: number;
}

/** Where one clip is drawn, in the same pixel space as the marquee. */
export interface ClipRect extends TimelineRect {
	id: string;
}

/** The vertical extent of one track row. */
export interface TrackRow {
	bottom: number;
	top: number;
	track: number;
}

/** The normalized rectangle spanned by two pointer positions. */
export function rectFromPoints(
	a: { x: number; y: number },
	b: { x: number; y: number }
): TimelineRect {
	return {
		bottom: Math.max(a.y, b.y),
		left: Math.min(a.x, b.x),
		right: Math.max(a.x, b.x),
		top: Math.min(a.y, b.y),
	};
}

/**
 * Lay clips out the way the timeline draws them: `start * zoom` across and
 * the row of their track down. Clips on tracks without a row, and clips on
 * locked tracks (which a marquee must not select, as `selectAll` skips
 * them), are omitted.
 */
export function timelineLayout(
	project: Pick<Project, "segments" | "trackSettings">,
	rows: readonly TrackRow[],
	zoom: number
): ClipRect[] {
	const rowFor = new Map(rows.map((row) => [row.track, row]));
	return project.segments.flatMap((segment) => {
		const row = rowFor.get(segment.track);
		if (!row || trackSettingFor(project, segment.track).locked) {
			return [];
		}
		return [
			{
				bottom: row.bottom,
				id: segment.id,
				left: segment.start * zoom,
				right: (segment.start + segmentDuration(segment)) * zoom,
				top: row.top,
			},
		];
	});
}

/** Ids of the clips a marquee touches (any overlap counts, edges excluded). */
export function clipsInRect(
	layout: readonly ClipRect[],
	rect: TimelineRect
): string[] {
	return layout
		.filter(
			(clip) =>
				clip.left < rect.right &&
				clip.right > rect.left &&
				clip.top < rect.bottom &&
				clip.bottom > rect.top
		)
		.map((clip) => clip.id);
}

/**
 * Combine a marquee hit list with the selection it started from: a plain
 * marquee replaces the selection, an additive (Shift/Ctrl) one extends it.
 */
export function marqueeSelection(
	initial: readonly string[],
	hits: readonly string[],
	additive: boolean
): string[] {
	if (!additive) {
		return [...hits];
	}
	const merged = [...initial];
	for (const id of hits) {
		if (!merged.includes(id)) {
			merged.push(id);
		}
	}
	return merged;
}
