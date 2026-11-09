import { z } from "zod";
import {
	type AnimationCurves,
	type AnimationFrame,
	animationCurves,
	animationFrameAt,
} from "./clip-animation.ts";
import {
	type Asset,
	type Project,
	retimeKeyframes,
	type Segment,
	segmentDuration,
	trackSettingFor,
	validateProject,
} from "./project.ts";
import {
	isShapedReveal,
	pushExitOf,
	revealBlurExpr,
	revealCoverageExpr,
	revealOffsetExpr,
	revealScaleExpr,
} from "./reveal-transitions.ts";
import {
	type EdgeTransition,
	type TransitionIn,
	transitionInSchema,
} from "./schema/transition.ts";
import {
	add,
	div,
	type Expr,
	max,
	mul,
	smooth,
	sub,
	unit,
} from "./transition-expr.ts";

function direction(segment: Segment, axis: "x" | "y") {
	if (axis === "x") {
		return segment.entryTransition === "slide-left"
			? 1
			: segment.entryTransition === "slide-right"
				? -1
				: 0;
	}
	return segment.entryTransition === "slide-up"
		? 1
		: segment.entryTransition === "slide-down"
			? -1
			: 0;
}

export function entryProgress(segment: Segment, elapsed: number): number {
	if (!segment.entryDuration) {
		return 1;
	}
	return Math.max(
		0,
		Math.min(1, (elapsed + segment.entryOffset) / segment.entryDuration)
	);
}

export function entryOpacity(segment: Segment, elapsed: number): number {
	return segment.entryTransition === "crossfade"
		? entryProgress(segment, elapsed)
		: 1;
}

export function entryScale(segment: Segment, elapsed: number): number {
	const progress = entryProgress(segment, elapsed);
	if (segment.entryTransition === "zoom-in" && segment.entryDuration > 0) {
		return 0.85 + progress * 0.15;
	}
	if (segment.entryTransition === "zoom-out" && segment.entryDuration > 0) {
		return 1.15 - progress * 0.15;
	}
	return 1;
}

/** Translation in output-frame widths/heights, independent of source speed. */
export function entryShift(
	segment: Segment,
	elapsed: number,
	axis: "x" | "y"
): number {
	if (!segment.entryDuration) {
		return 0;
	}
	return direction(segment, axis) * (1 - entryProgress(segment, elapsed));
}

export function entryScaleExpression(
	segment: Segment,
	elapsed: string
): string {
	if (segment.entryTransition === "zoom-in") {
		return `(0.85+0.15*clip(((${elapsed})+${segment.entryOffset})/${segment.entryDuration},0,1))`;
	}
	if (segment.entryTransition === "zoom-out") {
		return `(1.15-0.15*clip(((${elapsed})+${segment.entryOffset})/${segment.entryDuration},0,1))`;
	}
	return "1";
}

export function entryExpression(
	segment: Segment,
	axis: "x" | "y",
	elapsed: string
): string {
	const value = direction(segment, axis);
	if (!(value && segment.entryDuration)) {
		return "0";
	}
	return `${value}*(1-clip(((${elapsed})+${segment.entryOffset})/${segment.entryDuration},0,1))`;
}

// ---------------------------------------------------------------------------
// W2-V10: exit transitions, reveal transitions and clip animations.
// The legacy entry functions above keep their exact strings (render golden).
// ---------------------------------------------------------------------------

export const DEFAULT_EXIT_DURATION = 0.5;

/**
 * Exit duration with its default, never longer than the clip (an unset
 * duration on a clip shorter than the default would otherwise start the exit
 * before the clip); 0 when the clip has no exit transition.
 */
export function exitDurationOf(segment: Segment): number {
	if (!segment.exitTransition || segment.exitTransition === "none") {
		return 0;
	}
	return Math.min(
		segment.exitDuration ?? DEFAULT_EXIT_DURATION,
		segmentDuration(segment)
	);
}

/**
 * Exit progress `q` over clip-local `t`: 1 until the exit starts, 0 at the
 * clip's end. Eased like reveals so a push's outgoing clip stays butted to the
 * incoming one.
 */
function exitProgressExpr(segment: Segment, length: number): Expr {
	return smooth(unit(div(sub(length, "t"), exitDurationOf(segment))));
}

/**
 * Exits mirror the entry set at the clip end: `crossfade` fades out, slides
 * leave in the named direction, and both zooms shrink to 85% (`zoom-out` also
 * fades). Growing exits are not offered: the transform stage sizes the
 * transparent pad for the clip's own scale.
 */
function exitScaleExpr(segment: Segment, length: number): Expr {
	const kind = segment.exitTransition;
	if (
		exitDurationOf(segment) === 0 ||
		(kind !== "zoom-in" && kind !== "zoom-out")
	) {
		return 1;
	}
	return add(0.85, mul(0.15, exitProgressExpr(segment, length)));
}

/** Whether the exit fades the clip's alpha (rendered with `fade=t=out`). */
export function exitFades(segment: Segment): boolean {
	return (
		exitDurationOf(segment) > 0 &&
		(segment.exitTransition === "crossfade" ||
			segment.exitTransition === "zoom-out")
	);
}

/** Linear fade-out multiplier of a fading exit, matching FFmpeg `fade`. */
function exitOpacityExpr(segment: Segment, length: number): Expr {
	if (!exitFades(segment)) {
		return 1;
	}
	return unit(div(sub(length, "t"), exitDurationOf(segment)));
}

const exitDirections: Partial<Record<EdgeTransition, [number, number]>> = {
	"slide-down": [0, 1],
	"slide-left": [-1, 0],
	"slide-right": [1, 0],
	"slide-up": [0, -1],
};

function exitShiftExpr(
	segment: Segment,
	length: number,
	axis: "x" | "y"
): Expr {
	const direction = segment.exitTransition
		? exitDirections[segment.exitTransition]
		: undefined;
	const sign = direction?.[axis === "x" ? 0 : 1] ?? 0;
	if (sign === 0 || exitDurationOf(segment) === 0) {
		return 0;
	}
	return mul(sign, sub(1, exitProgressExpr(segment, length)));
}

/**
 * Every W2-V10 motion of one clip as curves over clip-local `t`: the reveal
 * transition (zoom, slide, push, blur, and the whole-frame dissolve alpha),
 * the exit transition, and the in/out/loop animation. Shaped reveal alphas
 * and fades through a color are per-pixel and live in
 * `./reveal-transitions.ts`; `opacity` here excludes them.
 */
export type ClipMotion = AnimationCurves;

export function clipMotion(segment: Segment, length: number): ClipMotion {
	const animation = animationCurves(segment.animation, length);
	const reveal = segment.transitionIn;
	const dissolve =
		reveal && !isShapedReveal(reveal.type) ? revealCoverageExpr(reveal) : 1;
	return {
		blur: reveal
			? maxExpr(animation.blur, revealBlurExpr(reveal))
			: animation.blur,
		opacity: mul(animation.opacity, dissolve, exitOpacityExpr(segment, length)),
		rotation: animation.rotation,
		scale: mul(
			animation.scale,
			reveal ? revealScaleExpr(reveal) : 1,
			exitScaleExpr(segment, length)
		),
		shiftX: add(
			animation.shiftX,
			reveal ? revealOffsetExpr(reveal, "x") : 0,
			exitShiftExpr(segment, length, "x")
		),
		shiftY: add(
			animation.shiftY,
			reveal ? revealOffsetExpr(reveal, "y") : 0,
			exitShiftExpr(segment, length, "y")
		),
	};
}

const maxExpr = (a: Expr, b: Expr): Expr => {
	if (a === 0) {
		return b;
	}
	return b === 0 ? a : max(a, b);
};

/** Numeric `clipMotion` at clip-local `elapsed` seconds (the preview). */
export function clipMotionAt(
	segment: Segment,
	elapsed: number
): AnimationFrame {
	return animationFrameAt(
		clipMotion(segment, segmentDuration(segment)),
		elapsed
	);
}

// ---------------------------------------------------------------------------
// Applying a reveal transition to a cut.
// ---------------------------------------------------------------------------

const CUT_TOLERANCE = 1e-3;
const clipEnd = (segment: Segment) => segment.start + segmentDuration(segment);
const round6 = (value: number) => Number(value.toFixed(6));

/**
 * The clip a reveal on `incoming` plays over: the same-track clip that starts
 * before it and reaches its start (touching or overlapping), latest end first.
 */
export function cutPredecessor(
	project: Pick<Project, "segments">,
	incoming: Segment
): Segment | undefined {
	const tolerance = Math.max(CUT_TOLERANCE, 0.5 / 120);
	let best: Segment | undefined;
	for (const other of project.segments) {
		if (
			other.id === incoming.id ||
			other.track !== incoming.track ||
			other.start >= incoming.start ||
			clipEnd(other) < incoming.start - tolerance
		) {
			continue;
		}
		if (!best || clipEnd(other) > clipEnd(best)) {
			best = other;
		}
	}
	return best;
}

/**
 * The cut nearest `time` on `track`: the clip that starts within `tolerance`
 * seconds of it and has a predecessor (a drop target for the gallery).
 */
export function cutNear(
	project: Pick<Project, "segments">,
	track: number,
	time: number,
	tolerance: number
): { incoming: Segment; outgoing: Segment } | undefined {
	let found: { incoming: Segment; outgoing: Segment } | undefined;
	let distance = Number.POSITIVE_INFINITY;
	for (const segment of project.segments) {
		if (segment.track !== track) {
			continue;
		}
		const gap = Math.abs(segment.start - time);
		const outgoing =
			gap <= tolerance ? cutPredecessor(project, segment) : undefined;
		if (outgoing && gap < distance) {
			found = { incoming: segment, outgoing };
			distance = gap;
		}
	}
	return found;
}

const isStill = (asset: Asset) => asset.kind === "image";

function assetOf(assets: readonly Asset[], segment: Segment): Asset {
	const asset = assets.find((candidate) => candidate.id === segment.assetId);
	if (!asset) {
		throw new Error("A timeline segment references missing media.");
	}
	return asset;
}

/**
 * The clip and its linked visual partners (same `linkGroupId`). Linked audio
 * stays at the original cut: extending it would stack the outgoing and
 * incoming audio on the same track for the whole transition. Shifting
 * `start` and `sourceIn` together keeps the visual in sync with that audio.
 */
function withVisualPartners(
	project: Project,
	assets: readonly Asset[],
	segment: Segment
): Segment[] {
	if (!segment.linkGroupId) {
		return [segment];
	}
	return project.segments.filter(
		(other) =>
			other.id === segment.id ||
			(other.linkGroupId === segment.linkGroupId &&
				assetOf(assets, other).kind !== "audio")
	);
}

/** Extend the head of a clip left by `seconds`, or undefined without source. */
function extendHead(
	segment: Segment,
	asset: Asset,
	seconds: number
): Segment | undefined {
	const source = seconds * segment.speed;
	const start = round6(segment.start - seconds);
	if (start < -1e-9) {
		return;
	}
	const still = isStill(asset);
	if (!still && segment.sourceIn - source < -1e-9) {
		return;
	}
	const extended: Segment = still
		? { ...segment, sourceOut: round6(segment.sourceOut + source), start }
		: {
				...segment,
				sourceIn: round6(Math.max(0, segment.sourceIn - source)),
				start,
			};
	return {
		...extended,
		keyframes: retimeKeyframes(segment, -seconds, segmentDuration(extended)),
	};
}

/** Extend the tail of a clip right by `seconds`, or undefined without source. */
function extendTail(
	segment: Segment,
	asset: Asset,
	seconds: number
): Segment | undefined {
	const sourceOut = round6(segment.sourceOut + seconds * segment.speed);
	if (!isStill(asset) && sourceOut > asset.duration + 1e-6) {
		return;
	}
	return { ...segment, sourceOut };
}

/** Extend every member by `seconds`, or undefined when any one cannot. */
function extendAll(
	assets: readonly Asset[],
	members: Segment[],
	extend: typeof extendHead,
	seconds: number
): Map<string, Segment> | undefined {
	const changed = new Map<string, Segment>();
	for (const member of members) {
		const next = extend(member, assetOf(assets, member), seconds);
		if (!next) {
			return;
		}
		changed.set(member.id, next);
	}
	return changed;
}

/**
 * Make `outgoing` overlap `incoming` by at least `duration`. The incoming
 * clip (with its linked visual partners) extends its head left, roll-style, so the
 * program keeps its length and the cut point moves earlier; when it has no
 * source before its in point, the outgoing clip extends its tail instead.
 */
function overlapFor(
	project: Project,
	assets: readonly Asset[],
	incoming: Segment,
	outgoing: Segment,
	duration: number
): Map<string, Segment> {
	const missing = round6(duration - (clipEnd(outgoing) - incoming.start));
	if (missing <= CUT_TOLERANCE) {
		return new Map();
	}
	if (outgoing.start < incoming.start - missing - 1e-6) {
		const head = extendAll(
			assets,
			withVisualPartners(project, assets, incoming),
			extendHead,
			missing
		);
		if (head) {
			return head;
		}
	}
	const tail = extendAll(
		assets,
		withVisualPartners(project, assets, outgoing),
		extendTail,
		missing
	);
	if (tail) {
		return tail;
	}
	throw new Error(
		`Neither clip has ${missing.toFixed(2)} s of extra media for this transition. Shorten the transition or trim the clips first.`
	);
}

const pairedPushExit = (outgoing: Segment, transition: TransitionIn) =>
	pushExitOf(transition.type) !== undefined &&
	outgoing.exitTransition === pushExitOf(transition.type) &&
	outgoing.exitDuration === transition.duration;

/**
 * The agent's equivalent of a gallery drop on a cut or the inspector's
 * "Transition in" control: set or (with `null`) remove the reveal transition
 * on the cut into `clipId`, with the current project revision.
 */
export const revealTransitionRequestSchema = z
	.object({
		clipId: z.uuid(),
		revision: z.number().int().nonnegative(),
		transition: transitionInSchema.nullable(),
	})
	.strict();
export type RevealTransitionRequest = z.infer<
	typeof revealTransitionRequestSchema
>;

/**
 * Set (or with `transition: null`, remove) the reveal transition on the cut
 * into `clipId`. Adding one creates the overlap it needs (see `overlapFor`);
 * a push also gives the outgoing clip the matching exit slide. Removing keeps
 * the overlap (the incoming clip simply covers the outgoing tail) and clears
 * a paired push exit. The result is validated.
 */
export function applyRevealTransition(
	project: Project,
	assets: readonly Asset[],
	clipId: string,
	transition: TransitionIn | null
): Project {
	const incoming = project.segments.find((segment) => segment.id === clipId);
	if (!incoming) {
		throw new Error("Clip not found on this timeline.");
	}
	if (assetOf(assets, incoming).kind === "audio") {
		throw new Error("Transitions apply to video and image clips.");
	}
	const outgoing = cutPredecessor(project, incoming);
	const locked = [incoming, outgoing].some(
		(segment) => segment && trackSettingFor(project, segment.track).locked
	);
	if (locked) {
		throw new Error("Unlock the track before changing its transitions.");
	}
	if (!outgoing) {
		if (transition) {
			throw new Error(
				"Place the clip right after another clip on its track to add a transition."
			);
		}
		const { transitionIn: _removed, ...rest } = incoming;
		return validateProject(
			{
				...project,
				segments: project.segments.map((segment) =>
					segment.id === clipId ? rest : segment
				),
			},
			[...assets]
		);
	}
	const changed = transition
		? overlapFor(project, assets, incoming, outgoing, transition.duration)
		: new Map<string, Segment>();
	const nextIncoming = changed.get(incoming.id) ?? incoming;
	let nextOutgoing = changed.get(outgoing.id) ?? outgoing;
	if (
		incoming.transitionIn &&
		pairedPushExit(outgoing, incoming.transitionIn)
	) {
		const {
			exitDuration: _duration,
			exitTransition: _exit,
			...rest
		} = nextOutgoing;
		nextOutgoing = rest;
	}
	const push = transition ? pushExitOf(transition.type) : undefined;
	if (transition && push) {
		nextOutgoing = {
			...nextOutgoing,
			exitDuration: transition.duration,
			exitTransition: push,
		};
	}
	const { transitionIn: _previous, ...bare } = nextIncoming;
	const updatedIncoming: Segment = transition
		? { ...bare, transitionIn: transition }
		: bare;
	changed.set(incoming.id, updatedIncoming);
	changed.set(outgoing.id, nextOutgoing);
	ensureUnlocked(project, changed.values());
	return validateProject(
		{
			...project,
			segments: incomingAfterOutgoing(
				project.segments.map((segment) => changed.get(segment.id) ?? segment),
				incoming.id,
				outgoing.id
			),
		},
		[...assets]
	);
}

/** Every clip the transition edits (partners included) must be unlocked. */
function ensureUnlocked(project: Project, segments: Iterable<Segment>) {
	for (const segment of segments) {
		if (trackSettingFor(project, segment.track).locked) {
			throw new Error("Unlock the track before changing its transitions.");
		}
	}
}

/**
 * Same-track layers stack in array order in the preview, so the incoming
 * clip must follow the clip it reveals over (the render sorts by start and
 * agrees). Moves only the incoming clip, and only when it is ahead.
 */
function incomingAfterOutgoing(
	segments: Segment[],
	incomingId: string,
	outgoingId: string
): Segment[] {
	const from = segments.findIndex((segment) => segment.id === incomingId);
	const after = segments.findIndex((segment) => segment.id === outgoingId);
	if (from < 0 || after < 0 || from > after) {
		return segments;
	}
	const moved = segments[from] as Segment;
	const rest = segments.filter((segment) => segment.id !== incomingId);
	rest.splice(after, 0, moved);
	return rest;
}
