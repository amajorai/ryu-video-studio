/**
 * Motion tracking (W4-M4): the request contract, the clip/canvas geometry
 * that turns a tracked source path into canvas motion, keyframe decimation,
 * and the edit that applies a path to a title, a graphic, another clip (for
 * example a sticker) or a new blur/mosaic adjustment layer.
 *
 * The tracker itself (`sidecar/src/tracker.ts`) works in source pixels. It
 * reports one `TrackSample` per analysed frame: the timeline time, the
 * tracked center as fractions of the source frame, and the size relative to
 * the region at the start. Everything here is pure and deterministic apart
 * from the fresh ids the region layer mints (`mintId`).
 */
import { z } from "zod";
import { editAdjustmentLayers, roundAdjustmentTime } from "./adjustment.ts";
import { animatedValue } from "./animation.ts";
import type { Effect } from "./effects.ts";
import {
	type FrameSize,
	frameToLocalPx,
	localToFramePx,
	type Point,
	pixelToNormalized,
	segmentPlacement,
} from "./preview-geometry.ts";
import {
	type Asset,
	type Graphic,
	type Keyframe,
	type Project,
	type Segment,
	segmentDuration,
	type Title,
	trackSettingFor,
	validateProject,
} from "./project.ts";
import type { AdjustmentLayer } from "./schema/adjustment.ts";
import type { KeyframeProperty } from "./schema/keyframe.ts";
import type { Mask } from "./schema/mask.ts";
import { bounded, idSchema, timeSchema } from "./schema/primitives.ts";
import { graphicAnimatedValue } from "./shape-geometry.ts";
import { titleKeyValue } from "./text-animation.ts";
import { trackedSourceOf } from "./tracked-layers.ts";

/** Longest stretch of timeline one request tracks, in seconds. */
export const MAX_TRACK_SECONDS = 120;
/** Smallest region side, as a fraction of the frame. */
export const MIN_TRACK_REGION = 0.01;
/** Keyframes an overlay or clip may hold (the schema bound). */
export const MAX_TARGET_KEYFRAMES = 200;
/** Decimation tolerance: canvas fraction (about 2 px on a 1080p canvas). */
export const DEFAULT_TRACK_TOLERANCE = 0.001;
/** Scale error allowed by decimation, as a fraction of the scale. */
const SCALE_TOLERANCE_FACTOR = 2;
/** Feather of the region mask, so the blur edge is soft. */
export const REGION_MASK_FEATHER = 0.02;

export const trackRegionKindSchema = z.enum(["blur", "mosaic"]);
export type TrackRegionKind = z.infer<typeof trackRegionKindSchema>;

export const trackTargetKindSchema = z.enum(["title", "graphic", "clip"]);
export type TrackTargetKind = z.infer<typeof trackTargetKindSchema>;

/** What follows the tracked subject. */
export const trackTargetSchema = z.union([
	z.object({ kind: trackTargetKindSchema, id: idSchema }).strict(),
	z.object({ createRegion: trackRegionKindSchema }).strict(),
]);
export type TrackTarget = z.infer<typeof trackTargetSchema>;

/**
 * A rectangle, top-left `x`/`y` plus `width`/`height`, as fractions of the
 * frame it is drawn on (the canvas, or the clip's source frame).
 */
export const trackRegionSchema = z
	.object({
		x: bounded(0, 1),
		y: bounded(0, 1),
		width: bounded(MIN_TRACK_REGION, 1),
		height: bounded(MIN_TRACK_REGION, 1),
	})
	.strict()
	.refine(
		(region) =>
			region.x + region.width <= 1 + 1e-9 &&
			region.y + region.height <= 1 + 1e-9,
		"The region must lie inside the frame."
	);
export type TrackRegion = z.infer<typeof trackRegionSchema>;

export const trackRegionSpaceSchema = z.enum(["canvas", "source"]);
export type TrackRegionSpace = z.infer<typeof trackRegionSpaceSchema>;

/** `POST /projects/:id/track`. */
export const trackRequestSchema = z
	.object({
		/** The video clip whose pixels are tracked. */
		clipId: idSchema,
		/** Project time of the frame the region is drawn on. */
		time: timeSchema,
		roi: trackRegionSchema,
		/** Absent means `canvas`: the region as the preview shows it. */
		roiSpace: trackRegionSpaceSchema.optional(),
		/** Seconds to track from `time`; absent tracks to the clip end. */
		duration: bounded(0.05, MAX_TRACK_SECONDS).optional(),
		target: trackTargetSchema,
		revision: z.number().int().nonnegative(),
	})
	.strict();
export type TrackRequest = z.infer<typeof trackRequestSchema>;

/** One analysed frame of a tracked path. */
export interface TrackSample {
	/** Tracker score in `0..1` (normalized cross-correlation, floored at 0). */
	confidence: number;
	/** Size relative to the region at the start frame. */
	scale: number;
	/** Project time in seconds. */
	time: number;
	/** Center as a fraction of the source frame width. */
	x: number;
	/** Center as a fraction of the source frame height. */
	y: number;
}

/** The timeline span a request tracks and the source range it reads. */
export interface TrackWindow {
	end: number;
	sourceEnd: number;
	sourceStart: number;
	start: number;
}

const round = (value: number, digits = 4) => {
	const factor = 10 ** digits;
	const rounded = Math.round(value * factor) / factor;
	return Object.is(rounded, -0) ? 0 : rounded;
};
const clamp = (value: number, min: number, max: number) =>
	Math.min(max, Math.max(min, value));

/** The clip's source time at project time `time` (no clamping). */
export function clipSourceTime(
	segment: Pick<Segment, "sourceIn" | "speed" | "start">,
	time: number
): number {
	return segment.sourceIn + (time - segment.start) * segment.speed;
}

/** The project time a source time of the clip plays at. */
export function clipTimelineTime(
	segment: Pick<Segment, "sourceIn" | "speed" | "start">,
	sourceTime: number
): number {
	return segment.start + (sourceTime - segment.sourceIn) / segment.speed;
}

/**
 * The span tracked from `time`: to the clip end, or `duration` seconds,
 * whichever comes first, never longer than `MAX_TRACK_SECONDS`.
 */
export function trackWindow(
	segment: Segment,
	time: number,
	duration?: number
): TrackWindow {
	const clipEnd = segment.start + segmentDuration(segment);
	if (time < segment.start || time >= clipEnd) {
		throw new Error("Place the playhead inside the clip to track.");
	}
	const end = Math.min(clipEnd, time + (duration ?? MAX_TRACK_SECONDS));
	const limited = Math.min(end, time + MAX_TRACK_SECONDS);
	return {
		end: limited,
		sourceEnd: clipSourceTime(segment, limited),
		sourceStart: clipSourceTime(segment, time),
		start: time,
	};
}

/** Canvas pixel size of a project. */
export const canvasFrame = (project: Pick<Project, "height" | "width">) => ({
	height: project.height,
	width: project.width,
});

/** Source pixel size of a clip's media, falling back to the canvas. */
export function clipContent(
	asset: Pick<Asset, "height" | "width"> | undefined,
	canvas: FrameSize
): FrameSize {
	return asset && asset.width > 0 && asset.height > 0
		? { height: asset.height, width: asset.width }
		: canvas;
}

/**
 * Where a point of the source frame (fractions, top-left origin) is drawn on
 * the canvas at clip-relative `elapsed` seconds, following
 * `segmentPlacement` (crop, fit, scale, position, rotation) plus the flips.
 */
export function sourceToCanvas(
	segment: Segment,
	content: FrameSize,
	canvas: FrameSize,
	point: Point,
	elapsed: number
): Point {
	const { full } = segmentPlacement(segment, content, canvas, elapsed);
	const u = segment.flipH ? 1 - point.x : point.x;
	const v = segment.flipV ? 1 - point.y : point.y;
	const pixel = localToFramePx(full, canvas, {
		x: (u - 0.5) * full.width * canvas.width,
		y: (v - 0.5) * full.height * canvas.height,
	});
	return pixelToNormalized(pixel, canvas);
}

/** The inverse of `sourceToCanvas` (the result may lie outside `0..1`). */
export function canvasToSource(
	segment: Segment,
	content: FrameSize,
	canvas: FrameSize,
	point: Point,
	elapsed: number
): Point {
	const { full } = segmentPlacement(segment, content, canvas, elapsed);
	const local = frameToLocalPx(full, canvas, {
		x: point.x * canvas.width,
		y: point.y * canvas.height,
	});
	const u = full.width > 0 ? local.x / (full.width * canvas.width) + 0.5 : 0.5;
	const v =
		full.height > 0 ? local.y / (full.height * canvas.height) + 0.5 : 0.5;
	return { x: segment.flipH ? 1 - u : u, y: segment.flipV ? 1 - v : v };
}

function boundingRegion(points: readonly Point[]): TrackRegion {
	const xs = points.map((point) => point.x);
	const ys = points.map((point) => point.y);
	const left = clamp(Math.min(...xs), 0, 1);
	const top = clamp(Math.min(...ys), 0, 1);
	const right = clamp(Math.max(...xs), 0, 1);
	const bottom = clamp(Math.max(...ys), 0, 1);
	return { height: bottom - top, width: right - left, x: left, y: top };
}

const corners = (region: TrackRegion): Point[] => [
	{ x: region.x, y: region.y },
	{ x: region.x + region.width, y: region.y },
	{ x: region.x + region.width, y: region.y + region.height },
	{ x: region.x, y: region.y + region.height },
];

/**
 * A canvas region drawn over the clip at `elapsed`, as a region of the
 * source frame: the bounding box of its mapped corners, clipped to the
 * frame. Fails when the region misses the clip.
 */
export function canvasRegionToSource(
	segment: Segment,
	content: FrameSize,
	canvas: FrameSize,
	region: TrackRegion,
	elapsed: number
): TrackRegion {
	const source = boundingRegion(
		corners(region).map((corner) =>
			canvasToSource(segment, content, canvas, corner, elapsed)
		)
	);
	if (source.width < MIN_TRACK_REGION || source.height < MIN_TRACK_REGION) {
		throw new Error("Draw the tracking region over the clip's picture.");
	}
	return source;
}

/** A source region as the canvas shows it at `elapsed` (bounding box). */
export function sourceRegionToCanvas(
	segment: Segment,
	content: FrameSize,
	canvas: FrameSize,
	region: TrackRegion,
	elapsed: number
): TrackRegion {
	return boundingRegion(
		corners(region).map((corner) =>
			sourceToCanvas(segment, content, canvas, corner, elapsed)
		)
	);
}

/** One sample of the path as the canvas shows it. */
export interface CanvasTrackPoint {
	/** Drawn size relative to the start frame (subject and clip scale). */
	scale: number;
	time: number;
	/** Center, canvas fractions. */
	x: number;
	y: number;
}

/**
 * The tracked path on the canvas. The clip's own animated transform is
 * applied at every sample, so a clip that zooms or pans while the subject
 * moves still lines up; `scale` folds in the clip's drawn size change.
 *
 * The analysis grid follows the source frame rate, so its last sample can
 * fall up to one source frame before the tracked window ends. Passing
 * `end` (the window end) holds the last sample's position until then, so a
 * follower or region covers every project frame of the window.
 */
export function canvasTrackPath(
	segment: Segment,
	content: FrameSize,
	canvas: FrameSize,
	samples: readonly TrackSample[],
	end?: number
): CanvasTrackPoint[] {
	const last = samples.at(-1);
	const held =
		last && end !== undefined && end > last.time + 1e-6
			? [...samples, { ...last, time: end }]
			: samples;
	return mapTrackSamples(segment, content, canvas, held);
}

function mapTrackSamples(
	segment: Segment,
	content: FrameSize,
	canvas: FrameSize,
	samples: readonly TrackSample[]
): CanvasTrackPoint[] {
	const drawnWidth = (elapsed: number) =>
		segmentPlacement(segment, content, canvas, elapsed).full.width;
	const first = samples[0];
	const baseWidth = first ? drawnWidth(first.time - segment.start) : 1;
	return samples.map((sample) => {
		const elapsed = sample.time - segment.start;
		const point = sourceToCanvas(segment, content, canvas, sample, elapsed);
		const widthRatio = baseWidth > 0 ? drawnWidth(elapsed) / baseWidth : 1;
		return {
			scale: sample.scale * widthRatio,
			time: Math.round(sample.time * 1e6) / 1e6,
			x: point.x,
			y: point.y,
		};
	});
}

/** Largest deviation of `point` from the straight line between `a` and `b`. */
function deviation(
	a: CanvasTrackPoint,
	b: CanvasTrackPoint,
	point: CanvasTrackPoint,
	scaleWeight: number
): number {
	const span = b.time - a.time;
	const p = span > 0 ? (point.time - a.time) / span : 0;
	const lerp = (from: number, to: number) => from + (to - from) * p;
	return Math.max(
		Math.abs(point.x - lerp(a.x, b.x)),
		Math.abs(point.y - lerp(a.y, b.y)),
		Math.abs(point.scale - lerp(a.scale, b.scale)) * scaleWeight
	);
}

/** Indices kept by a time-parametric Ramer-Douglas-Peucker pass. */
function simplify(
	points: readonly CanvasTrackPoint[],
	tolerance: number,
	scaleWeight: number
): number[] {
	const keep = new Set<number>([0, points.length - 1]);
	const stack: [number, number][] = [[0, points.length - 1]];
	while (stack.length) {
		const [from, to] = stack.pop() ?? [0, 0];
		const a = points[from];
		const b = points[to];
		if (!(a && b) || to - from < 2) {
			continue;
		}
		let worst = -1;
		let worstIndex = -1;
		for (let index = from + 1; index < to; index++) {
			const point = points[index];
			if (!point) {
				continue;
			}
			const error = deviation(a, b, point, scaleWeight);
			if (error > worst) {
				worst = error;
				worstIndex = index;
			}
		}
		if (worst > tolerance && worstIndex > 0) {
			keep.add(worstIndex);
			stack.push([from, worstIndex], [worstIndex, to]);
		}
	}
	return [...keep].sort((left, right) => left - right);
}

/**
 * Keyframe-ready points: the path simplified so linear interpolation stays
 * within `tolerance` (canvas fractions; scale errors are weighted as
 * `SCALE_TOLERANCE_FACTOR`× smaller), loosened until at most `maxPoints`
 * remain, then evenly thinned if it still does not fit. The first and last
 * points are always kept.
 */
export function decimateTrack(
	points: readonly CanvasTrackPoint[],
	maxPoints: number,
	tolerance = DEFAULT_TRACK_TOLERANCE
): CanvasTrackPoint[] {
	if (maxPoints < 2) {
		throw new Error("A tracked path needs room for at least two keyframes.");
	}
	if (points.length <= 2) {
		return [...points];
	}
	let limit = tolerance;
	for (let attempt = 0; attempt < 40; attempt++) {
		const kept = simplify(points, limit, 1 / SCALE_TOLERANCE_FACTOR);
		if (kept.length <= maxPoints) {
			return kept.flatMap((index) => {
				const point = points[index];
				return point ? [point] : [];
			});
		}
		limit *= 1.5;
	}
	const step = (points.length - 1) / (maxPoints - 1);
	return Array.from({ length: maxPoints }, (_, index) => {
		const point = points[Math.round(index * step)];
		return point ?? points[0];
	}).filter((point): point is CanvasTrackPoint => point !== undefined);
}

/** A path value at `time`, linearly interpolated between samples. */
export function pathAt(
	points: readonly CanvasTrackPoint[],
	time: number
): CanvasTrackPoint | undefined {
	const first = points[0];
	if (!first || time <= first.time) {
		return first && { ...first, time };
	}
	for (let index = 1; index < points.length; index++) {
		const next = points[index];
		const previous = points[index - 1];
		if (next && previous && time <= next.time) {
			const span = next.time - previous.time;
			const p = span > 0 ? (time - previous.time) / span : 1;
			const lerp = (a: number, b: number) => a + (b - a) * p;
			return {
				scale: lerp(previous.scale, next.scale),
				time,
				x: lerp(previous.x, next.x),
				y: lerp(previous.y, next.y),
			};
		}
	}
	const last = points.at(-1);
	return last && { ...last, time };
}

/** Item time span on the timeline. */
interface Span {
	end: number;
	start: number;
}

/**
 * A keyframed item: its start and its length exactly as `validateProject`
 * computes it, so relative keyframe times never exceed the bound.
 */
interface ItemClock {
	length: number;
	start: number;
}

/**
 * The part of `path` inside `span`, with exact points at both span edges so
 * motion clipped by the item's start or end still matches the subject.
 */
function pathWithin(
	path: readonly CanvasTrackPoint[],
	span: Span
): CanvasTrackPoint[] {
	const first = path[0];
	const last = path.at(-1);
	if (!(first && last) || span.end <= first.time || span.start >= last.time) {
		throw new Error("The target does not overlap the tracked range.");
	}
	const from = Math.max(span.start, first.time);
	const to = Math.min(span.end, last.time);
	const inner = path.filter((point) => point.time > from && point.time < to);
	const head = pathAt(path, from);
	const tail = pathAt(path, to);
	return [
		...(head ? [head] : []),
		...inner,
		...(tail && to > from ? [tail] : []),
	];
}

/** A channel of keyframes: the property and the value each point gives it. */
interface Channel {
	clampTo: readonly [number, number];
	property: KeyframeProperty;
	target?: string;
	value: (point: CanvasTrackPoint) => number;
}

/** Keyframe time relative to an item that starts at `start`. */
const relativeTime = (time: number, start: number, length: number) =>
	clamp(Math.round((time - start) * 1e6) / 1e6, 0, length);

function channelKeyframes(
	points: readonly CanvasTrackPoint[],
	channels: readonly Channel[],
	item: ItemClock,
	mintId: () => string
): Keyframe[] {
	const { length } = item;
	const frames: Keyframe[] = [];
	for (const channel of channels) {
		const seen = new Set<number>();
		for (const point of points) {
			const time = relativeTime(point.time, item.start, length);
			if (seen.has(time)) {
				continue;
			}
			seen.add(time);
			const [min, max] = channel.clampTo;
			frames.push({
				id: mintId(),
				property: channel.property,
				time,
				value: round(clamp(channel.value(point), min, max)),
				...(channel.target === undefined ? {} : { target: channel.target }),
			});
		}
	}
	return frames;
}

/** Keyframes of `item` that the tracked channels do not replace. */
function keptKeyframes(
	keyframes: readonly Keyframe[] | undefined,
	channels: readonly Channel[]
): Keyframe[] {
	const replaced = new Set(channels.map((channel) => channel.property));
	return (keyframes ?? []).filter(
		(frame) => frame.target !== undefined || !replaced.has(frame.property)
	);
}

/** The per-channel point budget once the item's other keyframes are kept. */
function pointBudget(kept: number, channels: number): number {
	const budget = Math.floor((MAX_TARGET_KEYFRAMES - kept) / channels);
	if (budget < 2) {
		throw new Error(
			"The target has too many other keyframes to hold a tracked path."
		);
	}
	return budget;
}

/** Inputs for applying a tracked path. */
export interface ApplyTrackInput {
	/** Canvas path from `canvasTrackPath`, in time order. */
	path: readonly CanvasTrackPoint[];
	/** The tracked region at the start frame, in canvas fractions. */
	region: TrackRegion;
	/** The tracked clip (a region layer sits on its track). */
	segment: Segment;
	target: TrackTarget;
	tolerance?: number;
}

export interface ApplyTrackResult {
	/** Keyframes written to the target. */
	keyframes: number;
	project: Project;
	target: { id: string; kind: TrackTargetKind | "adjustment-layer" };
}

/** Item-relative seconds of the path's first point (the reference frame). */
function referenceElapsed(
	path: readonly CanvasTrackPoint[],
	item: ItemClock
): number {
	const first = path[0];
	return first ? clamp(first.time - item.start, 0, item.length) : 0;
}

/** The motion relative to the first point (canvas fractions and factor). */
function offsets(path: readonly CanvasTrackPoint[]) {
	const origin = path[0] ?? { scale: 1, time: 0, x: 0, y: 0 };
	return {
		dx: (point: CanvasTrackPoint) => point.x - origin.x,
		dy: (point: CanvasTrackPoint) => point.y - origin.y,
		factor: (point: CanvasTrackPoint) =>
			origin.scale > 0 ? point.scale / origin.scale : 1,
	};
}

function applyToTitle(
	title: Title,
	input: ApplyTrackInput,
	mintId: () => string
): { keyframes: Keyframe[]; title: Title } {
	const motion = offsets(input.path);
	// Start from the pose the title has at the reference frame (where it was
	// lined up with the subject), not its static fields.
	const local = referenceElapsed(input.path, {
		length: title.end - title.start,
		start: title.start,
	});
	const baseX = titleKeyValue(title, "x", local);
	const baseY = titleKeyValue(title, "y", local);
	const baseScale = titleKeyValue(title, "scale", local);
	const channels: Channel[] = [
		{
			clampTo: [0, 1],
			property: "x",
			value: (point) => baseX + motion.dx(point),
		},
		{
			clampTo: [0, 1],
			property: "y",
			value: (point) => baseY + motion.dy(point),
		},
		{
			clampTo: [0.1, 4],
			property: "scale",
			value: (point) => baseScale * motion.factor(point),
		},
	];
	const kept = keptKeyframes(title.keyframes, channels);
	const points = decimateTrack(
		pathWithin(input.path, title),
		pointBudget(kept.length, channels.length),
		input.tolerance
	);
	const keyframes = channelKeyframes(
		points,
		channels,
		{ length: title.end - title.start, start: title.start },
		mintId
	);
	return {
		keyframes,
		title: { ...title, keyframes: [...kept, ...keyframes] },
	};
}

function applyToGraphic(
	graphic: Graphic,
	input: ApplyTrackInput,
	mintId: () => string
): { graphic: Graphic; keyframes: Keyframe[] } {
	const motion = offsets(input.path);
	// Graphic keyframes animate position, rotation and opacity only, so the
	// box keeps its size; `x`/`y` is its top-left corner, taken at the
	// reference frame so an already animated graphic does not jump.
	const elapsed = referenceElapsed(input.path, {
		length: graphic.end - graphic.start,
		start: graphic.start,
	});
	const baseX = graphicAnimatedValue(graphic, "x", elapsed);
	const baseY = graphicAnimatedValue(graphic, "y", elapsed);
	const channels: Channel[] = [
		{
			clampTo: [0, 1],
			property: "x",
			value: (point) => baseX + motion.dx(point),
		},
		{
			clampTo: [0, 1],
			property: "y",
			value: (point) => baseY + motion.dy(point),
		},
	];
	const kept = keptKeyframes(graphic.keyframes, channels);
	const points = decimateTrack(
		pathWithin(input.path, graphic),
		pointBudget(kept.length, channels.length),
		input.tolerance
	);
	const keyframes = channelKeyframes(
		points,
		channels,
		{ length: graphic.end - graphic.start, start: graphic.start },
		mintId
	);
	return {
		graphic: { ...graphic, keyframes: [...kept, ...keyframes] },
		keyframes,
	};
}

function applyToClip(
	clip: Segment,
	input: ApplyTrackInput,
	mintId: () => string
): { clip: Segment; keyframes: Keyframe[] } {
	const motion = offsets(input.path);
	const length = segmentDuration(clip);
	const span = { end: clip.start + length, start: clip.start };
	const first = input.path[0];
	const startElapsed = first ? clamp(first.time - clip.start, 0, length) : 0;
	// The clip keeps its pose at the start frame; `x`/`y` place its center
	// with ±1 at the frame edges, so a canvas offset counts twice.
	const baseX = animatedValue(clip, "x", startElapsed);
	const baseY = animatedValue(clip, "y", startElapsed);
	const baseScale = animatedValue(clip, "scale", startElapsed);
	const channels: Channel[] = [
		{
			clampTo: [-1, 1],
			property: "x",
			value: (point) => baseX + 2 * motion.dx(point),
		},
		{
			clampTo: [-1, 1],
			property: "y",
			value: (point) => baseY + 2 * motion.dy(point),
		},
		{
			clampTo: [0.1, 4],
			property: "scale",
			value: (point) => baseScale * motion.factor(point),
		},
	];
	const kept = keptKeyframes(clip.keyframes, channels);
	const points = decimateTrack(
		pathWithin(input.path, span),
		pointBudget(kept.length, channels.length),
		input.tolerance
	);
	const keyframes = channelKeyframes(
		points,
		channels,
		{ length, start: clip.start },
		mintId
	);
	return { clip: { ...clip, keyframes: [...kept, ...keyframes] }, keyframes };
}

/** The effect a region layer applies. */
export function regionEffect(kind: TrackRegionKind, id: string): Effect {
	return {
		amount: kind === "mosaic" ? 0.5 : 1,
		enabled: true,
		id,
		type: kind,
	};
}

/**
 * A new adjustment layer on the tracked clip's track whose rectangle mask
 * follows the path, blurring or pixelating only that region.
 */
export function trackedRegionLayer(
	kind: TrackRegionKind,
	input: ApplyTrackInput,
	mintId: () => string
): Omit<AdjustmentLayer, "id"> {
	const first = input.path[0];
	const last = input.path.at(-1);
	if (!(first && last) || last.time <= first.time) {
		throw new Error("The tracked range is too short for a region.");
	}
	// The layer stores microsecond times (`roundAdjustmentTime`), so its
	// keyframes are measured against the same rounded span.
	const span = {
		end: roundAdjustmentTime(last.time),
		start: roundAdjustmentTime(first.time),
	};
	const maskId = mintId();
	const effectId = mintId();
	const motion = offsets(input.path);
	const region = input.region;
	const centerX = region.x + region.width / 2;
	const centerY = region.y + region.height / 2;
	const channels: Channel[] = [
		{
			clampTo: [-1, 1],
			property: "maskX",
			target: maskId,
			value: (point) => 2 * (centerX + motion.dx(point)) - 1,
		},
		{
			clampTo: [-1, 1],
			property: "maskY",
			target: maskId,
			value: (point) => 2 * (centerY + motion.dy(point)) - 1,
		},
		{
			clampTo: [0, 2],
			property: "maskWidth",
			target: maskId,
			value: (point) => region.width * motion.factor(point),
		},
		{
			clampTo: [0, 2],
			property: "maskHeight",
			target: maskId,
			value: (point) => region.height * motion.factor(point),
		},
	];
	const points = decimateTrack(
		input.path,
		pointBudget(0, channels.length),
		input.tolerance
	);
	const mask: Mask = {
		feather: REGION_MASK_FEATHER,
		height: round(region.height),
		id: maskId,
		invert: false,
		opacity: 1,
		rotation: 0,
		shape: "rectangle",
		width: round(region.width),
		x: round(2 * centerX - 1),
		y: round(2 * centerY - 1),
	};
	return {
		effects: [regionEffect(kind, effectId)],
		end: span.end,
		keyframes: channelKeyframes(
			points,
			channels,
			{ length: span.end - span.start, start: span.start },
			mintId
		),
		label: kind === "mosaic" ? "Tracked mosaic" : "Tracked blur",
		masks: [mask],
		opacity: 1,
		start: span.start,
		track: input.segment.track,
	};
}

/**
 * Apply a tracked canvas path to the request's target and validate the
 * project. Title and clip targets get `x`/`y`/`scale` keyframes, graphics
 * `x`/`y`; earlier keyframes of those channels are replaced. A region target
 * adds a blur or mosaic adjustment layer with a tracked mask.
 */
export function applyTrack(
	project: Project,
	assets: readonly Asset[],
	input: ApplyTrackInput,
	mintId: () => string = () => crypto.randomUUID()
): ApplyTrackResult {
	if (input.path.length < 2) {
		throw new Error("Tracking produced fewer than two frames.");
	}
	const target = input.target;
	if ("createRegion" in target) {
		const layer = trackedRegionLayer(target.createRegion, input, mintId);
		const result = editAdjustmentLayers(
			project,
			assets,
			{ action: "create", layer, revision: project.revision },
			mintId
		);
		const created = result.layer;
		if (!created) {
			throw new Error("The tracked region layer was not created.");
		}
		// The layer remembers the source moments it hides, so trims, slips
		// and ramps of the clip move it with them (`followTrackedLayers`).
		const follows = trackedSourceOf(input.segment, created);
		return {
			keyframes: created.keyframes?.length ?? 0,
			project: validateProject(
				{
					...result.project,
					adjustmentLayers: (result.project.adjustmentLayers ?? []).map(
						(layer) => (layer.id === created.id ? { ...layer, follows } : layer)
					),
				},
				[...assets]
			),
			target: { id: created.id, kind: "adjustment-layer" },
		};
	}
	let written: Keyframe[] = [];
	let next: Project;
	switch (target.kind) {
		case "title": {
			const title = project.titles.find((item) => item.id === target.id);
			if (!title) {
				throw new Error("The title to track was not found.");
			}
			const applied = applyToTitle(title, input, mintId);
			written = applied.keyframes;
			next = {
				...project,
				titles: project.titles.map((item) =>
					item.id === title.id ? applied.title : item
				),
			};
			break;
		}
		case "graphic": {
			const graphic = project.graphics.find((item) => item.id === target.id);
			if (!graphic) {
				throw new Error("The graphic to track was not found.");
			}
			const applied = applyToGraphic(graphic, input, mintId);
			written = applied.keyframes;
			next = {
				...project,
				graphics: project.graphics.map((item) =>
					item.id === graphic.id ? applied.graphic : item
				),
			};
			break;
		}
		default: {
			if (target.id === input.segment.id) {
				throw new Error("A clip cannot follow its own tracked subject.");
			}
			const clip = project.segments.find((item) => item.id === target.id);
			if (!clip) {
				throw new Error("The clip to track was not found.");
			}
			if (trackSettingFor(project, clip.track).locked) {
				throw new Error("Unlock the clip track before editing the timeline.");
			}
			const applied = applyToClip(clip, input, mintId);
			written = applied.keyframes;
			next = {
				...project,
				segments: project.segments.map((item) =>
					item.id === clip.id ? applied.clip : item
				),
			};
		}
	}
	return {
		keyframes: written.length,
		project: validateProject(next, [...assets]),
		target: { id: target.id, kind: target.kind },
	};
}

/** Summary numbers a tracking run reports with its edit. */
export interface TrackSummary {
	/** Mean tracker confidence, `0..1`. */
	confidence: number;
	/** Frames whose confidence fell below `lostBelow` (position held). */
	lostFrames: number;
	samples: number;
}

export function summarizeTrack(
	samples: readonly TrackSample[],
	lostBelow: number
): TrackSummary {
	const total = samples.reduce((sum, sample) => sum + sample.confidence, 0);
	return {
		confidence: samples.length ? round(total / samples.length, 3) : 0,
		lostFrames: samples.filter((sample) => sample.confidence < lostBelow)
			.length,
		samples: samples.length,
	};
}

/**
 * Items a tracked path can drive at project time `time`: titles, graphics
 * and visible clips (other than the tracked one, and not on a locked
 * track) that are on screen then.
 */
export function trackTargetsAt(
	project: Project,
	assets: readonly Asset[],
	trackedClipId: string,
	time: number
): { id: string; kind: TrackTargetKind; label: string }[] {
	const visual = new Set(
		assets.filter((asset) => asset.kind !== "audio").map((asset) => asset.id)
	);
	const onScreen = (span: Span) => time >= span.start && time < span.end;
	return [
		...project.titles.filter(onScreen).map((title) => ({
			id: title.id,
			kind: "title" as const,
			label: `Title: ${title.text.slice(0, 40)}`,
		})),
		...project.graphics.filter(onScreen).map((graphic) => ({
			id: graphic.id,
			kind: "graphic" as const,
			label: `Graphic: ${graphic.shape}`,
		})),
		...project.segments
			.filter(
				(segment) =>
					segment.id !== trackedClipId &&
					visual.has(segment.assetId) &&
					!trackSettingFor(project, segment.track).locked &&
					onScreen({
						end: segment.start + segmentDuration(segment),
						start: segment.start,
					})
			)
			.map((segment) => ({
				id: segment.id,
				kind: "clip" as const,
				label: `Clip: ${segment.label ?? `track ${segment.track + 1}`}`,
			})),
	];
}
