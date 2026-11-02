import { z } from "zod";
import { MIN_CUT_PIECE } from "./cut-ops.ts";
import { trackIndexSchema } from "./limits.ts";
import {
	type Asset,
	type Project,
	projectDuration,
	type Segment,
	segmentDuration,
	splitSegment,
	trackSettingFor,
	validateProject,
} from "./project.ts";
import { rippleDeleteRange } from "./ripple.ts";
import { syncLockedOf } from "./schema/defaults.ts";
import { withLinkedPartners } from "./selection.ts";
import { affectedTracks } from "./sync-lock.ts";
import { shiftTimedLayers } from "./timed-layers.ts";
import { timelineDeletion } from "./timeline-delete.ts";
import { withoutClips } from "./timeline-edits.ts";

/**
 * Ripple edits on the clip timeline: ripple delete of a selection (Shift+
 * Delete, `remove` with `ripple: true`) and Ripple Delete Gap. Both remove
 * spans with `rippleDeleteRange`, so titles, captions, markers, and other
 * layers stay aligned with the clips that move.
 */

const EPSILON = 1e-6;

const segmentEnd = (segment: Segment) =>
	segment.start + segmentDuration(segment);

export interface TimeSpan {
	end: number;
	start: number;
}

/** Sort spans and merge those that overlap or touch. */
export function mergeTimeSpans(spans: readonly TimeSpan[]): TimeSpan[] {
	const merged: TimeSpan[] = [];
	for (const span of [...spans].sort((a, b) => a.start - b.start)) {
		const previous = merged.at(-1);
		if (previous && span.start <= previous.end + EPSILON) {
			previous.end = Math.max(previous.end, span.end);
		} else {
			merged.push({ end: span.end, start: span.start });
		}
	}
	return merged;
}

/**
 * Throw when a ripple over `start..end` would cut a clip on a locked track.
 * Locked clips that only sit later on the timeline follow the ripple's
 * track rules.
 */
export function assertRippleSpanUnlocked(
	project: Project,
	start: number,
	end: number
) {
	const blocked = project.segments.find(
		(segment) =>
			trackSettingFor(project, segment.track).locked &&
			segment.start < end - EPSILON &&
			segmentEnd(segment) > start + EPSILON
	);
	if (blocked) {
		throw new Error(
			`Unlock track ${blocked.track + 1}: the ripple would cut its clips.`
		);
	}
}

/**
 * The first clip that closing `start..end` would cut: one overlapping the
 * span on a sync-locked track (tracks are sync-locked unless opted out).
 */
export function clipBlockingRipple(
	project: Project,
	start: number,
	end: number,
	ignoreTrack?: number
): Segment | undefined {
	return project.segments.find(
		(segment) =>
			segment.track !== ignoreTrack &&
			syncLockedOf(trackSettingFor(project, segment.track)) &&
			segment.start < end - EPSILON &&
			segmentEnd(segment) > start + EPSILON
	);
}

export interface RippleRemoveResult {
	/** Spans closed, latest first. */
	closed: TimeSpan[];
	project: Project;
	/**
	 * Spans left open: other clips still cover them (closing would cut those
	 * clips), or they are shorter than the 0.04 s minimum.
	 */
	unclosed: number;
}

/**
 * Remove clips (and their linked partners) and close each contiguous span
 * they covered, latest first so earlier spans keep their times. A span
 * still covered by a clip on a sync-locked track, or by an unselected clip on
 * a track a removed clip sat on, stays open, since closing it would cut that
 * clip; a span past the end of the timeline needs none.
 */
export function rippleRemoveClips(
	project: Project,
	assets: readonly Asset[],
	ids: readonly string[]
): RippleRemoveResult {
	const unknown = ids.find(
		(id) => !project.segments.some((segment) => segment.id === id)
	);
	if (unknown) {
		throw new Error("Clip not found on this timeline.");
	}
	const deletion = timelineDeletion(project, ids);
	if (!deletion.ids.size) {
		throw new Error("Choose at least one clip to ripple delete.");
	}
	if (deletion.locked) {
		throw new Error("Unlock every affected clip track before deleting.");
	}
	const removed = project.segments.filter((segment) =>
		deletion.ids.has(segment.id)
	);
	const spans = mergeTimeSpans(
		removed.map((segment) => ({
			end: segmentEnd(segment),
			start: segment.start,
		}))
	);
	let next = withoutClips(project, deletion.ids);
	const closed: TimeSpan[] = [];
	let unclosed = 0;
	for (const span of spans.reverse()) {
		const end = Math.min(span.end, projectDuration(next));
		if (end <= span.start + EPSILON) {
			continue;
		}
		// The tracks the removed clips sat on close up even when they opted
		// out of sync lock; otherwise the span would stay open on them.
		const tracks = new Set(
			removed
				.filter(
					(segment) =>
						segment.start < span.end - EPSILON &&
						segmentEnd(segment) > span.start + EPSILON
				)
				.map((segment) => segment.track)
		);
		// Spans merge across tracks, so a clip left on one of those tracks
		// (sync-locked or not) can sit inside the span; closing would cut it.
		const coveredOnEditedTrack = next.segments.some(
			(segment) =>
				tracks.has(segment.track) &&
				segment.start < end - EPSILON &&
				segmentEnd(segment) > span.start + EPSILON
		);
		if (
			end - span.start < MIN_CUT_PIECE - EPSILON ||
			coveredOnEditedTrack ||
			clipBlockingRipple(next, span.start, end)
		) {
			unclosed += 1;
			continue;
		}
		assertRippleSpanUnlocked(next, span.start, end);
		next = rippleDeleteRange(next, assets, span.start, end, {
			tracks: [...tracks],
		});
		closed.push({ end, start: span.start });
	}
	return { closed, project: validateProject(next, [...assets]), unclosed };
}

/**
 * The empty span on `track` around `time`: from the end of the previous
 * clip (or the timeline start) to the start of the next clip. `null` when
 * `time` is on a clip or after the track's last clip.
 */
export function gapAt(
	project: Project,
	track: number,
	time: number
): TimeSpan | null {
	const lane = project.segments.filter((segment) => segment.track === track);
	if (
		lane.some(
			(segment) =>
				segment.start <= time + EPSILON && segmentEnd(segment) > time + EPSILON
		)
	) {
		return null;
	}
	let start = 0;
	let end = Number.POSITIVE_INFINITY;
	for (const segment of lane) {
		const segmentStop = segmentEnd(segment);
		if (segmentStop <= time + EPSILON) {
			start = Math.max(start, segmentStop);
		} else if (segment.start > time) {
			end = Math.min(end, segment.start);
		}
	}
	if (!Number.isFinite(end) || end - start <= EPSILON) {
		return null;
	}
	return { end, start };
}

/** `POST /projects/:id/ripple-delete-gap`. */
export const rippleDeleteGapRequestSchema = z
	.object({
		revision: z.number().int().nonnegative(),
		time: z.number().finite().min(0).max(7200),
		track: trackIndexSchema,
	})
	.strict();
export type RippleDeleteGapRequest = z.infer<
	typeof rippleDeleteGapRequestSchema
>;

export interface RippleDeleteGapResult {
	gap: TimeSpan;
	project: Project;
}

/**
 * Close the gap on `track` at `time` by rippling later content left. Clips
 * on other sync-locked tracks inside the gap would be cut, so they refuse
 * the edit instead.
 */
export function rippleDeleteGap(
	project: Project,
	assets: readonly Asset[],
	input: { time: number; track: number }
): RippleDeleteGapResult {
	if (trackSettingFor(project, input.track).locked) {
		throw new Error("Unlock this track before deleting its gap.");
	}
	const gap = gapAt(project, input.track, input.time);
	if (!gap) {
		throw new Error("There is no gap between clips at that point.");
	}
	if (gap.end - gap.start < MIN_CUT_PIECE - EPSILON) {
		throw new Error(
			"This gap is shorter than 0.04 seconds; move the next clip instead."
		);
	}
	const blocking = clipBlockingRipple(project, gap.start, gap.end, input.track);
	if (blocking) {
		throw new Error(
			`Track ${blocking.track + 1} has clips inside this gap; deleting it would cut them.`
		);
	}
	assertRippleSpanUnlocked(project, gap.start, gap.end);
	return {
		gap,
		project: rippleDeleteRange(project, assets, gap.start, gap.end, {
			tracks: [input.track],
		}),
	};
}

export interface RippleMoveResult {
	/** Where the moved block starts after the edit. */
	at: number;
	project: Project;
}

/**
 * Ripple move (pointer moves in ripple mode): extract the clips and their
 * linked partners, closing the span they leave (like a ripple delete), then
 * insert them as a block at the edit point nearest the drop on their target
 * track, pushing that track's later clips (and sync-locked tracks) right.
 * The drop snaps to a clip boundary so no clip is cut, and a drop past the
 * end of the track's content lands at that end, so the track stays gapless.
 * The moved clips keep their ids and every property.
 */
export function rippleMoveClips(
	project: Project,
	assets: readonly Asset[],
	input: { clipIds: readonly string[]; delta: number; trackDelta: number }
): RippleMoveResult {
	const moverIds = new Set(withLinkedPartners(project, input.clipIds));
	const movers = project.segments.filter((segment) => moverIds.has(segment.id));
	if (!movers.length) {
		throw new Error("Choose at least one clip to move.");
	}
	const blockStart = Math.min(...movers.map((segment) => segment.start));
	const blockEnd = Math.max(...movers.map(segmentEnd));
	const blockDuration = blockEnd - blockStart;
	const extracted = rippleRemoveClips(project, assets, [...moverIds]);
	// The drop point in the extracted timeline: closed spans before it are gone.
	let target = Math.max(0, blockStart + input.delta);
	for (const span of [...extracted.closed].sort((a, b) => b.start - a.start)) {
		if (target >= span.end - EPSILON) {
			target -= span.end - span.start;
		} else if (target > span.start) {
			target = span.start;
		}
	}
	const anchor = movers.find((segment) => input.clipIds.includes(segment.id));
	const targetTrack =
		(anchor?.track ?? movers[0]?.track ?? 0) + input.trackDelta;
	const remaining = extracted.project.segments.filter(
		(segment) => segment.track === targetTrack
	);
	const contentEnd = Math.max(0, ...remaining.map(segmentEnd));
	let at = contentEnd;
	if (target < contentEnd - EPSILON) {
		const edges = [
			0,
			...remaining.flatMap((segment) => [segment.start, segmentEnd(segment)]),
		];
		at = edges.reduce(
			(best, edge) =>
				Math.abs(edge - target) < Math.abs(best - target) - EPSILON
					? edge
					: best,
			contentEnd
		);
	}
	const tracks = new Set(
		movers.map((segment) => segment.track + input.trackDelta)
	);
	const affected = affectedTracks(extracted.project, tracks);
	const segments: Segment[] = [];
	for (const segment of extracted.project.segments) {
		if (!affected.has(segment.track) || segmentEnd(segment) <= at + EPSILON) {
			segments.push(segment);
		} else if (segment.start >= at - EPSILON) {
			segments.push({ ...segment, start: segment.start + blockDuration });
		} else {
			// A sync-locked clip spanning the edit point is cut there.
			const [left, right] = splitSegment(segment, at);
			segments.push(left, { ...right, start: right.start + blockDuration });
		}
	}
	for (const segment of movers) {
		segments.push({
			...segment,
			start: at + (segment.start - blockStart),
			track: segment.track + input.trackDelta,
		});
	}
	const shifted = {
		...extracted.project,
		...shiftTimedLayers(extracted.project, at, blockDuration),
		segments,
	};
	return { at, project: validateProject(shifted, [...assets]) };
}
