import { z } from "zod";
import {
	type Asset,
	dissolveOrphanedLinkGroups,
	fitEdgeTransitions,
	type Project,
	projectDuration,
	type Segment,
	segmentDuration,
	splitSegment,
	trackSettingFor,
	trimSegment,
	validateProject,
} from "./project.ts";
import { rippleDeleteRange } from "./ripple.ts";
import { affectedTracks } from "./sync-lock.ts";

/**
 * Cut operations: multi-clip split (razor, S, Cmd/Ctrl+K and the `split`
 * route) and trim-to-playhead (Q/W with ripple, Alt+Q/Alt+W leaving a gap).
 * Every function is pure and returns one validated project, so a whole
 * operation is a single revision and a single undo step.
 */

/** Shortest piece a cut or trim may leave, matching `splitSegment`. */
export const MIN_CUT_PIECE = 0.04;
const EPSILON = 1e-6;

const timelineTime = z.number().finite().min(0).max(7200);
const revision = z.number().int().nonnegative();

const segmentEnd = (segment: Segment) =>
	segment.start + segmentDuration(segment);

/** Whether `time` falls inside `segment` with room for a piece on each side. */
export function cutsInside(segment: Segment, time: number): boolean {
	return (
		time - segment.start >= MIN_CUT_PIECE - EPSILON &&
		segmentEnd(segment) - time >= MIN_CUT_PIECE - EPSILON
	);
}

/**
 * `POST /projects/:id/split`. Pass `times` (up to 64) and optionally
 * `clipIds` (up to 200); the legacy `{clipId, time}` body still parses.
 * Without clip ids every clip under each time on an unlocked track is cut.
 */
export const splitClipsRequestSchema = z
	.object({
		clipId: z.uuid().optional(),
		clipIds: z.array(z.uuid()).min(1).max(200).optional(),
		revision,
		time: timelineTime.optional(),
		times: z.array(timelineTime).min(1).max(64).optional(),
	})
	.strict()
	.refine((body) => (body.time === undefined) !== (body.times === undefined), {
		message: "Send either time or times.",
		path: ["times"],
	})
	.refine((body) => !(body.clipId && body.clipIds), {
		message: "Send either clipId or clipIds.",
		path: ["clipIds"],
	});
export type SplitClipsRequest = z.infer<typeof splitClipsRequestSchema>;

export interface SplitClipsInput {
	/** Clips to cut, plus their linked partners. Omit to cut every unlocked clip. */
	clipIds?: readonly string[];
	times: readonly number[];
}

/** Normalize a parsed `split` body (legacy or multi-time) to split input. */
export function splitInputFromRequest(
	request: SplitClipsRequest
): SplitClipsInput {
	const times =
		request.times ?? (request.time === undefined ? [] : [request.time]);
	const clipIds =
		request.clipIds ?? (request.clipId ? [request.clipId] : undefined);
	return clipIds ? { clipIds, times } : { times };
}

export interface SplitClipsResult {
	/** Ids of the new right-hand pieces, in timeline order. */
	newIds: string[];
	project: Project;
	/** Number of clips cut (each cut adds one clip). */
	splitCount: number;
}

interface CutTargetOptions {
	clipIds?: readonly string[];
	/** Verb for error messages ("splitting", "trimming"). */
	verb: string;
}

const groupMembers = (project: Project, linkGroupId: string) =>
	project.segments.filter((segment) => segment.linkGroupId === linkGroupId);

/**
 * The clips an operation at `time` acts on. Explicit ids must be editable
 * and bring their linked partners; an id or partner on a locked track
 * throws. Without ids, every clip under `time` on an unlocked track is a
 * target, and a link group with any member on a locked track is skipped so
 * a cut never separates linked audio from its picture.
 */
export function cutTargets(
	project: Project,
	time: number,
	options: CutTargetOptions
): Segment[] {
	const locked = (segment: Segment) =>
		trackSettingFor(project, segment.track).locked;
	const groupLocked = (segment: Segment) =>
		segment.linkGroupId !== undefined &&
		groupMembers(project, segment.linkGroupId).some(locked);
	const chosen = new Map<string, Segment>();
	if (options.clipIds) {
		for (const id of options.clipIds) {
			const segment = project.segments.find((candidate) => candidate.id === id);
			if (!segment) {
				throw new Error("Clip not found on this timeline.");
			}
			if (locked(segment) || groupLocked(segment)) {
				throw new Error(
					`Unlock every linked clip track before ${options.verb} the clip.`
				);
			}
			chosen.set(segment.id, segment);
			if (segment.linkGroupId) {
				for (const member of groupMembers(project, segment.linkGroupId)) {
					chosen.set(member.id, member);
				}
			}
		}
	} else {
		for (const segment of project.segments) {
			if (
				!(locked(segment) || groupLocked(segment)) &&
				cutsInside(segment, time)
			) {
				chosen.set(segment.id, segment);
				if (segment.linkGroupId) {
					for (const member of groupMembers(project, segment.linkGroupId)) {
						chosen.set(member.id, member);
					}
				}
			}
		}
	}
	return project.segments.filter((segment) => chosen.has(segment.id));
}

/** Add `rightId` to every multicam group that lists `leftId`. */
function withMulticamPiece(
	groups: Project["multicamGroups"],
	leftId: string,
	rightId: string
): Project["multicamGroups"] {
	return groups.map((group) =>
		group.segmentIds.includes(leftId) && group.segmentIds.length < 400
			? { ...group, segmentIds: [...group.segmentIds, rightId] }
			: group
	);
}

/**
 * Split at one time. Targets that contain the time are cut; each link group
 * touched keeps its id on the left of the cut, and its members right of the
 * cut (new right pieces and partners that start after it) get a fresh id.
 */
function splitAtTime(
	project: Project,
	time: number,
	clipIds: readonly string[] | undefined
): { newIds: string[]; project: Project } {
	const targets = cutTargets(project, time, {
		...(clipIds ? { clipIds } : {}),
		verb: "splitting",
	});
	const cut = targets.filter((segment) => cutsInside(segment, time));
	if (!cut.length) {
		return { newIds: [], project };
	}
	const cutIds = new Set(cut.map((segment) => segment.id));
	const groups = new Set(
		cut.flatMap((segment) => (segment.linkGroupId ? [segment.linkGroupId] : []))
	);
	const rightGroup = new Map(
		[...groups].map((group) => [group, crypto.randomUUID()] as const)
	);
	const regroup = (segment: Segment): Segment => {
		const fresh = segment.linkGroupId && rightGroup.get(segment.linkGroupId);
		return fresh ? { ...segment, linkGroupId: fresh } : segment;
	};
	const newIds: string[] = [];
	let multicamGroups = project.multicamGroups;
	const segments = project.segments.flatMap((segment) => {
		if (cutIds.has(segment.id)) {
			const [left, right] = splitSegment(segment, time);
			newIds.push(right.id);
			multicamGroups = withMulticamPiece(multicamGroups, left.id, right.id);
			return [left, regroup(right)];
		}
		// A linked partner that does not cross the cut stays on its side.
		if (
			segment.linkGroupId &&
			groups.has(segment.linkGroupId) &&
			segment.start >= time - EPSILON
		) {
			return [regroup(segment)];
		}
		return [segment];
	});
	return { newIds, project: { ...project, multicamGroups, segments } };
}

/**
 * Split clips at one or more times as a single edit. Times are cut from the
 * latest to the earliest so explicit `clipIds` always name the piece left of
 * the next (earlier) cut. Throws when nothing could be cut.
 */
export function splitClips(
	project: Project,
	assets: readonly Asset[],
	input: SplitClipsInput
): SplitClipsResult {
	const times = [...new Set(input.times)].sort((a, b) => b - a);
	if (!times.length) {
		throw new Error("Choose a time to split at.");
	}
	let next = project;
	const newIds: string[] = [];
	for (const time of times) {
		const result = splitAtTime(next, time, input.clipIds);
		next = result.project;
		newIds.push(...result.newIds);
	}
	if (!newIds.length) {
		throw new Error(
			input.clipIds
				? "Place the playhead inside the clip to split it."
				: "There is no unlocked clip under that time to split."
		);
	}
	const order = new Map(
		next.segments.map((segment, index) => [segment.id, index])
	);
	newIds.sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
	return {
		newIds,
		project: validateProject(
			{ ...next, segments: dissolveOrphanedLinkGroups(next.segments) },
			[...assets]
		),
		splitCount: newIds.length,
	};
}

export type TrimEdge = "start" | "end";

/** `POST /projects/:id/trim-to-playhead`. */
export const trimToPlayheadRequestSchema = z
	.object({
		clipIds: z.array(z.uuid()).min(1).max(200).optional(),
		edge: z.enum(["start", "end"]),
		revision,
		ripple: z.boolean(),
		time: timelineTime,
	})
	.strict();
export type TrimToPlayheadRequest = z.infer<typeof trimToPlayheadRequestSchema>;

export interface TrimToPlayheadInput {
	clipIds?: readonly string[];
	edge: TrimEdge;
	/** Close the trimmed span by rippling later content left. */
	ripple: boolean;
	time: number;
}

export interface TrimToPlayheadResult {
	/**
	 * Trimmed clips whose removed part stays (partly) open because another
	 * clip on a track the ripple moves sits inside it; always 0 for a gap trim.
	 */
	limited: number;
	/**
	 * Where the media that was at the playhead now sits: the playhead minus
	 * the closed span after a ripple start trim, otherwise the playhead.
	 */
	playhead: number;
	project: Project;
	/** Ids of the trimmed clips (ids are kept through the trim). */
	trimmedIds: string[];
}

function gapTrim(
	segment: Segment,
	assets: readonly Asset[],
	edge: TrimEdge,
	time: number
): Segment {
	const assetDuration = Math.max(
		segment.sourceOut,
		assets.find((asset) => asset.id === segment.assetId)?.duration ?? 0
	);
	const edgeTime = edge === "start" ? segment.start : segmentEnd(segment);
	const trimmed = trimSegment(segment, assetDuration, edge, time - edgeTime);
	const duration = segmentDuration(trimmed);
	const fades = trimmed.fadeIn + trimmed.fadeOut;
	const fit = fades > duration ? duration / fades : 1;
	return fitEdgeTransitions(
		{
			...trimmed,
			fadeIn: trimmed.fadeIn * fit,
			fadeOut: trimmed.fadeOut * fit,
		},
		true,
		true
	);
}

/**
 * The part of the removed span that a ripple can close without cutting a
 * clip on a track the ripple moves: from the playhead outwards up to the
 * nearest clip still inside the span.
 */
function clearRippleSpan(
	project: Project,
	edge: TrimEdge,
	span: { end: number; start: number },
	tracks: readonly number[]
): { end: number; start: number } {
	const affected = affectedTracks(project, tracks);
	let { end, start } = span;
	for (const segment of project.segments) {
		if (
			!affected.has(segment.track) ||
			segment.start >= span.end - EPSILON ||
			segmentEnd(segment) <= span.start + EPSILON
		) {
			continue;
		}
		if (edge === "end") {
			end = Math.min(end, segment.start);
		} else {
			start = Math.max(start, segmentEnd(segment));
		}
	}
	return { end: Math.max(end, span.start), start: Math.min(start, span.end) };
}

/**
 * Trim the start or end of every target under `time` to it; clips keep their
 * ids. Without ripple a gap is left. With ripple the removed span (every
 * target's trimmed part, which always touches the playhead) is closed once
 * with `rippleDeleteRange`, targeting the trimmed tracks: those tracks and
 * every sync-locked track move together with titles, captions, and markers,
 * so nothing drifts out of sync. A clip still inside the span on a track
 * that moves limits the ripple to the part of the span before it (after it
 * for a start trim) instead of being cut.
 */
export function trimToPlayhead(
	project: Project,
	assets: readonly Asset[],
	input: TrimToPlayheadInput
): TrimToPlayheadResult {
	const { edge, time } = input;
	const targets = cutTargets(project, time, {
		...(input.clipIds ? { clipIds: input.clipIds } : {}),
		verb: "trimming",
	}).filter((segment) => cutsInside(segment, time));
	if (!targets.length) {
		throw new Error(
			input.clipIds
				? "Place the playhead inside the clip to trim it."
				: "There is no unlocked clip under the playhead to trim."
		);
	}
	const trimmedIds = targets.map((segment) => segment.id);
	const trimmed = new Map(
		targets.map((segment) => [segment.id, gapTrim(segment, assets, edge, time)])
	);
	const gapped: Project = {
		...project,
		segments: project.segments.map(
			(segment) => trimmed.get(segment.id) ?? segment
		),
	};
	if (!input.ripple) {
		return {
			limited: 0,
			playhead: time,
			project: validateProject(gapped, [...assets]),
			trimmedIds,
		};
	}
	const removed = {
		end:
			edge === "end"
				? Math.min(
						Math.max(...targets.map(segmentEnd)),
						projectDuration(gapped)
					)
				: time,
		start:
			edge === "end"
				? time
				: Math.min(...targets.map((segment) => segment.start)),
	};
	const tracks = [...new Set(targets.map((segment) => segment.track))];
	const clear = clearRippleSpan(gapped, edge, removed, tracks);
	const closes = clear.end - clear.start >= MIN_CUT_PIECE - EPSILON;
	const closedStart = closes ? clear.start : time;
	const closedEnd = closes ? clear.end : time;
	const limited = targets.filter((segment) =>
		edge === "end"
			? Math.min(segmentEnd(segment), removed.end) > closedEnd + EPSILON
			: segment.start < closedStart - EPSILON
	).length;
	const next = closes
		? rippleDeleteRange(gapped, assets, clear.start, clear.end, { tracks })
		: gapped;
	return {
		limited,
		playhead: edge === "start" ? time - (closedEnd - closedStart) : time,
		project: validateProject(next, [...assets]),
		trimmedIds,
	};
}
