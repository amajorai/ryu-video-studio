import { z } from "zod";
import { MAX_TRACK_INDEX } from "./limits.ts";
import {
	type Asset,
	type Project,
	type Segment,
	segmentDuration,
	trackSettingFor,
	validateProject,
} from "./project.ts";
import { trackHiddenOf } from "./schema/defaults.ts";

/** Overlaps shorter than this (half a millisecond) do not occupy a track. */
const OVERLAP_EPSILON = 0.0005;

/** Media classes that share a track: video and images, or audio. */
export type PlacementKind = "audio" | "visual";

/** Placement class of an asset kind (video and image clips share lanes). */
export const placementKindOf = (kind: Asset["kind"]): PlacementKind =>
	kind === "audio" ? "audio" : "visual";

export interface FirstFreeTrackOptions {
	/**
	 * Assets used to read the media class of clips already on a track. With
	 * `kind`, a track holding clips of the other class is skipped, so audio
	 * does not land on a video lane and vice versa.
	 */
	assets?: readonly Asset[];
	/** Clip ids that do not occupy their track (clips being moved away). */
	exclude?: ReadonlySet<string>;
	/** The lowest track index considered (default 0). */
	from?: number;
	/** Media class (or asset kind) of the clip being placed. */
	kind?: PlacementKind | Asset["kind"];
}

const segmentEnd = (segment: Segment) =>
	segment.start + segmentDuration(segment);

/**
 * Whether no clip on `track` (other than `exclude`) overlaps `[start, end)`
 * by more than half a millisecond.
 */
export function trackFreeOver(
	project: Pick<Project, "segments">,
	track: number,
	start: number,
	end: number,
	exclude: ReadonlySet<string> = new Set()
): boolean {
	return !project.segments.some(
		(segment) =>
			segment.track === track &&
			!exclude.has(segment.id) &&
			Math.min(segmentEnd(segment), end) - Math.max(segment.start, start) >
				OVERLAP_EPSILON
	);
}

/** A track accepts new clips when it is neither locked nor hidden. */
export function trackAcceptsClips(
	project: Pick<Project, "trackSettings">,
	track: number
): boolean {
	const setting = trackSettingFor(project, track);
	return !(setting.locked || trackHiddenOf(setting));
}

function kindCompatible(
	project: Pick<Project, "segments">,
	track: number,
	options: FirstFreeTrackOptions
): boolean {
	const { assets, exclude, kind } = options;
	if (!(assets && kind)) {
		return true;
	}
	const wanted =
		kind === "audio" || kind === "visual" ? kind : placementKindOf(kind);
	return project.segments.every((segment) => {
		if (segment.track !== track || exclude?.has(segment.id)) {
			return true;
		}
		const asset = assets.find((candidate) => candidate.id === segment.assetId);
		return !asset || placementKindOf(asset.kind) === wanted;
	});
}

/**
 * The lowest unlocked, visible track at or above `options.from` that is free
 * over `[start, end)` (and, with `kind` and `assets`, holds no clips of the
 * other media class). Returns `undefined` when every track is taken.
 */
export function firstFreeTrack(
	project: Pick<Project, "segments" | "trackSettings">,
	start: number,
	end: number,
	options: FirstFreeTrackOptions = {}
): number | undefined {
	for (
		let track = Math.max(0, options.from ?? 0);
		track <= MAX_TRACK_INDEX;
		track += 1
	) {
		if (
			trackAcceptsClips(project, track) &&
			trackFreeOver(project, track, start, end, options.exclude) &&
			kindCompatible(project, track, options)
		) {
			return track;
		}
	}
	return undefined;
}

const TIME_TOLERANCE = 1e-6;

/**
 * Whether a clip's reveal transition is still valid: it fits the clip and a
 * same-track predecessor overlaps it by the transition's duration (the rule
 * `validateProject` enforces). A clip without a reveal is always covered.
 */
export function revealCovered(
	segments: readonly Segment[],
	segment: Segment
): boolean {
	const transition = segment.transitionIn;
	if (!transition) {
		return true;
	}
	const required = segment.start + transition.duration;
	return (
		transition.duration <= segmentDuration(segment) + TIME_TOLERANCE &&
		segments.some(
			(other) =>
				other.id !== segment.id &&
				other.track === segment.track &&
				other.start < segment.start &&
				segmentEnd(other) >= required - TIME_TOLERANCE
		)
	);
}

/**
 * Drop reveal transitions whose predecessor overlap a placement edit cut or
 * moved away, instead of failing the edit. Other clips are returned as-is.
 */
export function dropUncoveredRevealTransitions(
	segments: readonly Segment[]
): Segment[] {
	return segments.map((segment) => {
		if (revealCovered(segments, segment)) {
			return segment;
		}
		const { transitionIn: _dropped, ...rest } = segment;
		return rest;
	});
}

export const moveToNewTrackRequestSchema = z
	.object({
		clipIds: z.array(z.uuid()).min(1).max(50),
		/** Copy the clips instead of moving them (the originals stay). */
		duplicate: z.boolean().default(false),
		revision: z.number().int().nonnegative(),
	})
	.strict();
export type MoveToNewTrackRequest = z.infer<typeof moveToNewTrackRequestSchema>;
export type MoveToNewTrackInput = z.input<typeof moveToNewTrackRequestSchema>;

export interface NewTrackPlacement {
	/** Ids of the moved clips, or of the copies, in request order. */
	ids: string[];
	project: Project;
	/** Track offset applied to every clip (destination = source + delta). */
	trackDelta: number;
}

/**
 * Smallest track offset that lands every clip on an unlocked, visible track
 * that is free over its span and, like `firstFreeTrack`, holds no clips of
 * the other media class (so audio never joins a video lane or vice versa).
 */
function placementDelta(
	project: Project,
	assets: readonly Asset[],
	clips: readonly Segment[],
	exclude: ReadonlySet<string>
): number {
	const kindOf = (segment: Segment) =>
		assets.find((asset) => asset.id === segment.assetId)?.kind;
	const tracks = clips.map((segment) => segment.track);
	const highest = Math.max(...tracks);
	for (let delta = 1; highest + delta <= MAX_TRACK_INDEX; delta += 1) {
		const fits = clips.every((segment) => {
			const track = segment.track + delta;
			return (
				trackAcceptsClips(project, track) &&
				trackFreeOver(
					project,
					track,
					segment.start,
					segmentEnd(segment),
					exclude
				) &&
				kindCompatible(project, track, {
					assets,
					exclude,
					kind: kindOf(segment),
				})
			);
		});
		if (fits) {
			return delta;
		}
	}
	throw new Error(
		"No free, unlocked track above these clips can hold them without mixing audio and video. Free or unlock a track first."
	);
}

function requestedClips(project: Project, clipIds: readonly string[]) {
	if (new Set(clipIds).size !== clipIds.length) {
		throw new Error("Choose each clip once.");
	}
	return clipIds.map((id) => {
		const found = project.segments.find((segment) => segment.id === id);
		if (!found) {
			throw new Error("Clip not found on this timeline.");
		}
		return found;
	});
}

/** A copy of `segment` with fresh clip and keyframe ids. */
function copiedSegment(segment: Segment): Segment {
	const { multicamGroupId: _multicam, linkGroupId: _link, ...rest } = segment;
	return {
		...rest,
		id: crypto.randomUUID(),
		keyframes: segment.keyframes.map((keyframe) => ({
			...keyframe,
			id: crypto.randomUUID(),
		})),
	};
}

/**
 * Link groups for copies: members copied together keep a fresh shared group
 * when the copies still pair audio with visual media; otherwise the copy is
 * unlinked.
 */
function relinkCopies(
	pairs: readonly { copy: Segment; source: Segment }[],
	assets: readonly Asset[]
): Segment[] {
	const classes = new Map<string, Set<PlacementKind>>();
	for (const { source } of pairs) {
		if (!source.linkGroupId) {
			continue;
		}
		const asset = assets.find((candidate) => candidate.id === source.assetId);
		const set = classes.get(source.linkGroupId) ?? new Set<PlacementKind>();
		if (asset) {
			set.add(placementKindOf(asset.kind));
		}
		classes.set(source.linkGroupId, set);
	}
	const minted = new Map<string, string>();
	return pairs.map(({ copy, source }) => {
		const group = source.linkGroupId;
		if (!group || classes.get(group)?.size !== 2) {
			return copy;
		}
		const next = minted.get(group) ?? crypto.randomUUID();
		minted.set(group, next);
		return { ...copy, linkGroupId: next };
	});
}

/**
 * Move (or, with `duplicate`, copy) clips to the first free tracks above
 * them. Every clip shifts by the same track offset, so a multi-track
 * selection keeps its stacking; the offset is the smallest one at which each
 * destination track is unlocked, visible, and free over the clip's span.
 * Moving keeps link groups (only track indices change); copies get fresh
 * ids and re-minted link groups.
 */
export function placeOnNewTrack(
	project: Project,
	assets: readonly Asset[],
	input: MoveToNewTrackInput
): NewTrackPlacement {
	const request = moveToNewTrackRequestSchema.parse(input);
	const clips = requestedClips(project, request.clipIds);
	if (
		!request.duplicate &&
		clips.some((segment) => trackSettingFor(project, segment.track).locked)
	) {
		throw new Error(
			"Unlock the clip track before moving clips to a new track."
		);
	}
	const exclude = new Set(request.duplicate ? [] : request.clipIds);
	const trackDelta = placementDelta(project, assets, clips, exclude);
	if (request.duplicate) {
		const copies = relinkCopies(
			clips.map((source) => ({
				copy: { ...copiedSegment(source), track: source.track + trackDelta },
				source,
			})),
			assets
		);
		return {
			ids: copies.map((copy) => copy.id),
			project: validateProject(
				{
					...project,
					segments: dropUncoveredRevealTransitions(
						sortSegments([...project.segments, ...copies])
					),
				},
				[...assets]
			),
			trackDelta,
		};
	}
	const moved = project.segments.map((segment) =>
		exclude.has(segment.id)
			? { ...segment, track: segment.track + trackDelta }
			: segment
	);
	return {
		ids: [...request.clipIds],
		project: validateProject(
			{
				...project,
				segments: sortSegments(dropUncoveredRevealTransitions(moved)),
			},
			[...assets]
		),
		trackDelta,
	};
}

/** Move clips to the first free tracks above them (see `placeOnNewTrack`). */
export const moveToNewTrack = (
	project: Project,
	assets: readonly Asset[],
	clipIds: readonly string[]
): NewTrackPlacement =>
	placeOnNewTrack(project, assets, {
		clipIds: [...clipIds],
		duplicate: false,
		revision: project.revision,
	});

/** Copy clips onto the first free tracks above them (see `placeOnNewTrack`). */
export const duplicateToNewTrack = (
	project: Project,
	assets: readonly Asset[],
	clipIds: readonly string[]
): NewTrackPlacement =>
	placeOnNewTrack(project, assets, {
		clipIds: [...clipIds],
		duplicate: true,
		revision: project.revision,
	});

/** Timeline storage order: by track, then start. */
export const sortSegments = (segments: readonly Segment[]): Segment[] =>
	[...segments].sort((a, b) => a.track - b.track || a.start - b.start);
