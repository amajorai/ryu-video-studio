import {
	activeCaptions,
	type Marker,
	type Project,
	segmentDuration,
} from "./project.ts";

/**
 * Timeline snapping. `collectSnapTargets` lists every time a dragged edge,
 * the razor, or a scrub can stick to; `snap` picks the target within a
 * pixel threshold (scaled by zoom) and otherwise quantizes to the frame
 * grid. Both are pure and deterministic: the same project and options give
 * the same targets in the same order.
 */

export type SnapTargetKind =
	| "playhead"
	| "range-in"
	| "range-out"
	| "marker"
	| "marker-end"
	| "clip-start"
	| "clip-end"
	| "keyframe"
	| "overlay-start"
	| "overlay-end";

export interface SnapTarget {
	/** Clip, marker, overlay, or keyframe id the target came from. */
	id?: string;
	kind: SnapTargetKind;
	/** Lower wins when several targets are within the threshold. */
	priority: number;
	time: number;
	/** Track of a clip target. */
	track?: number;
}

/** Priority tiers: the playhead wins, then edit points, then fine detail. */
export const SNAP_PRIORITY: Readonly<Record<SnapTargetKind, number>> = {
	playhead: 0,
	"range-in": 1,
	"range-out": 1,
	marker: 1,
	"marker-end": 1,
	"clip-start": 1,
	"clip-end": 1,
	keyframe: 2,
	"overlay-start": 2,
	"overlay-end": 2,
};

/** Default pointer distance, in pixels, within which a target captures. */
export const DEFAULT_SNAP_THRESHOLD_PX = 8;

export interface CollectSnapTargetsOptions {
	/**
	 * Ids of the items being dragged: clips, overlays, markers, or keyframes.
	 * None of them is ever a target, and neither are clips linked to an
	 * excluded clip unless `excludeLinked` is false.
	 */
	exclude?: ReadonlySet<string>;
	/** Also exclude clips sharing a link group with an excluded clip (default true). */
	excludeLinked?: boolean;
	/** Include keyframes of `keyframeOwnerId` (the selected clip or overlay). */
	includeKeyframes?: boolean;
	/** Include title, graphic, caption, avatar, and adjustment-layer bounds (default true). */
	includeOverlays?: boolean;
	keyframeOwnerId?: string | null;
	/** The I/O range; skipped when absent or empty. */
	range?: { end: number; start: number } | null;
	/** The playhead; skipped when absent. */
	time?: number | null;
}

interface TimedItem {
	end: number;
	id: string;
	start: number;
}

function excludedIds(
	project: Project,
	exclude: ReadonlySet<string>,
	excludeLinked: boolean
): ReadonlySet<string> {
	if (!(excludeLinked && exclude.size)) {
		return exclude;
	}
	const groups = new Set<string>();
	for (const segment of project.segments) {
		if (segment.linkGroupId && exclude.has(segment.id)) {
			groups.add(segment.linkGroupId);
		}
	}
	if (!groups.size) {
		return exclude;
	}
	const expanded = new Set(exclude);
	for (const segment of project.segments) {
		if (segment.linkGroupId && groups.has(segment.linkGroupId)) {
			expanded.add(segment.id);
		}
	}
	return expanded;
}

function overlayItems(project: Project): TimedItem[] {
	return [
		...project.titles,
		...project.graphics,
		...project.avatars,
		...(project.adjustmentLayers ?? []),
		...activeCaptions(project),
	];
}

function keyframeTargets(
	project: Project,
	ownerId: string,
	exclude: ReadonlySet<string>
): SnapTarget[] {
	const segment = project.segments.find(
		(candidate) => candidate.id === ownerId
	);
	const overlay = segment
		? undefined
		: [
				...project.titles,
				...project.graphics,
				...(project.adjustmentLayers ?? []),
			].find((candidate) => candidate.id === ownerId);
	const owner = segment ?? overlay;
	if (!owner?.keyframes?.length) {
		return [];
	}
	const end = segment
		? segment.start + segmentDuration(segment)
		: (overlay?.end ?? owner.start);
	const seen = new Set<number>();
	const targets: SnapTarget[] = [];
	for (const keyframe of owner.keyframes) {
		if (exclude.has(keyframe.id)) {
			continue;
		}
		const time = owner.start + keyframe.time;
		if (time > end + 1e-9 || seen.has(time)) {
			continue;
		}
		seen.add(time);
		targets.push({
			id: keyframe.id,
			kind: "keyframe",
			priority: SNAP_PRIORITY.keyframe,
			time,
		});
	}
	return targets;
}

function markerTargets(
	markers: readonly Marker[],
	exclude: ReadonlySet<string>
): SnapTarget[] {
	return markers.flatMap((marker) => {
		if (exclude.has(marker.id)) {
			return [];
		}
		const start: SnapTarget = {
			id: marker.id,
			kind: "marker",
			priority: SNAP_PRIORITY.marker,
			time: marker.time,
		};
		return marker.duration && marker.duration > 0
			? [
					start,
					{
						id: marker.id,
						kind: "marker-end" as const,
						priority: SNAP_PRIORITY["marker-end"],
						time: marker.time + marker.duration,
					},
				]
			: [start];
	});
}

/**
 * Every snap target on the timeline, in a stable order: playhead, I/O,
 * markers, clip edges (project order), selected-clip keyframes, overlays.
 */
export function collectSnapTargets(
	project: Project,
	options: CollectSnapTargetsOptions = {}
): SnapTarget[] {
	const targets: SnapTarget[] = [];
	const exclude = excludedIds(
		project,
		options.exclude ?? new Set(),
		options.excludeLinked ?? true
	);
	if (options.time !== undefined && options.time !== null) {
		targets.push({
			kind: "playhead",
			priority: SNAP_PRIORITY.playhead,
			time: Math.max(0, options.time),
		});
	}
	const range = options.range;
	if (range && range.end > range.start) {
		targets.push(
			{
				kind: "range-in",
				priority: SNAP_PRIORITY["range-in"],
				time: range.start,
			},
			{
				kind: "range-out",
				priority: SNAP_PRIORITY["range-out"],
				time: range.end,
			}
		);
	}
	targets.push(...markerTargets(project.markers, exclude));
	for (const segment of project.segments) {
		if (exclude.has(segment.id)) {
			continue;
		}
		targets.push(
			{
				id: segment.id,
				kind: "clip-start",
				priority: SNAP_PRIORITY["clip-start"],
				time: segment.start,
				track: segment.track,
			},
			{
				id: segment.id,
				kind: "clip-end",
				priority: SNAP_PRIORITY["clip-end"],
				time: segment.start + segmentDuration(segment),
				track: segment.track,
			}
		);
	}
	if (
		options.includeKeyframes &&
		options.keyframeOwnerId &&
		!exclude.has(options.keyframeOwnerId)
	) {
		targets.push(...keyframeTargets(project, options.keyframeOwnerId, exclude));
	}
	if (options.includeOverlays ?? true) {
		for (const item of overlayItems(project)) {
			if (exclude.has(item.id)) {
				continue;
			}
			targets.push(
				{
					id: item.id,
					kind: "overlay-start",
					priority: SNAP_PRIORITY["overlay-start"],
					time: item.start,
				},
				{
					id: item.id,
					kind: "overlay-end",
					priority: SNAP_PRIORITY["overlay-end"],
					time: item.end,
				}
			);
		}
	}
	return targets;
}

/** Round to the nearest frame of `fps`, never before zero. */
export function quantizeToFrame(value: number, fps: number): number {
	if (!(Number.isFinite(fps) && fps > 0)) {
		return Math.max(0, value);
	}
	return Math.max(0, Math.round(value * fps) / fps);
}

export interface SnapOptions {
	fps: number;
	/** Timeline zoom; the threshold in seconds is `thresholdPx / pxPerSec`. */
	pxPerSec: number;
	thresholdPx?: number;
}

export interface SnapResult {
	/** The captured target; absent when the value fell back to the frame grid. */
	target?: SnapTarget;
	time: number;
}

/**
 * Snap `value` (seconds) to the best target within the threshold: the
 * lowest priority wins, then the nearest, then the earliest in `targets`.
 * Targets keep their exact time (a marker between frames stays exact);
 * otherwise the value is quantized to the frame grid.
 */
export function snap(
	value: number,
	targets: readonly SnapTarget[],
	options: SnapOptions
): SnapResult {
	const thresholdPx = options.thresholdPx ?? DEFAULT_SNAP_THRESHOLD_PX;
	const threshold = options.pxPerSec > 0 ? thresholdPx / options.pxPerSec : 0;
	let best: SnapTarget | undefined;
	let bestDistance = Number.POSITIVE_INFINITY;
	for (const target of targets) {
		const distance = Math.abs(target.time - value);
		if (distance > threshold + 1e-9) {
			continue;
		}
		if (
			!best ||
			target.priority < best.priority ||
			(target.priority === best.priority && distance < bestDistance)
		) {
			best = target;
			bestDistance = distance;
		}
	}
	return best
		? { target: best, time: Math.max(0, best.time) }
		: { time: quantizeToFrame(value, options.fps) };
}

/**
 * Legacy marker snap: quantize to a frame, then stick to the nearest marker
 * within `threshold` seconds of that frame.
 */
export function snapTimelineTime(
	value: number,
	fps: number,
	markers: readonly Marker[],
	threshold = 0.12
): number {
	const frame = quantizeToFrame(value, fps);
	const targets = markers.map<SnapTarget>((marker) => ({
		id: marker.id,
		kind: "marker",
		priority: SNAP_PRIORITY.marker,
		time: marker.time,
	}));
	const snapped = snap(frame, targets, {
		fps,
		pxPerSec: 1,
		thresholdPx: threshold,
	});
	return snapped.target ? snapped.time : frame;
}
