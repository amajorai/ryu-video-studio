import { useSyncExternalStore } from "react";
import {
	animatedValue,
	keyframeCurve,
	withCurve,
} from "../../../../shared/animation.ts";
import type { KeyframeClipboard } from "../../../../shared/keyframe-clipboard.ts";
import {
	DEFAULT_KEYFRAME_BEZIER,
	type KeyframeEasing,
	splitEasing,
} from "../../../../shared/keyframe-easing.ts";
import type { Keyframe, Segment } from "../../../../shared/project.ts";
import type { KeyframeProperty } from "../../../../shared/schema/keyframe.ts";

/** A property the inspector can animate, with its label. */
export interface KeyframePropertyOption {
	label: string;
	property: KeyframeProperty;
}

/**
 * Picture properties the render animates today. Effect, mask, flip-scale and
 * pan channels arrive with their own sections.
 */
export const visualKeyframeProperties: readonly KeyframePropertyOption[] = [
	{ label: "Scale", property: "scale" },
	{ label: "Horizontal position", property: "x" },
	{ label: "Vertical position", property: "y" },
	{ label: "Rotation", property: "rotation" },
	{ label: "Opacity", property: "opacity" },
	{ label: "Crop left", property: "cropLeft" },
	{ label: "Crop right", property: "cropRight" },
	{ label: "Crop top", property: "cropTop" },
	{ label: "Crop bottom", property: "cropBottom" },
	{ label: "Brightness", property: "brightness" },
	{ label: "Contrast", property: "contrast" },
	{ label: "Saturation", property: "saturation" },
	{ label: "Exposure", property: "exposure" },
	{ label: "Temperature", property: "temperature" },
];

export const audioKeyframeProperties: readonly KeyframePropertyOption[] = [
	{ label: "Volume", property: "volume" },
];

export const interpolationOptions: readonly {
	kind: KeyframeEasing;
	label: string;
}[] = [
	{ kind: "linear", label: "Linear" },
	{ kind: "hold", label: "Hold" },
	{ kind: "ease-in", label: "Ease in" },
	{ kind: "ease-out", label: "Ease out" },
	{ kind: "ease-in-out", label: "Ease in and out" },
	{ kind: "bezier", label: "Custom curve" },
];

const localTime = (value: number) => Number(value.toFixed(3));

/** The clip's keyframes of one property, in time order. */
export function propertyKeyframes(
	segment: Pick<Segment, "keyframes">,
	property: KeyframeProperty
): Keyframe[] {
	return segment.keyframes
		.filter(
			(frame) => frame.property === property && frame.target === undefined
		)
		.sort((a, b) => a.time - b.time);
}

/**
 * Add (or replace) a keyframe at a clip-relative time with the value the
 * curve already has there, so adding one never changes the animation: an
 * eased interval is split in two (`splitEasing`), the earlier keyframe keeps
 * the left part of the curve and the new one takes the right part.
 */
export function addKeyframeAt(
	segment: Segment,
	property: KeyframeProperty,
	time: number
): Keyframe[] {
	const at = localTime(time);
	const sameTime = (existing: Keyframe) =>
		existing.property === property &&
		existing.target === undefined &&
		existing.time === at;
	const frame: Keyframe = {
		id: crypto.randomUUID(),
		property,
		time: at,
		value: Number(animatedValue(segment, property, at).toFixed(6)),
	};
	const frames = propertyKeyframes(segment, property);
	const previous = frames.filter((existing) => existing.time <= at).at(-1);
	const next = frames.find((existing) => existing.time > at);
	const rest = segment.keyframes.filter((existing) => !sameTime(existing));
	if (!previous || previous.interpolation === undefined) {
		return [...rest, frame];
	}
	if (previous.time === at || !next) {
		return [...rest, withCurve(frame, keyframeCurve(previous))];
	}
	const u = (at - previous.time) / (next.time - previous.time);
	const split = splitEasing(previous.interpolation, u, previous.bezier);
	return [
		...rest.map((existing) =>
			existing.id === previous.id ? withCurve(existing, split.left) : existing
		),
		withCurve({ ...frame, interpolation: split.right.kind }, split.right),
	];
}

/**
 * Set the curve after one keyframe. Bezier starts from CSS `ease` (or keeps
 * its controls); every other kind drops them.
 */
export function withInterpolation(
	keyframes: readonly Keyframe[],
	id: string,
	kind: KeyframeEasing
): Keyframe[] {
	return keyframes.map((frame) => {
		if (frame.id !== id) {
			return frame;
		}
		const { bezier, interpolation: _interpolation, ...rest } = frame;
		return kind === "bezier"
			? {
					...rest,
					bezier: bezier ?? [...DEFAULT_KEYFRAME_BEZIER],
					interpolation: kind,
				}
			: { ...rest, interpolation: kind };
	});
}

/** Change one Bezier control (0 = x1, 1 = y1, 2 = x2, 3 = y2). */
export function withBezierControl(
	keyframes: readonly Keyframe[],
	id: string,
	index: 0 | 1 | 2 | 3,
	value: number
): Keyframe[] {
	return keyframes.map((frame) => {
		if (frame.id !== id || !frame.bezier) {
			return frame;
		}
		const bezier: [number, number, number, number] = [...frame.bezier];
		bezier[index] = value;
		return { ...frame, bezier };
	});
}

// Copied keyframes outlive the inspected clip, so they live in a tiny module
// store shared by every KeyframesSection instance.
let clipboard: KeyframeClipboard | null = null;
const listeners = new Set<() => void>();

export function setKeyframeClipboard(next: KeyframeClipboard | null) {
	clipboard = next;
	for (const listener of listeners) {
		listener();
	}
}

export function keyframeClipboard(): KeyframeClipboard | null {
	return clipboard;
}

function subscribe(listener: () => void) {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

/** The copied keyframes, re-rendering when they change. */
export function useKeyframeClipboard(): KeyframeClipboard | null {
	return useSyncExternalStore(subscribe, keyframeClipboard, keyframeClipboard);
}
