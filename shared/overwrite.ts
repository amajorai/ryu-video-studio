import { z } from "zod";
import { retimeKeyframes } from "./animation.ts";
import { type InsertClip, insertClipSchema } from "./insert.ts";
import { trackIndexSchema } from "./limits.ts";
import {
	type Asset,
	fitEdgeTransitions,
	newSegment,
	type Project,
	type Segment,
	segmentDuration,
	splitSegment,
	trackSettingFor,
	trimSegment,
	validateProject,
} from "./project.ts";
import {
	dropUncoveredRevealTransitions,
	placementKindOf,
	sortSegments,
} from "./track-placement.ts";

/** Projects are limited to two hours. */
const TIMELINE_LIMIT = 7200;
/** The shortest clip piece an overwrite leaves behind (as `splitSegment`). */
const MIN_PIECE = 0.04;
/** Overlaps at or below this are touching edges, not overwrites. */
const TOUCH_EPSILON = 1e-6;

const timelineTime = z.number().finite().min(0).max(TIMELINE_LIMIT);

export const overwriteRequestSchema = z
	.object({
		at: timelineTime,
		entries: z.array(insertClipSchema).min(1).max(30),
		revision: z.number().int().nonnegative(),
		track: trackIndexSchema,
	})
	.strict();
export type OverwriteRequest = z.infer<typeof overwriteRequestSchema>;
export type OverwriteInput = z.input<typeof overwriteRequestSchema>;

export interface OverwriteOptions {
	/** Timeline time the first entry starts at. */
	at: number;
	/** Track the entries are placed on. */
	track: number;
}

export interface OverwriteResult {
	/** Ids of the placed clips, in entry order. */
	newIds: string[];
	project: Project;
}

/** What an overwrite does to one clip it covers. */
export interface OverwriteImpact {
	/** `trim`: one end is cut; `split`: the middle is cut out; `remove`: covered. */
	action: "trim" | "split" | "remove";
	/** Covered part of the clip, in timeline seconds. */
	end: number;
	id: string;
	start: number;
	track: number;
}

const segmentEnd = (segment: Segment) =>
	segment.start + segmentDuration(segment);

const overlapOf = (segment: Segment, start: number, end: number) =>
	Math.min(segmentEnd(segment), end) - Math.max(segment.start, start);

function impactOn(
	segment: Segment,
	start: number,
	end: number
): OverwriteImpact | undefined {
	if (overlapOf(segment, start, end) <= TOUCH_EPSILON) {
		return undefined;
	}
	const keepsHead = start - segment.start >= MIN_PIECE;
	const keepsTail = segmentEnd(segment) - end >= MIN_PIECE;
	let action: OverwriteImpact["action"] = "remove";
	if (keepsHead && keepsTail) {
		action = "split";
	} else if (keepsHead || keepsTail) {
		action = "trim";
	}
	return {
		action,
		end: Math.min(segmentEnd(segment), end),
		id: segment.id,
		start: Math.max(segment.start, start),
		track: segment.track,
	};
}

/**
 * Clips an overwrite of `[start, end)` on `track` would cut, including linked
 * partners on other tracks. The drop preview shades these ranges.
 */
export function overwriteImpacts(
	project: Pick<Project, "segments">,
	track: number,
	start: number,
	end: number
): OverwriteImpact[] {
	const direct = project.segments.filter(
		(segment) =>
			segment.track === track && overlapOf(segment, start, end) > TOUCH_EPSILON
	);
	const groups = new Set(
		direct.flatMap((segment) =>
			segment.linkGroupId ? [segment.linkGroupId] : []
		)
	);
	const directIds = new Set(direct.map((segment) => segment.id));
	return project.segments.flatMap((segment) => {
		const involved =
			directIds.has(segment.id) ||
			(segment.linkGroupId !== undefined && groups.has(segment.linkGroupId));
		const impact = involved ? impactOn(segment, start, end) : undefined;
		return impact ? [impact] : [];
	});
}

/**
 * Clamp fades and edge transitions after a piece got shorter. The fades are
 * fitted together so `fadeIn + fadeOut` never exceeds the piece; the fade on
 * the cut side gives way first.
 */
function fitPiece(
	piece: Segment,
	cutEdge: "start" | "end",
	keepsHead: boolean,
	keepsTail: boolean
) {
	const duration = segmentDuration(piece);
	let fadeIn = Math.min(piece.fadeIn, duration);
	let fadeOut = Math.min(piece.fadeOut, duration);
	const excess = fadeIn + fadeOut - duration;
	if (excess > 0) {
		if (cutEdge === "start") {
			fadeIn = Math.max(0, fadeIn - excess);
		} else {
			fadeOut = Math.max(0, fadeOut - excess);
		}
	}
	return fitEdgeTransitions(
		{ ...piece, fadeIn, fadeOut },
		keepsHead,
		keepsTail
	);
}

/** The part of `segment` before `at` (keeps the clip id). */
function headBefore(segment: Segment, at: number): Segment {
	if (segmentEnd(segment) - at >= MIN_PIECE) {
		return splitSegment(segment, at)[0];
	}
	// A sliver under one split minimum: shorten the source out-point instead.
	const duration = at - segment.start;
	return fitPiece(
		{
			...segment,
			sourceOut: segment.sourceIn + duration * segment.speed,
			// Keep the curves of the surviving range: frames past the cut give
			// way to an interpolated boundary keyframe, as `splitSegment` does.
			keyframes: retimeKeyframes(segment, 0, duration),
		},
		"end",
		true,
		false
	);
}

/**
 * The part of `segment` after `at`. When the head survives too (`split`), the
 * tail is a new clip; otherwise the start edge is trimmed and the clip keeps
 * its id, so template slots and lip-sync links that name it stay valid.
 */
function tailAfter(segment: Segment, at: number, headSurvives: boolean) {
	const cut = at - segment.start;
	if (headSurvives) {
		return splitSegment(segment, at)[1];
	}
	// `trimSegment` ignores the asset duration when trimming the start edge.
	const trimmed = trimSegment(segment, Number.POSITIVE_INFINITY, "start", cut);
	if (cut < MIN_PIECE) {
		// A sliver: keep the clip's own fade-in and entry transition.
		return fitPiece(trimmed, "start", true, true);
	}
	// The new clip now butts against this edge, as after a split.
	return fitPiece({ ...trimmed, fadeIn: 0 }, "start", false, true);
}

/** Pieces of `segment` left after clearing `[start, end)`; [] when covered. */
function clearPieces(segment: Segment, start: number, end: number): Segment[] {
	const impact = impactOn(segment, start, end);
	if (!impact) {
		return [segment];
	}
	switch (impact.action) {
		case "remove":
			return [];
		case "split":
			return [headBefore(segment, start), tailAfter(segment, end, true)];
		default:
			return start - segment.start >= MIN_PIECE
				? [headBefore(segment, start)]
				: [tailAfter(segment, end, false)];
	}
}

/**
 * Clear link groups that no longer pair audio with visual media, and give the
 * pieces after a cleared range a fresh group so before and after pieces form
 * separate pairs.
 */
function regroup(
	segments: readonly Segment[],
	assets: readonly Asset[],
	touchedGroups: ReadonlySet<string>,
	end: number
): Segment[] {
	const minted = new Map<string, string>();
	const regrouped = segments.map((segment) => {
		const group = segment.linkGroupId;
		if (!(group && touchedGroups.has(group)) || segment.start < end - 1e-6) {
			return segment;
		}
		const next = minted.get(group) ?? crypto.randomUUID();
		minted.set(group, next);
		return { ...segment, linkGroupId: next };
	});
	const classes = new Map<string, Set<string>>();
	for (const segment of regrouped) {
		if (!segment.linkGroupId) {
			continue;
		}
		const asset = assets.find((candidate) => candidate.id === segment.assetId);
		const set = classes.get(segment.linkGroupId) ?? new Set<string>();
		if (asset) {
			set.add(placementKindOf(asset.kind));
		}
		classes.set(segment.linkGroupId, set);
	}
	return regrouped.map((segment) => {
		if (!segment.linkGroupId || classes.get(segment.linkGroupId)?.size === 2) {
			return segment;
		}
		const { linkGroupId: _dissolved, ...rest } = segment;
		return rest;
	});
}

/**
 * Drop template slots and lip-sync clip links whose clip the overwrite
 * removed (as ripple delete and paste do).
 */
function pruneClipReferences(
	project: Project,
	segments: readonly Segment[]
): Pick<Project, "avatars" | "template"> {
	const surviving = new Set(segments.map((segment) => segment.id));
	const avatars = project.avatars.map((avatar) => {
		const segmentId = avatar.lipSync?.segmentId;
		if (
			!avatar.lipSync ||
			segmentId === undefined ||
			surviving.has(segmentId)
		) {
			return avatar;
		}
		const { segmentId: _removed, ...lipSync } = avatar.lipSync;
		return { ...avatar, lipSync };
	});
	if (!project.template) {
		return { avatars };
	}
	return {
		avatars,
		template: {
			...project.template,
			slots: project.template.slots.filter((slot) =>
				surviving.has(slot.segmentId)
			),
		},
	};
}

/** Build the clips to place, back to back from `at` on `track`. */
function placedSegments(
	assets: readonly Asset[],
	entries: readonly InsertClip[],
	at: number,
	track: number
): Segment[] {
	let cursor = at;
	return entries.map((input) => {
		const entry = insertClipSchema.parse(input);
		const asset = assets.find((candidate) => candidate.id === entry.assetId);
		if (!asset) {
			throw new Error("An overwrite clip references missing media.");
		}
		const sourceDuration =
			asset.kind === "image" ? Math.max(5, asset.duration) : asset.duration;
		const sourceOut = entry.sourceOut ?? sourceDuration;
		if (
			entry.sourceIn >= sourceOut ||
			sourceOut > sourceDuration + 0.05 ||
			sourceOut - entry.sourceIn < MIN_PIECE
		) {
			throw new Error(
				"An overwrite clip range is outside its source duration."
			);
		}
		const segment: Segment = {
			...newSegment(asset, cursor, track),
			sourceIn: entry.sourceIn,
			sourceOut: Math.min(sourceDuration, sourceOut),
			speed: entry.speed,
			volume: entry.volume,
		};
		cursor += segmentDuration(segment);
		return segment;
	});
}

/**
 * Place clips back to back at `at` on `track`, overwriting what is there:
 * clips underneath are trimmed, split around the new clips, or removed, and
 * their linked partners on other tracks are cut over the same range so link
 * groups stay in sync. Nothing else on the timeline moves.
 */
export function overwriteClips(
	project: Project,
	assets: readonly Asset[],
	entries: readonly InsertClip[],
	options: OverwriteOptions
): OverwriteResult {
	const { at, track } = options;
	if (!(Number.isFinite(at) && at >= 0)) {
		throw new Error("Choose a timeline point to overwrite at.");
	}
	if (!entries.length) {
		throw new Error("Choose at least one clip to place.");
	}
	if (trackSettingFor(project, track).locked) {
		throw new Error("Unlock the target track before placing clips.");
	}
	const placed = placedSegments(assets, entries, at, track);
	const end = at + placed.reduce((sum, item) => sum + segmentDuration(item), 0);
	if (end > TIMELINE_LIMIT) {
		throw new Error("The placed clips exceed the two-hour project limit.");
	}
	const impacted = new Set(
		overwriteImpacts(project, track, at, end).map((impact) => impact.id)
	);
	const touchedGroups = new Set<string>();
	for (const segment of project.segments) {
		if (!impacted.has(segment.id)) {
			continue;
		}
		if (trackSettingFor(project, segment.track).locked) {
			throw new Error(
				"Unlock every linked clip track before overwriting this range."
			);
		}
		if (segment.multicamGroupId) {
			throw new Error("An overwrite cannot cut through a multicam clip.");
		}
		if (segment.linkGroupId) {
			touchedGroups.add(segment.linkGroupId);
		}
	}
	const cleared = project.segments.flatMap((segment) =>
		impacted.has(segment.id) ? clearPieces(segment, at, end) : [segment]
	);
	const segments = dropUncoveredRevealTransitions(
		sortSegments([...regroup(cleared, assets, touchedGroups, end), ...placed])
	);
	return {
		newIds: placed.map((segment) => segment.id),
		project: validateProject(
			{ ...project, ...pruneClipReferences(project, segments), segments },
			[...assets]
		),
	};
}

/** Agent form of `overwriteClips` (the caller checks `revision`). */
export function overwriteRequest(
	project: Project,
	assets: readonly Asset[],
	input: OverwriteInput
): Project {
	const request = overwriteRequestSchema.parse(input);
	return overwriteClips(project, assets, request.entries, {
		at: request.at,
		track: request.track,
	}).project;
}
