import {
	type BezierControls,
	easedProgress,
	easingExpression,
	type KeyframeEasing,
	MAX_BEZIER_PIECES,
	subEasing,
} from "./keyframe-easing.ts";
import type { Keyframe, Segment } from "./project.ts";
import {
	type KeyframeProperty,
	keyframeProperties,
	legacyKeyframeProperties,
} from "./schema/keyframe.ts";

export { keyframeProperties, legacyKeyframeProperties };

/** One animated channel: a property, plus the effect or mask it drives. */
export interface KeyframeGroup {
	property: KeyframeProperty;
	target?: string;
}

const legacyProperties: ReadonlySet<KeyframeProperty> = new Set(
	legacyKeyframeProperties
);

/** True for the six properties stored directly as numeric clip fields. */
export function isLegacyKeyframeProperty(
	property: KeyframeProperty
): property is (typeof legacyKeyframeProperties)[number] {
	return legacyProperties.has(property);
}

/**
 * The static (un-keyframed) value of a property on a clip: the value the
 * curve starts from when its first keyframe is after time zero.
 */
export function keyframeBaseValue(
	segment: Segment,
	property: KeyframeProperty,
	target?: string
): number {
	switch (property) {
		case "x":
		case "y":
		case "scale":
		case "rotation":
		case "opacity":
		case "volume":
		case "brightness":
		case "contrast":
		case "saturation":
			return segment[property];
		case "scaleX":
			return segment.scaleX ?? 1;
		case "scaleY":
			return segment.scaleY ?? 1;
		case "cropLeft":
			return segment.crop.left;
		case "cropRight":
			return segment.crop.right;
		case "cropTop":
			return segment.crop.top;
		case "cropBottom":
			return segment.crop.bottom;
		case "exposure":
			return segment.colorGrade.exposure;
		case "temperature":
			return segment.colorGrade.temperature;
		case "blur":
			return 0;
		case "effectAmount":
			return (
				segment.effects.find((effect) => effect.id === target)?.amount ?? 0
			);
		case "pan":
			return segment.pan ?? 0;
		default:
			return maskBaseValue(segment, property, target);
	}
}

function maskBaseValue(
	segment: Segment,
	property: KeyframeProperty,
	target: string | undefined
): number {
	const mask = segment.masks?.find((candidate) => candidate.id === target);
	switch (property) {
		case "maskX":
			return mask?.x ?? 0;
		case "maskY":
			return mask?.y ?? 0;
		case "maskWidth":
			return mask?.width ?? 1;
		case "maskHeight":
			return mask?.height ?? 1;
		case "maskRotation":
			return mask?.rotation ?? 0;
		case "maskFeather":
			return mask?.feather ?? 0;
		default:
			return 0;
	}
}

/**
 * Distinct animated channels on a clip, ordered by the property enum and then
 * by first appearance of each target. Legacy clips yield the historical
 * `x, y, scale, rotation, opacity, volume` order.
 */
export function keyframeGroups(
	keyframes: readonly Pick<Keyframe, "property" | "target">[]
): KeyframeGroup[] {
	const groups: KeyframeGroup[] = [];
	for (const property of keyframeProperties) {
		const targets: (string | undefined)[] = [];
		for (const frame of keyframes) {
			if (frame.property === property && !targets.includes(frame.target)) {
				targets.push(frame.target);
			}
		}
		for (const target of targets) {
			groups.push(target === undefined ? { property } : { property, target });
		}
	}
	return groups;
}

export const inKeyframeGroup =
	(group: KeyframeGroup) =>
	(frame: Pick<Keyframe, "property" | "target">): boolean =>
		frame.property === group.property && frame.target === group.target;

/** A curve shape: the easing from one keyframe to the next. */
export interface KeyframeCurve {
	bezier?: BezierControls;
	kind: KeyframeEasing;
}

/** The easing a keyframe applies to the interval after it (linear by default). */
export function keyframeCurve(
	frame: Pick<Keyframe, "bezier" | "interpolation">
): KeyframeCurve {
	const kind = frame.interpolation ?? "linear";
	return frame.bezier ? { bezier: frame.bezier, kind } : { kind };
}

/**
 * Write a curve onto a keyframe. A linear curve on a keyframe that never had
 * an interpolation stays implicit, so legacy projects keep their bytes.
 */
export function withCurve(frame: Keyframe, curve: KeyframeCurve): Keyframe {
	const { bezier: _bezier, interpolation: _interpolation, ...rest } = frame;
	if (curve.kind === "linear" && frame.interpolation === undefined) {
		return rest;
	}
	return curve.bezier && curve.kind === "bezier"
		? { ...rest, bezier: curve.bezier, interpolation: curve.kind }
		: { ...rest, interpolation: curve.kind };
}

/**
 * The part of an eased interval between time progress `from` and `to`
 * (0 <= from < to <= 1), re-normalized to its own unit box.
 */
export function subCurve(
	curve: KeyframeCurve,
	from: number,
	to: number
): KeyframeCurve {
	return subEasing(curve, from, to);
}

/** The original interval around `sourceTime`: its start point and next point. */
function intervalAt(
	points: readonly AnimationPoint[],
	sourceTime: number
): { a: AnimationPoint; b: AnimationPoint } | undefined {
	for (let i = 0; i + 1 < points.length; i++) {
		const a = points[i] as AnimationPoint;
		const b = points[i + 1] as AnimationPoint;
		if (sourceTime >= a.time - 1e-9 && sourceTime < b.time - 1e-9) {
			return { a, b };
		}
	}
	return undefined;
}

/**
 * Build a keyframe inserted on an existing curve at `time` (clip-relative,
 * after the edit) for the original clip moment `sourceTime`. It keeps the
 * group's target, the exact eased value, and the remainder of the curve it
 * splits, so the animation after it is unchanged.
 */
export function boundaryKeyframe(
	segment: Segment,
	group: KeyframeGroup,
	time: number,
	sourceTime: number
): Keyframe {
	const points = animationPoints(segment, group.property, group.target);
	const frame: Keyframe = {
		id: crypto.randomUUID(),
		property: group.property,
		time,
		value: animatedValue(segment, group.property, sourceTime, group.target),
	};
	if (group.target !== undefined) {
		frame.target = group.target;
	}
	const interval = intervalAt(points, sourceTime);
	if (interval) {
		const u =
			(sourceTime - interval.a.time) / (interval.b.time - interval.a.time);
		const curve = subCurve(keyframeCurve(interval.a), u, 1);
		return curve.kind === "linear" && interval.a.interpolation === undefined
			? frame
			: withCurve({ ...frame, interpolation: curve.kind }, curve);
	}
	const previous = points.filter((point) => point.time <= sourceTime).at(-1);
	return previous?.interpolation === undefined
		? frame
		: withCurve(frame, keyframeCurve(previous));
}

const keyframeTime = (value: number) => Number(value.toFixed(6));
/** Largest 6-decimal time that does not exceed `duration`. */
function keyframeEnd(duration: number) {
	let end = keyframeTime(duration);
	while (end > duration) {
		end = keyframeTime(end - 1e-6);
	}
	return end;
}

/**
 * Re-fit the curve of each kept keyframe to the sub-interval that now
 * follows it, so eased curves survive trims and boundary insertions.
 */
function refitCurves(
	points: readonly AnimationPoint[],
	placed: readonly { frame: Keyframe; source: number }[]
): Keyframe[] {
	return placed.map((entry, index) => {
		const next = placed[index + 1];
		const interval = intervalAt(points, entry.source);
		if (!(next && interval) || interval.a.interpolation === undefined) {
			return entry.frame;
		}
		const span = interval.b.time - interval.a.time;
		const from = (entry.source - interval.a.time) / span;
		const to = Math.min(1, (next.source - interval.a.time) / span);
		if (to - from < 1e-9) {
			return entry.frame;
		}
		if (from < 1e-9 && to > 1 - 1e-9) {
			return withCurve(entry.frame, keyframeCurve(interval.a));
		}
		return withCurve(
			{ ...entry.frame, interpolation: interval.a.interpolation },
			subCurve(keyframeCurve(interval.a), from, to)
		);
	});
}

/**
 * Re-base clip-relative keyframes after the clip start moves by `startShift`
 * timeline seconds (positive trims the head, negative extends it) so every
 * keyframe stays on the same source moment; boundary values are interpolated
 * on the eased curve and eased intervals are subdivided exactly. Times never
 * exceed `duration`, even after 6-decimal rounding. Channels are grouped by
 * property and target.
 */
export function retimeKeyframes(
	segment: Segment,
	startShift: number,
	duration: number
): Keyframe[] {
	const end = keyframeEnd(duration);
	const next: Keyframe[] = [];
	for (const group of keyframeGroups(segment.keyframes)) {
		const frames = segment.keyframes.filter(inKeyframeGroup(group));
		const placed: { frame: Keyframe; source: number }[] = [];
		for (const frame of frames) {
			const time = Math.min(end, keyframeTime(frame.time - startShift));
			if (
				time >= 0 &&
				frame.time - startShift <= duration + 1e-9 &&
				!placed.some((kept) => kept.frame.time === time)
			) {
				placed.push({ frame: { ...frame, time }, source: frame.time });
			}
		}
		const boundaries: number[] = [];
		if (startShift !== 0) {
			boundaries.push(0);
		}
		if (startShift < 0) {
			boundaries.push(Math.min(end, keyframeTime(-startShift)));
		}
		if (frames.some((frame) => frame.time - startShift > duration + 1e-9)) {
			boundaries.push(end);
		}
		for (const time of boundaries) {
			if (placed.some((entry) => entry.frame.time === time)) {
				continue;
			}
			const source = Math.max(0, time + startShift);
			placed.push({
				frame: boundaryKeyframe(segment, group, time, source),
				source,
			});
		}
		placed.sort((a, b) => a.frame.time - b.frame.time);
		next.push(
			...refitCurves(
				animationPoints(segment, group.property, group.target),
				placed
			)
		);
	}
	return next;
}

interface AnimationPoint {
	bezier?: BezierControls;
	id: string;
	interpolation?: KeyframeEasing;
	property: KeyframeProperty;
	time: number;
	value: number;
}

/**
 * The points of one channel in time order. When the first keyframe is after
 * time zero, a linear point at the static value leads the curve.
 */
export function animationPoints(
	segment: Segment,
	property: KeyframeProperty,
	target?: string
): AnimationPoint[] {
	const frames: AnimationPoint[] = segment.keyframes
		.filter(inKeyframeGroup({ property, target }))
		.sort((a, b) => a.time - b.time);
	return frames[0]?.time === 0
		? frames
		: [
				{
					id: "initial",
					time: 0,
					property,
					value: keyframeBaseValue(segment, property, target),
				},
				...frames,
			];
}

/** True when the clip has keyframes on this channel. */
export function isAnimated(
	segment: Pick<Segment, "keyframes">,
	property: KeyframeProperty,
	target?: string
): boolean {
	return segment.keyframes.some(inKeyframeGroup({ property, target }));
}

/**
 * Value of a channel at clip-relative time `at`, eased by the interpolation
 * of the keyframe that starts each interval. The render expression from
 * `animationExpression` evaluates the same curve.
 */
export function animatedValue(
	segment: Segment,
	property: KeyframeProperty,
	at: number,
	target?: string
): number {
	const points = animationPoints(segment, property, target);
	let previous = points[0];
	if (!previous) {
		return keyframeBaseValue(segment, property, target);
	}
	for (const next of points.slice(1)) {
		if (at <= next.time) {
			const fraction = Math.max(
				0,
				(at - previous.time) / (next.time - previous.time)
			);
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

/** Smallest and largest value a channel takes over the clip, eased curves included. */
export function animatedRange(
	segment: Segment,
	property: KeyframeProperty,
	target?: string
): { max: number; min: number } {
	const points = animationPoints(segment, property, target);
	let min = Number.POSITIVE_INFINITY;
	let max = Number.NEGATIVE_INFINITY;
	for (const [index, point] of points.entries()) {
		min = Math.min(min, point.value);
		max = Math.max(max, point.value);
		const next = points[index + 1];
		const kind = point.interpolation ?? "linear";
		if (!next || kind === "linear" || kind === "hold") {
			continue;
		}
		for (let i = 1; i < 64; i++) {
			const value =
				point.value +
				(next.value - point.value) * easedProgress(kind, i / 64, point.bezier);
			min = Math.min(min, value);
			max = Math.max(max, value);
		}
	}
	if (min > max) {
		const value = keyframeBaseValue(segment, property, target);
		return { max: value, min: value };
	}
	return { max, min };
}

/**
 * Cubic pieces one clip's Bezier intervals share in the render. Each piece
 * costs about 240 characters of filtergraph text, so a clip's Bezier curves
 * stay near 30 KB however many keyframes it has (the whole graph is one argv
 * string, capped at 128 KiB on Linux).
 */
export const CLIP_BEZIER_PIECE_BUDGET = 128;

/**
 * Pieces each Bezier interval of this clip may use in the render: the full
 * fit (up to 32) for a few curves, fewer as Bezier keyframes accumulate
 * across all of the clip's channels, and at least one.
 */
export function bezierPieceLimit(segment: Pick<Segment, "keyframes">): number {
	const curves = segment.keyframes.filter(
		(frame) => frame.interpolation === "bezier"
	).length;
	return Math.min(
		MAX_BEZIER_PIECES,
		Math.max(1, Math.floor(CLIP_BEZIER_PIECE_BUDGET / Math.max(1, curves)))
	);
}

/**
 * FFmpeg expression of a channel over `clock` (clip-relative seconds). Linear
 * intervals keep their historical text exactly; eased intervals multiply the
 * value change by the easing polynomial (Bezier: a piecewise cubic fit within
 * the clip's `bezierPieceLimit`), and hold intervals are constant.
 */
export function animationExpression(
	segment: Segment,
	property: KeyframeProperty,
	clock = "t",
	target?: string
): string {
	const points = animationPoints(segment, property, target);
	const maxPieces = bezierPieceLimit(segment);
	let result = String(
		points.at(-1)?.value ?? keyframeBaseValue(segment, property, target)
	);
	for (let i = points.length - 2; i >= 0; i--) {
		const a = points[i];
		const b = points[i + 1];
		if (!(a && b)) {
			continue;
		}
		const kind = a.interpolation ?? "linear";
		let interval: string;
		if (kind === "linear") {
			interval = `${a.value}+(${b.value - a.value})*max(0,(${clock}-${a.time}))/${b.time - a.time}`;
		} else if (kind === "hold") {
			interval = String(a.value);
		} else {
			const u = `max(0,(${clock}-${a.time}))/${b.time - a.time}`;
			interval = `${a.value}+(${b.value - a.value})*(${easingExpression(kind, u, a.bezier, maxPieces)})`;
		}
		result = `if(lt(${clock},${b.time}),${interval},${result})`;
	}
	return result;
}
