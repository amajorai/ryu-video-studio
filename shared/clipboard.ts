import { z } from "zod";
import {
	dropUncoveredReveals,
	remintKeyframe,
	remintMasks,
} from "./clip-edits.ts";
import { MAX_TRACK_INDEX } from "./limits.ts";
import { overwriteImpacts } from "./overwrite.ts";
import {
	type Asset,
	type Avatar,
	activeCaptions,
	type Caption,
	dissolveOrphanedLinkGroups,
	type Graphic,
	type Project,
	projectDuration,
	type Segment,
	segmentDuration,
	splitSegment,
	type Title,
	trackSettingFor,
	validateProject,
	withActiveCaptions,
} from "./project.ts";
import { rippleRemoveClips } from "./ripple-edits.ts";
import type { AdjustmentLayer } from "./schema/adjustment.ts";
import { withLinkedPartners } from "./selection.ts";
import { affectedTracks, rippleMarkersOf } from "./sync-lock.ts";
import {
	firstFreeTrack,
	type PlacementKind,
	placementKindOf,
} from "./track-placement.ts";

/** Projects are limited to two hours. */
const TIMELINE_LIMIT = 7200;
/** The shortest clip piece an overwrite leaves behind. */
const MIN_PIECE = 0.04;
/** Times this close count as equal when comparing to an edit point. */
const TIME_TOLERANCE = 1e-6;

/** Overlay collections a clipboard can carry alongside clips. */
export type ClipboardOverlayKind =
	| "titles"
	| "graphics"
	| "captions"
	| "avatars"
	| "adjustmentLayers";

export const clipboardOverlayKindSchema = z.enum([
	"titles",
	"graphics",
	"captions",
	"avatars",
	"adjustmentLayers",
]);

/** A reference to one overlay item (a title, graphic, caption…). */
export interface OverlayRef {
	id: string;
	kind: ClipboardOverlayKind;
}

/** A copied overlay item with its offset from the clipboard origin. */
export type ClipboardOverlay =
	| { item: Title; kind: "titles"; offset: number }
	| { item: Graphic; kind: "graphics"; offset: number }
	| { item: Caption; kind: "captions"; offset: number }
	| { item: Avatar; kind: "avatars"; offset: number }
	| { item: AdjustmentLayer; kind: "adjustmentLayers"; offset: number };

/** A copied clip; `offset` is its start relative to the clipboard origin. */
export interface ClipboardItem {
	offset: number;
	segment: Segment;
}

/**
 * Clips and overlays captured by copy or cut. Items are full snapshots, so
 * a payload still pastes after its sources were cut or deleted. `span` runs
 * from the earliest start to the latest end of everything copied.
 */
export interface ClipboardPayload {
	items: ClipboardItem[];
	overlays: ClipboardOverlay[];
	span: number;
}

export type PasteMode = "overwrite" | "insert";

export interface PasteOptions {
	/** Timeline time the payload origin lands on. */
	at: number;
	/** `insert` first opens a gap of `span` at `at` (rippling later content). */
	mode: PasteMode;
	/**
	 * Track the payload's lowest track lands on. When given, content on the
	 * destination tracks is overwritten; when absent, clips keep their source
	 * tracks if those are free over the pasted span, otherwise the whole
	 * payload moves to the first free tracks.
	 */
	track?: number;
}

export interface PasteResult {
	/** Ids of the pasted clips, in payload order. */
	newIds: string[];
	/** The pasted overlay items. */
	newOverlays: OverlayRef[];
	project: Project;
}

const segmentEnd = (segment: Segment) =>
	segment.start + segmentDuration(segment);

function overlayItems(
	project: Project,
	kind: ClipboardOverlayKind
): readonly { end: number; id: string; start: number }[] {
	switch (kind) {
		case "titles":
			return project.titles;
		case "graphics":
			return project.graphics;
		case "captions":
			return activeCaptions(project);
		case "avatars":
			return project.avatars;
		case "adjustmentLayers":
			return project.adjustmentLayers ?? [];
		default:
			return [];
	}
}

function copyOverlay(
	project: Project,
	ref: OverlayRef
): Omit<ClipboardOverlay, "offset"> | null {
	const item = overlayItems(project, ref.kind).find(
		(candidate) => candidate.id === ref.id
	);
	return item
		? ({ item: structuredClone(item), kind: ref.kind } as Omit<
				ClipboardOverlay,
				"offset"
			>)
		: null;
}

/**
 * Snapshot clips (with their linked audio/video partners) and overlays into
 * a clipboard payload. Throws when nothing in `ids`/`overlays` exists.
 */
export function copyClips(
	project: Project,
	ids: readonly string[],
	overlays: readonly OverlayRef[] = []
): ClipboardPayload {
	const wanted = new Set(withLinkedPartners(project, ids));
	const segments = project.segments
		.filter((segment) => wanted.has(segment.id))
		.sort((a, b) => a.track - b.track || a.start - b.start);
	const copiedOverlays = overlays
		.map((ref) => copyOverlay(project, ref))
		.filter((overlay) => overlay !== null);
	if (!(segments.length || copiedOverlays.length)) {
		throw new Error("Select clips or overlays to copy.");
	}
	const starts = [
		...segments.map((segment) => segment.start),
		...copiedOverlays.map((overlay) => overlay.item.start),
	];
	const ends = [
		...segments.map(segmentEnd),
		...copiedOverlays.map((overlay) => overlay.item.end),
	];
	const origin = Math.min(...starts);
	return {
		items: segments.map((segment) => ({
			offset: segment.start - origin,
			segment: structuredClone(segment),
		})),
		overlays: copiedOverlays.map(
			(overlay) =>
				({
					...overlay,
					offset: overlay.item.start - origin,
				}) as ClipboardOverlay
		),
		span: Math.max(...ends) - origin,
	};
}

interface Placement {
	end: number;
	/** Asset kind of the placed clip, when its media is known. */
	kind?: Asset["kind"];
	start: number;
	track: number;
}

function placements(
	payload: ClipboardPayload,
	assets: readonly Asset[],
	at: number,
	delta: number
) {
	return payload.items.map((item): Placement => {
		const placement: Placement = {
			end: at + item.offset + segmentDuration(item.segment),
			start: at + item.offset,
			track: item.segment.track + delta,
		};
		const kind = assets.find(
			(asset) => asset.id === item.segment.assetId
		)?.kind;
		if (kind) {
			placement.kind = kind;
		}
		return placement;
	});
}

/**
 * Whether every placement lands on an existing track that accepts clips
 * (unlocked, visible), is free over its span, and holds no clips of the
 * other media class, so a pasted A/V pair never puts video on an audio lane.
 */
function placementFits(
	project: Project,
	assets: readonly Asset[],
	placed: readonly Placement[]
) {
	return placed.every(
		(entry) =>
			entry.track >= 0 &&
			entry.track <= MAX_TRACK_INDEX &&
			firstFreeTrack(
				project,
				entry.start,
				entry.end,
				entry.kind
					? { assets, from: entry.track, kind: entry.kind }
					: { from: entry.track }
			) === entry.track
	);
}

/**
 * Track offset for an automatic paste: the source tracks when they are free,
 * accept clips (unlocked, visible), and match each clip's media class over
 * the pasted span. Otherwise a single clip goes to `firstFreeTrack` for its
 * media class, and a multi-track payload to the lowest base track where
 * every clip (keeping relative track spacing) lands on such a lane.
 */
function automaticTrackDelta(
	project: Project,
	assets: readonly Asset[],
	payload: ClipboardPayload,
	at: number
): number {
	if (
		!payload.items.length ||
		placementFits(project, assets, placements(payload, assets, at, 0))
	) {
		return 0;
	}
	const [only] = payload.items;
	if (only && payload.items.length === 1) {
		const kind = assets.find(
			(asset) => asset.id === only.segment.assetId
		)?.kind;
		const start = at + only.offset;
		const track = firstFreeTrack(
			project,
			start,
			start + segmentDuration(only.segment),
			kind ? { assets, kind } : {}
		);
		if (track === undefined) {
			throw new Error("No free track can hold the pasted clips.");
		}
		return track - only.segment.track;
	}
	const tracks = payload.items.map((item) => item.segment.track);
	const lowest = Math.min(...tracks);
	const height = Math.max(...tracks) - lowest;
	for (let base = 0; base + height <= MAX_TRACK_INDEX; base += 1) {
		const delta = base - lowest;
		if (
			placementFits(project, assets, placements(payload, assets, at, delta))
		) {
			return delta;
		}
	}
	throw new Error("No free track can hold the pasted clips.");
}

/**
 * Pieces of `segment` left after clearing `[start, end)`: the clip is
 * removed when covered, trimmed when one end survives (keeping its id, so
 * template slots and lip-sync links naming it stay valid), or split around
 * the range. Overlaps shorter than a minimum piece are tolerated rather
 * than cut, and pieces under 0.04 s are dropped.
 */
function clearSegment(segment: Segment, start: number, end: number): Segment[] {
	const finish = segmentEnd(segment);
	const overlapStart = Math.max(segment.start, start);
	const overlapEnd = Math.min(finish, end);
	if (overlapEnd - overlapStart < MIN_PIECE) {
		return [segment];
	}
	const keepsHead = start - segment.start >= MIN_PIECE;
	const keepsTail = finish - end >= MIN_PIECE;
	const kept: Segment[] = [];
	let rest = segment;
	if (keepsHead) {
		const [left, right] = splitSegment(segment, start);
		kept.push(left);
		rest = right;
	}
	if (keepsTail) {
		const tail = splitSegment(rest, end)[1];
		kept.push(keepsHead ? tail : { ...tail, id: segment.id });
	}
	return kept;
}

/**
 * Clear `[start, end)` on one track: clips inside are removed and clips
 * crossing an edge are cut there (pieces under 0.04 s are dropped). Linked
 * partners are not touched; `pasteClips` cuts them through `overwriteImpacts`.
 */
export function overwriteRange(
	segments: readonly Segment[],
	track: number,
	start: number,
	end: number
): Segment[] {
	return segments.flatMap((segment): Segment[] =>
		segment.track === track ? clearSegment(segment, start, end) : [segment]
	);
}

/**
 * Give clips of the `touched` link groups that start at or after `boundary`
 * a fresh group per original group, so the pieces before and after an edit
 * point form separate pairs. Touched or re-minted groups that no longer
 * pair audio with visual media are then cleared. Other groups are kept.
 */
function regroupFrom(
	segments: readonly Segment[],
	assets: readonly Asset[],
	touched: ReadonlySet<string>,
	boundary: number
): Segment[] {
	if (!touched.size) {
		return [...segments];
	}
	const minted = new Map<string, string>();
	const regrouped = segments.map((segment) => {
		const group = segment.linkGroupId;
		if (
			!(group && touched.has(group)) ||
			segment.start < boundary - TIME_TOLERANCE
		) {
			return segment;
		}
		const next = minted.get(group) ?? crypto.randomUUID();
		minted.set(group, next);
		return { ...segment, linkGroupId: next };
	});
	const checked = new Set([...touched, ...minted.values()]);
	const classes = new Map<string, Set<PlacementKind>>();
	for (const segment of regrouped) {
		const group = segment.linkGroupId;
		if (!(group && checked.has(group))) {
			continue;
		}
		const set = classes.get(group) ?? new Set<PlacementKind>();
		const kind = assets.find((asset) => asset.id === segment.assetId)?.kind;
		if (kind) {
			set.add(placementKindOf(kind));
		}
		classes.set(group, set);
	}
	return regrouped.map((segment) => {
		const group = segment.linkGroupId;
		if (!(group && checked.has(group)) || (classes.get(group)?.size ?? 0) > 1) {
			return segment;
		}
		const { linkGroupId: _dissolved, ...rest } = segment;
		return rest;
	});
}

/**
 * Drop template slots and avatar lip-sync clip links whose clip an edit
 * removed (as ripple delete and overwrite do).
 */
function pruneClipReferences(project: Project): Project {
	const surviving = new Set(project.segments.map((segment) => segment.id));
	const next: Project = {
		...project,
		avatars: project.avatars.map((avatar) => {
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
		}),
	};
	if (project.template) {
		next.template = {
			...project.template,
			slots: project.template.slots.filter((slot) =>
				surviving.has(slot.segmentId)
			),
		};
	}
	return next;
}

/**
 * Re-time every overlay, caption (with words), and marker through
 * `mapTime`, and set the clip list. Overlay keyframes are relative to their
 * item, so they move with it. Markers stay put when the project sets
 * `rippleMarkers: false`.
 */
function retimeTimeline(
	project: Project,
	segments: Segment[],
	mapTime: (value: number) => number
): Project {
	const timed = <T extends { end: number; start: number }>(
		items: readonly T[]
	) =>
		items.map((item) => ({
			...item,
			end: mapTime(item.end),
			start: mapTime(item.start),
		}));
	const mapCaptions = (captions: readonly Caption[]) =>
		captions.map((caption) => {
			const mapped = {
				...caption,
				end: mapTime(caption.end),
				start: mapTime(caption.start),
			};
			if (caption.words) {
				mapped.words = caption.words.map((word) => ({
					...word,
					end: mapTime(word.end),
					start: mapTime(word.start),
				}));
			}
			return mapped;
		});
	const next: Project = {
		...project,
		avatars: timed(project.avatars),
		captions: mapCaptions(project.captions),
		captionTracks: project.captionTracks.map((track) => ({
			...track,
			captions: mapCaptions(track.captions),
		})),
		graphics: timed(project.graphics),
		markers: rippleMarkersOf(project)
			? project.markers.map((marker) => ({
					...marker,
					time: mapTime(marker.time),
				}))
			: project.markers,
		meshes: timed(project.meshes),
		segments,
		spatialObjects: timed(project.spatialObjects),
		titles: timed(project.titles),
	};
	if (project.adjustmentLayers) {
		next.adjustmentLayers = timed(project.adjustmentLayers);
	}
	return next;
}

/**
 * The insert point for a paste at `at`: when `at` falls less than a piece
 * (`MIN_PIECE`) inside a clip edge on a gap track (one frame before a clip's
 * end, say), it snaps to that edge, so the paste lands next to the clip
 * instead of overlapping it or splitting off a sliver.
 */
function insertPoint(
	project: Project,
	at: number,
	tracks: readonly number[]
): number {
	const affected = affectedTracks(project, tracks);
	for (const segment of project.segments) {
		if (
			!affected.has(segment.track) ||
			segment.start >= at - TIME_TOLERANCE ||
			segmentEnd(segment) <= at
		) {
			continue;
		}
		if (segmentEnd(segment) - at < MIN_PIECE) {
			return segmentEnd(segment);
		}
		if (at - segment.start < MIN_PIECE) {
			return segment.start;
		}
	}
	return at;
}

/**
 * Open a gap of `span` seconds at `at` with the same track rules as
 * `insertClips`: clips on `tracks` (the paste destination) and on every
 * sync-locked track that start at or after `at` move right, locked tracks
 * included, so the destination never loses later clips and locked content
 * stays in sync. Clips crossing `at` are split (the right pieces get their
 * own link groups, so the halves of an A/V pair stay separate pairs);
 * splitting a locked or multicam clip is refused. Overlays, captions, and
 * (unless the project pins them) markers after `at` move right too.
 */
export function openGap(
	project: Project,
	at: number,
	span: number,
	assets: readonly Asset[],
	tracks: readonly number[] = []
): Project {
	const affected = affectedTracks(project, tracks);
	const touched = new Set<string>();
	const segments = project.segments.flatMap((segment) => {
		if (!affected.has(segment.track) || segmentEnd(segment) <= at) {
			return [segment];
		}
		if (segment.start >= at - TIME_TOLERANCE) {
			return [{ ...segment, start: segment.start + span }];
		}
		// A clip ending less than a piece after `at` stays put, like one that
		// ends at `at`; one starting less than a piece before it moves whole.
		if (segmentEnd(segment) - at < MIN_PIECE) {
			return [segment];
		}
		if (at - segment.start < MIN_PIECE) {
			return [{ ...segment, start: segment.start + span }];
		}
		if (trackSettingFor(project, segment.track).locked) {
			throw new Error(
				`Unlock track ${segment.track + 1}: the insert would split its clips.`
			);
		}
		if (segment.multicamGroupId) {
			throw new Error("Paste insert cannot split a multicam clip.");
		}
		if (segment.linkGroupId) {
			touched.add(segment.linkGroupId);
		}
		const [left, right] = splitSegment(segment, at);
		return [left, { ...right, start: right.start + span }];
	});
	return retimeTimeline(
		project,
		regroupFrom(segments, assets, touched, at),
		(value) => (value < at ? value : value + span)
	);
}

/**
 * Overwrite each placement's range on its track. Clips underneath and their
 * linked partners on other tracks are trimmed, split, or removed over the
 * same range (as `overwriteImpacts` reports), and the pieces after the range
 * get fresh link groups. Locked tracks and multicam clips are refused.
 */
function overwritePlacements(
	project: Project,
	assets: readonly Asset[],
	placed: readonly Placement[]
): Project {
	let segments: Segment[] = [...project.segments];
	for (const entry of placed) {
		if (entry.track < 0 || entry.track > MAX_TRACK_INDEX) {
			throw new Error("The pasted clips do not fit below the top track.");
		}
		if (trackSettingFor(project, entry.track).locked) {
			throw new Error("Unlock the destination track before pasting.");
		}
		const impacted = new Set(
			overwriteImpacts({ segments }, entry.track, entry.start, entry.end)
				.filter((impact) => impact.end - impact.start >= MIN_PIECE)
				.map((impact) => impact.id)
		);
		const touched = new Set<string>();
		for (const segment of segments) {
			if (!impacted.has(segment.id)) {
				continue;
			}
			if (trackSettingFor(project, segment.track).locked) {
				throw new Error(
					"Unlock every linked clip track before pasting over this range."
				);
			}
			if (segment.multicamGroupId) {
				throw new Error("A paste cannot overwrite part of a multicam clip.");
			}
			if (segment.linkGroupId) {
				touched.add(segment.linkGroupId);
			}
		}
		segments = regroupFrom(
			segments.flatMap((segment) =>
				impacted.has(segment.id)
					? clearSegment(segment, entry.start, entry.end)
					: [segment]
			),
			assets,
			touched,
			entry.end
		);
	}
	return pruneClipReferences({ ...project, segments });
}

function pastedSegment(
	item: ClipboardItem,
	at: number,
	delta: number,
	linkGroups: Map<string, string>
): Segment {
	const { masks, targets } = remintMasks(item.segment.masks);
	const {
		multicamGroupId: _multicam,
		linkGroupId,
		...rest
	} = structuredClone(item.segment);
	const segment: Segment = {
		...rest,
		id: crypto.randomUUID(),
		keyframes: item.segment.keyframes.map((keyframe) =>
			remintKeyframe(keyframe, targets)
		),
		start: at + item.offset,
		track: item.segment.track + delta,
	};
	if (masks) {
		segment.masks = masks;
	}
	if (linkGroupId) {
		const minted = linkGroups.get(linkGroupId) ?? crypto.randomUUID();
		linkGroups.set(linkGroupId, minted);
		segment.linkGroupId = minted;
	}
	return segment;
}

function shiftedOverlay<T extends { end: number; id: string; start: number }>(
	item: T,
	start: number
): T {
	return {
		...structuredClone(item),
		end: start + (item.end - item.start),
		id: crypto.randomUUID(),
		start,
	};
}

function pasteOverlays(
	project: Project,
	overlays: readonly ClipboardOverlay[],
	at: number
): { overlays: OverlayRef[]; project: Project } {
	let next = project;
	const refs: OverlayRef[] = [];
	for (const overlay of overlays) {
		const start = at + overlay.offset;
		switch (overlay.kind) {
			case "titles": {
				const title = shiftedOverlay(overlay.item, start);
				if (title.keyframes) {
					title.keyframes = title.keyframes.map((frame) =>
						remintKeyframe(frame, new Map())
					);
				}
				next = { ...next, titles: [...next.titles, title] };
				refs.push({ id: title.id, kind: "titles" });
				break;
			}
			case "graphics": {
				const graphic = shiftedOverlay(overlay.item, start);
				if (graphic.keyframes) {
					graphic.keyframes = graphic.keyframes.map((frame) =>
						remintKeyframe(frame, new Map())
					);
				}
				next = { ...next, graphics: [...next.graphics, graphic] };
				refs.push({ id: graphic.id, kind: "graphics" });
				break;
			}
			case "avatars": {
				const avatar = shiftedOverlay(overlay.item, start);
				if (avatar.rigKeyframes) {
					avatar.rigKeyframes = avatar.rigKeyframes.map((frame) => ({
						...frame,
						id: crypto.randomUUID(),
					}));
				}
				next = { ...next, avatars: [...next.avatars, avatar] };
				refs.push({ id: avatar.id, kind: "avatars" });
				break;
			}
			case "adjustmentLayers": {
				const layer = shiftedOverlay(overlay.item, start);
				const { masks, targets } = remintMasks(layer.masks);
				if (masks) {
					layer.masks = masks;
				}
				if (layer.keyframes) {
					layer.keyframes = layer.keyframes.map((frame) =>
						remintKeyframe(frame, targets)
					);
				}
				next = {
					...next,
					adjustmentLayers: [...(next.adjustmentLayers ?? []), layer],
				};
				refs.push({ id: layer.id, kind: "adjustmentLayers" });
				break;
			}
			case "captions": {
				const caption = shiftedOverlay(overlay.item, start);
				const shift = start - overlay.item.start;
				if (caption.words) {
					caption.words = caption.words.map((word) => ({
						...word,
						end: word.end + shift,
						id: crypto.randomUUID(),
						start: word.start + shift,
					}));
				}
				next = withActiveCaptions(
					next,
					[...activeCaptions(next), caption].sort((a, b) => a.start - b.start)
				);
				refs.push({ id: caption.id, kind: "captions" });
				break;
			}
			default:
				break;
		}
	}
	return { overlays: refs, project: next };
}

/**
 * Paste a clipboard payload at `at`. Every clip and overlay gets fresh ids
 * (link groups, masks, and keyframes are re-minted, so pasted A/V pairs stay
 * linked to each other, never to the originals), relative timing and track
 * spacing are preserved, and the result is validated as one edit.
 */
export function pasteClips(
	project: Project,
	assets: readonly Asset[],
	payload: ClipboardPayload,
	options: PasteOptions
): PasteResult {
	const { mode } = options;
	if (!(Number.isFinite(options.at) && options.at >= 0)) {
		throw new Error("Choose a paste time inside the timeline.");
	}
	if (!(payload.items.length || payload.overlays.length)) {
		throw new Error("The clipboard is empty.");
	}
	for (const item of payload.items) {
		if (!assets.some((asset) => asset.id === item.segment.assetId)) {
			throw new Error("Copied media is no longer in the library.");
		}
	}
	const minTrack = payload.items.length
		? Math.min(...payload.items.map((item) => item.segment.track))
		: 0;
	const explicitDelta =
		options.track === undefined ? undefined : options.track - minTrack;
	// Insert opens the gap on the destination tracks (the source tracks for
	// an automatic paste) plus every sync-locked track, as `insertClips` does,
	// so the paste never overwrites content that sat after `at`.
	const gapTracks = payload.items.map(
		(item) => item.segment.track + (explicitDelta ?? 0)
	);
	const at =
		mode === "insert"
			? insertPoint(project, options.at, gapTracks)
			: options.at;
	if (at + payload.span > TIMELINE_LIMIT) {
		throw new Error("The paste would make this project longer than two hours.");
	}
	let base =
		mode === "insert" && at < projectDuration(project)
			? openGap(project, at, payload.span, assets, gapTracks)
			: project;
	let delta: number;
	if (explicitDelta === undefined) {
		delta = automaticTrackDelta(base, assets, payload, at);
	} else {
		delta = explicitDelta;
		base = overwritePlacements(
			base,
			assets,
			placements(payload, assets, at, delta)
		);
	}
	const linkGroups = new Map<string, string>();
	const pasted = payload.items.map((item) =>
		pastedSegment(item, at, delta, linkGroups)
	);
	const pastedIds = new Set(pasted.map((segment) => segment.id));
	const withOverlays = pasteOverlays(base, payload.overlays, at);
	const segments = dropUncoveredReveals(
		dissolveOrphanedLinkGroups(
			[...withOverlays.project.segments, ...pasted].sort(
				(a, b) => a.track - b.track || a.start - b.start
			)
		),
		pastedIds
	);
	return {
		newIds: pasted.map((segment) => segment.id),
		newOverlays: withOverlays.overlays,
		project: validateProject({ ...withOverlays.project, segments }, [
			...assets,
		]),
	};
}

export interface CutOptions {
	/** Close the removed spans (ripple delete) instead of leaving gaps. */
	ripple: boolean;
}

export interface CutResult {
	payload: ClipboardPayload;
	project: Project;
	/**
	 * Removed clip spans a ripple cut left open because clips on sync-locked
	 * tracks still cover them (as `rippleRemoveClips` reports). Always 0
	 * without `ripple`.
	 */
	unclosedSpans: number;
}

/**
 * Copy clips (with linked partners) and overlays, then remove them as one
 * edit. With `ripple`, the removed clips' spans close through
 * `rippleRemoveClips`, the same edit as Shift+Delete: a span another clip on
 * a sync-locked track still covers stays open, locked tracks follow the
 * ripple, and markers move unless the project pins them. Cut overlays leave
 * their time empty.
 */
export function cutClips(
	project: Project,
	assets: readonly Asset[],
	ids: readonly string[],
	overlays: readonly OverlayRef[],
	options: CutOptions
): CutResult {
	const payload = copyClips(project, ids, overlays);
	const removed = new Set(payload.items.map((item) => item.segment.id));
	for (const item of payload.items) {
		if (trackSettingFor(project, item.segment.track).locked) {
			throw new Error("Unlock every affected clip track before cutting.");
		}
	}
	const removedOverlays = new Map<ClipboardOverlayKind, Set<string>>();
	for (const overlay of payload.overlays) {
		const set = removedOverlays.get(overlay.kind) ?? new Set<string>();
		set.add(overlay.item.id);
		removedOverlays.set(overlay.kind, set);
	}
	const keep =
		(kind: ClipboardOverlayKind) =>
		(item: { id: string }): boolean =>
			!removedOverlays.get(kind)?.has(item.id);
	let next: Project = {
		...project,
		avatars: project.avatars.filter(keep("avatars")),
		graphics: project.graphics.filter(keep("graphics")),
		titles: project.titles.filter(keep("titles")),
	};
	if (project.adjustmentLayers) {
		next.adjustmentLayers = project.adjustmentLayers.filter(
			keep("adjustmentLayers")
		);
	}
	if (removedOverlays.has("captions")) {
		next = withActiveCaptions(
			next,
			activeCaptions(next).filter(keep("captions"))
		);
	}
	if (options.ripple && removed.size) {
		// Close the clip spans exactly as Shift+Delete does, so ripple cut
		// follows the same sync-lock, locked-track, and marker rules.
		const rippled = rippleRemoveClips(next, assets, [...removed]);
		return {
			payload,
			project: rippled.project,
			unclosedSpans: rippled.unclosed,
		};
	}
	next = pruneClipReferences({
		...next,
		multicamGroups: next.multicamGroups
			.map((group) => ({
				...group,
				segmentIds: group.segmentIds.filter((id) => !removed.has(id)),
			}))
			.filter((group) => group.segmentIds.length > 0),
		segments: dissolveOrphanedLinkGroups(
			next.segments.filter((segment) => !removed.has(segment.id))
		),
	});
	return {
		payload,
		project: validateProject(next, [...assets]),
		unclosedSpans: 0,
	};
}

const clipboardRequestBase = {
	at: z.number().finite().min(0).max(TIMELINE_LIMIT),
	mode: z.enum(["overwrite", "insert"]).default("overwrite"),
	revision: z.number().int().nonnegative(),
	track: z.number().int().min(0).max(MAX_TRACK_INDEX).optional(),
};

/**
 * Agent duplicate-to-time: copy clips already on the timeline (with linked
 * partners) and paste them at `at` in one revision.
 */
export const pasteClipsRequestSchema = z
	.object({
		...clipboardRequestBase,
		clipIds: z.array(z.uuid()).min(1).max(200),
	})
	.strict();
export type PasteClipsRequestInput = z.input<typeof pasteClipsRequestSchema>;

/** Copy timeline clips and paste them at another time, as one edit. */
export function duplicateClipsTo(
	project: Project,
	assets: readonly Asset[],
	input: PasteClipsRequestInput
): PasteResult {
	const request = pasteClipsRequestSchema.parse(input);
	const missing = request.clipIds.filter(
		(id) => !project.segments.some((segment) => segment.id === id)
	);
	if (missing.length) {
		throw new Error("Clip not found on this timeline.");
	}
	const pasteOptions: PasteOptions = { at: request.at, mode: request.mode };
	if (request.track !== undefined) {
		pasteOptions.track = request.track;
	}
	return pasteClips(
		project,
		assets,
		copyClips(project, request.clipIds),
		pasteOptions
	);
}
