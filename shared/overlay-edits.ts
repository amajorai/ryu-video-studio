import { z } from "zod";
import { type KeyframeCurve, keyframeCurve, subCurve } from "./animation.ts";
import { easedProgress } from "./keyframe-easing.ts";
import {
	type Asset,
	type Avatar,
	activeCaptions,
	type Caption,
	type Graphic,
	type Project,
	type Title,
	validateProject,
	withActiveCaptions,
} from "./project.ts";
import type { AdjustmentLayer } from "./schema/adjustment.ts";
import type { Keyframe } from "./schema/keyframe.ts";
import { idSchema, timeSchema } from "./schema/primitives.ts";
import { overlayLaneSchema } from "./schema/text-style.ts";
import {
	collectSnapTargets,
	quantizeToFrame,
	type SnapResult,
	type SnapTarget,
	snap,
} from "./timeline-snap.ts";

/**
 * Timing edits for the items that sit above the clip tracks: titles,
 * graphics, avatars, adjustment layers, and the captions of the active
 * caption track. Every function is pure and deterministic apart from the
 * fresh ids a duplicate mints; `editOverlay` validates the result as one
 * project edit.
 */

/** Projects are limited to two hours. */
export const OVERLAY_TIMELINE_LIMIT = 7200;
/** Overlay lanes a title or graphic can sit on (`lane` 0..7). */
export const OVERLAY_LANE_COUNT = (overlayLaneSchema.maxValue ?? 7) + 1;

export const overlayKindSchema = z.enum([
	"titles",
	"graphics",
	"captions",
	"avatars",
	"adjustmentLayers",
]);
export type OverlayKind = z.infer<typeof overlayKindSchema>;

/** Kinds that carry an explicit `lane`. */
export const LANED_OVERLAY_KINDS: ReadonlySet<OverlayKind> = new Set([
	"titles",
	"graphics",
]);

export interface OverlayRef {
	id: string;
	kind: OverlayKind;
}

/** The timing every overlay item shares. */
export interface OverlayTiming {
	end: number;
	id: string;
	start: number;
}

/** The lane a title or graphic sits on; items without one use lane 0. */
export const overlayLaneOf = (item: { lane?: number }): number =>
	item.lane ?? 0;

/** Shortest overlay an edit can leave: one frame of the project. */
export function minOverlayDuration(fps: number): number {
	return Number.isFinite(fps) && fps > 0 ? 1 / fps : 1 / 30;
}

/** Items of one overlay kind; captions come from the active caption track. */
export function overlayItemsOf(
	project: Project,
	kind: OverlayKind
): readonly OverlayTiming[] {
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

/** The overlay `ref` names, or `undefined` when it is not in the project. */
export function findOverlay(
	project: Project,
	ref: OverlayRef
): OverlayTiming | undefined {
	return overlayItemsOf(project, ref.kind).find((item) => item.id === ref.id);
}

function requireOverlay(project: Project, ref: OverlayRef): OverlayTiming {
	const item = findOverlay(project, ref);
	if (!item) {
		throw new Error("Overlay item not found.");
	}
	return item;
}

/** Replace the items of one overlay kind, keeping the project otherwise intact. */
function withOverlayItems(
	project: Project,
	kind: OverlayKind,
	map: (items: readonly OverlayTiming[]) => OverlayTiming[]
): Project {
	switch (kind) {
		case "titles":
			return { ...project, titles: map(project.titles) as Title[] };
		case "graphics":
			return { ...project, graphics: map(project.graphics) as Graphic[] };
		case "avatars":
			return { ...project, avatars: map(project.avatars) as Avatar[] };
		case "adjustmentLayers":
			return {
				...project,
				adjustmentLayers: map(
					project.adjustmentLayers ?? []
				) as AdjustmentLayer[],
			};
		case "captions":
			return withActiveCaptions(
				project,
				(map(activeCaptions(project)) as Caption[]).sort(
					(a, b) => a.start - b.start
				)
			);
		default:
			return project;
	}
}

function replaceOverlay(
	project: Project,
	ref: OverlayRef,
	next: OverlayTiming
): Project {
	return withOverlayItems(project, ref.kind, (items) =>
		items.map((item) => (item.id === ref.id ? next : item))
	);
}

const roundTime = (value: number) => Number(value.toFixed(6));
/** Largest 6-decimal time that does not exceed `value`. */
function floorTime(value: number): number {
	let time = roundTime(value);
	while (time > value) {
		time = roundTime(time - 1e-6);
	}
	return Math.max(0, time);
}
/**
 * End time for an item of `duration` placed at `start`, nudged so that
 * `end - start` never comes out below `duration` in floating point (item
 * validation compares fades and keyframes against that difference).
 */
function endFor(start: number, duration: number): number {
	let end = start + duration;
	while (end - start < duration) {
		end += Number.EPSILON * Math.max(1, end);
	}
	return end;
}

/**
 * Place an item of `duration` at `start`, pulled back just far enough that
 * its end never passes the two-hour limit, even after the floating-point
 * nudge in `endFor` (time validation caps every time at the limit).
 */
function placeOnTimeline(
	start: number,
	duration: number
): { end: number; start: number } {
	let placed = start;
	let end = endFor(placed, duration);
	if (end <= OVERLAY_TIMELINE_LIMIT) {
		return { end, start: placed };
	}
	placed = floorTime(Math.min(start, OVERLAY_TIMELINE_LIMIT - duration));
	end = endFor(placed, duration);
	while (end > OVERLAY_TIMELINE_LIMIT && placed > 0) {
		placed = Math.max(0, roundTime(placed - 1e-6));
		end = endFor(placed, duration);
	}
	return { end: Math.min(end, OVERLAY_TIMELINE_LIMIT), start: placed };
}

/* ------------------------------------------------------------------ */
/* Snapping                                                            */
/* ------------------------------------------------------------------ */

export interface OverlaySnapOptions {
	/** Timeline zoom, used to turn the pixel threshold into seconds. */
	pxPerSec: number;
	/** I/O range edges also capture when given. */
	range?: { end: number; start: number } | null;
	/** Pointer capture distance; defaults to the timeline-snap threshold. */
	thresholdPx?: number;
	/** Playhead; captures when given. */
	time?: number | null;
}

function overlayTargets(
	project: Project,
	ref: OverlayRef,
	options: OverlaySnapOptions
): SnapTarget[] {
	return collectSnapTargets(project, {
		exclude: new Set([ref.id]),
		range: options.range ?? null,
		time: options.time ?? null,
	});
}

/** The better of two captured snaps: lower priority, then the nearer one. */
function betterSnap(
	first: { distance: number; result: SnapResult },
	second: { distance: number; result: SnapResult }
): "first" | "second" | null {
	const a = first.result.target;
	const b = second.result.target;
	if (!(a || b)) {
		return null;
	}
	if (!b) {
		return "first";
	}
	if (!a) {
		return "second";
	}
	if (a.priority !== b.priority) {
		return a.priority < b.priority ? "first" : "second";
	}
	return first.distance <= second.distance ? "first" : "second";
}

/**
 * Snap a moved overlay: its start or its end sticks to the best target in
 * range (the item keeps its duration); otherwise the start lands on the
 * frame grid.
 */
export function snapOverlayStart(
	project: Project,
	ref: OverlayRef,
	start: number,
	duration: number,
	options: OverlaySnapOptions
): number {
	const targets = overlayTargets(project, ref, options);
	const snapOptions = {
		fps: project.fps,
		pxPerSec: options.pxPerSec,
		thresholdPx: options.thresholdPx,
	};
	const head = snap(start, targets, snapOptions);
	const tail = snap(start + duration, targets, snapOptions);
	const winner = betterSnap(
		{ distance: Math.abs(head.time - start), result: head },
		{ distance: Math.abs(tail.time - (start + duration)), result: tail }
	);
	if (winner === "second") {
		return tail.time - duration;
	}
	return winner === "first" ? head.time : quantizeToFrame(start, project.fps);
}

/** Snap one trimmed edge of an overlay to the best target or the frame grid. */
export function snapOverlayEdge(
	project: Project,
	ref: OverlayRef,
	time: number,
	options: OverlaySnapOptions
): number {
	return snap(time, overlayTargets(project, ref, options), {
		fps: project.fps,
		pxPerSec: options.pxPerSec,
		thresholdPx: options.thresholdPx,
	}).time;
}

/* ------------------------------------------------------------------ */
/* Move                                                                */
/* ------------------------------------------------------------------ */

export interface MoveOverlayInput extends OverlayRef {
	/** Titles and graphics only: the overlay lane to land on. */
	lane?: number;
	start: number;
}

/** Shift word timings with their cue, kept inside the cue. */
function shiftCaptionWords(caption: Caption, shift: number): Caption {
	if (!caption.words) {
		return caption;
	}
	return {
		...caption,
		words: caption.words.map((word) => ({
			...word,
			end: Math.min(caption.end, word.end + shift),
			start: Math.max(caption.start, word.start + shift),
		})),
	};
}

function withLane(
	item: OverlayTiming & { lane?: number },
	lane: number
): OverlayTiming {
	if (item.lane === undefined && lane === 0) {
		return item;
	}
	return { ...item, lane } as OverlayTiming;
}

/**
 * Move an overlay so it starts at `start` (clamped to the timeline) with
 * its duration unchanged. Keyframes are item-relative and travel with it;
 * caption word timings shift with their cue. `lane` re-stacks a title or
 * graphic; other kinds have no lanes and refuse one.
 */
export function moveOverlay(
	project: Project,
	input: MoveOverlayInput,
	options: { snap?: OverlaySnapOptions } = {}
): Project {
	const item = requireOverlay(project, input);
	if (input.lane !== undefined && !LANED_OVERLAY_KINDS.has(input.kind)) {
		throw new Error("Only titles and graphics sit on overlay lanes.");
	}
	if (input.lane !== undefined) {
		overlayLaneSchema.parse(input.lane);
	}
	const duration = item.end - item.start;
	const wanted = options.snap
		? snapOverlayStart(project, input, input.start, duration, options.snap)
		: input.start;
	const clamped = Math.min(
		Math.max(0, wanted),
		OVERLAY_TIMELINE_LIMIT - duration
	);
	const placed =
		clamped === item.start
			? { end: item.end, start: item.start }
			: placeOnTimeline(clamped, duration);
	const shift = placed.start - item.start;
	let next: OverlayTiming = shift === 0 ? item : { ...item, ...placed };
	if (input.kind === "captions") {
		next = shiftCaptionWords(next as Caption, shift);
	}
	if (input.lane !== undefined) {
		next = withLane(next, input.lane);
	}
	if (next === item) {
		return project;
	}
	return replaceOverlay(project, input, next);
}

/* ------------------------------------------------------------------ */
/* Trim                                                                */
/* ------------------------------------------------------------------ */

export type OverlayEdge = "start" | "end";

export interface TrimOverlayInput extends OverlayRef {
	edge: OverlayEdge;
	/** Timeline time the edge moves to. */
	time: number;
}

const groupKey = (frame: Pick<Keyframe, "property" | "target">) =>
	`${frame.property}\u0000${frame.target ?? ""}`;

/**
 * Value of one keyframe channel (frames of one property and target, sorted
 * by time) at item-relative time `at`, eased the way
 * `animatedValue` eases clip keyframes: each interval follows the curve of
 * the keyframe that starts it (hold keeps that keyframe's value). Before the
 * first keyframe the channel holds the first value; after the last, the last.
 */
export function overlayChannelValue(
	sorted: readonly Keyframe[],
	at: number
): number {
	const first = sorted[0];
	if (!first) {
		return 0;
	}
	if (at <= first.time) {
		return first.value;
	}
	let previous = first;
	for (const next of sorted.slice(1)) {
		if (at <= next.time) {
			const span = next.time - previous.time;
			const fraction = span > 0 ? (at - previous.time) / span : 1;
			const kind = previous.interpolation ?? "linear";
			if (kind !== "linear" && fraction >= 1) {
				return next.value;
			}
			const progress =
				kind === "linear"
					? fraction
					: easedProgress(kind, fraction, previous.bezier);
			return previous.value + (next.value - previous.value) * progress;
		}
		previous = next;
	}
	return previous.value;
}

/** The original interval that item-relative time `at` falls in. */
function intervalAround(
	sorted: readonly Keyframe[],
	at: number
): { a: Keyframe; b: Keyframe } | undefined {
	for (let i = 0; i + 1 < sorted.length; i++) {
		const a = sorted[i] as Keyframe;
		const b = sorted[i + 1] as Keyframe;
		if (at >= a.time - 1e-9 && at < b.time - 1e-9) {
			return { a, b };
		}
	}
	return undefined;
}

/** Write `curve` onto a keyframe; implicit linear stays implicit. */
function withKeyframeCurve(frame: Keyframe, curve: KeyframeCurve): Keyframe {
	const { bezier: _bezier, interpolation: _interpolation, ...rest } = frame;
	if (curve.kind === "linear" && frame.interpolation === undefined) {
		return rest;
	}
	return curve.kind === "bezier" && curve.bezier
		? { ...rest, bezier: curve.bezier, interpolation: curve.kind }
		: { ...rest, interpolation: curve.kind };
}

interface PlacedKeyframe {
	frame: Keyframe;
	/** Item-relative time of this moment before the trim. */
	source: number;
}

function boundaryFrame(
	sorted: readonly Keyframe[],
	at: number,
	time: number
): Keyframe | undefined {
	const source = sorted[0];
	if (!source) {
		return undefined;
	}
	const frame: Keyframe = {
		id: crypto.randomUUID(),
		property: source.property,
		time,
		value: overlayChannelValue(sorted, at),
	};
	if (source.target !== undefined) {
		frame.target = source.target;
	}
	return frame;
}

/**
 * Give every kept keyframe the part of its original curve that now runs to
 * the next kept keyframe, so a cut eased or bezier interval keeps its shape.
 */
function refitKeyframeCurves(
	sorted: readonly Keyframe[],
	placed: readonly PlacedKeyframe[]
): Keyframe[] {
	return placed.map((entry, index) => {
		const next = placed[index + 1];
		const interval = intervalAround(sorted, entry.source);
		if (!(next && interval) || interval.a.interpolation === undefined) {
			return entry.frame;
		}
		const span = interval.b.time - interval.a.time;
		const from = (entry.source - interval.a.time) / span;
		const to = Math.min(1, (next.source - interval.a.time) / span);
		if (to - from < 1e-9) {
			return entry.frame;
		}
		const curve = keyframeCurve(interval.a);
		if (from < 1e-9 && to > 1 - 1e-9) {
			return withKeyframeCurve(entry.frame, curve);
		}
		return withKeyframeCurve(
			{ ...entry.frame, interpolation: curve.kind },
			subCurve(curve, from, to)
		);
	});
}

/**
 * Re-base item-relative keyframes after a trim: `startShift` is how far the
 * start moved (positive trims the head) and `duration` the new length.
 * Keyframes keep their timeline moment; channels that cross a new edge get
 * a boundary keyframe holding the eased value there (hold, ease, and bezier
 * curves included), and cut intervals are re-fitted to the matching part of
 * their curve, so the visible animation inside the item does not change.
 */
export function rebaseOverlayKeyframes(
	keyframes: readonly Keyframe[],
	startShift: number,
	duration: number
): Keyframe[] {
	const groups = new Map<string, Keyframe[]>();
	for (const frame of keyframes) {
		const key = groupKey(frame);
		groups.set(key, [...(groups.get(key) ?? []), frame]);
	}
	const end = floorTime(duration);
	const result: Keyframe[] = [];
	for (const frames of groups.values()) {
		const sorted = [...frames].sort((a, b) => a.time - b.time);
		const placed: PlacedKeyframe[] = [];
		const taken = (time: number) =>
			placed.some((entry) => entry.frame.time === time);
		for (const frame of sorted) {
			const shifted = frame.time - startShift;
			const time = Math.min(end, Math.max(0, roundTime(shifted)));
			if (shifted >= -1e-9 && shifted <= duration + 1e-9 && !taken(time)) {
				placed.push({ frame: { ...frame, time }, source: frame.time });
			}
		}
		const edges: [number, number][] = [
			[startShift, 0],
			[startShift + duration, end],
		];
		for (const [at, time] of edges) {
			const outside = sorted.some((frame) =>
				time === 0 ? frame.time < at : frame.time > at
			);
			if (taken(time) || !outside) {
				continue;
			}
			const boundary = boundaryFrame(sorted, at, time);
			if (boundary) {
				placed.push({ frame: boundary, source: at });
			}
		}
		placed.sort((a, b) => a.frame.time - b.frame.time);
		result.push(...refitKeyframeCurves(sorted, placed));
	}
	return result;
}

function fitTitleFades(title: Title, duration: number): Title {
	const total = title.fadeIn + title.fadeOut;
	if (total <= duration) {
		return title;
	}
	const fadeIn = floorTime(title.fadeIn * (duration / total));
	return { ...title, fadeIn, fadeOut: floorTime(duration - fadeIn - 1e-6) };
}

function trimCaptionWords(caption: Caption): Caption {
	if (!caption.words) {
		return caption;
	}
	const words = caption.words.map((word) => ({
		...word,
		end: Math.min(word.end, caption.end),
		start: Math.max(word.start, caption.start),
	}));
	// A trim that swallows a whole word drops the word alignment: the cue text
	// stays, and karaoke highlighting falls back to the whole cue.
	if (words.some((word) => word.end <= word.start)) {
		const { words: _dropped, ...rest } = caption;
		return rest;
	}
	return { ...caption, words };
}

function trimRigKeyframes(
	avatar: Avatar,
	startShift: number,
	duration: number
): Avatar {
	if (!avatar.rigKeyframes) {
		return avatar;
	}
	const seen = new Set<string>();
	const end = floorTime(duration);
	const rigKeyframes = avatar.rigKeyframes.flatMap((frame) => {
		const shifted = frame.time - startShift;
		const time = Math.min(end, Math.max(0, roundTime(shifted)));
		const key = `${frame.property}:${time}`;
		if (shifted < -1e-9 || shifted > duration + 1e-9 || seen.has(key)) {
			return [];
		}
		seen.add(key);
		return [{ ...frame, time }];
	});
	return { ...avatar, rigKeyframes };
}

/** Fit kind-specific timing (fades, entry, keyframes, words) to a trimmed item. */
function fitTrimmed(
	kind: OverlayKind,
	item: OverlayTiming,
	startShift: number
): OverlayTiming {
	const duration = item.end - item.start;
	switch (kind) {
		case "titles": {
			const title = fitTitleFades(item as Title, duration);
			if (!title.keyframes) {
				return title;
			}
			const rebased: Title = {
				...title,
				keyframes: rebaseOverlayKeyframes(
					title.keyframes,
					startShift,
					duration
				),
			};
			return rebased;
		}
		case "graphics": {
			const graphic = item as Graphic;
			const fitted: Graphic = {
				...graphic,
				entryDuration: Math.min(graphic.entryDuration, duration),
			};
			if (graphic.keyframes) {
				fitted.keyframes = rebaseOverlayKeyframes(
					graphic.keyframes,
					startShift,
					duration
				);
			}
			return fitted;
		}
		case "avatars": {
			const avatar = item as Avatar;
			return trimRigKeyframes(
				{
					...avatar,
					entryDuration: Math.min(avatar.entryDuration, duration),
				},
				startShift,
				duration
			);
		}
		case "adjustmentLayers": {
			const layer = item as AdjustmentLayer;
			if (!layer.keyframes) {
				return layer;
			}
			const rebased: AdjustmentLayer = {
				...layer,
				keyframes: rebaseOverlayKeyframes(
					layer.keyframes,
					startShift,
					duration
				),
			};
			return rebased;
		}
		case "captions":
			return trimCaptionWords(item as Caption);
		default:
			return item;
	}
}

/**
 * Move one edge of an overlay to `time`. The edge is clamped so the item
 * keeps at least one frame (`start < end`) and stays on the timeline; the
 * opposite edge never moves. Fades, entry animations, and keyframes are
 * fitted to the new span.
 */
export function trimOverlay(
	project: Project,
	input: TrimOverlayInput,
	options: { snap?: OverlaySnapOptions } = {}
): Project {
	const item = requireOverlay(project, input);
	const minimum = minOverlayDuration(project.fps);
	const wanted = options.snap
		? snapOverlayEdge(project, input, input.time, options.snap)
		: input.time;
	let start = item.start;
	let end = item.end;
	if (input.edge === "start") {
		start = Math.min(Math.max(0, wanted), item.end - minimum);
	} else {
		end = Math.max(
			Math.min(OVERLAY_TIMELINE_LIMIT, wanted),
			endFor(item.start, minimum)
		);
	}
	if (start === item.start && end === item.end) {
		return project;
	}
	const next = fitTrimmed(
		input.kind,
		{ ...item, end, start },
		start - item.start
	);
	return replaceOverlay(project, input, next);
}

/* ------------------------------------------------------------------ */
/* Delete and duplicate                                                */
/* ------------------------------------------------------------------ */

/** Remove one overlay item. */
export function deleteOverlay(project: Project, ref: OverlayRef): Project {
	requireOverlay(project, ref);
	return withOverlayItems(project, ref.kind, (items) =>
		items.filter((item) => item.id !== ref.id)
	);
}

const remintFrames = (frames: readonly Keyframe[] | undefined) =>
	frames?.map((frame) => ({ ...frame, id: crypto.randomUUID() }));

/** A copy of `item` with fresh ids at the given placement. */
function cloneOverlay(
	kind: OverlayKind,
	item: OverlayTiming,
	at: { end: number; start: number }
): OverlayTiming {
	const placed = {
		...structuredClone(item),
		end: at.end,
		id: crypto.randomUUID(),
		start: at.start,
	};
	switch (kind) {
		case "titles":
		case "graphics":
		case "adjustmentLayers": {
			const laid = placed as Title | Graphic | AdjustmentLayer;
			if (laid.keyframes) {
				laid.keyframes = remintFrames(laid.keyframes);
			}
			return laid;
		}
		case "avatars": {
			const avatar = placed as Avatar;
			if (avatar.rigKeyframes) {
				avatar.rigKeyframes = avatar.rigKeyframes.map((frame) => ({
					...frame,
					id: crypto.randomUUID(),
				}));
			}
			return avatar;
		}
		case "captions": {
			const caption = placed as Caption;
			const shift = caption.start - item.start;
			if (caption.words) {
				caption.words = caption.words.map((word) => ({
					...word,
					end: Math.min(caption.end, word.end + shift),
					id: crypto.randomUUID(),
					start: Math.max(caption.start, word.start + shift),
				}));
			}
			return caption;
		}
		default:
			return placed;
	}
}

/**
 * Duplicate an overlay item with fresh ids. The copy starts at `at`, or right
 * after the original, keeps its duration, lane, and styling, and must fit on
 * the timeline.
 */
export function duplicateOverlay(
	project: Project,
	ref: OverlayRef,
	at?: number
): { id: string; project: Project } {
	const item = requireOverlay(project, ref);
	const duration = item.end - item.start;
	const wanted = at ?? item.end;
	if (wanted + duration > OVERLAY_TIMELINE_LIMIT + 1e-9) {
		throw new Error("The duplicate would run past the two-hour limit.");
	}
	const copy = cloneOverlay(
		ref.kind,
		item,
		placeOnTimeline(
			Math.min(wanted, OVERLAY_TIMELINE_LIMIT - duration),
			duration
		)
	);
	return {
		id: copy.id,
		project: withOverlayItems(project, ref.kind, (items) => [...items, copy]),
	};
}

/* ------------------------------------------------------------------ */
/* Lane layout for the timeline                                        */
/* ------------------------------------------------------------------ */

export interface OverlayLaneItem extends OverlayRef {
	end: number;
	/** Display row inside the kind's lane group, 0 = top row. */
	row: number;
	start: number;
}

export interface OverlayLaneGroup {
	items: OverlayLaneItem[];
	kind: OverlayKind;
	/** Number of display rows (at least one). */
	rows: number;
}

/**
 * Where each overlay is drawn in the timeline lanes. Titles and graphics
 * are drawn on their stored `lane` when that row is free over their span;
 * one that would cover an earlier item on the same lane is shown on the
 * next free row below (display only, the stored lane is unchanged). Items
 * without a lane, and the other kinds, are packed into the lowest free row.
 * Overlapping items therefore never cover each other. The order is stable:
 * start time, then id.
 */
export function overlayLaneLayout(
	project: Project,
	kind: OverlayKind
): OverlayLaneGroup {
	const source = overlayItemsOf(project, kind) as readonly (OverlayTiming & {
		lane?: number;
	})[];
	const sorted = [...source].sort(
		(a, b) => a.start - b.start || a.id.localeCompare(b.id)
	);
	const occupied: OverlayTiming[][] = [];
	const occupy = (row: number, item: OverlayTiming) => {
		while (occupied.length <= row) {
			occupied.push([]);
		}
		occupied[row]?.push(item);
	};
	const free = (row: number, item: OverlayTiming) =>
		!occupied[row]?.some(
			(other) => other.start < item.end && item.start < other.end
		);
	const rowOf = new Map<string, number>();
	const laned = LANED_OVERLAY_KINDS.has(kind);
	for (const item of sorted) {
		if (laned && item.lane !== undefined) {
			let row = item.lane;
			while (!free(row, item)) {
				row += 1;
			}
			rowOf.set(item.id, row);
			occupy(row, item);
		}
	}
	for (const item of sorted) {
		if (rowOf.has(item.id)) {
			continue;
		}
		let row = 0;
		while (!free(row, item)) {
			row += 1;
		}
		rowOf.set(item.id, row);
		occupy(row, item);
	}
	return {
		items: sorted.map((item) => ({
			end: item.end,
			id: item.id,
			kind,
			row: rowOf.get(item.id) ?? 0,
			start: item.start,
		})),
		kind,
		rows: Math.max(1, occupied.length),
	};
}

/* ------------------------------------------------------------------ */
/* Request contract                                                    */
/* ------------------------------------------------------------------ */

const revisionSchema = z.number().int().nonnegative();

export const overlaySnapRequestSchema = z
	.object({
		pxPerSec: z.number().finite().positive().max(10_000),
		thresholdPx: z.number().finite().min(0).max(64).optional(),
		time: timeSchema.optional(),
	})
	.strict();

const target = {
	id: idSchema,
	kind: overlayKindSchema,
	revision: revisionSchema,
};

export const overlayEditRequestSchema = z.discriminatedUnion("op", [
	z
		.object({
			...target,
			lane: overlayLaneSchema.optional(),
			op: z.literal("move"),
			snap: overlaySnapRequestSchema.optional(),
			start: timeSchema,
		})
		.strict(),
	z
		.object({
			...target,
			edge: z.enum(["start", "end"]),
			op: z.literal("trim"),
			snap: overlaySnapRequestSchema.optional(),
			time: timeSchema,
		})
		.strict(),
	z.object({ ...target, op: z.literal("delete") }).strict(),
	z
		.object({
			...target,
			at: timeSchema.optional(),
			op: z.literal("duplicate"),
		})
		.strict(),
]);
export type OverlayEditRequest = z.input<typeof overlayEditRequestSchema>;
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
	? Omit<T, K>
	: never;
/** An overlay edit without the revision, as the editor applies it locally. */
export type OverlayEdit = DistributiveOmit<OverlayEditRequest, "revision">;

export interface OverlayEditResult {
	/** The edited item, or the new copy for `duplicate`; absent for `delete`. */
	id?: string;
	project: Project;
}

/**
 * Apply one overlay edit (move, trim, delete, duplicate) and validate the
 * project. `snap` turns on timeline snapping with the given zoom.
 */
export function editOverlay(
	project: Project,
	assets: readonly Asset[],
	edit: OverlayEdit
): OverlayEditResult {
	const request = overlayEditRequestSchema.parse({ ...edit, revision: 0 });
	const ref: OverlayRef = { id: request.id, kind: request.kind };
	// A move or trim that changes nothing hands back the input project, so
	// callers can skip recording an empty undo step.
	const validated = (next: Project) =>
		next === project ? project : validateProject(next, [...assets]);
	switch (request.op) {
		case "move":
			return {
				id: ref.id,
				project: validated(
					moveOverlay(
						project,
						{ ...ref, lane: request.lane, start: request.start },
						{ snap: request.snap }
					)
				),
			};
		case "trim":
			return {
				id: ref.id,
				project: validated(
					trimOverlay(
						project,
						{ ...ref, edge: request.edge, time: request.time },
						{ snap: request.snap }
					)
				),
			};
		case "delete":
			return { project: validated(deleteOverlay(project, ref)) };
		case "duplicate": {
			const result = duplicateOverlay(project, ref, request.at);
			return { id: result.id, project: validated(result.project) };
		}
		default:
			return { project };
	}
}
