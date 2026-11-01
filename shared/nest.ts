import { dbToGain } from "./decibels.ts";
import { MAX_TRACK_INDEX } from "./limits.ts";
import { unpinRemovedLipSyncClips } from "./lipsync-links.ts";
import { minOverlayDuration, trimOverlay } from "./overlay-edits.ts";
import {
	type Asset,
	dissolveOrphanedLinkGroups,
	fitCutPiece,
	type Graphic,
	isTrackAudible,
	newProject,
	newSegment,
	type Project,
	type Segment,
	segmentDuration,
	type Title,
	type TrackSetting,
	trackSettingFor,
	trimSegment,
	validateProject,
} from "./project.ts";
import { trackGainOf, trackHiddenOf, trackPanOf } from "./schema/defaults.ts";
import { clipAudible, clipHeard, clipVisible } from "./sync-lock.ts";
import {
	dropUncoveredRevealTransitions,
	firstFreeTrack,
	type PlacementKind,
	placementKindOf,
	sortSegments,
	trackAcceptsClips,
	trackFreeOver,
} from "./track-placement.ts";

/**
 * Nest and decompose (W4-N1).
 *
 * Nesting moves a selection of clips, plus the titles and graphics that sit
 * fully inside the selection's span, into a new child project with the
 * parent's canvas settings. Clip times are re-based so the span starts at 0
 * and tracks so the lowest selected track is track 0. After the child is
 * rendered as a sequence asset, `applyNest` swaps the selection for one
 * sequence clip.
 *
 * The nested sequence renders opaque, so nesting refuses selections whose
 * sequence clip would cover or reorder other pictures: no unselected video or
 * image clip may sit on or below the highest selected video track (or the
 * sequence clip's track) during the span, and no adjustment layer may sit
 * between the selected tracks. A title or graphic moves into the child only
 * when nothing that stays in the parent overlaps it in time and would change
 * its stacking; otherwise it stays in the parent. The child keeps the
 * selected tracks' hidden, mute, solo, gain and pan state (gain and pan
 * relative to the sequence clip's own track), so the parent's render does not
 * change because of the nest.
 *
 * Decomposing copies the child's clips and overlays back into the parent at
 * `clip.start - clip.sourceIn`, clipped and trimmed to the sequence clip's
 * source range, with fresh ids. Copies keep the child tracks' effective
 * state (mute, solo, hide, and gain and pan folded into the clip) and the
 * sequence clip's own mute and hide, and audible copies land only on audible
 * tracks. A nest followed by a decompose restores the original clips (up to
 * ids); trimming the sequence clip first restores them trimmed to the kept
 * range, without the fades or entry animation of the cut edges.
 *
 * Every function is pure apart from id minting, which callers can inject.
 */

const EPSILON = 1e-6;
const MAX_TITLE = 200;

export interface NestIdOptions {
	/** Mints fresh ids (default `crypto.randomUUID`). */
	mintId?: () => string;
	/** Timestamp for the child project (default now). */
	now?: string;
}

export interface NestInput {
	clipIds: readonly string[];
	title?: string;
}

export interface NestPlan {
	/** The child project to create; the store assigns its final id. */
	child: Project;
	clipIds: string[];
	/** Exclusive end of the nested span on the parent timeline. */
	end: number;
	graphicIds: string[];
	/** Start of the nested span on the parent timeline. */
	start: number;
	titleIds: string[];
	/** Parent track that receives the sequence clip. */
	track: number;
}

export interface DecomposeResult {
	clipIds: string[];
	graphicIds: string[];
	project: Project;
	titleIds: string[];
	/** Tracks the copies moved up because the anchor tracks were taken. */
	trackDelta: number;
}

const clipEnd = (segment: Segment) => segment.start + segmentDuration(segment);

interface Span {
	end: number;
	start: number;
}

/** Whether two time ranges share more than a boundary instant. */
const overlaps = (a: Span, b: Span) =>
	a.start < b.end - EPSILON && b.start < a.end - EPSILON;

/**
 * The end of an item of `duration` starting at `start`, nudged so that
 * `end - start` never comes out shorter than `duration` in floating point.
 * Fades and keyframes that fill the whole duration stay valid after a move.
 */
function endFor(start: number, duration: number): number {
	let end = start + duration;
	while (end - start < duration) {
		end += Number.EPSILON * Math.max(1, end);
	}
	return end;
}

/** Move a title or graphic by `offset`, keeping its duration exactly. */
function shiftOverlay<Item extends Span>(item: Item, offset: number): Item {
	const duration = item.end - item.start;
	const start = Math.max(0, item.start + offset);
	return { ...item, end: endFor(start, duration), start };
}

const defaultTrackName = (track: number) => `Track ${track + 1}`;

const truncate = (text: string, max: number) =>
	text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;

/** Default title of a nested project made from `parent`. */
export function nestedTitle(parent: Pick<Project, "title">): string {
	return `${truncate(parent.title, MAX_TITLE - 7)} · nest`;
}

/** Name of the sequence asset a nest renders for `child`. */
export function nestedAssetName(child: Pick<Project, "title">): string {
	return truncate(`Sequence · ${child.title}`, MAX_TITLE);
}

function assetFor(assets: readonly Asset[], segment: Segment): Asset {
	const asset = assets.find((candidate) => candidate.id === segment.assetId);
	if (!asset) {
		throw new Error("A clip references media that is not in the library.");
	}
	return asset;
}

function requireSelection(
	project: Project,
	clipIds: readonly string[]
): Segment[] {
	if (new Set(clipIds).size !== clipIds.length) {
		throw new Error("Each clip can be nested only once.");
	}
	return clipIds.map((id) => {
		const segment = project.segments.find((candidate) => candidate.id === id);
		if (!segment) {
			throw new Error("A clip to nest is not on the timeline.");
		}
		return segment;
	});
}

function assertNestable(project: Project, clips: readonly Segment[]): void {
	const ids = new Set(clips.map((segment) => segment.id));
	if (clips.some((segment) => trackSettingFor(project, segment.track).locked)) {
		throw new Error("Unlock the clip tracks before nesting these clips.");
	}
	if (clips.some((segment) => segment.multicamGroupId)) {
		throw new Error(
			"Multicam clips cannot be nested. Ungroup the multicam session first."
		);
	}
	if (project.template?.slots.some((slot) => ids.has(slot.segmentId))) {
		throw new Error(
			"Template slot clips cannot be nested. Remove the slot first."
		);
	}
	if (
		project.avatars.some(
			(avatar) =>
				avatar.lipSync?.segmentId !== undefined &&
				ids.has(avatar.lipSync.segmentId)
		)
	) {
		throw new Error(
			"An avatar lip-syncs to a selected clip. Change its lip-sync source first."
		);
	}
}

const insideSpan = (
	item: { end: number; start: number },
	start: number,
	end: number
) => item.start >= start - EPSILON && item.end <= end + EPSILON;

interface LayerCheck {
	exclude: ReadonlySet<string>;
	/** Highest track the nested content occupied or will occupy. */
	highest: number;
	/** Lowest selected video or image track. */
	lowest: number;
	span: Span;
}

const isVisualClip = (assets: readonly Asset[], segment: Segment) =>
	placementKindOf(assetFor(assets, segment).kind) === "visual";

/**
 * Refuse a nest whose opaque sequence clip would cover or reorder pictures
 * that stay in the parent.
 */
function assertLayersKept(
	parent: Project,
	assets: readonly Asset[],
	check: LayerCheck
): void {
	const covered = parent.segments.some(
		(segment) =>
			!check.exclude.has(segment.id) &&
			segment.track <= check.highest &&
			overlaps(check.span, { end: clipEnd(segment), start: segment.start }) &&
			isVisualClip(assets, segment)
	);
	if (covered) {
		throw new Error(
			"Other video or image clips sit below or between the selected clips during their span, and the nested sequence would cover them. Select those clips too, or move them first."
		);
	}
	const between = (parent.adjustmentLayers ?? []).some(
		(layer) =>
			layer.track >= check.lowest &&
			layer.track < check.highest &&
			overlaps(check.span, layer)
	);
	if (between) {
		throw new Error(
			"An adjustment layer sits between the selected tracks during their span. Move it above or below the selection first."
		);
	}
}

/**
 * Track settings for the child at re-based indices. Visibility, mute and solo
 * become the effective state; gain and pan are relative to the sequence
 * clip's track, which applies its own again in the parent.
 */
function childTrackSettings(
	parent: Project,
	assets: readonly Asset[],
	clips: readonly Segment[],
	placement: { minTrack: number; track: number }
): TrackSetting[] {
	const target = trackSettingFor(parent, placement.track);
	const targetGain = trackGainOf(target);
	const targetPan = trackPanOf(target);
	const audible = clips.filter(
		(segment) =>
			assetFor(assets, segment).hasAudio && clipHeard(parent, segment)
	);
	if (audible.length > 0 && !isTrackAudible(parent, placement.track)) {
		throw new Error(
			"The track that would hold the nested sequence is muted or excluded by solo while selected clips are audible. Unmute it first."
		);
	}
	const audibleTracks = new Set(audible.map((segment) => segment.track));
	const tracks = [...new Set(clips.map((segment) => segment.track))].sort(
		(a, b) => a - b
	);
	return tracks.map((track) => {
		const setting = trackSettingFor(parent, track);
		const index = track - placement.minTrack;
		const gain = trackGainOf(setting) - targetGain;
		const pan = trackPanOf(setting);
		if (audibleTracks.has(track)) {
			if (gain < -60 || gain > 12) {
				throw new Error(
					"The selected tracks' gain differs too much from the sequence clip's track to nest. Even out the track gain first."
				);
			}
			if (targetPan !== 0 && Math.abs(pan - targetPan) > EPSILON) {
				throw new Error(
					"The selected tracks are panned differently from the sequence clip's track. Even out the track pan first."
				);
			}
		}
		const childGain = Math.min(12, Math.max(-60, gain));
		const childPan = targetPan === 0 ? pan : 0;
		const named = parent.trackSettings.some((item) => item.track === track);
		return {
			locked: false,
			muted: !isTrackAudible(parent, track),
			name:
				named && setting.name !== defaultTrackName(track)
					? setting.name
					: defaultTrackName(index),
			solo: false,
			track: index,
			...(trackHiddenOf(setting) ? { hidden: true } : {}),
			...(setting.syncLocked === undefined
				? {}
				: { syncLocked: setting.syncLocked }),
			...(setting.height ? { height: setting.height } : {}),
			...(Math.abs(childGain) > EPSILON ? { gainDb: childGain } : {}),
			...(Math.abs(childPan) > EPSILON ? { pan: childPan } : {}),
		};
	});
}

/**
 * Titles and graphics fully inside the span whose stacking a move into the
 * child cannot change. In the parent they draw above every clip track; in the
 * child they draw inside the sequence clip. An item stays in the parent when
 * anything left there that it used to cover overlaps it in time: unselected
 * video or image clips, adjustment layers at or above the sequence track,
 * avatars, stage objects, meshes, or another title or graphic that stays.
 */
function movableOverlays(
	parent: Project,
	assets: readonly Asset[],
	scope: { exclude: ReadonlySet<string>; span: Span; track: number }
): { graphics: Graphic[]; titles: Title[] } {
	const fixed: Span[] = [
		...parent.segments
			.filter(
				(segment) =>
					!scope.exclude.has(segment.id) && isVisualClip(assets, segment)
			)
			.map((segment) => ({ end: clipEnd(segment), start: segment.start })),
		...(parent.adjustmentLayers ?? []).filter(
			(layer) => layer.track >= scope.track
		),
		...parent.avatars,
		...parent.spatialObjects,
		...parent.meshes,
	];
	const overlays: (Graphic | Title)[] = [...parent.titles, ...parent.graphics];
	const moving = new Set<string>(
		overlays
			.filter(
				(item) =>
					insideSpan(item, scope.span.start, scope.span.end) &&
					!fixed.some((other) => overlaps(item, other))
			)
			.map((item) => item.id)
	);
	let changed = true;
	while (changed) {
		changed = false;
		const staying = overlays.filter((item) => !moving.has(item.id));
		for (const item of overlays) {
			if (
				moving.has(item.id) &&
				staying.some((other) => overlaps(item, other))
			) {
				moving.delete(item.id);
				changed = true;
			}
		}
	}
	return {
		graphics: parent.graphics.filter((item) => moving.has(item.id)),
		titles: parent.titles.filter((item) => moving.has(item.id)),
	};
}

/**
 * Plan a nest: validate the selection, pick the parent track for the
 * sequence clip (the lowest selected video or image track, or the first free
 * track above it), and build the child project.
 */
export function planNest(
	parent: Project,
	assets: readonly Asset[],
	input: NestInput,
	options: NestIdOptions = {}
): NestPlan {
	const clips = requireSelection(parent, input.clipIds);
	if (clips.length === 0) {
		throw new Error("Select clips to nest.");
	}
	assertNestable(parent, clips);
	const visual = clips.filter(
		(segment) => placementKindOf(assetFor(assets, segment).kind) === "visual"
	);
	if (visual.length === 0) {
		throw new Error("Select at least one video or image clip to nest.");
	}
	const start = Math.min(...clips.map((segment) => segment.start));
	const end = Math.max(...clips.map(clipEnd));
	if (end - start <= EPSILON) {
		throw new Error("The selected clips have no duration to nest.");
	}
	const minTrack = Math.min(...clips.map((segment) => segment.track));
	const lowestVisual = Math.min(...visual.map((segment) => segment.track));
	const highestVisual = Math.max(...visual.map((segment) => segment.track));
	const exclude = new Set(clips.map((segment) => segment.id));
	const track = firstFreeTrack(parent, start, end, {
		assets,
		exclude,
		from: lowestVisual,
		kind: "visual",
	});
	if (track === undefined) {
		throw new Error(
			"No free, unlocked video track can hold the nested sequence clip."
		);
	}
	const span: Span = { end, start };
	assertLayersKept(parent, assets, {
		exclude,
		highest: Math.max(track, highestVisual),
		lowest: lowestVisual,
		span,
	});
	const trackSettings = childTrackSettings(parent, assets, clips, {
		minTrack,
		track,
	});
	const { graphics, titles } = movableOverlays(parent, assets, {
		exclude,
		span,
		track,
	});
	const segments = sortSegments(
		dropUncoveredRevealTransitions(
			dissolveOrphanedLinkGroups(
				clips.map((segment) => ({
					...segment,
					start: segment.start - start,
					track: segment.track - minTrack,
				}))
			)
		)
	);
	const title = input.title?.trim() || nestedTitle(parent);
	const blank = newProject(title);
	const child = validateProject(
		{
			...blank,
			background: parent.background,
			captionStyle: parent.captionStyle,
			exportCodec: parent.exportCodec,
			exportPreset: parent.exportPreset,
			fps: parent.fps,
			graphics: graphics.map((graphic) => shiftOverlay(graphic, -start)),
			height: parent.height,
			id: options.mintId?.() ?? blank.id,
			requireApproval: parent.requireApproval,
			segments,
			speakers: parent.speakers,
			styleProfile: parent.styleProfile,
			titles: titles.map((item) => shiftOverlay(item, -start)),
			trackSettings,
			updatedAt: options.now ?? blank.updatedAt,
			width: parent.width,
		},
		[...assets]
	);
	return {
		child,
		clipIds: clips.map((segment) => segment.id),
		end,
		graphicIds: graphics.map((graphic) => graphic.id),
		start,
		titleIds: titles.map((item) => item.id),
		track,
	};
}

/**
 * Replace a planned selection with one clip of the rendered sequence asset
 * and remove the overlays that moved into the child.
 */
export function applyNest(
	parent: Project,
	assets: readonly Asset[],
	plan: NestPlan,
	sequence: Asset,
	options: NestIdOptions = {}
): { clipId: string; project: Project } {
	if (!sequence.sequenceProjectId) {
		throw new Error("The nested media is not a sequence asset.");
	}
	const span = plan.end - plan.start;
	const length = Math.min(sequence.duration, span);
	if (length <= EPSILON) {
		throw new Error("The nested sequence rendered no picture.");
	}
	const clip: Segment = {
		...newSegment(sequence, plan.start, plan.track),
		id: options.mintId?.() ?? crypto.randomUUID(),
		sourceOut: length,
	};
	const moved = new Set(plan.clipIds);
	const titles = new Set(plan.titleIds);
	const graphics = new Set(plan.graphicIds);
	const segments = sortSegments(
		dropUncoveredRevealTransitions(
			dissolveOrphanedLinkGroups([
				...parent.segments.filter((segment) => !moved.has(segment.id)),
				clip,
			])
		)
	);
	const library = assets.some((asset) => asset.id === sequence.id)
		? [...assets]
		: [...assets, sequence];
	return {
		clipId: clip.id,
		project: validateProject(
			{
				...parent,
				graphics: parent.graphics.filter((item) => !graphics.has(item.id)),
				segments,
				titles: parent.titles.filter((item) => !titles.has(item.id)),
			},
			library
		),
	};
}

interface Window {
	in: number;
	out: number;
}

function clipToWindow(
	segment: Segment,
	assets: readonly Asset[],
	window: Window
): Segment | undefined {
	const overlap =
		Math.min(clipEnd(segment), window.out) - Math.max(segment.start, window.in);
	if (overlap <= EPSILON) {
		return undefined;
	}
	const source = assetFor(assets, segment);
	const limit = Math.max(source.duration, segment.sourceOut);
	let next = segment;
	const head = window.in - next.start;
	const keepsHead = head <= EPSILON;
	if (!keepsHead) {
		next = trimSegment(next, limit, "start", head);
	}
	const tail = clipEnd(next) - window.out;
	const keepsTail = tail <= EPSILON;
	if (!keepsTail) {
		next = trimSegment(next, limit, "end", -tail);
	}
	// A reveal, fade, entry animation, or exit cut off by the window never
	// played in the sequence clip, so only the edges the window keeps carry
	// them (the same fit `splitSegment` gives its halves).
	next = fitCutPiece(segment, next, keepsHead, keepsTail);
	// Trimming keeps a minimum source length; a copy that would reach outside
	// the kept range is a sliver the user trimmed away, so it is dropped.
	if (
		next.start < window.in - EPSILON ||
		clipEnd(next) > window.out + EPSILON
	) {
		return undefined;
	}
	return next;
}

type OverlayKey = "graphics" | "titles";

function overlaysInWindow<Item extends Graphic | Title>(
	child: Project,
	kind: OverlayKey,
	window: Window
): Item[] {
	const minimum = minOverlayDuration(child.fps);
	const items: readonly (Graphic | Title)[] = child[kind];
	const kept: Item[] = [];
	for (const item of items) {
		const overlap =
			Math.min(item.end, window.out) - Math.max(item.start, window.in);
		if (overlap < minimum - EPSILON) {
			continue;
		}
		let working = child;
		if (item.start < window.in - EPSILON) {
			working = trimOverlay(working, {
				edge: "start",
				id: item.id,
				kind,
				time: window.in,
			});
		}
		if (item.end > window.out + EPSILON) {
			working = trimOverlay(working, {
				edge: "end",
				id: item.id,
				kind,
				time: window.out,
			});
		}
		const trimmed = (working[kind] as readonly (Graphic | Title)[]).find(
			(candidate) => candidate.id === item.id
		);
		if (trimmed) {
			kept.push(trimmed as Item);
		}
	}
	return kept;
}

function kindOnTrack(
	project: Project,
	assets: readonly Asset[],
	track: number,
	exclude: string
): PlacementKind | undefined {
	for (const segment of project.segments) {
		if (segment.track !== track || segment.id === exclude) {
			continue;
		}
		const asset = assets.find((candidate) => candidate.id === segment.assetId);
		if (asset) {
			return placementKindOf(asset.kind);
		}
	}
	return undefined;
}

/** Whether a decomposed copy plays audio of its own (before track state). */
function copyAudible(assets: readonly Asset[], segment: Segment): boolean {
	const asset = assetFor(assets, segment);
	return (
		(asset.kind === "audio" || asset.hasAudio) &&
		!segment.muted &&
		!segment.hidden
	);
}

/**
 * Carry the child track's effective state onto a copy of one of its clips:
 * mute when the child track is muted or excluded by solo, hide when it is
 * hidden, and fold its gain into the clip volume and its pan into the clip
 * pan. The sequence clip's own mute and hide carry over the same way.
 * Throws when the track mix cannot be represented on the clip.
 */
function withChildTrackState(
	child: Project,
	assets: readonly Asset[],
	segment: Segment,
	sequence: { audible: boolean; visible: boolean }
): Segment {
	const setting = trackSettingFor(child, segment.track);
	let next = segment;
	if (trackHiddenOf(setting) || !sequence.visible) {
		next = { ...next, hidden: true };
	}
	if (!(isTrackAudible(child, segment.track) && sequence.audible)) {
		next = { ...next, muted: true };
	}
	if (!clipHeard(child, next)) {
		return next;
	}
	const gainDb = trackGainOf(setting);
	if (Math.abs(gainDb) > EPSILON) {
		const gain = dbToGain(gainDb);
		const volume = next.volume * gain;
		const keyframes = next.keyframes.map((keyframe) =>
			keyframe.property === "volume" && keyframe.target === undefined
				? { ...keyframe, value: keyframe.value * gain }
				: keyframe
		);
		if (
			volume > 4 + EPSILON ||
			keyframes.some(
				(keyframe) =>
					keyframe.property === "volume" &&
					keyframe.target === undefined &&
					keyframe.value > 4 + EPSILON
			)
		) {
			throw new Error(
				"A nested track's gain would push a clip above the maximum volume. Lower the nested track gain first."
			);
		}
		next = { ...next, keyframes, volume: Math.min(4, volume) };
	}
	const pan = trackPanOf(setting);
	if (Math.abs(pan) > EPSILON) {
		const panned =
			Math.abs(next.pan ?? 0) > EPSILON ||
			(next.channelMode !== undefined && next.channelMode !== "stereo") ||
			next.keyframes.some((keyframe) => keyframe.property === "pan");
		if (panned) {
			throw new Error(
				"A nested track is panned and so is one of its clips. Center the nested track pan first."
			);
		}
		next = { ...next, pan };
	}
	return next;
}

function placementOffset(
	parent: Project,
	assets: readonly Asset[],
	copies: readonly Segment[],
	exclude: string
): number {
	if (copies.length === 0) {
		return 0;
	}
	const lowest = Math.min(...copies.map((segment) => segment.track));
	const highest = Math.max(...copies.map((segment) => segment.track));
	const excluded = new Set([exclude]);
	for (
		let delta = Math.max(0, -lowest);
		highest + delta <= MAX_TRACK_INDEX;
		delta += 1
	) {
		const fits = copies.every((segment) => {
			const track = segment.track + delta;
			const kind = placementKindOf(assetFor(assets, segment).kind);
			const existing = kindOnTrack(parent, assets, track, exclude);
			return (
				trackAcceptsClips(parent, track) &&
				(!copyAudible(assets, segment) || isTrackAudible(parent, track)) &&
				trackFreeOver(
					parent,
					track,
					segment.start,
					clipEnd(segment),
					excluded
				) &&
				(existing === undefined || existing === kind)
			);
		});
		if (fits) {
			return delta;
		}
	}
	throw new Error(
		"No free, unlocked, audible tracks can hold the decomposed clips. Free, unlock, or unmute tracks first."
	);
}

/**
 * Expand a sequence clip back into the child project's clips, titles, and
 * graphics. Only the part of the child inside the clip's source range comes
 * back, trimmed to it and placed at `clip.start - clip.sourceIn`. Tracks are
 * anchored so the child's lowest video track lands on the sequence clip's
 * track, moving up as a block when those tracks are taken.
 */
export function decomposeSequence(
	parent: Project,
	assets: readonly Asset[],
	child: Project,
	clipId: string,
	options: NestIdOptions = {}
): DecomposeResult {
	const mint = options.mintId ?? (() => crypto.randomUUID());
	const clip = parent.segments.find((segment) => segment.id === clipId);
	if (!clip) {
		throw new Error("The sequence clip is not on the timeline.");
	}
	const sequence = assetFor(assets, clip);
	if (!sequence.sequenceProjectId) {
		throw new Error("This clip is not a nested sequence.");
	}
	if (sequence.sequenceProjectId !== child.id) {
		throw new Error("The nested project does not match this sequence clip.");
	}
	if (trackSettingFor(parent, clip.track).locked) {
		throw new Error("Unlock the clip track before decomposing it.");
	}
	if (Math.abs(clip.speed - 1) > EPSILON) {
		throw new Error(
			"Reset the sequence clip speed to 100% before decomposing it."
		);
	}
	if (clip.multicamGroupId) {
		throw new Error("Ungroup the multicam session before decomposing.");
	}
	const window: Window = { in: clip.sourceIn, out: clip.sourceOut };
	const offset = clip.start - clip.sourceIn;
	const state = {
		audible: clipAudible(parent, clip),
		visible: clipVisible(parent, clip),
	};
	const speakers = new Set((parent.speakers ?? []).map((item) => item.id));
	const links = new Map<string, string>();
	const placed: Segment[] = [];
	for (const segment of child.segments) {
		const cut = clipToWindow(segment, assets, window);
		if (!cut) {
			continue;
		}
		const trimmed = withChildTrackState(child, assets, cut, state);
		let linkGroupId: string | undefined;
		if (trimmed.linkGroupId) {
			linkGroupId = links.get(trimmed.linkGroupId) ?? mint();
			links.set(trimmed.linkGroupId, linkGroupId);
		}
		const copy: Segment = {
			...trimmed,
			id: mint(),
			linkGroupId,
			start: trimmed.start + offset,
		};
		if (copy.speakerId !== undefined && !speakers.has(copy.speakerId)) {
			copy.speakerId = undefined;
		}
		placed.push(copy);
	}
	const titles = overlaysInWindow<Title>(child, "titles", window).map(
		(item) => ({ ...shiftOverlay(item, offset), id: mint() })
	);
	const graphics = overlaysInWindow<Graphic>(child, "graphics", window).map(
		(item) => ({ ...shiftOverlay(item, offset), id: mint() })
	);
	if (placed.length + titles.length + graphics.length === 0) {
		throw new Error("The sequence clip's range holds nothing to decompose.");
	}
	const visual = placed.filter(
		(segment) => placementKindOf(assetFor(assets, segment).kind) === "visual"
	);
	const anchor = Math.min(
		...(visual.length ? visual : placed).map((segment) => segment.track),
		Number.POSITIVE_INFINITY
	);
	const base = Number.isFinite(anchor) ? clip.track - anchor : clip.track;
	const anchored = placed.map((segment) => ({
		...segment,
		track: segment.track + base,
	}));
	const trackDelta = placementOffset(parent, assets, anchored, clip.id);
	const copies = anchored.map((segment) => ({
		...segment,
		track: segment.track + trackDelta,
	}));
	// An avatar pinned to the sequence clip keeps the sequence media and
	// loses only the clip pin, as a clip delete does.
	const project = validateProject(
		unpinRemovedLipSyncClips({
			...parent,
			graphics: [...parent.graphics, ...graphics],
			segments: sortSegments(
				dropUncoveredRevealTransitions(
					dissolveOrphanedLinkGroups([
						...parent.segments.filter((segment) => segment.id !== clip.id),
						...copies,
					])
				)
			),
			titles: [...parent.titles, ...titles],
		}),
		[...assets]
	);
	return {
		clipIds: copies.map((segment) => segment.id),
		graphicIds: graphics.map((item) => item.id),
		project,
		titleIds: titles.map((item) => item.id),
		trackDelta,
	};
}
