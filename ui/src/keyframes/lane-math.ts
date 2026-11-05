/**
 * Pure geometry for the timeline keyframe lanes and the volume rubber band:
 * clip-relative time ↔ lane x, property value ↔ lane y (volume on a decibel
 * scale), snapped diamond drags and the `/keyframes` request a lane edit
 * saves through. Nothing here touches the DOM, so the mapping is tested
 * directly and the lane components stay thin.
 */
import {
	animatedValue,
	inKeyframeGroup,
	type KeyframeGroup,
	keyframeGroups,
} from "../../../shared/animation.ts";
import {
	clipVolumeFromDb,
	gainToDb,
	MAX_CLIP_GAIN,
} from "../../../shared/decibels.ts";
import type { SetKeyframesInput } from "../../../shared/keyframe-edits.ts";
import {
	type Keyframe,
	type Segment,
	segmentDuration,
} from "../../../shared/project.ts";
import {
	type KeyframeProperty,
	keyframeValueBounds,
} from "../../../shared/schema/keyframe.ts";
import {
	quantizeToFrame,
	SNAP_PRIORITY,
	type SnapTarget,
	snap,
} from "../../../shared/timeline-snap.ts";

/** Height of one collapsed-value lane (diamonds only). */
export const LANE_ROW_PX = 22;
/** Height of one lane in the graph view, where value is vertical. */
export const GRAPH_ROW_PX = 72;
/** Pointer travel (px) before a press on a diamond becomes a drag. */
export const DRAG_START_PX = 3;
/** Inset that keeps the extreme values (and their diamonds) inside a lane. */
export const LANE_INSET_PX = 5;

/** The volume line's floor: everything at or below it reads as silence. */
export const VOLUME_FLOOR_DB = -60;
/** The volume line's ceiling: the schema's maximum clip gain (≈ +12 dB). */
export const VOLUME_CEILING_DB = gainToDb(MAX_CLIP_GAIN);

const propertyLabels: Record<KeyframeProperty, string> = {
	x: "Horizontal position",
	y: "Vertical position",
	scale: "Scale",
	rotation: "Rotation",
	opacity: "Opacity",
	volume: "Volume",
	scaleX: "Horizontal scale",
	scaleY: "Vertical scale",
	cropLeft: "Crop left",
	cropRight: "Crop right",
	cropTop: "Crop top",
	cropBottom: "Crop bottom",
	brightness: "Brightness",
	contrast: "Contrast",
	saturation: "Saturation",
	exposure: "Exposure",
	temperature: "Temperature",
	blur: "Blur",
	effectAmount: "Effect amount",
	pan: "Pan",
	maskX: "Mask horizontal position",
	maskY: "Mask vertical position",
	maskWidth: "Mask width",
	maskHeight: "Mask height",
	maskRotation: "Mask rotation",
	maskFeather: "Mask feather",
	fontSize: "Text size",
	letterSpacing: "Letter spacing",
	lineHeight: "Line height",
	backgroundPadding: "Background padding",
	backgroundRadius: "Background corner radius",
	strokeWidth: "Stroke width",
	cornerRadius: "Corner radius",
	innerRadius: "Inner radius",
	color: "Text color",
	backgroundColor: "Background color",
	fill: "Fill color",
	stroke: "Stroke color",
};

/** A readable name for an animated channel. */
export function channelLabel(group: KeyframeGroup): string {
	return propertyLabels[group.property];
}

/** A stable key for one channel (property plus its effect or mask id). */
export function channelKey(group: KeyframeGroup): string {
	return group.target === undefined
		? group.property
		: `${group.property}:${group.target}`;
}

/** One lane: an animated channel and its keyframes in time order. */
export interface LaneChannel {
	frames: Keyframe[];
	group: KeyframeGroup;
	key: string;
	label: string;
}

/** Every animated channel on a clip, one lane each, in property order. */
export function laneChannels(
	segment: Pick<Segment, "keyframes">
): LaneChannel[] {
	return keyframeGroups(segment.keyframes).map((group) => ({
		frames: segment.keyframes
			.filter(inKeyframeGroup(group))
			.sort((a, b) => a.time - b.time),
		group,
		key: channelKey(group),
		label: channelLabel(group),
	}));
}

const clampUnit = (value: number) => Math.min(1, Math.max(0, value));

/**
 * Where a value sits in its property's range, 0 at the bottom of a lane and
 * 1 at the top. Volume uses decibels between `VOLUME_FLOOR_DB` and the
 * maximum clip gain, so equal steps sound like equal changes.
 */
export function valueFraction(
	property: KeyframeProperty,
	value: number
): number {
	if (property === "volume") {
		const db = gainToDb(value);
		if (!Number.isFinite(db)) {
			return 0;
		}
		return clampUnit(
			(db - VOLUME_FLOOR_DB) / (VOLUME_CEILING_DB - VOLUME_FLOOR_DB)
		);
	}
	const [min, max] = keyframeValueBounds(property);
	// Color channels have no numeric range; their diamonds sit mid-lane.
	return max > min ? clampUnit((value - min) / (max - min)) : 0.5;
}

/**
 * The value at a lane fraction (inverse of `valueFraction`), clamped to the
 * property's range. Volume rounds to 0.1 dB, and the floor mutes the clip.
 */
export function fractionValue(
	property: KeyframeProperty,
	fraction: number
): number {
	const unit = clampUnit(fraction);
	if (property === "volume") {
		if (unit <= 0) {
			return 0;
		}
		if (unit >= 1) {
			return MAX_CLIP_GAIN;
		}
		const db = VOLUME_FLOOR_DB + unit * (VOLUME_CEILING_DB - VOLUME_FLOOR_DB);
		return Number(clipVolumeFromDb(Math.round(db * 10) / 10).toFixed(6));
	}
	const [min, max] = keyframeValueBounds(property);
	return Number((min + unit * (max - min)).toFixed(4));
}

/** The lane y (pixels from the lane top) of a value. */
export function valueToY(
	property: KeyframeProperty,
	value: number,
	height: number
): number {
	const usable = Math.max(0, height - 2 * LANE_INSET_PX);
	return LANE_INSET_PX + (1 - valueFraction(property, value)) * usable;
}

/** The value at a lane y (pixels from the lane top). */
export function yToValue(
	property: KeyframeProperty,
	y: number,
	height: number
): number {
	const usable = Math.max(1, height - 2 * LANE_INSET_PX);
	return fractionValue(property, 1 - (y - LANE_INSET_PX) / usable);
}

/** Inputs that turn a diamond's pointer delta into a keyframe time. */
export interface KeyframeTimeDrag {
	/** Clip duration on the timeline; keyframes stay within 0..duration. */
	duration: number;
	/** Horizontal pointer movement in pixels. */
	dxPx: number;
	fps: number;
	/** Neighbouring keyframe times on the same channel (order is kept). */
	next?: number;
	previous?: number;
	snapping: boolean;
	/** Clip-relative times worth snapping to (playhead, other keyframes…). */
	snapTargets: readonly SnapTarget[];
	startTime: number;
	/** Timeline zoom, pixels per second. */
	zoom: number;
}

const roundTime = (time: number) => Number(time.toFixed(6));

/**
 * The time a dragged diamond lands on: the snapped (or frame-quantized)
 * pointer time, kept a frame inside its neighbours so a drag never reorders
 * or merges keyframes, and inside the clip.
 */
export function draggedKeyframeTime(drag: KeyframeTimeDrag): number {
	const raw = drag.startTime + (drag.zoom > 0 ? drag.dxPx / drag.zoom : 0);
	const snapped = drag.snapping
		? snap(raw, drag.snapTargets, { fps: drag.fps, pxPerSec: drag.zoom }).time
		: quantizeToFrame(raw, drag.fps);
	const frame = drag.fps > 0 ? 1 / drag.fps : 0;
	const low = Math.max(
		0,
		drag.previous === undefined ? 0 : drag.previous + frame
	);
	const high = Math.min(
		drag.duration,
		drag.next === undefined ? drag.duration : drag.next - frame
	);
	if (low > high) {
		return roundTime(drag.startTime);
	}
	return roundTime(Math.min(high, Math.max(low, snapped)));
}

/**
 * Snap targets for a diamond drag, all clip-relative: the playhead (when it
 * is over the clip), the clip edges, project markers over the clip and the
 * keyframes of the clip's other channels.
 */
export function keyframeSnapTargets(
	segment: Segment,
	options: {
		excludeIds?: ReadonlySet<string>;
		markerTimes?: readonly number[];
		playhead?: number;
	}
): SnapTarget[] {
	const duration = segmentDuration(segment);
	const inside = (time: number) => time >= 0 && time <= duration;
	const targets: SnapTarget[] = [
		{ kind: "clip-start", priority: SNAP_PRIORITY["clip-start"], time: 0 },
		{ kind: "clip-end", priority: SNAP_PRIORITY["clip-end"], time: duration },
	];
	const playhead =
		options.playhead === undefined
			? undefined
			: options.playhead - segment.start;
	if (playhead !== undefined && inside(playhead)) {
		targets.push({
			kind: "playhead",
			priority: SNAP_PRIORITY.playhead,
			time: playhead,
		});
	}
	for (const markerTime of options.markerTimes ?? []) {
		const local = markerTime - segment.start;
		if (inside(local)) {
			targets.push({
				kind: "marker",
				priority: SNAP_PRIORITY.marker,
				time: local,
			});
		}
	}
	for (const frame of segment.keyframes) {
		if (!options.excludeIds?.has(frame.id)) {
			targets.push({
				id: frame.id,
				kind: "keyframe",
				priority: SNAP_PRIORITY.keyframe,
				time: frame.time,
			});
		}
	}
	return targets;
}

/** A diamond drag on one channel: time always, value in the graph view. */
export interface DiamondDrag
	extends Omit<KeyframeTimeDrag, "next" | "previous" | "startTime"> {
	/** Vertical pointer movement in pixels (used only when `vertical`). */
	dyPx: number;
	/** The channel's keyframes in time order. */
	frames: readonly Keyframe[];
	/** Lane height in pixels, for the vertical value mapping. */
	height: number;
	id: string;
	property: KeyframeProperty;
	vertical: boolean;
}

/** The channel after dragging one diamond; other keyframes are untouched. */
export function dragDiamond(drag: DiamondDrag): Keyframe[] {
	const index = drag.frames.findIndex((frame) => frame.id === drag.id);
	const frame = drag.frames[index];
	if (!frame) {
		return [...drag.frames];
	}
	const time = draggedKeyframeTime({
		...drag,
		next: drag.frames[index + 1]?.time,
		previous: drag.frames[index - 1]?.time,
		startTime: frame.time,
	});
	const value = drag.vertical
		? yToValue(
				drag.property,
				valueToY(drag.property, frame.value, drag.height) + drag.dyPx,
				drag.height
			)
		: frame.value;
	return drag.frames.map((candidate) =>
		candidate.id === frame.id ? { ...candidate, time, value } : candidate
	);
}

/** The channel with one keyframe removed. */
export function withoutKeyframe(
	frames: readonly Keyframe[],
	id: string
): Keyframe[] {
	return frames.filter((frame) => frame.id !== id);
}

/** The channel with one keyframe moved by whole frames (keyboard nudge). */
export function nudgeKeyframe(
	frames: readonly Keyframe[],
	id: string,
	frameCount: number,
	fps: number,
	duration: number
): Keyframe[] {
	const index = frames.findIndex((frame) => frame.id === id);
	const frame = frames[index];
	if (!frame || fps <= 0) {
		return [...frames];
	}
	const time = draggedKeyframeTime({
		duration,
		dxPx: frameCount,
		fps,
		next: frames[index + 1]?.time,
		previous: frames[index - 1]?.time,
		snapTargets: [],
		snapping: false,
		startTime: frame.time,
		zoom: fps,
	});
	return frames.map((candidate) =>
		candidate.id === id ? { ...candidate, time } : candidate
	);
}

/**
 * The channel with one keyframe's value stepped by `steps` hundredths of
 * its lane (volume: of its decibel scale), clamped to the property range.
 */
export function nudgeValue(
	frames: readonly Keyframe[],
	id: string,
	property: KeyframeProperty,
	steps: number
): Keyframe[] {
	return frames.map((frame) =>
		frame.id === id
			? {
					...frame,
					value: fractionValue(
						property,
						valueFraction(property, frame.value) + steps / 100
					),
				}
			: frame
	);
}

/** Which item a `/keyframes` request edits. */
export type KeyframeOwnerRef =
	| { clipId: string }
	| { graphicId: string }
	| { titleId: string };

/**
 * The `/keyframes` request (`setKeyframes`) that replaces one channel of a
 * clip, title or graphic with `frames`, carrying each keyframe's
 * interpolation, Bezier controls and (color channels) color.
 */
export function ownerChannelRequest(
	owner: KeyframeOwnerRef,
	group: KeyframeGroup,
	frames: readonly Keyframe[],
	revision: number
): SetKeyframesInput {
	return {
		...owner,
		keyframes: [...frames]
			.sort((a, b) => a.time - b.time)
			.map((frame) => ({
				time: frame.time,
				value: frame.value,
				...(frame.color === undefined ? {} : { color: frame.color }),
				...(frame.interpolation === undefined
					? {}
					: { interpolation: frame.interpolation }),
				...(frame.bezier === undefined ? {} : { bezier: [...frame.bezier] }),
			})) as SetKeyframesInput["keyframes"],
		property: group.property,
		revision,
		...(group.target === undefined ? {} : { target: group.target }),
	};
}

/**
 * The `/keyframes` request (`setKeyframes`) that replaces one clip channel
 * with `frames` (see `ownerChannelRequest`).
 */
export function channelRequest(
	segment: Pick<Segment, "id">,
	group: KeyframeGroup,
	frames: readonly Keyframe[],
	revision: number
): SetKeyframesInput {
	return ownerChannelRequest({ clipId: segment.id }, group, frames, revision);
}

/**
 * SVG polyline points of any channel's curve across `width` pixels, sampled
 * every `stepPx` (and just before and at every keyframe, so holds draw as
 * steps) through `valueAt`.
 */
export function sampledCurvePoints(
	frames: readonly Pick<Keyframe, "time">[],
	property: KeyframeProperty,
	valueAt: (time: number) => number,
	options: { height: number; stepPx?: number; width: number; zoom: number }
): string {
	const { height, width, zoom } = options;
	const step = Math.max(1, options.stepPx ?? 3);
	const times = new Set<number>();
	if (zoom > 0) {
		for (let x = 0; x <= width; x += step) {
			times.add(x / zoom);
		}
		times.add(width / zoom);
	}
	for (const frame of frames) {
		times.add(Math.max(0, frame.time - 1e-4));
		times.add(frame.time);
	}
	return [...times]
		.filter((time) => time >= 0 && time * zoom <= width)
		.sort((a, b) => a - b)
		.map(
			(time) =>
				`${(time * zoom).toFixed(2)},${valueToY(property, valueAt(time), height).toFixed(2)}`
		)
		.join(" ");
}

/**
 * Snap targets for a diamond drag on any keyframed item, all item-relative:
 * its edges, the playhead and markers over it, and its other keyframes.
 */
export function itemKeyframeSnapTargets(
	item: { duration: number; keyframes: readonly Keyframe[]; start: number },
	options: {
		excludeIds?: ReadonlySet<string>;
		markerTimes?: readonly number[];
		playhead?: number;
	}
): SnapTarget[] {
	const inside = (time: number) => time >= 0 && time <= item.duration;
	const targets: SnapTarget[] = [
		{ kind: "clip-start", priority: SNAP_PRIORITY["clip-start"], time: 0 },
		{
			kind: "clip-end",
			priority: SNAP_PRIORITY["clip-end"],
			time: item.duration,
		},
	];
	const local = (time: number) => time - item.start;
	if (options.playhead !== undefined && inside(local(options.playhead))) {
		targets.push({
			kind: "playhead",
			priority: SNAP_PRIORITY.playhead,
			time: local(options.playhead),
		});
	}
	for (const markerTime of options.markerTimes ?? []) {
		if (inside(local(markerTime))) {
			targets.push({
				kind: "marker",
				priority: SNAP_PRIORITY.marker,
				time: local(markerTime),
			});
		}
	}
	for (const frame of item.keyframes) {
		if (!options.excludeIds?.has(frame.id)) {
			targets.push({
				id: frame.id,
				kind: "keyframe",
				priority: SNAP_PRIORITY.keyframe,
				time: frame.time,
			});
		}
	}
	return targets;
}

/**
 * SVG polyline points of a channel's curve across a clip `width` pixels wide,
 * sampled every `stepPx` (and at every keyframe) through `animatedValue`, so
 * the drawn curve is the one the preview and render play.
 */
export function curvePoints(
	segment: Segment,
	group: KeyframeGroup,
	options: { height: number; stepPx?: number; width: number; zoom: number }
): string {
	const { height, width, zoom } = options;
	const step = Math.max(1, options.stepPx ?? 3);
	const times = new Set<number>();
	if (zoom > 0) {
		for (let x = 0; x <= width; x += step) {
			times.add(x / zoom);
		}
		times.add(width / zoom);
	}
	for (const frame of segment.keyframes.filter(inKeyframeGroup(group))) {
		// Sample just before each keyframe too so holds draw as steps.
		times.add(Math.max(0, frame.time - 1e-4));
		times.add(frame.time);
	}
	return [...times]
		.filter((time) => time >= 0 && time * zoom <= width)
		.sort((a, b) => a - b)
		.map((time) => {
			const value = animatedValue(segment, group.property, time, group.target);
			return `${(time * zoom).toFixed(2)},${valueToY(group.property, value, height).toFixed(2)}`;
		})
		.join(" ");
}

/** Clip-relative time under a pointer at `offsetPx` from the clip's left edge. */
export function timeAtOffset(
	offsetPx: number,
	zoom: number,
	fps: number,
	duration: number
): number {
	const raw = zoom > 0 ? offsetPx / zoom : 0;
	return roundTime(Math.min(duration, Math.max(0, quantizeToFrame(raw, fps))));
}
