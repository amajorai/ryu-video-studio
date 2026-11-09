import { z } from "zod";
import { trackIndexSchema } from "./limits.ts";
import {
	type Asset,
	dissolveOrphanedLinkGroups,
	newSegment,
	type Project,
	segmentDuration,
	splitSegment,
	trackSettingFor,
	validateProject,
} from "./project.ts";
import { dropUncoveredRevealTransitions } from "./track-placement.ts";

export {
	type SetKeyframesInput,
	type SetKeyframesRequest,
	setKeyframes,
	setKeyframesRequestSchema,
} from "./keyframe-edits.ts";

const timelineTime = z.number().finite().min(0).max(7200);
const track = trackIndexSchema;

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
		/** Close the removed spans by rippling later content left. */
		ripple: z.boolean().optional(),
	})
	.strict();
export type RemoveClipsRequest = z.infer<typeof removeClipsRequestSchema>;

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

export type AddClipsInput = z.input<typeof addClipsRequestSchema>;

/** Place clips at a timeline point without rippling later content. */
export function addClips(
	project: Project,
	assets: readonly Asset[],
	input: AddClipsInput
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

export type MoveClipInput = z.input<typeof moveClipRequestSchema>;

/**
 * Move one clip to a frame-quantized timeline position and track. Pass
 * `exact` when the caller already snapped the start (for example a pointer
 * drag snapped to a marker between frames) so the snap target is kept.
 */
export function moveClip(
	project: Project,
	assets: readonly Asset[],
	input: MoveClipInput,
	options: { exact?: boolean } = {}
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
	const quantizedStart = options.exact
		? start
		: Math.min(
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
			segments: project.segments.map((segment) => {
				if (!linked.some((member) => member.id === segment.id)) {
					return segment;
				}
				const moved = { ...segment, start: segment.start + delta };
				if (segment.id === current.id) {
					moved.track = request.track;
				}
				return moved;
			}),
		},
		[...assets]
	);
}

export type SplitClipInput = z.input<typeof splitClipRequestSchema>;

/** Split one editable clip at a timeline time. */
export function splitClip(
	project: Project,
	assets: readonly Asset[],
	input: SplitClipInput
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

export type RemoveClipsInput = z.input<typeof removeClipsRequestSchema>;

/** Remove selected clips and dissolve any now-empty multicam metadata. */
export function removeClips(
	project: Project,
	assets: readonly Asset[],
	input: RemoveClipsInput
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
	return validateProject(withoutClips(project, removed), [...assets]);
}

/**
 * Drop clips and every reference to them: multicam membership (empty groups
 * dissolve), template slots, avatar lip-sync sources, link groups left
 * with one member, and reveal transitions whose predecessor was removed (they
 * would have nothing to play over). The result is not validated.
 */
export function withoutClips(
	project: Project,
	removed: ReadonlySet<string>
): Project {
	const segments = dropUncoveredRevealTransitions(
		dissolveOrphanedLinkGroups(
			project.segments.filter((segment) => !removed.has(segment.id))
		)
	);
	const next: Project = {
		...project,
		avatars: project.avatars.map((avatar) => {
			const segmentId = avatar.lipSync?.segmentId;
			if (!(avatar.lipSync && segmentId && removed.has(segmentId))) {
				return avatar;
			}
			const { segmentId: _removed, ...lipSync } = avatar.lipSync;
			return { ...avatar, lipSync };
		}),
		multicamGroups: project.multicamGroups
			.map((group) => ({
				...group,
				segmentIds: group.segmentIds.filter((id) => !removed.has(id)),
			}))
			.filter((group) => group.segmentIds.length > 0),
		segments,
	};
	if (project.template) {
		next.template = {
			...project.template,
			slots: project.template.slots.filter(
				(slot) => !removed.has(slot.segmentId)
			),
		};
	}
	return next;
}
