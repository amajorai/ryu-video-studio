import {
	boundaryKeyframe,
	inKeyframeGroup,
	keyframeGroups,
} from "./animation.ts";
import { unpinRemovedLipSyncClips } from "./lipsync-links.ts";
import {
	type Asset,
	type Caption,
	dissolveOrphanedLinkGroups,
	fitEdgeTransitions,
	type Keyframe,
	type Project,
	projectDuration,
	type Segment,
	segmentDuration,
	validateProject,
} from "./project.ts";
import { affectedTracks, rippleMarkersOf } from "./sync-lock.ts";

export interface RippleOptions {
	/**
	 * Tracks the edit targets. They ripple even when not sync-locked; every
	 * sync-locked track ripples too. Omitted means only sync-locked tracks,
	 * which is every track unless one is explicitly unlocked.
	 */
	tracks?: readonly number[];
}

/**
 * Remove a timeline interval and shift every later timed layer left. Clips on
 * tracks outside `affectedTracks` keep their place; markers stay put when the
 * project sets `rippleMarkers: false`.
 */
export function rippleDeleteRange(
	project: Project,
	assets: readonly Asset[],
	rangeStart: number,
	rangeEnd: number,
	options: RippleOptions = {}
): Project {
	const duration = projectDuration(project);
	if (
		!(Number.isFinite(rangeStart) && Number.isFinite(rangeEnd)) ||
		rangeStart < 0 ||
		rangeEnd > duration ||
		rangeEnd <= rangeStart ||
		rangeEnd - rangeStart < 0.04
	) {
		throw new Error("Choose a timeline range of at least 0.04 seconds.");
	}
	const deletedDuration = rangeEnd - rangeStart;
	const mapTime = (value: number) =>
		value <= rangeStart
			? value
			: value >= rangeEnd
				? value - deletedDuration
				: rangeStart;
	const mapInterval = (start: number, end: number) => {
		const nextStart = mapTime(start);
		const nextEnd = mapTime(end);
		return nextEnd - nextStart >= 0.04
			? { end: nextEnd, start: nextStart }
			: null;
	};
	const sliceSegment = (
		segment: Segment,
		localStart: number,
		localEnd: number,
		timelineStart: number,
		preserveId: boolean
	): Segment => {
		const segmentDurationValue = segmentDuration(segment);
		const slicedDuration = localEnd - localStart;
		const keyframes: Keyframe[] = [];
		for (const group of keyframeGroups(segment.keyframes)) {
			const frames = segment.keyframes.filter(inKeyframeGroup(group));
			if (localStart > 0) {
				keyframes.push(boundaryKeyframe(segment, group, 0, localStart));
			}
			for (const frame of frames) {
				if (
					frame.time < localStart ||
					frame.time > localEnd ||
					(localStart > 0 && frame.time === localStart)
				) {
					continue;
				}
				keyframes.push({
					...frame,
					id: crypto.randomUUID(),
					time: frame.time - localStart,
				});
			}
		}
		const piece: Segment = {
			...segment,
			id: preserveId ? segment.id : crypto.randomUUID(),
			start: timelineStart,
			sourceIn: segment.sourceIn + localStart * segment.speed,
			sourceOut: segment.sourceIn + localEnd * segment.speed,
			fadeIn: localStart === 0 ? Math.min(segment.fadeIn, slicedDuration) : 0,
			fadeOut:
				localEnd >= segmentDurationValue
					? Math.min(segment.fadeOut, slicedDuration)
					: 0,
			entryOffset: Math.min(7200, segment.entryOffset + localStart),
			keyframes: keyframes.slice(0, 200),
		};
		return fitEdgeTransitions(
			piece,
			localStart === 0,
			localEnd >= segmentDurationValue
		);
	};
	const affected = affectedTracks(project, options.tracks);
	const segments: Segment[] = [];
	for (const segment of project.segments) {
		if (!affected.has(segment.track)) {
			segments.push(segment);
			continue;
		}
		const segmentLength = segmentDuration(segment);
		const segmentEnd = segment.start + segmentLength;
		if (segmentEnd <= rangeStart) {
			segments.push(segment);
			continue;
		}
		if (segment.start >= rangeEnd) {
			segments.push({ ...segment, start: segment.start - deletedDuration });
			continue;
		}
		const localStart = Math.max(0, rangeStart - segment.start);
		const localEnd = Math.min(segmentLength, rangeEnd - segment.start);
		if (localStart >= 0.04) {
			segments.push(sliceSegment(segment, 0, localStart, segment.start, true));
		}
		if (segmentLength - localEnd >= 0.04) {
			segments.push(
				sliceSegment(
					segment,
					localEnd,
					segmentLength,
					mapTime(segment.start + localEnd),
					false
				)
			);
		}
	}
	const remapFrames = <T extends { id: string; time: number }>(
		frames: readonly T[] | undefined,
		objectStart: number,
		nextStart: number,
		max: number,
		key: (frame: T, time: number) => string
	): T[] | undefined => {
		if (!frames) {
			return undefined;
		}
		const seen = new Set<string>();
		return frames
			.flatMap((frame) => {
				const time = Number(
					(mapTime(objectStart + frame.time) - nextStart).toFixed(3)
				);
				if (time < 0 || seen.has(key(frame, time))) {
					return [];
				}
				seen.add(key(frame, time));
				return [{ ...frame, id: crypto.randomUUID(), time }];
			})
			.slice(0, max);
	};
	const timed = <T extends { end: number; start: number }>(
		items: readonly T[],
		map: (item: T, interval: { end: number; start: number }) => T
	): T[] =>
		items.flatMap((item) => {
			const interval = mapInterval(item.start, item.end);
			return interval ? [map(item, interval)] : [];
		});
	const overlayKeyframes = (
		frames: readonly Keyframe[] | undefined,
		objectStart: number,
		interval: { end: number; start: number }
	) =>
		remapFrames(
			frames,
			objectStart,
			interval.start,
			200,
			(frame, time) => `${frame.property}:${frame.target ?? ""}:${time}`
		)?.filter((frame) => frame.time <= interval.end - interval.start);
	const titles = timed(project.titles, (title, interval) => {
		const length = interval.end - interval.start;
		const mapped = {
			...title,
			...interval,
			fadeIn: Math.min(title.fadeIn, length),
			fadeOut: Math.min(title.fadeOut, length),
		};
		if (title.keyframes) {
			mapped.keyframes = overlayKeyframes(
				title.keyframes,
				title.start,
				interval
			);
		}
		return mapped;
	});
	const graphics = timed(project.graphics, (graphic, interval) => {
		const mapped = {
			...graphic,
			...interval,
			entryDuration: Math.min(
				graphic.entryDuration,
				interval.end - interval.start
			),
		};
		if (graphic.keyframes) {
			mapped.keyframes = overlayKeyframes(
				graphic.keyframes,
				graphic.start,
				interval
			);
		}
		return mapped;
	});
	const avatars = timed(project.avatars, (avatar, interval) => ({
		...avatar,
		...interval,
		entryDuration: Math.min(
			avatar.entryDuration,
			interval.end - interval.start
		),
		rigKeyframes: remapFrames(
			avatar.rigKeyframes,
			avatar.start,
			interval.start,
			100,
			(frame, time) => `${frame.property}:${time}`
		),
	}));
	const spatialObjects = timed(project.spatialObjects, (object, interval) => ({
		...object,
		...interval,
		entryDuration: Math.min(
			object.entryDuration,
			interval.end - interval.start
		),
	}));
	const meshes = timed(project.meshes, (mesh, interval) => ({
		...mesh,
		...interval,
		keyframes: remapFrames(
			mesh.keyframes,
			mesh.start,
			interval.start,
			120,
			(frame, time) => `${frame.property}:${time}`
		),
		deformationFrames: mesh.deformationFrames
			?.reduce<typeof mesh.deformationFrames>((frames, frame) => {
				const time = Number(
					(mapTime(mesh.start + frame.time) - interval.start).toFixed(3)
				);
				if (time < 0 || frames.some((existing) => existing.time === time)) {
					return frames;
				}
				frames.push({ ...frame, time });
				return frames;
			}, [])
			.slice(0, 30),
		rig: mesh.rig
			? {
					...mesh.rig,
					keyframes: remapFrames(
						mesh.rig.keyframes,
						mesh.start,
						interval.start,
						384,
						(frame, time) => `${frame.joint}:${frame.property}:${time}`
					),
				}
			: undefined,
	}));
	const mapCaptions = (captions: readonly Caption[]) =>
		captions.flatMap((caption) => {
			const interval = mapInterval(caption.start, caption.end);
			if (!interval) {
				return [];
			}
			const wordsTouched = caption.words?.some(
				(word) => word.start < rangeEnd && word.end > rangeStart
			);
			return [
				{
					...caption,
					...interval,
					words: wordsTouched
						? undefined
						: caption.words?.map((word) => ({
								...word,
								start: mapTime(word.start),
								end: mapTime(word.end),
							})),
				},
			];
		});
	const captions = mapCaptions(project.captions);
	const captionTracks = project.captionTracks.map((track) => ({
		...track,
		captions: mapCaptions(track.captions),
	}));
	const rippledMarkers = () => {
		const shifted: Project["markers"] = [];
		const markerTimes = new Set<number>();
		for (const marker of project.markers) {
			const markerDuration = marker.duration ?? 0;
			const markerEnd = marker.time + markerDuration;
			if (markerDuration > 0) {
				const interval = mapInterval(marker.time, markerEnd);
				if (!interval) {
					continue;
				}
				const time = Number(interval.start.toFixed(3));
				if (markerTimes.has(time)) {
					continue;
				}
				markerTimes.add(time);
				shifted.push({
					...marker,
					duration: Number((interval.end - interval.start).toFixed(3)),
					time,
				});
				continue;
			}
			if (marker.time > rangeStart && marker.time < rangeEnd) {
				continue;
			}
			const time = Number(mapTime(marker.time).toFixed(3));
			if (markerTimes.has(time)) {
				continue;
			}
			markerTimes.add(time);
			shifted.push({ ...marker, time });
		}
		return shifted;
	};
	const markers = rippleMarkersOf(project) ? rippledMarkers() : project.markers;
	const rippled: Project = {
		...project,
		segments: dissolveOrphanedLinkGroups(segments),
		titles,
		graphics,
		avatars,
		spatialObjects,
		meshes,
		captions,
		captionTracks,
		markers,
	};
	if (project.template) {
		const surviving = new Set(segments.map((segment) => segment.id));
		rippled.template = {
			...project.template,
			slots: project.template.slots.filter((slot) =>
				surviving.has(slot.segmentId)
			),
		};
	}
	if (project.adjustmentLayers) {
		rippled.adjustmentLayers = timed(
			project.adjustmentLayers,
			(layer, interval) => {
				const mapped = { ...layer, ...interval };
				if (layer.keyframes) {
					mapped.keyframes = overlayKeyframes(
						layer.keyframes,
						layer.start,
						interval
					);
				}
				return mapped;
			}
		);
	}
	return validateProject(unpinRemovedLipSyncClips(rippled), [...assets]);
}
