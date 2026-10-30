/**
 * AI transition gap fill (W4-G2): a generated still bridges the cut or gap
 * between a clip (A) and the next picture clip on its track (B).
 *
 * The editor captures A's last frame and B's first frame, asks the host image
 * model for an intermediate still with both as `input_images`, and imports
 * it. `applyGapFill` then places that still on A's track so it overlaps A's
 * tail and B's head, dissolves it in over A, dissolves B in over it, and
 * gives it a slow Ken Burns push (`scale` keyframes). Nothing else moves, so
 * the timeline length and every other clip are unchanged.
 *
 * Placement (all times on the timeline):
 * - with a gap, the still fills it and overlaps each neighbour;
 * - at a cut, the still sits over the cut (a 1 s bridge by default).
 * An explicit `duration` centres the still on the gap or cut; otherwise each
 * side overlaps by `DEFAULT_GAP_FILL_OVERLAP`, shortened to fit short clips.
 *
 * "Generate motion" (G79) is the video variant: the sidecar extracts the
 * exact last frame A shows and the exact first frame B shows
 * (`gapFillBoundaryFrames`), a first/last-frame video model animates between
 * them, and `applyGapFill` places the returned clip so it fills the gap
 * exactly, trimmed (or slowed) to the gap length, with hard cuts on both
 * sides because its first and last frames already match the neighbours. The
 * still bridge stays the fallback, and the only option at a plain cut.
 *
 * Everything here is pure and deterministic so the route, the editor, and
 * tests share one definition.
 */
import { z } from "zod";
import { MIN_CLIP_SPEED } from "./audio.ts";
import {
	type GenerationRequest,
	generationRequestSchema,
} from "./generation.ts";
import {
	assetFrameRate,
	frameAtTime,
	lastFrameBefore,
} from "./generation-inputs.ts";
import {
	type Asset,
	idSchema,
	newSegment,
	type Project,
	type Segment,
	segmentDuration,
	trackSettingFor,
	validateProject,
} from "./project.ts";
import {
	newRevealTransition,
	type TransitionIn,
} from "./reveal-transitions.ts";

/** Seconds each side of the still overlaps a neighbour by default. */
export const DEFAULT_GAP_FILL_OVERLAP = 0.5;
/** Default end scale of the Ken Burns push (start scale is 1). */
export const DEFAULT_GAP_FILL_ZOOM = 1.1;
/** Shortest overlap a dissolve can use (the reveal transition minimum). */
export const MIN_GAP_FILL_OVERLAP = 0.04;
/** Longest reveal transition the schema accepts. */
const MAX_DISSOLVE = 5;
/** A still keeps at least this much of A visible before it starts. */
const MIN_HEAD = 0.04;
/** Edges closer than this are a cut, not a gap or an overlap. */
const EDGE_EPSILON = 1e-6;

export const gapFillRequestSchema = z
	.object({
		/** Clip A: the still bridges from its end to the next clip on its track. */
		afterClipId: idSchema,
		/** The library still to place (usually the generated bridge). */
		assetId: idSchema,
		/** Total still length in seconds; centred on the gap or cut when set. */
		duration: z.number().finite().min(0.08).max(30).optional(),
		/** Dissolve length on each side; clamped to the overlap. */
		transitionDuration: z.number().finite().min(0.04).max(5).optional(),
		/** End scale of the Ken Burns push; 1 holds the still steady. */
		zoom: z.number().finite().min(1).max(1.5).optional(),
		revision: z.number().int().nonnegative(),
	})
	.strict();
export type GapFillRequest = z.infer<typeof gapFillRequestSchema>;
export type GapFillInput = z.input<typeof gapFillRequestSchema>;

/** The two clips a gap fill bridges. */
export interface GapFillNeighbors {
	/** Seconds between A's end and B's start; 0 at a cut. */
	gap: number;
	next: Segment;
	previous: Segment;
}

/** Where the still goes and how it dissolves. */
export interface GapFillPlan {
	/** Dissolve from A into the still (the still's `transitionIn`). */
	dissolveIn: number;
	/** Dissolve from the still into B (B's `transitionIn`). */
	dissolveOut: number;
	end: number;
	gap: number;
	mode: "cut" | "gap";
	nextClipId: string;
	/** Seconds the still overlaps A's tail. */
	overlapIn: number;
	/** Seconds the still overlaps B's head. */
	overlapOut: number;
	previousClipId: string;
	start: number;
	track: number;
}

export interface GapFillResult {
	clipId: string;
	plan: GapFillPlan;
	project: Project;
}

const segmentEnd = (segment: Segment) =>
	segment.start + segmentDuration(segment);

const isPicture = (segment: Segment, assets: readonly Asset[]) => {
	const asset = assets.find((candidate) => candidate.id === segment.assetId);
	return asset !== undefined && asset.kind !== "audio";
};

/**
 * Clip `clipId` and the next picture clip that starts after it on the same
 * track. Throws with an editor-facing reason when there is nothing to
 * bridge: an audio clip, no following clip, or neighbours that already
 * overlap (a transition is already there).
 */
export function gapFillNeighbors(
	project: Pick<Project, "segments">,
	assets: readonly Asset[],
	clipId: string
): GapFillNeighbors {
	const previous = project.segments.find((segment) => segment.id === clipId);
	if (!previous) {
		throw new Error("Clip not found on this timeline.");
	}
	if (!isPicture(previous, assets)) {
		throw new Error("Gap fill bridges picture clips, not audio clips.");
	}
	let next: Segment | undefined;
	for (const segment of project.segments) {
		if (
			segment.id !== previous.id &&
			segment.track === previous.track &&
			segment.start > previous.start &&
			isPicture(segment, assets) &&
			(!next ||
				segment.start < next.start ||
				(segment.start === next.start && segment.id < next.id))
		) {
			next = segment;
		}
	}
	if (!next) {
		throw new Error("Gap fill needs a following clip on the same track.");
	}
	const gap = next.start - segmentEnd(previous);
	if (gap < -EDGE_EPSILON) {
		throw new Error(
			"These clips already overlap. Remove the transition between them before filling the gap."
		);
	}
	return { gap: Math.max(0, gap), next, previous };
}

/** Whether `clipId` has a following clip a gap fill could bridge to. */
export function canGapFill(
	project: Pick<Project, "segments">,
	assets: readonly Asset[],
	clipId: string
): boolean {
	try {
		gapFillNeighbors(project, assets, clipId);
		return true;
	} catch {
		return false;
	}
}

/** Round to microseconds so placement stays stable through JSON. */
const settle = (value: number) => Math.round(value * 1e6) / 1e6;

/**
 * Plan the still's placement and dissolves for bridging after `clipId`.
 * Pure: no project is changed.
 */
export function planGapFill(
	project: Pick<Project, "segments">,
	assets: readonly Asset[],
	input: Pick<GapFillRequest, "afterClipId" | "duration" | "transitionDuration">
): GapFillPlan {
	const { gap, next, previous } = gapFillNeighbors(
		project,
		assets,
		input.afterClipId
	);
	const previousEnd = segmentEnd(previous);
	const maxIn = segmentDuration(previous) - MIN_HEAD;
	const maxOut = segmentDuration(next);
	let overlapIn: number;
	let overlapOut: number;
	if (input.duration === undefined) {
		overlapIn = Math.min(DEFAULT_GAP_FILL_OVERLAP, maxIn);
		overlapOut = Math.min(DEFAULT_GAP_FILL_OVERLAP, maxOut);
	} else {
		if (input.duration <= gap + 2 * MIN_GAP_FILL_OVERLAP) {
			throw new Error(
				`The bridge must be longer than the ${gap.toFixed(2)}s gap plus a dissolve on each side.`
			);
		}
		overlapIn = (input.duration - gap) / 2;
		overlapOut = overlapIn;
		if (overlapIn > maxIn || overlapOut > maxOut) {
			throw new Error(
				"The bridge overlaps its neighbours by more than they last. Choose a shorter duration."
			);
		}
	}
	if (overlapIn < MIN_GAP_FILL_OVERLAP || overlapOut < MIN_GAP_FILL_OVERLAP) {
		throw new Error("The neighbouring clips are too short for a dissolve.");
	}
	const start = settle(previousEnd - overlapIn);
	const end = settle(next.start + overlapOut);
	// Durations are re-derived from the settled edges so each dissolve fits
	// the overlap the validator measures.
	const settledIn = settle(previousEnd - start);
	const settledOut = settle(end - next.start);
	const dissolve = (overlap: number) =>
		settle(
			Math.max(
				MIN_GAP_FILL_OVERLAP,
				Math.min(input.transitionDuration ?? overlap, overlap, MAX_DISSOLVE)
			)
		);
	return {
		dissolveIn: dissolve(settledIn),
		dissolveOut: dissolve(settledOut),
		end,
		gap: settle(gap),
		mode: gap > EDGE_EPSILON ? "gap" : "cut",
		nextClipId: next.id,
		overlapIn: settledIn,
		overlapOut: settledOut,
		previousClipId: previous.id,
		start,
		track: previous.track,
	};
}

/** The dissolve a gap fill sets on the still and on B. */
export const gapFillDissolve = (duration: number): TransitionIn =>
	newRevealTransition("dissolve", duration);

/**
 * Ken Burns `scale` keyframes over a still of `length` seconds: 1 at the
 * start, `zoom` at the end. No keyframes when `zoom` is 1.
 */
export function kenBurnsKeyframes(
	length: number,
	zoom: number,
	newId: () => string
): Segment["keyframes"] {
	if (zoom <= 1) {
		return [];
	}
	return [
		{ id: newId(), property: "scale", time: 0, value: 1 },
		{ id: newId(), property: "scale", time: settle(length), value: zoom },
	];
}

/**
 * Place still `assetId` between `afterClipId` and the next clip on its
 * track: the still dissolves in over A, B dissolves in over the still, and
 * the still pushes in slowly. Validates the result.
 */
export function applyGapFill(
	project: Project,
	assets: readonly Asset[],
	input: GapFillInput,
	newId: () => string = () => crypto.randomUUID()
): GapFillResult {
	const request = gapFillRequestSchema.parse(input);
	const still = assets.find((asset) => asset.id === request.assetId);
	if (!still) {
		throw new Error("The bridge still is not in the library.");
	}
	if (still.sequenceProjectId || still.kind === "audio") {
		throw new Error(
			"Gap fill places a still image or a generated motion clip."
		);
	}
	if (still.kind === "video") {
		return applyGapFillMotion(project, assets, request, still, newId);
	}
	const plan = planGapFill(project, assets, request);
	if (trackSettingFor(project, plan.track).locked) {
		throw new Error("Unlock the clip track before filling the gap.");
	}
	const length = settle(plan.end - plan.start);
	const clipId = newId();
	const bridge: Segment = {
		...newSegment(still, plan.start, plan.track),
		fit: "fill",
		id: clipId,
		keyframes: kenBurnsKeyframes(
			length,
			request.zoom ?? DEFAULT_GAP_FILL_ZOOM,
			newId
		),
		label: "AI bridge",
		sourceOut: length,
		transitionIn: gapFillDissolve(plan.dissolveIn),
	};
	// Same-track layers stack in array order in the preview (the render sorts
	// by start), so keep A, then the bridge, then B: B moves after the bridge
	// only when it was ahead of A.
	const segments: Segment[] = [];
	let deferredNext: Segment | undefined;
	let seenPrevious = false;
	for (const segment of project.segments) {
		if (segment.id === plan.nextClipId) {
			const next = {
				...segment,
				transitionIn: gapFillDissolve(plan.dissolveOut),
			};
			if (seenPrevious) {
				segments.push(next);
			} else {
				deferredNext = next;
			}
			continue;
		}
		segments.push(segment);
		if (segment.id === plan.previousClipId) {
			seenPrevious = true;
			segments.push(bridge);
			if (deferredNext) {
				segments.push(deferredNext);
			}
		}
	}
	return {
		clipId,
		plan,
		project: validateProject({ ...project, segments }, [...assets]),
	};
}

/** Fewest frames of gap a motion bridge fills. */
export const MIN_MOTION_GAP_FRAMES = 2;

/** Longest motion clip asked of a model, in seconds. */
export const MAX_MOTION_BRIDGE_SECONDS = 10;
/**
 * Widest gap Generate motion can fill: the longest clip slowed to
 * `MIN_CLIP_SPEED`. Wider gaps would leave a hole, so they are refused.
 */
export const MAX_MOTION_GAP_SECONDS =
	MAX_MOTION_BRIDGE_SECONDS / MIN_CLIP_SPEED;

/**
 * Frames and rate of a local motion clip. Generate motion sends the local
 * engine no frame count, so Core renders its `vid_gen` default: 33 frames at
 * 16 fps.
 */
export const LOCAL_MOTION_FRAMES = 33;
export const LOCAL_MOTION_FPS = 16;
/** Length of the clip the local engine returns, in seconds (about 2.06 s). */
export const LOCAL_MOTION_CLIP_SECONDS = LOCAL_MOTION_FRAMES / LOCAL_MOTION_FPS;
/**
 * Widest gap a local motion clip can fill: the local clip slowed to
 * `MIN_CLIP_SPEED` (about 20.6 s).
 */
export const MAX_LOCAL_MOTION_GAP_SECONDS =
	LOCAL_MOTION_CLIP_SECONDS / MIN_CLIP_SPEED;

/**
 * Why the local engine cannot fill a gap of `gap` seconds, if it cannot.
 * Checked before generating, so a long local run is never wasted on a clip
 * that placement would refuse.
 */
export function localMotionGapRefusal(gap: number): string | undefined {
	if (gap <= MAX_LOCAL_MOTION_GAP_SECONDS + EDGE_EPSILON) {
		return undefined;
	}
	return `The local engine renders a ${LOCAL_MOTION_CLIP_SECONDS.toFixed(2)} s clip (${LOCAL_MOTION_FRAMES} frames at ${LOCAL_MOTION_FPS} fps), so it fills gaps up to ${MAX_LOCAL_MOTION_GAP_SECONDS.toFixed(1)} s at ${MIN_CLIP_SPEED * 100}% speed. Shorten the gap, choose a cloud model, or use the still bridge.`;
}

/**
 * Seconds of motion to ask the model for: the gap, but at least one second
 * and at most ten so short gaps still get a usable clip to trim from.
 */
export function motionBridgeSeconds(gap: number): number {
	return settle(Math.min(MAX_MOTION_BRIDGE_SECONDS, Math.max(1, gap)));
}

/** Why Generate motion cannot fill a gap of `gap` seconds, if it cannot. */
export function motionGapRefusal(gap: number, fps: number): string | undefined {
	if (gap < MIN_MOTION_GAP_FRAMES / fps - EDGE_EPSILON) {
		return "Generate motion fills a gap between the clips. At a cut, use the still bridge instead.";
	}
	if (gap > MAX_MOTION_GAP_SECONDS + EDGE_EPSILON) {
		return `Generate motion fills gaps up to ${MAX_MOTION_GAP_SECONDS} s (a ${MAX_MOTION_BRIDGE_SECONDS} s clip slowed to ${MIN_CLIP_SPEED * 100}%). Shorten the gap or use the still bridge.`;
	}
	return undefined;
}

/** Where a motion clip goes: exactly the gap, with its source trim and speed. */
export interface GapFillMotionPlan {
	end: number;
	gap: number;
	nextClipId: string;
	previousClipId: string;
	sourceOut: number;
	/** Below 1 when the clip is shorter than the gap and is slowed to fit. */
	speed: number;
	start: number;
	track: number;
}

/**
 * Plan a motion bridge of `clipDuration` seconds after `afterClipId`. Throws
 * at a cut or a gap shorter than `MIN_MOTION_GAP_FRAMES`, where only the
 * still bridge applies, and when the clip is too short to fill the gap even
 * slowed to `MIN_CLIP_SPEED` (it would leave a hole before clip B).
 */
export function planGapFillMotion(
	project: Pick<Project, "fps" | "segments">,
	assets: readonly Asset[],
	afterClipId: string,
	clipDuration: number
): GapFillMotionPlan {
	const { gap, next, previous } = gapFillNeighbors(
		project,
		assets,
		afterClipId
	);
	const refusal = motionGapRefusal(gap, project.fps);
	if (refusal) {
		throw new Error(refusal);
	}
	if (!(clipDuration > 0)) {
		throw new Error("The generated motion clip is empty.");
	}
	const start = settle(segmentEnd(previous));
	const end = settle(next.start);
	const length = settle(end - start);
	if (clipDuration < length * MIN_CLIP_SPEED - EDGE_EPSILON) {
		throw new Error(
			`The generated motion clip (${clipDuration.toFixed(2)} s) is too short to fill this ${length.toFixed(2)} s gap even at ${MIN_CLIP_SPEED * 100}% speed. Shorten the gap or use the still bridge.`
		);
	}
	const speed =
		clipDuration >= length
			? 1
			: Math.max(MIN_CLIP_SPEED, settle(clipDuration / length));
	return {
		end,
		gap: length,
		nextClipId: next.id,
		previousClipId: previous.id,
		sourceOut: settle(Math.min(clipDuration, length * speed)),
		speed,
		start,
		track: previous.track,
	};
}

function applyGapFillMotion(
	project: Project,
	assets: readonly Asset[],
	request: GapFillRequest,
	clip: Asset,
	newId: () => string
): GapFillResult {
	const motion = planGapFillMotion(
		project,
		assets,
		request.afterClipId,
		clip.duration
	);
	if (trackSettingFor(project, motion.track).locked) {
		throw new Error("Unlock the clip track before filling the gap.");
	}
	const clipId = newId();
	const bridge: Segment = {
		...newSegment(clip, motion.start, motion.track),
		fit: "fill",
		id: clipId,
		label: "AI motion bridge",
		sourceIn: 0,
		sourceOut: motion.sourceOut,
		speed: motion.speed,
		volume: 0,
	};
	const segments: Segment[] = [];
	for (const segment of project.segments) {
		segments.push(segment);
		if (segment.id === motion.previousClipId) {
			segments.push(bridge);
		}
	}
	return {
		clipId,
		plan: {
			dissolveIn: 0,
			dissolveOut: 0,
			end: motion.end,
			gap: motion.gap,
			mode: "gap",
			nextClipId: motion.nextClipId,
			overlapIn: 0,
			overlapOut: 0,
			previousClipId: motion.previousClipId,
			start: motion.start,
			track: motion.track,
		},
		project: validateProject({ ...project, segments }, [...assets]),
	};
}

/** The exact source frames a motion bridge starts and ends on. */
export interface GapFillBoundaryFrame {
	assetId: string;
	/** Zero-based frame index in the asset's media (0 for stills). */
	frame: number;
	kind: Asset["kind"];
	/** Presentation time of that frame in the asset's media. */
	sourceTime: number;
}

/**
 * The last source frame clip A shows (the frame before its `sourceOut`) and
 * the first source frame clip B shows (the frame at its `sourceIn`). Stills
 * contribute their only frame.
 */
export function gapFillBoundaryFrames(
	neighbors: Pick<GapFillNeighbors, "next" | "previous">,
	assets: readonly Asset[]
): { next: GapFillBoundaryFrame; previous: GapFillBoundaryFrame } {
	const boundary = (segment: Segment, side: "first" | "last") => {
		const asset = assets.find((candidate) => candidate.id === segment.assetId);
		if (!asset) {
			throw new Error("A neighbouring clip's media is missing.");
		}
		if (asset.kind !== "video") {
			return { assetId: asset.id, frame: 0, kind: asset.kind, sourceTime: 0 };
		}
		const frame =
			side === "last"
				? lastFrameBefore(asset, segment.sourceOut)
				: frameAtTime(asset, segment.sourceIn);
		return {
			assetId: asset.id,
			frame,
			kind: asset.kind,
			sourceTime: settle(frame / assetFrameRate(asset)),
		};
	};
	return {
		next: boundary(neighbors.next, "first"),
		previous: boundary(neighbors.previous, "last"),
	};
}

/** Default direction for a generated motion bridge. */
export const DEFAULT_MOTION_DIRECTION =
	"Continuous, natural camera and subject motion from the first frame to the last frame.";

/** Prompt for a motion bridge between the two boundary frames. */
export function gapFillMotionPrompt(direction = ""): string {
	const guidance = direction.trim() || DEFAULT_MOTION_DIRECTION;
	return [
		"Animate a short shot that starts exactly on the first image and ends exactly on the second image.",
		"Keep the subjects, style, lighting, and framing consistent so it cuts seamlessly between both shots.",
		`Direction: ${guidance}`,
	]
		.join(" ")
		.slice(0, 8000);
}

/**
 * The first/last-frame video request for a motion bridge. The frames are
 * sidecar extracts, so the request records the neighbouring clips' media as
 * its inputs.
 */
export function gapFillMotionRequest(input: {
	direction?: string;
	durationSeconds: number;
	id: string;
	model: string;
	nextAssetId: string;
	presetId?: string;
	previousAssetId: string;
	projectId: string;
	provider: string;
	providerInput: GenerationRequest["providerInput"];
	/** `"local"` when the bridge runs on the node's own media engine. */
	route?: GenerationRequest["route"];
}): GenerationRequest {
	return generationRequestSchema.parse({
		durationSeconds: input.durationSeconds,
		id: input.id,
		inputAssetIds: [...new Set([input.previousAssetId, input.nextAssetId])],
		kind: "video",
		model: input.model,
		presetId: input.presetId,
		projectId: input.projectId,
		prompt: gapFillMotionPrompt(input.direction),
		provider: input.provider,
		providerInput: input.providerInput,
		purpose: "generate",
		rationale: "AI motion gap fill",
		route: input.route,
		task: "flf",
	});
}

/** Timeline times to capture A's last frame and B's first frame at. */
export function gapFillFrameTimes(
	neighbors: Pick<GapFillNeighbors, "next" | "previous">,
	fps: number
): { next: number; previous: number } {
	const frame = 1 / fps;
	const { next, previous } = neighbors;
	return {
		next: settle(Math.min(next.start + frame / 2, segmentEnd(next))),
		previous: settle(Math.max(previous.start, segmentEnd(previous) - frame)),
	};
}

/** Default direction when the editor leaves the prompt empty. */
export const DEFAULT_GAP_FILL_DIRECTION =
	"A natural in-between moment that carries the motion, framing, and lighting from the first shot into the second.";

/**
 * Prompt for the bridging still. The two input images are the end of the
 * outgoing shot and the start of the incoming shot, in that order.
 */
export function gapFillPrompt(direction = ""): string {
	const guidance = direction.trim() || DEFAULT_GAP_FILL_DIRECTION;
	return [
		"Create one still image that bridges two video shots.",
		"The first input image is the last frame of the outgoing shot; the second is the first frame of the incoming shot.",
		"Keep the subjects, style, and aspect ratio consistent with both so a crossfade between them reads as one continuous transition.",
		`Direction: ${guidance}`,
	]
		.join(" ")
		.slice(0, 8000);
}

/**
 * The image request for a bridge still: both captured frames go to the
 * model as references, outgoing frame first.
 */
export function gapFillGenerationRequest(input: {
	direction?: string;
	id: string;
	model?: string;
	nextFrameAssetId: string;
	previousFrameAssetId: string;
	projectId: string;
	provider?: string;
}): GenerationRequest {
	return generationRequestSchema.parse({
		id: input.id,
		inputAssetIds: [input.previousFrameAssetId, input.nextFrameAssetId],
		kind: "image",
		model: input.model ?? "",
		projectId: input.projectId,
		prompt: gapFillPrompt(input.direction),
		provider: input.provider ?? "",
		purpose: "generate",
		rationale: "AI transition gap fill",
	});
}

/**
 * Mark generated media used as a bridge with `derivation: "gap-fill"`.
 * Media that is not generated, or already carries a derivation, is kept.
 */
export function stampGapFillAsset(asset: Asset): Asset {
	if (!asset.generation || asset.derivation) {
		return asset;
	}
	return { ...asset, derivation: "gap-fill" };
}
