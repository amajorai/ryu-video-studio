import { type Project, segmentDuration, trackSettingFor } from "./project.ts";
import { trackHiddenOf } from "./schema/defaults.ts";

/**
 * Edit-point and marker navigation. Edit points are the union of clip start
 * and end times on tracks that are not hidden, plus the timeline start; the
 * navigation helpers step to the nearest one strictly before or after a
 * time. Everything here is pure and deterministic: the same project and time
 * give the same answer.
 */

/** Times closer than this are one edit point (avoids float noise duplicates). */
const MERGE_EPSILON = 1e-6;

/** Round to microseconds so edges computed through speed divisions merge. */
const quantize = (time: number) => Math.round(time * 1e6) / 1e6;

function sortedUnique(times: Iterable<number>): number[] {
	const sorted = [...times]
		.filter((time) => Number.isFinite(time))
		.map(quantize)
		.sort((a, b) => a - b);
	const unique: number[] = [];
	for (const time of sorted) {
		const last = unique.at(-1);
		if (last === undefined || time - last > MERGE_EPSILON) {
			unique.push(time);
		}
	}
	return unique;
}

/**
 * Every clip edge on unhidden tracks, plus 0, sorted ascending without
 * duplicates. Clips on hidden tracks are skipped; a hidden clip on a visible
 * track still counts (it is still an edit in the sequence).
 */
export function editPoints(
	project: Pick<Project, "segments" | "trackSettings">
): number[] {
	const hidden = new Map<number, boolean>();
	const isHidden = (track: number) => {
		const cached = hidden.get(track);
		if (cached !== undefined) {
			return cached;
		}
		const value = trackHiddenOf(trackSettingFor(project, track));
		hidden.set(track, value);
		return value;
	};
	const times: number[] = [0];
	for (const segment of project.segments) {
		if (isHidden(segment.track)) {
			continue;
		}
		times.push(segment.start, segment.start + segmentDuration(segment));
	}
	return sortedUnique(times);
}

/** Marker start times and range-marker end times, sorted without duplicates. */
export function markerPoints(project: Pick<Project, "markers">): number[] {
	const times: number[] = [];
	for (const marker of project.markers) {
		times.push(marker.time);
		if (marker.duration) {
			times.push(marker.time + marker.duration);
		}
	}
	return sortedUnique(times);
}

export interface StepOptions {
	/**
	 * Points within this many seconds of `time` count as "here" and are
	 * skipped, so a playhead parked on a point moves to the next one. Defaults
	 * to half a frame at `fps`.
	 */
	epsilon?: number;
	/** Frame rate used for the default epsilon (default 30). */
	fps?: number;
}

const epsilonOf = (options: StepOptions) =>
	options.epsilon ?? 0.5 / (options.fps && options.fps > 0 ? options.fps : 30);

/** The first of `points` (sorted ascending) strictly after `time`, or null. */
export function nextPoint(
	points: readonly number[],
	time: number,
	options: StepOptions = {}
): number | null {
	const epsilon = epsilonOf(options);
	return points.find((point) => point > time + epsilon) ?? null;
}

/** The last of `points` (sorted ascending) strictly before `time`, or null. */
export function previousPoint(
	points: readonly number[],
	time: number,
	options: StepOptions = {}
): number | null {
	const epsilon = epsilonOf(options);
	return points.findLast((point) => point < time - epsilon) ?? null;
}

/** The next edit point after `time` (Down arrow), or null at the last one. */
export const nextEditPoint = (
	project: Pick<Project, "fps" | "segments" | "trackSettings">,
	time: number,
	options: StepOptions = {}
) => nextPoint(editPoints(project), time, { fps: project.fps, ...options });

/** The previous edit point before `time` (Up arrow), or null at the first one. */
export const previousEditPoint = (
	project: Pick<Project, "fps" | "segments" | "trackSettings">,
	time: number,
	options: StepOptions = {}
) => previousPoint(editPoints(project), time, { fps: project.fps, ...options });

/** The next marker start or range end after `time` (Shift+Down), or null. */
export const nextMarkerPoint = (
	project: Pick<Project, "fps" | "markers">,
	time: number,
	options: StepOptions = {}
) => nextPoint(markerPoints(project), time, { fps: project.fps, ...options });

/** The previous marker start or range end before `time` (Shift+Up), or null. */
export const previousMarkerPoint = (
	project: Pick<Project, "fps" | "markers">,
	time: number,
	options: StepOptions = {}
) =>
	previousPoint(markerPoints(project), time, { fps: project.fps, ...options });

/** Snap `time` to the nearest frame boundary at `fps`. */
export function frameQuantize(time: number, fps: number): number {
	if (!(Number.isFinite(time) && fps > 0)) {
		return 0;
	}
	return Math.round(time * fps) / fps;
}
