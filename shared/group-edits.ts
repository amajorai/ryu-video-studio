import { z } from "zod";
import { type ClipboardPayload, copyClips, pasteClips } from "./clipboard.ts";
import { MAX_TRACK_INDEX } from "./limits.ts";
import {
	type Asset,
	fitEdgeTransitions,
	type Project,
	retimeKeyframes,
	type Segment,
	segmentDuration,
	trackSettingFor,
	trimSegment,
	validateProject,
} from "./project.ts";
import { withLinkedPartners } from "./selection.ts";
import { dropUncoveredRevealTransitions } from "./track-placement.ts";

/**
 * Group edits behind the timeline pointer drag: move several clips at once
 * (keeping A/V link groups together), trim one edge of several clips by a
 * shared amount (clamped by neighbours and source media), duplicate a
 * selection to a dragged position, and set a clip's fade lengths from its
 * fade knee handles. Every function is pure and returns a validated project.
 */

const PROJECT_LIMIT = 7200;
const MINIMUM_CLIP_SECONDS = 0.04;
const EPSILON = 1e-6;

const revision = z.number().int().nonnegative();
const delta = z.number().finite().min(-PROJECT_LIMIT).max(PROJECT_LIMIT);
const clipIds = z.array(z.uuid()).min(1).max(200);

export const groupMoveRequestSchema = z
	.object({
		clipIds,
		delta,
		/** Snapped deltas keep their exact value instead of a frame-rounded one. */
		exact: z.boolean().default(false),
		revision,
		trackDelta: z
			.number()
			.int()
			.min(-MAX_TRACK_INDEX)
			.max(MAX_TRACK_INDEX)
			.default(0),
	})
	.strict();
export type GroupMoveInput = z.input<typeof groupMoveRequestSchema>;

export const groupTrimRequestSchema = z
	.object({
		clipIds,
		delta,
		edge: z.enum(["start", "end"]),
		exact: z.boolean().default(false),
		/** Trim linked A/V partners too (false while Alt is held: a J/L cut). */
		linked: z.boolean().default(true),
		revision,
	})
	.strict();
export type GroupTrimInput = z.input<typeof groupTrimRequestSchema>;

export const groupDuplicateRequestSchema = z
	.object({
		clipIds,
		delta,
		revision,
		trackDelta: z
			.number()
			.int()
			.min(-MAX_TRACK_INDEX)
			.max(MAX_TRACK_INDEX)
			.default(0),
	})
	.strict();
export type GroupDuplicateInput = z.input<typeof groupDuplicateRequestSchema>;

export const clipFadeRequestSchema = z
	.object({
		clipId: z.uuid(),
		fade: z.enum(["in", "out"]),
		revision,
		seconds: z.number().finite().min(0).max(PROJECT_LIMIT),
	})
	.strict();
export type ClipFadeInput = z.input<typeof clipFadeRequestSchema>;

export interface GroupEditResult {
	/** The timeline delta actually applied after clamping (0 when nothing moved). */
	applied: number;
	project: Project;
	/** Track delta actually applied (moves and duplicates only). */
	trackApplied: number;
}

export interface GroupDuplicateResult {
	/** Ids of the new clips, in payload order. */
	newIds: string[];
	project: Project;
}

const round6 = (value: number) => Number(value.toFixed(6));
const quantize = (value: number, fps: number) => Math.round(value * fps) / fps;
const segmentEnd = (segment: Segment) =>
	segment.start + segmentDuration(segment);
/** Shortest clip a trim may leave: 0.04 s, rounded up to whole frames. */
const minimumKept = (fps: number) =>
	Math.ceil((MINIMUM_CLIP_SECONDS + EPSILON) * fps) / fps;

function clipsById(project: Project, ids: readonly string[]): Segment[] {
	const wanted = new Set(ids);
	const found = project.segments.filter((segment) => wanted.has(segment.id));
	if (found.length !== wanted.size) {
		throw new Error("Clip not found on this timeline.");
	}
	return found;
}

function assetFor(assets: readonly Asset[], segment: Segment): Asset {
	const asset = assets.find((candidate) => candidate.id === segment.assetId);
	if (!asset) {
		throw new Error("A timeline segment references missing media.");
	}
	return asset;
}

function ensureUnlocked(
	project: Project,
	tracks: Iterable<number>,
	message: string
) {
	for (const track of tracks) {
		if (trackSettingFor(project, track).locked) {
			throw new Error(message);
		}
	}
}

/** Clamp `requested` into `[low, high]`, never past zero in the wrong direction. */
function clampInto(requested: number, low: number, high: number): number {
	if (low > high + EPSILON) {
		return 0;
	}
	return Math.max(Math.min(low, 0), Math.min(Math.max(high, 0), requested));
}

function finish(
	project: Project,
	assets: readonly Asset[],
	segments: Segment[]
) {
	return validateProject(
		{
			...project,
			segments: dropUncoveredRevealTransitions(segments).sort(
				(a, b) => a.track - b.track || a.start - b.start
			),
		},
		[...assets]
	);
}

/**
 * Move clips by `delta` seconds and `trackDelta` tracks. Linked A/V partners
 * of every moved clip move in time with it but keep their own track, as a
 * single-clip move does. The time delta is clamped so the group stays inside
 * the timeline, and the track delta so every re-tracked clip stays within
 * the track limit. Throws when any affected source or destination track is
 * locked.
 */
export function groupMove(
	project: Project,
	assets: readonly Asset[],
	input: GroupMoveInput
): GroupEditResult {
	const request = groupMoveRequestSchema.parse(input);
	const direct = clipsById(project, request.clipIds);
	const directIds = new Set(direct.map((segment) => segment.id));
	const moving = clipsById(project, withLinkedPartners(project, directIds));
	ensureUnlocked(
		project,
		moving.map((segment) => segment.track),
		"Unlock every linked clip track before moving the group."
	);
	const lowestTrack = Math.min(...direct.map((segment) => segment.track));
	const highestTrack = Math.max(...direct.map((segment) => segment.track));
	// `|| 0` folds a clamped -0 into 0.
	const trackApplied =
		Math.max(
			-lowestTrack,
			Math.min(MAX_TRACK_INDEX - highestTrack, request.trackDelta)
		) || 0;
	ensureUnlocked(
		project,
		direct.map((segment) => segment.track + trackApplied),
		"Unlock the destination track before moving the clips."
	);
	const earliest = Math.min(...moving.map((segment) => segment.start));
	const latest = Math.max(...moving.map(segmentEnd));
	const anchorStart = Math.min(...direct.map((segment) => segment.start));
	const requested = request.exact
		? request.delta
		: quantize(anchorStart + request.delta, project.fps) - anchorStart;
	const applied = round6(
		clampInto(requested, -earliest, PROJECT_LIMIT - latest)
	);
	if (applied === 0 && trackApplied === 0) {
		return { applied: 0, project, trackApplied: 0 };
	}
	const movingIds = new Set(moving.map((segment) => segment.id));
	const segments = project.segments.map((segment) => {
		if (!movingIds.has(segment.id)) {
			return segment;
		}
		return {
			...segment,
			start: Math.max(0, round6(segment.start + applied)),
			track: directIds.has(segment.id)
				? segment.track + trackApplied
				: segment.track,
		};
	});
	return {
		applied,
		project: finish(project, assets, segments),
		trackApplied,
	};
}

/** Timeline-second range a trim of `edge` may take for one clip. */
export function trimBounds(
	project: Project,
	segment: Segment,
	asset: Asset,
	edge: "start" | "end"
): { high: number; low: number } {
	const shortest = minimumKept(project.fps);
	const duration = segmentDuration(segment);
	const end = segmentEnd(segment);
	const still = asset.kind === "image";
	const neighbours = project.segments.filter(
		(other) => other.id !== segment.id && other.track === segment.track
	);
	if (edge === "end") {
		const nextStart = Math.min(
			PROJECT_LIMIT,
			...neighbours
				.filter((other) => other.start >= end - EPSILON)
				.map((other) => other.start)
		);
		const sourceAfter = (asset.duration - segment.sourceOut) / segment.speed;
		return {
			high: Math.max(
				0,
				Math.min(
					nextStart - end,
					still ? Number.POSITIVE_INFINITY : sourceAfter
				)
			),
			low: -(duration - shortest),
		};
	}
	const previousEnd = Math.max(
		0,
		...neighbours
			.filter((other) => segmentEnd(other) <= segment.start + EPSILON)
			.map(segmentEnd)
	);
	const sourceBefore = segment.sourceIn / segment.speed;
	return {
		high: duration - shortest,
		low: -Math.max(
			0,
			Math.min(
				segment.start - previousEnd,
				still ? Number.POSITIVE_INFINITY : sourceBefore
			)
		),
	};
}

function clampFades(segment: Segment): Segment {
	const duration = segmentDuration(segment);
	const fadeIn = Math.min(segment.fadeIn, duration);
	const fadeOut = Math.max(
		0,
		Math.min(segment.fadeOut, round6(duration - fadeIn))
	);
	// Reveal and exit durations fit the new length; `finish` then drops a
	// reveal whose predecessor no longer covers it.
	return fitEdgeTransitions({ ...segment, fadeIn, fadeOut }, true, true);
}

/** Trim one edge of one clip by an already-clamped amount. */
function trimOne(
	segment: Segment,
	asset: Asset,
	edge: "start" | "end",
	shift: number
): Segment {
	if (asset.kind !== "image") {
		return clampFades(trimSegment(segment, asset.duration, edge, shift));
	}
	// A still has no source timeline: either edge lengthens or shortens the hold.
	const sourceShift = shift * segment.speed;
	if (edge === "end") {
		const next = {
			...segment,
			sourceOut: round6(segment.sourceOut + sourceShift),
		};
		return clampFades({
			...next,
			keyframes: retimeKeyframes(segment, 0, segmentDuration(next)),
		});
	}
	const next = {
		...segment,
		sourceOut: round6(segment.sourceOut - sourceShift),
		start: round6(segment.start + shift),
	};
	return clampFades({
		...next,
		keyframes: retimeKeyframes(segment, shift, segmentDuration(next)),
	});
}

/**
 * Trim the same edge of several clips by one shared delta. Each clip stops at
 * the adjacent clip on its track and at its source media (stills have no
 * source limit), and keyframes are re-based through `trimSegment`. With
 * `linked` (the default), linked A/V partners trim with their clip; with
 * `linked: false` (Alt held) only the named clips change, so trimming the
 * audio of a linked pair leaves a J- or L-cut. Throws on a locked track.
 */
export function groupTrim(
	project: Project,
	assets: readonly Asset[],
	input: GroupTrimInput
): GroupEditResult {
	const request = groupTrimRequestSchema.parse(input);
	const ids = request.linked
		? withLinkedPartners(project, request.clipIds)
		: request.clipIds;
	const targets = clipsById(project, ids);
	ensureUnlocked(
		project,
		targets.map((segment) => segment.track),
		"Unlock every affected clip track before trimming."
	);
	let low = Number.NEGATIVE_INFINITY;
	let high = Number.POSITIVE_INFINITY;
	for (const segment of targets) {
		const bounds = trimBounds(
			project,
			segment,
			assetFor(assets, segment),
			request.edge
		);
		low = Math.max(low, bounds.low);
		high = Math.min(high, bounds.high);
	}
	const requested = request.exact
		? request.delta
		: Math.round(request.delta * project.fps) / project.fps;
	const applied = round6(clampInto(requested, low, high));
	if (applied === 0) {
		return { applied: 0, project, trackApplied: 0 };
	}
	const targetIds = new Set(targets.map((segment) => segment.id));
	const segments = project.segments.map((segment) =>
		targetIds.has(segment.id)
			? trimOne(segment, assetFor(assets, segment), request.edge, applied)
			: segment
	);
	return {
		applied,
		project: finish(project, assets, segments),
		trackApplied: 0,
	};
}

/** Whether two placements share a track and overlap in time. */
function placementsOverlap(
	a: { end: number; start: number; track: number },
	b: { end: number; start: number; track: number }
) {
	return (
		a.track === b.track &&
		a.start < b.end - EPSILON &&
		b.start < a.end - EPSILON
	);
}

/**
 * Alt-drag duplicate: copy the clips (with linked partners) and paste them
 * `delta` seconds away through the clipboard paste contract. Track offsets
 * follow `groupMove`: only the named clips shift by `trackDelta` (clamped so
 * they stay within the track limit); linked partners' copies keep their own
 * tracks. The copy overwrites whatever it lands on, like a drop, but a drop
 * that would overlap the clips it copies (or stack two copies on one track)
 * is refused, so a duplicate never consumes its own source.
 */
export function groupDuplicate(
	project: Project,
	assets: readonly Asset[],
	input: GroupDuplicateInput
): GroupDuplicateResult {
	const request = groupDuplicateRequestSchema.parse(input);
	const direct = clipsById(project, request.clipIds);
	const directIds = new Set(direct.map((segment) => segment.id));
	const lowestTrack = Math.min(...direct.map((segment) => segment.track));
	const highestTrack = Math.max(...direct.map((segment) => segment.track));
	const trackApplied =
		Math.max(
			-lowestTrack,
			Math.min(MAX_TRACK_INDEX - highestTrack, request.trackDelta)
		) || 0;
	const copied = copyClips(project, request.clipIds);
	const payload: ClipboardPayload = {
		...copied,
		items: copied.items.map((item) =>
			directIds.has(item.segment.id)
				? {
						...item,
						segment: {
							...item.segment,
							track: item.segment.track + trackApplied,
						},
					}
				: item
		),
	};
	const origin = Math.min(...copied.items.map((item) => item.segment.start));
	const at = Math.max(
		0,
		Math.min(
			PROJECT_LIMIT - payload.span,
			quantize(origin + request.delta, project.fps)
		)
	);
	const placed = payload.items.map((item) => ({
		end: at + item.offset + segmentDuration(item.segment),
		start: at + item.offset,
		track: item.segment.track,
	}));
	const sources = copied.items.map((item) => ({
		end: segmentEnd(item.segment),
		start: item.segment.start,
		track: item.segment.track,
	}));
	if (
		placed.some((entry) =>
			sources.some((source) => placementsOverlap(entry, source))
		)
	) {
		throw new Error("Drop the copy clear of the clips it duplicates.");
	}
	if (
		placed.some((entry, index) =>
			placed.some(
				(other, otherIndex) =>
					otherIndex > index && placementsOverlap(entry, other)
			)
		)
	) {
		throw new Error("The copies would overlap each other on one track.");
	}
	const result = pasteClips(project, assets, payload, {
		at,
		mode: "overwrite",
		track: Math.min(...placed.map((entry) => entry.track)),
	});
	return { newIds: result.newIds, project: result.project };
}

/** Longest fade-in and fade-out a clip can take while keeping the other. */
export function fadeBounds(segment: Segment): { in: number; out: number } {
	const duration = segmentDuration(segment);
	return {
		in: Math.max(0, round6(duration - segment.fadeOut)),
		out: Math.max(0, round6(duration - segment.fadeIn)),
	};
}

/**
 * Set a clip's fade-in or fade-out length (seconds), clamped so the two
 * fades never exceed the clip. Throws on a locked track.
 */
export function setClipFade(
	project: Project,
	assets: readonly Asset[],
	input: ClipFadeInput
): Project {
	const request = clipFadeRequestSchema.parse(input);
	const [segment] = clipsById(project, [request.clipId]);
	if (!segment) {
		throw new Error("Clip not found on this timeline.");
	}
	ensureUnlocked(
		project,
		[segment.track],
		"Unlock the clip track before changing its fades."
	);
	const bounds = fadeBounds(segment);
	const seconds = round6(
		Math.min(request.fade === "in" ? bounds.in : bounds.out, request.seconds)
	);
	const current = request.fade === "in" ? segment.fadeIn : segment.fadeOut;
	if (Math.abs(current - seconds) < EPSILON) {
		return project;
	}
	const next: Segment =
		request.fade === "in"
			? { ...segment, fadeIn: seconds }
			: { ...segment, fadeOut: seconds };
	return validateProject(
		{
			...project,
			segments: project.segments.map((candidate) =>
				candidate.id === segment.id ? next : candidate
			),
		},
		[...assets]
	);
}
