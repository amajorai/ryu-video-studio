/**
 * The volume rubber band drawn over audible clips: its height is the clip's
 * gain on the decibel scale of `lane-math` (silence at the bottom, +12 dB at
 * the top). Dragging its handle sets the static `volume` (or offsets every
 * volume keyframe by the same decibels when the clip is animated), and
 * Cmd/Ctrl-clicking it adds a volume keyframe on the line at the click.
 */
import { animatedValue, isAnimated } from "../../../shared/animation.ts";
import { clipVolumeFromDb, gainToDb } from "../../../shared/decibels.ts";
import type { Keyframe, Segment } from "../../../shared/project.ts";
import { addKeyframeAt } from "../inspector/sections/keyframe-list.ts";
import {
	LANE_INSET_PX,
	VOLUME_CEILING_DB,
	VOLUME_FLOOR_DB,
	valueToY,
	yToValue,
} from "./lane-math.ts";

/** The volume line's drawing height (the clip box is stretched to fit). */
export const VOLUME_LINE_HEIGHT = 32;
/** Pointer distance (drawing units) within which a press grabs the line. */
export const VOLUME_LINE_HIT = 5;

/** The clip's volume channel in time order. */
export function volumeFrames(segment: Pick<Segment, "keyframes">): Keyframe[] {
	return segment.keyframes
		.filter(
			(frame) => frame.property === "volume" && frame.target === undefined
		)
		.sort((a, b) => a.time - b.time);
}

/** The line's y (drawing units) at clip-relative `time`. */
export function volumeLineY(segment: Segment, time: number): number {
	return valueToY(
		"volume",
		animatedValue(segment, "volume", time),
		VOLUME_LINE_HEIGHT
	);
}

/** The volume a pointer at drawing-unit `y` asks for. */
export function volumeAtY(y: number): number {
	return yToValue("volume", y, VOLUME_LINE_HEIGHT);
}

/** True when a press at (`time`, `y`) is close enough to grab the line. */
export function hitsVolumeLine(
	segment: Segment,
	time: number,
	y: number
): boolean {
	return Math.abs(volumeLineY(segment, time) - y) <= VOLUME_LINE_HIT;
}

/**
 * The volume after dragging the line by `dyUnits` (drawing units, positive
 * downwards) from `startVolume`.
 */
export function draggedVolume(startVolume: number, dyUnits: number): number {
	return volumeAtY(
		valueToY("volume", startVolume, VOLUME_LINE_HEIGHT) + dyUnits
	);
}

/**
 * Every volume keyframe raised or lowered by the same number of decibels
 * (silent keyframes stay silent), clamped to the clip gain range.
 */
export function offsetVolumeFrames(
	frames: readonly Keyframe[],
	deltaDb: number
): Keyframe[] {
	return frames.map((frame) => {
		const db = gainToDb(frame.value);
		if (!Number.isFinite(db)) {
			return frame;
		}
		const value = Number(
			clipVolumeFromDb(Math.round((db + deltaDb) * 10) / 10).toFixed(6)
		);
		return { ...frame, value };
	});
}

/**
 * The decibel change a line drag of `dyUnits` (drawing units, positive
 * downwards) makes: the line's scale is linear in decibels, so every unit is
 * the same number of decibels wherever the line is grabbed.
 */
export function lineDragDeltaDb(dyUnits: number): number {
	const usable = VOLUME_LINE_HEIGHT - 2 * LANE_INSET_PX;
	return (-dyUnits * (VOLUME_CEILING_DB - VOLUME_FLOOR_DB)) / usable;
}

/** The outcome of a line drag: a static volume or a new volume channel. */
export type VolumeLineEdit =
	| { kind: "static"; volume: number }
	| { frames: Keyframe[]; kind: "keyframes" };

/**
 * What dragging the line by `dyUnits` does: un-animated clips get a new static volume; animated clips have every
 * volume keyframe offset by the same decibels.
 */
export function volumeLineDrag(
	segment: Segment,
	dyUnits: number
): VolumeLineEdit {
	if (!isAnimated(segment, "volume")) {
		return { kind: "static", volume: draggedVolume(segment.volume, dyUnits) };
	}
	return {
		frames: offsetVolumeFrames(volumeFrames(segment), lineDragDeltaDb(dyUnits)),
		kind: "keyframes",
	};
}

/** The outcome of a Cmd/Ctrl-click on the line. */
export interface VolumeKeyframeAdd {
	/** False when the click landed on an existing volume keyframe. */
	added: boolean;
	/** The clip's volume channel after the click, in time order. */
	frames: Keyframe[];
	/** The clip-relative time of the added (or matched) keyframe. */
	time: number;
	/** The keyframe's gain: the line's value there, so nothing sounds different. */
	value: number;
}

/**
 * How close (seconds) a click must be to an existing volume keyframe to land
 * on it: half a frame, and never less than the 1 ms the inspector rounds to.
 */
export function volumeKeyframeTolerance(fps: number): number {
	return Math.max(1e-3, fps > 0 ? 0.5 / fps : 0);
}

/**
 * A Cmd/Ctrl-click at clip-relative `time` (frame-quantized by the caller):
 * a volume keyframe is added on the existing line, with the value the curve
 * already has there, so the clip's loudness never changes (an eased interval
 * is split in two). Its value is changed later by dragging the point. A click
 * within half a frame of an existing volume keyframe lands on that keyframe
 * and changes nothing. Times are stored at the lanes' 6-decimal precision.
 */
export function addVolumeKeyframe(
	segment: Segment,
	time: number,
	fps: number
): VolumeKeyframeAdd {
	const existing = volumeFrames(segment);
	const tolerance = volumeKeyframeTolerance(fps);
	const hit = existing.find(
		(frame) => Math.abs(frame.time - time) <= tolerance
	);
	if (hit) {
		return { added: false, frames: existing, time: hit.time, value: hit.value };
	}
	const at = Number(time.toFixed(6));
	const known = new Set(existing.map((frame) => frame.id));
	const frames = volumeFrames({
		keyframes: addKeyframeAt(segment, "volume", at),
	}).map((frame) => (known.has(frame.id) ? frame : { ...frame, time: at }));
	const created = frames.find((frame) => !known.has(frame.id));
	return {
		added: true,
		frames,
		time: at,
		value: created?.value ?? animatedValue(segment, "volume", at),
	};
}

/** SVG points of the volume line across a clip `width` pixels wide. */
export function volumeLinePoints(
	segment: Segment,
	width: number,
	zoom: number,
	stepPx = 3
): string {
	if (zoom <= 0 || width <= 0) {
		return "";
	}
	const times = new Set<number>([0, width / zoom]);
	for (let x = 0; x <= width; x += Math.max(1, stepPx)) {
		times.add(x / zoom);
	}
	for (const frame of volumeFrames(segment)) {
		times.add(Math.max(0, frame.time - 1e-4));
		times.add(frame.time);
	}
	return [...times]
		.filter((time) => time * zoom <= width + 1e-9)
		.sort((a, b) => a - b)
		.map(
			(time) =>
				`${(time * zoom).toFixed(2)},${volumeLineY(segment, time).toFixed(2)}`
		)
		.join(" ");
}

/**
 * A keyboard step of the volume handle: `deltaDb` added to the static volume
 * (silence steps up from the line's floor, and stepping to the floor mutes),
 * or to every volume keyframe when the clip is animated.
 */
export function volumeStepEdit(
	segment: Segment,
	deltaDb: number
): VolumeLineEdit {
	if (isAnimated(segment, "volume")) {
		return {
			frames: offsetVolumeFrames(volumeFrames(segment), deltaDb),
			kind: "keyframes",
		};
	}
	const current = gainToDb(segment.volume);
	const db =
		Math.round(
			((Number.isFinite(current) ? current : VOLUME_FLOOR_DB) + deltaDb) * 10
		) / 10;
	return {
		kind: "static",
		volume: db <= VOLUME_FLOOR_DB ? 0 : Number(clipVolumeFromDb(db).toFixed(6)),
	};
}
