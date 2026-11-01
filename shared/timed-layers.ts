/**
 * Shift the timed layers (titles, graphics, avatars, spatial objects, meshes,
 * adjustment layers, captions and markers) that start at or after a pivot, for
 * edits that change a clip's length and ripple later content: ripple trims and
 * timeline-ripple speed ramps. Layer keyframes are relative to the layer, so
 * only `start` and `end` move.
 */
import type { Caption, Project } from "./project.ts";
import { rippleMarkersOf } from "./sync-lock.ts";

const EPSILON = 1e-6;
const round6 = (value: number) => Number(value.toFixed(6));

export interface ShiftTimedLayersOptions {
	/**
	 * Drop point markers inside the span a shortening edit removed
	 * (`pivot + shift` to `pivot`), as a ripple trim does. A speed ramp keeps
	 * them, since that span still holds the ramped clip.
	 */
	dropTrimmedMarkers?: boolean;
}

/**
 * The layer fields after moving everything that starts at or after `pivot`
 * by `shift` seconds. Markers stay put when the project sets
 * `rippleMarkers: false`.
 */
export function shiftTimedLayers(
	project: Project,
	pivot: number,
	shift: number,
	options: ShiftTimedLayersOptions = {}
): Partial<Project> {
	const after = (time: number) => time >= pivot - EPSILON;
	const move = (time: number) => round6(time + shift);
	const timed = <T extends { end: number; start: number }>(
		items: readonly T[]
	) =>
		items.map((item) =>
			after(item.start)
				? { ...item, end: move(item.end), start: move(item.start) }
				: item
		);
	const captions = (items: readonly Caption[]) =>
		items.map((caption) =>
			after(caption.start)
				? {
						...caption,
						end: move(caption.end),
						start: move(caption.start),
						words: caption.words?.map((word) => ({
							...word,
							end: move(word.end),
							start: move(word.start),
						})),
					}
				: caption
		);
	const trimmedFrom = pivot + Math.min(0, shift);
	const shiftedMarkers = () => {
		const markers: Project["markers"] = [];
		const markerTimes = new Set<number>();
		for (const marker of project.markers) {
			const inTrimmedRange =
				options.dropTrimmedMarkers === true &&
				!marker.duration &&
				marker.time > trimmedFrom + EPSILON &&
				marker.time < pivot - EPSILON;
			if (inTrimmedRange) {
				continue;
			}
			const time = after(marker.time)
				? Number((marker.time + shift).toFixed(3))
				: marker.time;
			if (markerTimes.has(time)) {
				continue;
			}
			markerTimes.add(time);
			markers.push({ ...marker, time });
		}
		return markers;
	};
	const shifted: Partial<Project> = {
		avatars: timed(project.avatars),
		captions: captions(project.captions),
		captionTracks: project.captionTracks.map((track) => ({
			...track,
			captions: captions(track.captions),
		})),
		graphics: timed(project.graphics),
		markers: rippleMarkersOf(project) ? shiftedMarkers() : project.markers,
		meshes: timed(project.meshes),
		spatialObjects: timed(project.spatialObjects),
		titles: timed(project.titles),
	};
	if (project.adjustmentLayers) {
		shifted.adjustmentLayers = timed(project.adjustmentLayers);
	}
	return shifted;
}

/**
 * The latest end among timed layers (and rippling markers) that start at or
 * after `pivot`, so a ripple can keep them inside the project limit.
 */
export function latestTimedEnd(project: Project, pivot: number): number {
	const ends = [
		...project.titles,
		...project.graphics,
		...project.avatars,
		...project.spatialObjects,
		...project.meshes,
		...(project.adjustmentLayers ?? []),
		...project.captions,
		...project.captionTracks.flatMap((track) => track.captions),
	]
		.filter((item) => item.start >= pivot - EPSILON)
		.map((item) => item.end);
	for (const marker of rippleMarkersOf(project) ? project.markers : []) {
		if (marker.time >= pivot - EPSILON) {
			ends.push(marker.time + (marker.duration ?? 0));
		}
	}
	return Math.max(pivot, ...ends);
}
