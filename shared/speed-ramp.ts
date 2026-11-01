import { z } from "zod";
import {
	animatedValue,
	animationPoints,
	type KeyframeGroup,
	keyframeGroups,
	legacyKeyframeProperties,
	retimeKeyframes,
} from "./animation.ts";
import { MAX_CLIP_SPEED, MIN_CLIP_SPEED } from "./audio.ts";
import { unpinRemovedLipSyncClips } from "./lipsync-links.ts";
import {
	type Asset,
	dissolveOrphanedLinkGroups,
	fitEdgeTransitions,
	type Keyframe,
	type Project,
	type Segment,
	segmentDuration,
	trackSettingFor,
	validateProject,
} from "./project.ts";
import {
	MAX_CURVE_SPEED,
	MAX_EDITABLE_CURVE_POINTS,
	MIN_CURVE_SPEED,
	speedCurvePointSchema,
} from "./schema/speed-curve.ts";
import {
	clipSourceOffset,
	clipTimeAtSourceOffset,
	hasSpeedCurve,
	naturalCurveSpeed,
	normalizedCurvePoints,
} from "./speed-curve.ts";
import { shiftTimedLayers } from "./timed-layers.ts";
import { followTrackedLayers } from "./tracked-layers.ts";

const MINIMUM_SPEED = MIN_CURVE_SPEED;
const MAXIMUM_SPEED = MAX_CURVE_SPEED;
const MINIMUM_CLIP_SECONDS = 0.04;
const EPSILON = 1e-6;
const MAXIMUM_KEYFRAMES = 200;
/** The six channels stored as clip fields: each step's field holds its start value. */
const keyframeProperties = legacyKeyframeProperties;

const round6 = (value: number) => Number(value.toFixed(6));
/** Round down so a boundary keyframe never lands past the clip's real duration. */
const floor6 = (value: number) => Math.floor(value * 1e6 + EPSILON) / 1e6;
const clipEnd = (segment: Segment) => segment.start + segmentDuration(segment);
const clampSpeed = (speed: number) =>
	Math.max(MINIMUM_SPEED, Math.min(MAXIMUM_SPEED, speed));

export const speedRampPresetSchema = z.enum([
	"montage",
	"hero",
	"bullet",
	"flash-in",
	"flash-out",
	"jump-cut",
	"custom",
]);
export type SpeedRampPreset = z.infer<typeof speedRampPresetSchema>;

/** A curve point; speeds run from 0.1x to 10x. */
export const speedRampPointSchema = speedCurvePointSchema;
export type SpeedRampPoint = z.infer<typeof speedRampPointSchema>;

/**
 * How later clips react when the ramp changes the clip's length:
 * `track` shifts later clips on the ramped tracks (and their linked partners),
 * `timeline` shifts every later clip and timed layer, `none` leaves them and
 * refuses a ramp that would overlap the next clip.
 */
export const speedRampRippleSchema = z
	.enum(["track", "timeline", "none"])
	.default("track");

export const speedRampRequestSchema = z
	.object({
		clipId: z.uuid(),
		preset: speedRampPresetSchema,
		points: z
			.array(speedRampPointSchema)
			.min(2)
			.max(MAX_EDITABLE_CURVE_POINTS)
			.optional(),
		steps: z.number().int().min(4).max(24).default(12),
		ripple: speedRampRippleSchema,
		revision: z.number().int().nonnegative(),
	})
	.strict();
export type SpeedRampRequest = z.infer<typeof speedRampRequestSchema>;
export type SpeedRampInput = z.input<typeof speedRampRequestSchema>;

export const resetSpeedRampRequestSchema = z
	.object({
		clipId: z.uuid(),
		/** Constant speed for the merged clip; omitted keeps the ramp's total length. */
		speed: z.number().finite().min(MINIMUM_SPEED).max(MAXIMUM_SPEED).optional(),
		ripple: speedRampRippleSchema,
		revision: z.number().int().nonnegative(),
	})
	.strict();
export type ResetSpeedRampRequest = z.infer<typeof resetSpeedRampRequestSchema>;
export type ResetSpeedRampInput = z.input<typeof resetSpeedRampRequestSchema>;

/** Speed curves over the clip's source range (`t` 0 = source in, 1 = source out). */
export const SPEED_RAMP_PRESETS: Record<
	SpeedRampPreset,
	{ points: SpeedRampPoint[] }
> = {
	montage: {
		points: [
			{ t: 0, speed: 1.5 },
			{ t: 0.25, speed: 3 },
			{ t: 0.5, speed: 0.6 },
			{ t: 0.75, speed: 3 },
			{ t: 1, speed: 1.5 },
		],
	},
	hero: {
		points: [
			{ t: 0, speed: 2 },
			{ t: 0.38, speed: 2 },
			{ t: 0.5, speed: 0.35 },
			{ t: 0.62, speed: 2 },
			{ t: 1, speed: 2 },
		],
	},
	bullet: {
		points: [
			{ t: 0, speed: 1 },
			{ t: 0.3, speed: 1 },
			{ t: 0.42, speed: 0.25 },
			{ t: 0.68, speed: 0.25 },
			{ t: 0.8, speed: 1 },
			{ t: 1, speed: 1 },
		],
	},
	"flash-in": {
		points: [
			{ t: 0, speed: 4 },
			{ t: 0.45, speed: 1 },
			{ t: 1, speed: 1 },
		],
	},
	"flash-out": {
		points: [
			{ t: 0, speed: 1 },
			{ t: 0.55, speed: 1 },
			{ t: 1, speed: 4 },
		],
	},
	// Fast, slow, fast with hard steps: each speed change happens within 1%
	// of the source, so the ramp reads as two jumps rather than a glide.
	"jump-cut": {
		points: [
			{ t: 0, speed: 3 },
			{ t: 0.33, speed: 3 },
			{ t: 0.34, speed: 0.5 },
			{ t: 0.66, speed: 0.5 },
			{ t: 0.67, speed: 3 },
			{ t: 1, speed: 3 },
		],
	},
	custom: { points: [] },
};

/** Bounds a custom curve's points are kept within (`speedRampPointSchema`). */
export const SPEED_RAMP_LIMITS = {
	maxPoints: MAX_EDITABLE_CURVE_POINTS,
	maxSpeed: MAXIMUM_SPEED,
	minPoints: 2,
	minSpeed: MINIMUM_SPEED,
} as const;

/** One constant-speed sub-clip of a ramp, as fractions of the clip's source range. */
export interface SpeedRampStep {
	/** Timeline seconds of this step after ramping. */
	duration: number;
	/** Fraction of the source range where this step ends. */
	fromFraction: number;
	speed: number;
	toFraction: number;
}

export interface SpeedRampPlan {
	/** Total ramped timeline seconds: the midpoint integral of `1 / speed`. */
	duration: number;
	steps: SpeedRampStep[];
}

/** Piecewise-linear speed at `t`, holding the first and last point outside the curve. */
export function speedAtFraction(
	points: readonly SpeedRampPoint[],
	t: number
): number {
	const sorted = [...points].sort((a, b) => a.t - b.t);
	const first = sorted[0];
	const last = sorted.at(-1);
	if (!(first && last)) {
		throw new Error("A speed curve needs at least two points.");
	}
	if (t <= first.t) {
		return clampSpeed(first.speed);
	}
	for (let index = 1; index < sorted.length; index++) {
		const previous = sorted[index - 1];
		const next = sorted[index];
		if (!(previous && next) || t > next.t) {
			continue;
		}
		const span = next.t - previous.t;
		const fraction = span > 0 ? (t - previous.t) / span : 1;
		return clampSpeed(
			previous.speed + (next.speed - previous.speed) * fraction
		);
	}
	return clampSpeed(last.speed);
}

/** The curve a request ramps with: a preset, or its own points for `custom`. */
export function speedRampCurve(
	preset: SpeedRampPreset,
	points?: readonly SpeedRampPoint[]
): SpeedRampPoint[] {
	if (preset !== "custom") {
		return SPEED_RAMP_PRESETS[preset].points;
	}
	if (!points || points.length < 2) {
		throw new Error("Add at least two points to a custom speed curve.");
	}
	if (new Set(points.map((point) => point.t)).size !== points.length) {
		throw new Error("Speed curve points need distinct positions.");
	}
	return [...points].sort((a, b) => a.t - b.t);
}

/**
 * Split `sourceSeconds` of media into `steps` equal source slices, each played
 * at the curve's speed at its midpoint.
 */
export function planSpeedRamp(
	sourceSeconds: number,
	points: readonly SpeedRampPoint[],
	steps: number
): SpeedRampPlan {
	if (!(Number.isFinite(sourceSeconds) && sourceSeconds > 0)) {
		throw new Error("A speed ramp needs a clip with source media.");
	}
	const count = Math.trunc(steps);
	const planned: SpeedRampStep[] = [];
	let duration = 0;
	for (let index = 0; index < count; index++) {
		const fromFraction = index / count;
		const toFraction = (index + 1) / count;
		const speed = round6(
			speedAtFraction(points, (fromFraction + toFraction) / 2)
		);
		const stepDuration = (sourceSeconds * (toFraction - fromFraction)) / speed;
		planned.push({ duration: stepDuration, fromFraction, speed, toFraction });
		duration += stepDuration;
	}
	return { duration, steps: planned };
}

function clip(project: Project, id: string) {
	const found = project.segments.find((segment) => segment.id === id);
	if (!found) {
		throw new Error("Clip not found on this timeline.");
	}
	return found;
}

function assetFor(assets: readonly Asset[], segment: Segment) {
	const asset = assets.find((candidate) => candidate.id === segment.assetId);
	if (!asset) {
		throw new Error("A timeline segment references missing media.");
	}
	return asset;
}

function linkedMembers(project: Project, segment: Segment): Segment[] {
	return segment.linkGroupId
		? project.segments.filter(
				(candidate) => candidate.linkGroupId === segment.linkGroupId
			)
		: [segment];
}

function ensureRampable(
	project: Project,
	assets: readonly Asset[],
	members: readonly Segment[]
) {
	const multicamIds = new Set(
		project.multicamGroups.flatMap((group) => group.segmentIds)
	);
	for (const member of members) {
		if (trackSettingFor(project, member.track).locked) {
			throw new Error("Unlock every linked clip track before changing speed.");
		}
		if (member.multicamGroupId || multicamIds.has(member.id)) {
			throw new Error("Multicam clips cannot be speed ramped.");
		}
		if (assetFor(assets, member).kind === "image") {
			throw new Error("Speed ramps need video or audio clips.");
		}
	}
}

/**
 * The clip plus the linked partners on other tracks that play alongside it.
 * Same-track group members (a razor split of the clip) are not partners.
 */
function rampPartners(project: Project, primary: Segment): Segment[] {
	if (!primary.linkGroupId) {
		return [primary];
	}
	const partners = project.segments.filter(
		(candidate) =>
			candidate.id !== primary.id &&
			candidate.linkGroupId === primary.linkGroupId &&
			candidate.track !== primary.track &&
			candidate.start < clipEnd(primary) - EPSILON &&
			clipEnd(candidate) > primary.start + EPSILON
	);
	return [primary, ...partners];
}

/** Linked members must cover the same timeline span to stay in sync while ramping. */
function ensureAligned(project: Project, primary: Segment, members: Segment[]) {
	const tolerance = 0.5 / project.fps;
	for (const member of members) {
		if (
			Math.abs(member.start - primary.start) > tolerance ||
			Math.abs(clipEnd(member) - clipEnd(primary)) > tolerance
		) {
			throw new Error(
				"A linked clip does not line up with this clip (a J or L cut, or a split on only one track). Split it at the same points or unlink first."
			);
		}
	}
}

/** Whether `point` sits on the straight line from `anchor` to `next`. */
function onLine(
	anchor: { time: number; value: number },
	point: { time: number; value: number },
	next: { time: number; value: number }
) {
	const span = next.time - anchor.time;
	if (span <= 0) {
		return false;
	}
	const slope = (next.value - anchor.value) / span;
	const expected = anchor.value + slope * (point.time - anchor.time);
	// Keyframe times are rounded to microseconds, so allow that much drift on steep curves.
	return Math.abs(expected - point.value) <= EPSILON + Math.abs(slope) * 1e-5;
}

/** Whether a point and the interval it starts are plain linear ramps. */
const linear = (point: { interpolation?: string }) =>
	(point.interpolation ?? "linear") === "linear";

/**
 * Keyframes that change the animation: drops points on the line between their
 * neighbours and trailing holds, which render identically without them. Every
 * channel (mask, crop, color, blur, effect amount and pan included) is kept;
 * eased points are never dropped from the middle of a curve.
 */
function essentialKeyframes(segment: Segment): Keyframe[] {
	const kept: Keyframe[] = [];
	for (const group of keyframeGroups(segment.keyframes)) {
		const points = animationPoints(segment, group.property, group.target);
		const result: typeof points = [];
		for (const [index, point] of points.entries()) {
			const anchor = result.at(-1);
			const next = points[index + 1];
			const redundant =
				anchor !== undefined &&
				(next
					? linear(anchor) && linear(point) && onLine(anchor, point, next)
					: Math.abs(point.value - anchor.value) <= EPSILON);
			if (!redundant) {
				result.push(point);
			}
		}
		const real = new Set(segment.keyframes.map((frame) => frame.id));
		kept.push(...result.filter((point) => real.has(point.id)));
	}
	if (kept.length > MAXIMUM_KEYFRAMES) {
		throw new Error(
			"This clip has too many keyframes to change its speed. Remove some keyframes first."
		);
	}
	return kept.sort((a, b) => a.time - b.time);
}

/**
 * Keyframes for one slice of `original` covering clip time `[from, to]`, retimed
 * by `scale` (new seconds per original second). Every channel is sliced with
 * `retimeKeyframes`, so a boundary keyframe carries the value (and the rest of
 * an eased curve) at `from` and `to`; uniform scaling keeps each curve's shape.
 * The legacy clip fields carry their value at `from`, so a step reads the same
 * as a razor split.
 */
function sliceAnimation(
	original: Segment,
	from: number,
	to: number,
	scale: number,
	duration: number
): Pick<Segment, (typeof keyframeProperties)[number] | "keyframes"> {
	const base = Object.fromEntries(
		keyframeProperties.map((property) => [
			property,
			original.keyframes.some((frame) => frame.property === property)
				? animatedValue(original, property, from)
				: original[property],
		])
	) as Record<(typeof keyframeProperties)[number], number>;
	const end = floor6(duration);
	const seen = new Set<string>();
	const keyframes: Keyframe[] = [];
	for (const frame of retimeKeyframes(original, from, to - from)) {
		const time = Math.min(end, round6(frame.time * scale));
		const key = `${frame.property}:${frame.target ?? ""}:${time}`;
		if (seen.has(key)) {
			continue;
		}
		seen.add(key);
		keyframes.push({ ...frame, id: crypto.randomUUID(), time });
	}
	return { ...base, keyframes };
}

/**
 * The clip in/out animation of one ramp step: only the first step plays the
 * in animation and only the last plays the out animation, so the ramp does not
 * replay them at every step boundary. A loop runs on every step.
 */
function stepAnimation(
	animation: Segment["animation"],
	first: boolean,
	last: boolean
): Segment["animation"] {
	if (!animation) {
		return animation;
	}
	const { in: entry, inDuration, out: exit, outDuration, ...rest } = animation;
	const next: NonNullable<Segment["animation"]> = { ...rest };
	if (first && entry !== undefined) {
		next.in = entry;
	}
	if (first && inDuration !== undefined) {
		next.inDuration = inDuration;
	}
	if (last && exit !== undefined) {
		next.out = exit;
	}
	if (last && outDuration !== undefined) {
		next.outDuration = outDuration;
	}
	return Object.keys(next).length ? next : undefined;
}

/** Set or drop the clip animation so an absent one stays absent. */
function withAnimation(
	segment: Segment,
	animation: Segment["animation"]
): Segment {
	const { animation: _previous, ...rest } = segment;
	return animation ? { ...rest, animation } : rest;
}

function rampMember(
	member: Segment,
	primarySpeed: number,
	plan: SpeedRampPlan,
	groupId: string | undefined,
	keepId: boolean
): Segment[] {
	const originalDuration = segmentDuration(member);
	const sourceSeconds = member.sourceOut - member.sourceIn;
	const ratio = member.speed / primarySpeed;
	const boundary = (fraction: number) =>
		fraction >= 1
			? member.sourceOut
			: member.sourceIn + sourceSeconds * fraction;
	const result: Segment[] = [];
	let offset = 0;
	for (const [index, step] of plan.steps.entries()) {
		const speed = round6(step.speed * ratio);
		if (speed < MIN_CLIP_SPEED - EPSILON || speed > MAX_CLIP_SPEED + EPSILON) {
			throw new Error(
				"A linked clip would exceed the 0.1x to 100x clip speed range."
			);
		}
		const sourceIn = boundary(step.fromFraction);
		const sourceOut = boundary(step.toFraction);
		const duration = (sourceOut - sourceIn) / speed;
		if (duration < MINIMUM_CLIP_SECONDS + EPSILON) {
			throw new Error(
				"This clip is too short for that many ramp steps. Use fewer steps."
			);
		}
		const first = index === 0;
		const last = index === plan.steps.length - 1;
		if (
			(first && member.fadeIn > duration + EPSILON) ||
			(last && member.fadeOut > duration + EPSILON)
		) {
			throw new Error(
				"A fade is longer than the ramp's first or last step. Shorten the fade or use fewer steps."
			);
		}
		const sliced: Segment = {
			...member,
			...sliceAnimation(
				member,
				originalDuration * step.fromFraction,
				originalDuration * step.toFraction,
				member.speed / speed,
				duration
			),
			id: first && keepId ? member.id : crypto.randomUUID(),
			linkGroupId: groupId,
			start: round6(member.start + offset),
			sourceIn,
			sourceOut,
			speed,
			fadeIn: first ? member.fadeIn : 0,
			fadeOut: last ? member.fadeOut : 0,
			entryOffset: Math.min(7200, round6(member.entryOffset + offset)),
		};
		// Only the first step keeps the reveal and only the last the exit, each
		// clamped to its step, as a razor split does.
		const rampStep = withAnimation(
			fitEdgeTransitions(sliced, first, last),
			stepAnimation(member.animation, first, last)
		);
		result.push({ ...rampStep, keyframes: essentialKeyframes(rampStep) });
		offset += duration;
	}
	return result;
}

/**
 * Replace `members` with `replacement`, then move later content by the change
 * in length according to `ripple`.
 */
function applyRetime(
	project: Project,
	assets: readonly Asset[],
	members: readonly Segment[],
	replacement: readonly Segment[],
	ripple: SpeedRampRequest["ripple"]
): Project {
	const memberIds = new Set(members.map((segment) => segment.id));
	const pivot = Math.max(...members.map(clipEnd));
	const nextEnd = Math.max(...replacement.map(clipEnd));
	const shift = nextEnd - pivot;
	const tracks = new Set(members.map((segment) => segment.track));
	const others = project.segments.filter(
		(segment) => !memberIds.has(segment.id)
	);
	const isLater = (segment: Segment) => segment.start >= pivot - EPSILON;
	const followers = new Set<string>();
	if (Math.abs(shift) > EPSILON && ripple !== "none") {
		for (const segment of others) {
			if (!isLater(segment)) {
				continue;
			}
			if (ripple === "track" && !tracks.has(segment.track)) {
				continue;
			}
			for (const partner of linkedMembers(project, segment)) {
				followers.add(partner.id);
			}
		}
	}
	if (ripple === "none" && shift > EPSILON) {
		const blocked = others.some(
			(segment) =>
				tracks.has(segment.track) &&
				segment.start < nextEnd - EPSILON &&
				clipEnd(segment) > pivot + EPSILON
		);
		if (blocked) {
			throw new Error(
				"The slower clip would overlap the next clip. Ripple later clips or choose a faster curve."
			);
		}
	}
	for (const segment of others) {
		if (
			followers.has(segment.id) &&
			trackSettingFor(project, segment.track).locked
		) {
			throw new Error("Unlock every track with later clips before rippling.");
		}
	}
	const segments = dissolveOrphanedLinkGroups(
		[
			...others.map((segment) =>
				followers.has(segment.id)
					? { ...segment, start: round6(segment.start + shift) }
					: segment
			),
			...replacement,
		].sort((a, b) => a.track - b.track || a.start - b.start)
	);
	const layers =
		ripple === "timeline" && Math.abs(shift) > EPSILON
			? shiftTimedLayers(project, pivot, shift)
			: {};
	// Tracked region layers move with the source moments they hide.
	return validateProject(
		followTrackedLayers(
			project,
			unpinRemovedLipSyncClips({ ...project, ...layers, segments })
		),
		[...assets]
	);
}

/**
 * Approximate a speed curve by cutting a clip into contiguous constant-speed
 * steps. Linked partners ramp identically and all steps share one new link
 * group; source continuity is exact (each step starts where the last ended).
 */
export function speedRamp(
	project: Project,
	assets: readonly Asset[],
	input: SpeedRampInput
): Project {
	const request = speedRampRequestSchema.parse(input);
	const primary = clip(project, request.clipId);
	const members = rampPartners(project, primary);
	ensureRampable(project, assets, members);
	ensureAligned(project, primary, members);
	if (
		project.segments.length - members.length + members.length * request.steps >
		200
	) {
		throw new Error("This ramp would exceed the timeline's 200 clip limit.");
	}
	const curve = speedRampCurve(request.preset, request.points);
	const plan = planSpeedRamp(
		primary.sourceOut - primary.sourceIn,
		curve,
		request.steps
	);
	return rampWithPlan(project, assets, members, plan, request.ripple);
}

/**
 * Cut `members` (the clip first, then its linked partners) into the steps of
 * `plan`. A curved member is first flattened to its average speed so its
 * steps slice its animation on the right source moments.
 */
function rampWithPlan(
	project: Project,
	assets: readonly Asset[],
	members: readonly Segment[],
	plan: SpeedRampPlan,
	ripple: SpeedRampRequest["ripple"]
): Project {
	const flat = members.map((member) =>
		hasSpeedCurve(member) ? withoutCurve(member, member.speed) : member
	);
	const primary = flat[0];
	if (!primary) {
		throw new Error("Clip not found on this timeline.");
	}
	const groupId = flat.length > 1 ? crypto.randomUUID() : undefined;
	const replacement = flat.flatMap((member) =>
		rampMember(member, primary.speed, plan, groupId, true)
	);
	return applyRetime(project, assets, members, replacement, ripple);
}

export const speedCurveRequestSchema = z
	.object({
		clipId: z.uuid(),
		preset: speedRampPresetSchema,
		points: z
			.array(speedRampPointSchema)
			.min(2)
			.max(MAX_EDITABLE_CURVE_POINTS)
			.optional(),
		/**
		 * Keep pitch (true) or play the curve tape-style (false). Omitted keeps
		 * each clip's current choice (true for a clip without a curve).
		 */
		preservePitch: z.boolean().optional(),
		ripple: speedRampRippleSchema,
		revision: z.number().int().nonnegative(),
	})
	.strict();
export type SpeedCurveRequest = z.infer<typeof speedCurveRequestSchema>;
export type SpeedCurveInput = z.input<typeof speedCurveRequestSchema>;

export const removeSpeedCurveRequestSchema = z
	.object({
		clipId: z.uuid(),
		/** Constant speed for the clip; omitted keeps the curve's length. */
		speed: z
			.number()
			.finite()
			.min(MIN_CLIP_SPEED)
			.max(MAX_CLIP_SPEED)
			.optional(),
		ripple: speedRampRippleSchema,
		revision: z.number().int().nonnegative(),
	})
	.strict();
export type RemoveSpeedCurveInput = z.input<
	typeof removeSpeedCurveRequestSchema
>;

export const bakeSpeedCurveRequestSchema = z
	.object({
		clipId: z.uuid(),
		steps: z.number().int().min(4).max(24).default(12),
		ripple: speedRampRippleSchema,
		revision: z.number().int().nonnegative(),
	})
	.strict();
export type BakeSpeedCurveInput = z.input<typeof bakeSpeedCurveRequestSchema>;

/**
 * `next` (same media and source range as `original`, new timing) with every
 * keyframe kept on the source moment it animated, fades clamped to the new
 * length and edge transitions refitted.
 */
function retimeOnSource(original: Segment, next: Segment): Segment {
	const duration = segmentDuration(next);
	if (duration < MINIMUM_CLIP_SECONDS - EPSILON) {
		throw new Error("This curve would make the clip shorter than a frame.");
	}
	const end = floor6(duration);
	const seen = new Set<string>();
	const keyframes: Keyframe[] = [];
	for (const frame of original.keyframes) {
		const time = Math.min(
			end,
			round6(
				clipTimeAtSourceOffset(next, clipSourceOffset(original, frame.time))
			)
		);
		const key = `${frame.property}:${frame.target ?? ""}:${time}`;
		if (seen.has(key)) {
			continue;
		}
		seen.add(key);
		keyframes.push({ ...frame, time });
	}
	const fadeIn = Math.min(next.fadeIn, duration);
	return fitEdgeTransitions(
		{
			...next,
			fadeIn,
			fadeOut: Math.min(next.fadeOut, Math.max(0, duration - fadeIn)),
			keyframes: keyframes.sort((a, b) => a.time - b.time),
		},
		true,
		true
	);
}

/** The clip at constant `speed` with no curve, animation kept on its source moments. */
function withoutCurve(segment: Segment, speed: number): Segment {
	const { speedCurve: _curve, ...rest } = segment;
	return retimeOnSource(segment, { ...rest, speed: round6(speed) });
}

function checkClipSpeed(speed: number) {
	if (speed < MIN_CLIP_SPEED - EPSILON || speed > MAX_CLIP_SPEED + EPSILON) {
		throw new Error(
			"A linked clip would exceed the 0.1x to 100x clip speed range."
		);
	}
}

/**
 * Give a clip (and the linked partners that play alongside it) a continuous
 * speed curve: it stays one clip whose source is time-remapped along the
 * curve, with every point playing at its own speed. Its length becomes the
 * curve's exact integral, and later clips move by `ripple`.
 */
export function applySpeedCurve(
	project: Project,
	assets: readonly Asset[],
	input: SpeedCurveInput
): Project {
	const request = speedCurveRequestSchema.parse(input);
	const primary = clip(project, request.clipId);
	const members = rampPartners(project, primary);
	ensureRampable(project, assets, members);
	ensureAligned(project, primary, members);
	const points = normalizedCurvePoints(
		speedRampCurve(request.preset, request.points)
	).map((point) => ({ speed: round6(point.speed), t: round6(point.t) }));
	const speed = naturalCurveSpeed(points);
	const replacement = members.map((member) => {
		const memberSpeed = round6((speed * member.speed) / primary.speed);
		checkClipSpeed(memberSpeed);
		const preservePitch =
			request.preservePitch ?? member.speedCurve?.preservePitch;
		return retimeOnSource(member, {
			...member,
			speed: memberSpeed,
			speedCurve:
				preservePitch === false ? { points, preservePitch: false } : { points },
		});
	});
	return applyRetime(project, assets, members, replacement, request.ripple);
}

export const speedCurvePitchRequestSchema = z
	.object({
		clipId: z.uuid(),
		preservePitch: z.boolean(),
		revision: z.number().int().nonnegative(),
	})
	.strict();
export type SpeedCurvePitchInput = z.input<typeof speedCurvePitchRequestSchema>;

/**
 * Switch a curved clip (and its curved linked partners) between pitch kept
 * and tape-style audio. Timing is untouched; only how the audio is resampled
 * changes. `true` drops the field, the default.
 */
export function setSpeedCurvePitch(
	project: Project,
	input: SpeedCurvePitchInput
): Project {
	const request = speedCurvePitchRequestSchema.parse(input);
	if (request.revision !== project.revision) {
		throw new Error("The project changed. Reload before changing the pitch.");
	}
	const primary = clip(project, request.clipId);
	if (!hasSpeedCurve(primary)) {
		throw new Error("This clip has no speed curve.");
	}
	const ids = new Set(
		rampPartners(project, primary)
			.filter((member) => hasSpeedCurve(member))
			.map((member) => member.id)
	);
	return {
		...project,
		segments: project.segments.map((segment) => {
			if (!(ids.has(segment.id) && segment.speedCurve)) {
				return segment;
			}
			const { preservePitch: _previous, ...curve } = segment.speedCurve;
			return {
				...segment,
				speedCurve: request.preservePitch
					? curve
					: { ...curve, preservePitch: false },
			};
		}),
	};
}

/**
 * Return a curved clip (and its curved linked partners) to one constant
 * speed: the curve's average (keeping its length) unless `speed` is given.
 */
export function removeSpeedCurve(
	project: Project,
	assets: readonly Asset[],
	input: RemoveSpeedCurveInput
): Project {
	const request = removeSpeedCurveRequestSchema.parse(input);
	const primary = clip(project, request.clipId);
	if (!hasSpeedCurve(primary)) {
		throw new Error("This clip has no speed curve.");
	}
	const members = rampPartners(project, primary).filter((member) =>
		hasSpeedCurve(member)
	);
	ensureRampable(project, assets, members);
	const target = request.speed ?? primary.speed;
	const replacement = members.map((member) => {
		const memberSpeed = round6((target * member.speed) / primary.speed);
		checkClipSpeed(memberSpeed);
		return withoutCurve(member, memberSpeed);
	});
	return applyRetime(project, assets, members, replacement, request.ripple);
}

/**
 * Bake a curved clip into `steps` contiguous constant-speed clips (the
 * stepped ramp). Each step plays its slice of source at the exact average
 * speed the curve gives it, so the baked clips keep the curve's length.
 */
export function bakeSpeedCurve(
	project: Project,
	assets: readonly Asset[],
	input: BakeSpeedCurveInput
): Project {
	const request = bakeSpeedCurveRequestSchema.parse(input);
	const primary = clip(project, request.clipId);
	if (!hasSpeedCurve(primary)) {
		throw new Error("This clip has no speed curve to bake.");
	}
	const members = rampPartners(project, primary);
	ensureRampable(project, assets, members);
	ensureAligned(project, primary, members);
	if (
		project.segments.length - members.length + members.length * request.steps >
		200
	) {
		throw new Error("Baking would exceed the timeline's 200 clip limit.");
	}
	const source = primary.sourceOut - primary.sourceIn;
	const steps: SpeedRampStep[] = [];
	let duration = 0;
	for (let index = 0; index < request.steps; index++) {
		const fromFraction = index / request.steps;
		const toFraction = (index + 1) / request.steps;
		const time =
			clipTimeAtSourceOffset(primary, source * toFraction) -
			clipTimeAtSourceOffset(primary, source * fromFraction);
		const speed = round6((source * (toFraction - fromFraction)) / time);
		const stepDuration = (source * (toFraction - fromFraction)) / speed;
		steps.push({ duration: stepDuration, fromFraction, speed, toFraction });
		duration += stepDuration;
	}
	return rampWithPlan(
		project,
		assets,
		members,
		{ duration, steps },
		request.ripple
	);
}

/** Structural equality for plain JSON-like values, ignoring key order. */
function sameValue(left: unknown, right: unknown): boolean {
	if (left === right) {
		return true;
	}
	if (Array.isArray(left) && Array.isArray(right)) {
		return (
			left.length === right.length &&
			left.every((item, index) => sameValue(item, right[index]))
		);
	}
	if (
		typeof left !== "object" ||
		typeof right !== "object" ||
		left === null ||
		right === null ||
		Array.isArray(left) ||
		Array.isArray(right)
	) {
		return false;
	}
	const leftRecord = left as Record<string, unknown>;
	const rightRecord = right as Record<string, unknown>;
	const keys = new Set([
		...Object.keys(leftRecord),
		...Object.keys(rightRecord),
	]);
	return [...keys].every((key) => sameValue(leftRecord[key], rightRecord[key]));
}

/** Fields a ramp sets per step; every other field is identical across its steps. */
const stepTimingFields = new Set<string>([
	"id",
	"start",
	"sourceIn",
	"sourceOut",
	"speed",
	"keyframes",
	"fadeIn",
	"fadeOut",
	"entryOffset",
	// The first step keeps the reveal and in animation, the last the exit.
	"transitionIn",
	"exitTransition",
	"exitDuration",
	"animation",
	...keyframeProperties,
]);

/**
 * Whether `next` continues `previous` as one ramp step. Ramp steps share media,
 * track, link group and every non-timing setting; they touch on the timeline,
 * continue source and animation exactly, have no inner fades, and each covers
 * the same `span` of source (the ramp's equal slices). A razor-split sibling of
 * a different length or look is therefore never swallowed.
 */
function continuesStep(
	project: Project,
	previous: Segment,
	next: Segment,
	span: number
) {
	const sameSpan = (segment: Segment) =>
		Math.abs(segment.sourceOut - segment.sourceIn - span) <=
		EPSILON * Math.max(1, span);
	if (
		!(
			sameSpan(previous) &&
			sameSpan(next) &&
			previous.linkGroupId === next.linkGroupId &&
			previous.fadeOut === 0 &&
			next.fadeIn === 0 &&
			Math.abs(clipEnd(previous) - next.start) <= 0.5 / project.fps &&
			Math.abs(previous.sourceOut - next.sourceIn) <= EPSILON
		)
	) {
		return false;
	}
	const previousRecord = previous as Record<string, unknown>;
	const nextRecord = next as Record<string, unknown>;
	const keys = new Set([...Object.keys(previous), ...Object.keys(next)]);
	for (const key of keys) {
		if (
			!(
				stepTimingFields.has(key) ||
				sameValue(previousRecord[key], nextRecord[key])
			)
		) {
			return false;
		}
	}
	const previousEnd = segmentDuration(previous);
	const channels: KeyframeGroup[] = [
		...keyframeProperties.map((property) => ({ property })),
		...keyframeGroups([...previous.keyframes, ...next.keyframes]),
	];
	return channels.every(
		(channel) =>
			Math.abs(
				animatedValue(previous, channel.property, previousEnd, channel.target) -
					animatedValue(next, channel.property, 0, channel.target)
			) <= EPSILON
	);
}

/** The contiguous run of equal-slice steps on one track that contains `segment`. */
function stepRun(project: Project, segment: Segment): Segment[] {
	const span = segment.sourceOut - segment.sourceIn;
	const track = project.segments
		.filter((candidate) => candidate.track === segment.track)
		.sort((a, b) => a.start - b.start);
	let index = track.findIndex((candidate) => candidate.id === segment.id);
	let first = index;
	while (first > 0) {
		const previous = track[first - 1];
		const current = track[first];
		if (
			!(previous && current && continuesStep(project, previous, current, span))
		) {
			break;
		}
		first -= 1;
	}
	const run: Segment[] = [];
	for (index = first; index < track.length; index++) {
		const current = track[index];
		const previous = run.at(-1);
		if (
			!current ||
			(previous && !continuesStep(project, previous, current, span))
		) {
			break;
		}
		run.push(current);
	}
	return run;
}

/** Merge a run of steps into one clip at `speed`, keeping animation on its source moments. */
function mergeRun(run: readonly Segment[], speed: number): Segment {
	const first = run[0];
	const last = run.at(-1);
	if (!(first && last)) {
		throw new Error("This clip has no speed ramp to reset.");
	}
	const duration = (last.sourceOut - first.sourceIn) / speed;
	const end = floor6(duration);
	const seen = new Set<string>();
	const keyframes: Keyframe[] = [];
	for (const step of run) {
		for (const frame of step.keyframes) {
			const source = step.sourceIn + frame.time * step.speed;
			const time = Math.min(end, round6((source - first.sourceIn) / speed));
			const key = `${frame.property}:${frame.target ?? ""}:${time}`;
			if (seen.has(key)) {
				continue;
			}
			seen.add(key);
			keyframes.push({ ...frame, time });
		}
	}
	const fadeIn = Math.min(first.fadeIn, duration);
	const {
		exitDuration: _exitDuration,
		exitTransition: _exitTransition,
		...head
	} = first;
	const tail: Partial<Segment> = {};
	if (last.exitTransition !== undefined) {
		tail.exitTransition = last.exitTransition;
	}
	if (last.exitDuration !== undefined) {
		tail.exitDuration = last.exitDuration;
	}
	const animation =
		first.animation || last.animation
			? stepAnimation(
					{
						...stepAnimation(first.animation, true, false),
						...stepAnimation(last.animation, false, true),
					},
					true,
					true
				)
			: undefined;
	const merged = withAnimation(
		fitEdgeTransitions(
			{
				...head,
				...tail,
				sourceOut: last.sourceOut,
				speed: round6(speed),
				fadeIn,
				fadeOut: Math.min(last.fadeOut, Math.max(0, duration - fadeIn)),
				keyframes,
			},
			true,
			true
		),
		animation
	);
	return { ...merged, keyframes: essentialKeyframes(merged) };
}

/**
 * Merge a speed ramp back into one constant-speed clip. A ramp is identified
 * by its signature: the chosen clip plus every neighbour on its track that
 * touches it, continues its source and animation exactly, matches every
 * non-timing setting, and covers the same length of source (ramp steps are
 * equal source slices, so an even through edit merges too). Linked partner
 * runs merge with it. Without `speed`, the merged clip keeps the ramp's length.
 */
export function resetSpeedRamp(
	project: Project,
	assets: readonly Asset[],
	input: ResetSpeedRampInput
): Project {
	const request = resetSpeedRampRequestSchema.parse(input);
	const target = clip(project, request.clipId);
	const run = stepRun(project, target);
	if (run.length < 2) {
		throw new Error("This clip has no speed ramp to reset.");
	}
	const runs = [run];
	if (
		target.linkGroupId &&
		project.segments.some(
			(segment) =>
				segment.track === target.track &&
				segment.linkGroupId === target.linkGroupId &&
				!run.includes(segment)
		)
	) {
		throw new Error(
			"Linked ramp steps are no longer contiguous. Unlink them to reset."
		);
	}
	if (target.linkGroupId) {
		const partnerTracks = new Set(
			linkedMembers(project, target)
				.map((segment) => segment.track)
				.filter((track) => track !== target.track)
		);
		for (const track of partnerTracks) {
			const onTrack = project.segments.filter(
				(segment) =>
					segment.track === track && segment.linkGroupId === target.linkGroupId
			);
			const first = onTrack.sort((a, b) => a.start - b.start)[0];
			const partnerRun = first ? stepRun(project, first) : [];
			if (partnerRun.length !== onTrack.length) {
				throw new Error(
					"Linked ramp steps are no longer contiguous. Unlink them to reset."
				);
			}
			runs.push(partnerRun);
		}
	}
	const members = runs.flat();
	ensureRampable(project, assets, members);
	const rampStart = Math.min(...run.map((segment) => segment.start));
	const rampLength = Math.max(...run.map(clipEnd)) - rampStart;
	const primarySource = (run.at(-1)?.sourceOut ?? 0) - (run[0]?.sourceIn ?? 0);
	const primarySpeed = clampSpeed(request.speed ?? primarySource / rampLength);
	const replacement = runs.map((steps, index) => {
		const source = (steps.at(-1)?.sourceOut ?? 0) - (steps[0]?.sourceIn ?? 0);
		const speed =
			index === 0 ? primarySpeed : (source / primarySource) * primarySpeed;
		if (speed < MINIMUM_SPEED - EPSILON || speed > MAXIMUM_SPEED + EPSILON) {
			throw new Error(
				"A linked clip would exceed the 0.1x to 10x speed range."
			);
		}
		return mergeRun(steps, clampSpeed(speed));
	});
	// A lip-sync link to any step follows it into the merged clip.
	const mergedId = new Map(
		runs.flatMap((steps, index) =>
			steps.map((step) => [step.id, replacement[index]?.id ?? step.id] as const)
		)
	);
	const relinked: Project = {
		...project,
		avatars: project.avatars.map((avatar) => {
			const segmentId = avatar.lipSync?.segmentId;
			const target = segmentId ? mergedId.get(segmentId) : undefined;
			return avatar.lipSync && target
				? { ...avatar, lipSync: { ...avatar.lipSync, segmentId: target } }
				: avatar;
		}),
	};
	return applyRetime(relinked, assets, members, replacement, request.ripple);
}
