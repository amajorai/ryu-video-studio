import { z } from "zod";
import {
	type Asset,
	newSegment,
	type Project,
	segmentDuration,
	splitSegment,
	trackSettingFor,
	validateProject,
} from "./project.ts";

const timelineTime = z.number().finite().min(0).max(7200);
const track = z.number().int().min(0).max(15);

const clipEntrySchema = z
	.object({
		assetId: z.uuid(),
		sourceIn: timelineTime.default(0),
		sourceOut: timelineTime.optional(),
		speed: z.number().finite().min(0.25).max(4).default(1),
		volume: z.number().finite().min(0).max(4).default(1),
	})
	.strict();

export const addClipsRequestSchema = z
	.object({
		at: timelineTime,
		entries: z.array(clipEntrySchema).min(1).max(30),
		revision: z.number().int().nonnegative(),
		track,
	})
	.strict();
export type AddClipsRequest = z.infer<typeof addClipsRequestSchema>;

export const moveClipRequestSchema = z
	.object({
		clipId: z.uuid(),
		revision: z.number().int().nonnegative(),
		start: timelineTime,
		track,
	})
	.strict();
export type MoveClipRequest = z.infer<typeof moveClipRequestSchema>;

export const splitClipRequestSchema = z
	.object({
		clipId: z.uuid(),
		revision: z.number().int().nonnegative(),
		time: timelineTime,
	})
	.strict();
export type SplitClipRequest = z.infer<typeof splitClipRequestSchema>;

export const removeClipsRequestSchema = z
	.object({
		clipIds: z.array(z.uuid()).min(1).max(50),
		revision: z.number().int().nonnegative(),
	})
	.strict();
export type RemoveClipsRequest = z.infer<typeof removeClipsRequestSchema>;

const keyframeProperty = z.enum([
	"x",
	"y",
	"scale",
	"rotation",
	"opacity",
	"volume",
]);
const keyframeValueSchema = z
	.object({
		time: timelineTime,
		value: z.number().finite().min(-180).max(180),
	})
	.strict();

export const setKeyframesRequestSchema = z
	.object({
		clipId: z.uuid(),
		keyframes: z.array(keyframeValueSchema).max(200),
		property: keyframeProperty,
		revision: z.number().int().nonnegative(),
	})
	.strict();
export type SetKeyframesRequest = z.infer<typeof setKeyframesRequestSchema>;

function editable(project: Project, clipId: string) {
	const current = project.segments.find((segment) => segment.id === clipId);
	if (!current) {
		throw new Error("Clip not found on this timeline.");
	}
	if (trackSettingFor(project, current.track).locked) {
		throw new Error("Unlock the clip track before editing the timeline.");
	}
	return current;
}

function sourceRange(entry: AddClipsRequest["entries"][number], asset: Asset) {
	const sourceDuration =
		asset.kind === "image" ? Math.max(5, asset.duration) : asset.duration;
	const sourceOut = entry.sourceOut ?? sourceDuration;
	if (
		entry.sourceIn >= sourceOut ||
		sourceOut > sourceDuration + 0.05 ||
		sourceOut - entry.sourceIn < 0.04
	) {
		throw new Error("A clip range is outside its source duration.");
	}
	return {
		sourceIn: entry.sourceIn,
		sourceOut: Math.min(asset.duration, sourceOut),
	};
}

/** Place clips at a timeline point without rippling later content. */
export function addClips(
	project: Project,
	assets: readonly Asset[],
	input: unknown
): Project {
	const request = addClipsRequestSchema.parse(input);
	if (trackSettingFor(project, request.track).locked) {
		throw new Error("Unlock the target track before adding clips.");
	}
	let cursor = request.at;
	const added = request.entries.map((entry) => {
		const asset = assets.find((candidate) => candidate.id === entry.assetId);
		if (!asset) {
			throw new Error("An added clip references missing media.");
		}
		const range = sourceRange(entry, asset);
		const segment = {
			...newSegment(asset, cursor, request.track),
			...range,
			speed: entry.speed,
			volume: entry.volume,
		};
		cursor += segmentDuration(segment);
		return segment;
	});
	if (cursor > 7200) {
		throw new Error("The added clips exceed the two-hour project limit.");
	}
	return validateProject(
		{
			...project,
			segments: [...project.segments, ...added].sort(
				(a, b) => a.track - b.track || a.start - b.start
			),
		},
		[...assets]
	);
}

/** Move one clip to a frame-quantized timeline position and track. */
export function moveClip(
	project: Project,
	assets: readonly Asset[],
	input: unknown
): Project {
	const request = moveClipRequestSchema.parse(input);
	const current = editable(project, request.clipId);
	if (trackSettingFor(project, request.track).locked) {
		throw new Error("Unlock the destination track before moving the clip.");
	}
	const start = Number(
		Math.max(
			0,
			Math.min(7200 - segmentDuration(current), request.start)
		).toFixed(6)
	);
	const quantizedStart = Math.min(
		7200 - segmentDuration(current),
		Math.max(0, Math.round(start * project.fps) / project.fps)
	);
	const linked = current.linkGroupId
		? project.segments.filter(
				(segment) => segment.linkGroupId === current.linkGroupId
			)
		: [current];
	if (
		linked.some((segment) => trackSettingFor(project, segment.track).locked)
	) {
		throw new Error("Unlock every linked clip track before moving the group.");
	}
	const delta = quantizedStart - current.start;
	if (
		linked.some(
			(segment) =>
				segment.start + delta < 0 ||
				segment.start + delta + segmentDuration(segment) > 7200
		)
	) {
		throw new Error("Linked clips would move outside the project timeline.");
	}
	return validateProject(
		{
			...project,
			segments: project.segments.map((segment) =>
				linked.some((member) => member.id === segment.id)
					? {
							...segment,
							start: segment.start + delta,
							...(segment.id === current.id ? { track: request.track } : {}),
						}
					: segment
			),
		},
		[...assets]
	);
}

/** Split one editable clip at a timeline time. */
export function splitClip(
	project: Project,
	assets: readonly Asset[],
	input: unknown
): Project {
	const request = splitClipRequestSchema.parse(input);
	const current = editable(project, request.clipId);
	const parts = splitSegment(current, request.time);
	return validateProject(
		{
			...project,
			segments: project.segments.flatMap((segment) =>
				segment.id === current.id ? parts : [segment]
			),
		},
		[...assets]
	);
}

/** Remove selected clips and dissolve any now-empty multicam metadata. */
export function removeClips(
	project: Project,
	assets: readonly Asset[],
	input: unknown
): Project {
	const request = removeClipsRequestSchema.parse(input);
	if (new Set(request.clipIds).size !== request.clipIds.length) {
		throw new Error("Choose each clip once.");
	}
	for (const clipId of request.clipIds) {
		editable(project, clipId);
	}
	const removed = new Set(
		project.segments
			.filter(
				(segment) =>
					request.clipIds.includes(segment.id) ||
					(segment.linkGroupId !== undefined &&
						request.clipIds.some(
							(id) =>
								project.segments.find((candidate) => candidate.id === id)
									?.linkGroupId === segment.linkGroupId
						))
			)
			.map((segment) => segment.id)
	);
	for (const clipId of removed) {
		editable(project, clipId);
	}
	const segments = project.segments.filter(
		(segment) => !removed.has(segment.id)
	);
	const segmentIds = new Set(segments.map((segment) => segment.id));
	return validateProject(
		{
			...project,
			multicamGroups: project.multicamGroups
				.map((group) => ({
					...group,
					segmentIds: group.segmentIds.filter((id) => segmentIds.has(id)),
				}))
				.filter((group) => group.segmentIds.length > 0),
			segments,
		},
		[...assets]
	);
}

/** Replace one clip-relative keyframe track while retaining other properties. */
export function setKeyframes(
	project: Project,
	assets: readonly Asset[],
	input: unknown
): Project {
	const request = setKeyframesRequestSchema.parse(input);
	const current = editable(project, request.clipId);
	const times = new Set<number>();
	const keyframes = request.keyframes
		.map((keyframe) => ({
			...keyframe,
			id: crypto.randomUUID(),
			property: request.property,
		}))
		.sort((a, b) => a.time - b.time);
	for (const keyframe of keyframes) {
		if (times.has(keyframe.time)) {
			throw new Error("Choose each keyframe time once.");
		}
		times.add(keyframe.time);
	}
	return validateProject(
		{
			...project,
			segments: project.segments.map((segment) =>
				segment.id === current.id
					? {
							...segment,
							keyframes: [
								...segment.keyframes.filter(
									(frame) => frame.property !== request.property
								),
								...keyframes,
							],
						}
					: segment
			),
		},
		[...assets]
	);
}
