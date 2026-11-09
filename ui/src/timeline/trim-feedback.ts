/**
 * Source-frame feedback for trim gestures (W1-T12). While a slip, roll, or
 * ripple drag is in flight, the preview shows two source frames side by side:
 * slip shows the clip's first and last frames at the proposed source range,
 * roll and ripple show the outgoing frame (last frame before the edit point)
 * and the incoming frame (first frame after it).
 *
 * Frame times come from running the real trim edit (`trimEdit`) on the
 * proposal, so the viewer shows exactly what releasing the pointer would
 * commit, including frame quantization and handle clamping.
 *
 * The drag publishes its live proposal through `trimFeedbackStoreFor(store)`
 * (one channel per editor store) because `DragState` carries only the
 * gesture's kind and origin, not its delta.
 */
import type { Asset, Project, Segment } from "../../../shared/project.ts";
import { segmentDuration } from "../../../shared/project.ts";
import { type TrimEditInput, trimEdit } from "../../../shared/trim-modes.ts";
import type { DragEdge, TrimTool } from "../editing-ui.ts";
import { toolDragEdit } from "../editing-ui.ts";
import type { EditorStore } from "../editor/store.ts";
import type { FilmstripPlan } from "./clip-visual-cache.ts";

/** Trim gestures that show the two-up viewer. */
export type TrimFeedbackMode = "slip" | "roll" | "ripple";

/**
 * A live trim proposal: the request `trimEdit` would receive on release,
 * without the revision (the viewer reads the rendered project's).
 */
export type TrimProposal =
	| {
			clipId: string;
			/** Source seconds, as in the slip trim request. */
			delta: number;
			mode: "slip";
	  }
	| {
			delta: number;
			inClipId: string;
			mode: "roll";
			outClipId: string;
	  }
	| {
			clipId: string;
			delta: number;
			edge: "start" | "end";
			mode: "ripple";
	  };

/** Which side of the two-up a frame fills. */
export type TrimFrameRole = "first" | "last" | "outgoing" | "incoming";

export interface TrimFeedbackFrame {
	assetId: string;
	clipId: string;
	/** Short caption shown under the frame. */
	label: string;
	role: TrimFrameRole;
	/** Source seconds of the frame inside the asset. */
	time: number;
}

/** Source frames to show while a slip, roll, or ripple drag is in flight. */
export interface TrimFeedbackFrames {
	/** Asset and source time of each frame to preview, left then right. */
	frames: TrimFeedbackFrame[];
	mode: TrimFeedbackMode;
}

const round6 = (value: number) => Number(value.toFixed(6));
const clipEnd = (segment: Segment) => segment.start + segmentDuration(segment);
const halfFrame = (fps: number) => 0.5 / Math.max(1, fps);

/** Source time of a clip's first displayed frame. */
export function firstFrameTime(segment: Segment): number {
	return round6(Math.max(0, segment.sourceIn));
}

/**
 * Source time of a clip's last displayed frame: one timeline frame before
 * the clip ends, which is `speed / fps` source seconds before `sourceOut`.
 */
export function lastFrameTime(segment: Segment, fps: number): number {
	const step = segment.speed / Math.max(1, fps);
	return round6(Math.max(segment.sourceIn, segment.sourceOut - step));
}

const FRAME_LABELS: Record<TrimFrameRole, string> = {
	first: "First frame",
	incoming: "Incoming",
	last: "Last frame",
	outgoing: "Outgoing",
};

const frameOf = (
	segment: Segment,
	role: TrimFrameRole,
	fps: number
): TrimFeedbackFrame => ({
	assetId: segment.assetId,
	clipId: segment.id,
	label: FRAME_LABELS[role],
	role,
	time:
		role === "first" || role === "incoming"
			? firstFrameTime(segment)
			: lastFrameTime(segment, fps),
});

function editInput(project: Project, proposal: TrimProposal): TrimEditInput {
	return { ...proposal, revision: project.revision };
}

const byId = (project: Project, id: string) =>
	project.segments.find((segment) => segment.id === id);

/** Clip on the same track that starts at `time` (within half a frame). */
function clipStartingAt(
	project: Project,
	track: number,
	time: number,
	excludeId: string
): Segment | undefined {
	const tolerance = halfFrame(project.fps);
	return project.segments.find(
		(candidate) =>
			candidate.id !== excludeId &&
			candidate.track === track &&
			Math.abs(candidate.start - time) <= tolerance
	);
}

/** Clip on the same track that ends at `time` (within half a frame). */
function clipEndingAt(
	project: Project,
	track: number,
	time: number,
	excludeId: string
): Segment | undefined {
	const tolerance = halfFrame(project.fps);
	return project.segments.find(
		(candidate) =>
			candidate.id !== excludeId &&
			candidate.track === track &&
			Math.abs(clipEnd(candidate) - time) <= tolerance
	);
}

function slipFrames(
	edited: Project,
	proposal: Extract<TrimProposal, { mode: "slip" }>
): TrimFeedbackFrame[] {
	const target = byId(edited, proposal.clipId);
	return target
		? [
				frameOf(target, "first", edited.fps),
				frameOf(target, "last", edited.fps),
			]
		: [];
}

function rollFrames(
	edited: Project,
	proposal: Extract<TrimProposal, { mode: "roll" }>
): TrimFeedbackFrame[] {
	const outgoing = byId(edited, proposal.outClipId);
	const incoming = byId(edited, proposal.inClipId);
	return outgoing && incoming
		? [
				frameOf(outgoing, "outgoing", edited.fps),
				frameOf(incoming, "incoming", edited.fps),
			]
		: [];
}

/**
 * Ripple trims one side of an edit point. The trimmed clip supplies its new
 * edge frame; the clip butted against that edge (if any) supplies the other.
 */
function rippleFrames(
	edited: Project,
	proposal: Extract<TrimProposal, { mode: "ripple" }>
): TrimFeedbackFrame[] {
	const target = byId(edited, proposal.clipId);
	if (!target) {
		return [];
	}
	if (proposal.edge === "end") {
		const next = clipStartingAt(
			edited,
			target.track,
			clipEnd(target),
			target.id
		);
		return [
			frameOf(target, "outgoing", edited.fps),
			...(next ? [frameOf(next, "incoming", edited.fps)] : []),
		];
	}
	const previous = clipEndingAt(edited, target.track, target.start, target.id);
	return [
		...(previous ? [frameOf(previous, "outgoing", edited.fps)] : []),
		frameOf(target, "incoming", edited.fps),
	];
}

/**
 * Frames for the two-up trim viewer: slip shows the clip's first and last
 * frames, roll and ripple the outgoing and incoming frames at the edit point,
 * all at the source times the proposal would commit. Returns `null` when the
 * proposal cannot apply (missing clip, locked track, a still slipped, …).
 */
export function trimFeedbackFrames(
	project: Project,
	assets: readonly Asset[],
	proposal: TrimProposal
): TrimFeedbackFrames | null {
	let edited: Project;
	try {
		edited = trimEdit(project, assets, editInput(project, proposal)).project;
	} catch {
		return null;
	}
	let frames: TrimFeedbackFrame[];
	switch (proposal.mode) {
		case "slip":
			frames = slipFrames(edited, proposal);
			break;
		case "roll":
			frames = rollFrames(edited, proposal);
			break;
		default:
			frames = rippleFrames(edited, proposal);
	}
	return frames.length ? { frames, mode: proposal.mode } : null;
}

/**
 * The proposal for a tool drag, from the same request builder the timeline
 * commits with (`toolDragEdit`). `null` for drags that show no viewer
 * (pointer, slide, razor) or that cannot apply (a roll with no neighbour).
 */
export function trimProposalForToolDrag(
	project: Project,
	tool: TrimTool,
	segment: Segment,
	edge: DragEdge,
	delta: number
): TrimProposal | null {
	if (tool !== "slip" && tool !== "roll" && tool !== "ripple") {
		return null;
	}
	let input: TrimEditInput | null;
	try {
		input = toolDragEdit(project, tool, segment, edge, delta);
	} catch {
		return null;
	}
	switch (input?.mode) {
		case "slip":
			return { clipId: input.clipId, delta: input.delta, mode: "slip" };
		case "roll":
			return {
				delta: input.delta,
				inClipId: input.inClipId,
				mode: "roll",
				outClipId: input.outClipId,
			};
		case "ripple":
			return {
				clipId: input.clipId,
				delta: input.delta,
				edge: input.edge,
				mode: "ripple",
			};
		default:
			return null;
	}
}

/* ------------------------------------------------------------------ */
/* Frame requests                                                      */
/* ------------------------------------------------------------------ */

/** Height of the two-up frames requested from the sidecar. */
export const TRIM_FRAME_HEIGHT = 90;
/** Shortest source range the filmstrip route accepts. */
const MIN_RANGE = 0.001;
/**
 * Mirrors the filmstrip route's end guard: it never seeks later than this
 * far before the media's end, so a request must not start inside it.
 */
export const FILMSTRIP_SEEK_END_GUARD = 0.05;
/** Most frames one filmstrip request may sample. */
const MAX_TRIM_FRAME_TILES = 60;
const millis = (value: number) => Math.round(value * 1000) / 1000;
/**
 * Round down to the millisecond. FFmpeg's accurate seek drops every frame
 * that starts before the seek point, so rounding a frame's start time up
 * would skip to the next frame.
 */
const floorMillis = (value: number) => Math.floor(value * 1000 + 1e-6) / 1000;

/**
 * Index of the sprite tile that holds a trim frame's picture: always the
 * last one (a single-tile request is its own last tile).
 */
export const trimFrameTile = (plan: Pick<FilmstripPlan, "count">) =>
	Math.max(0, plan.count - 1);

/**
 * The filmstrip request whose last tile shows a trim frame. The route
 * samples each tile at the middle of its slice, so the last tile samples
 * `end - step / 2`; the plan puts that sample one millisecond after the
 * frame's source time (rounded down to the millisecond, so it can never
 * reach the next frame however fast the media's frame rate).
 *
 * Away from the media's end that is a one-tile, two-millisecond range. Near
 * the end the route would clamp its seek to `FILMSTRIP_SEEK_END_GUARD`
 * before the end and sample from there, so the range instead starts at or
 * before that guard, ends at the media's end, and is cut into equal tiles
 * whose last one still samples the frame. Audio has no picture (`null`); a
 * still always shows its one image.
 */
export function trimFramePlan(
	frame: Pick<TrimFeedbackFrame, "assetId" | "time">,
	asset: Pick<Asset, "duration" | "id" | "kind"> | undefined
): FilmstripPlan | null {
	if (!asset || asset.id !== frame.assetId || asset.kind === "audio") {
		return null;
	}
	if (asset.kind === "image") {
		return {
			assetId: asset.id,
			count: 1,
			end: 1,
			height: TRIM_FRAME_HEIGHT,
			start: 0,
		};
	}
	const mediaEnd = floorMillis(asset.duration);
	if (!(mediaEnd >= 2 * MIN_RANGE)) {
		return null;
	}
	const sample = Math.min(
		millis(floorMillis(Math.max(0, frame.time)) + MIN_RANGE),
		millis(mediaEnd - MIN_RANGE)
	);
	const seekLimit = floorMillis(
		Math.max(0, asset.duration - FILMSTRIP_SEEK_END_GUARD)
	);
	const start = millis(sample - MIN_RANGE);
	if (start <= seekLimit) {
		return {
			assetId: asset.id,
			count: 1,
			end: millis(sample + MIN_RANGE),
			height: TRIM_FRAME_HEIGHT,
			start,
		};
	}
	const step = millis(2 * (mediaEnd - sample));
	const count = Math.min(
		MAX_TRIM_FRAME_TILES,
		Math.max(1, Math.ceil((mediaEnd - seekLimit) / step - 1e-6))
	);
	return {
		assetId: asset.id,
		count,
		end: mediaEnd,
		height: TRIM_FRAME_HEIGHT,
		// Media shorter than the guard can only be read from its start; the
		// last tile then lands as close to the frame as equal tiles allow.
		start: Math.max(0, millis(mediaEnd - count * step)),
	};
}

/* ------------------------------------------------------------------ */
/* Live proposal channel                                               */
/* ------------------------------------------------------------------ */

export interface TrimFeedbackStore {
	clear: () => void;
	get: () => TrimProposal | null;
	set: (proposal: TrimProposal | null) => void;
	subscribe: (listener: () => void) => () => void;
}

const sameProposal = (a: TrimProposal | null, b: TrimProposal | null) =>
	a === b ||
	(a !== null && b !== null && JSON.stringify(a) === JSON.stringify(b));

export function createTrimFeedbackStore(): TrimFeedbackStore {
	let proposal: TrimProposal | null = null;
	const listeners = new Set<() => void>();
	const publish = (next: TrimProposal | null) => {
		if (sameProposal(proposal, next)) {
			return;
		}
		proposal = next;
		for (const listener of listeners) {
			listener();
		}
	};
	return {
		clear: () => publish(null),
		get: () => proposal,
		set: publish,
		subscribe: (listener) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
	};
}

const feedbackStores = new WeakMap<EditorStore, TrimFeedbackStore>();
const detachedFeedbackStore = createTrimFeedbackStore();

/**
 * The live trim proposal of one editor (one channel per `EditorStore`). A
 * tool drag sets `store.drag` to its kind and publishes each pointer move's
 * proposal here; it clears both on release or cancel. A preview rendered
 * outside an editor shares a detached channel.
 */
export function trimFeedbackStoreFor(
	store: EditorStore | null | undefined
): TrimFeedbackStore {
	if (!store) {
		return detachedFeedbackStore;
	}
	let feedback = feedbackStores.get(store);
	if (!feedback) {
		feedback = createTrimFeedbackStore();
		feedbackStores.set(store, feedback);
	}
	return feedback;
}
