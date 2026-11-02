import {
	type Marker,
	type Segment,
	segmentDuration,
	snapTimelineTime,
	trimSegment,
} from "../../../shared/project.ts";
import {
	type DragEdge,
	type TrimTool,
	toolHandlesDrag,
} from "../editing-ui.ts";
import type { EditorRuntime } from "../editor/runtime.ts";
import type { EditorStore } from "../editor/store.ts";
import {
	DRAG_THRESHOLD_PX,
	MAX_DRAG_TRACK,
	TIMELINE_LIMIT,
	TRACK_ROW_PX,
} from "./clip-drag-geometry.ts";
import {
	trimFeedbackStoreFor,
	trimProposalForToolDrag,
} from "./trim-feedback.ts";

export {
	type AppliedGroupDrag,
	applyGroupDragPlan,
	commitGroupDrag,
} from "./clip-drag-apply.ts";
export {
	attachClipDragEngine,
	CLIP_ID_ATTRIBUTE,
	DRAG_IGNORE_ATTRIBUTE,
	previewGroupDrag,
} from "./clip-drag-engine.ts";
export {
	FADE_KNEE_PX,
	fadeFromDrag,
	fadeKneeOffset,
	fadeLabel,
} from "./clip-drag-fade.ts";
export {
	DRAG_THRESHOLD_PX,
	dragEdgeAt,
	EDGE_HANDLE_PX,
	MAX_DRAG_TRACK,
	TRACK_ROW_PX,
} from "./clip-drag-geometry.ts";
export {
	createGroupDragSession,
	dragGroupIds,
	type GroupDragContext,
	type GroupDragGesture,
	type GroupDragPlan,
	type GroupDragPointer,
	snapGroupDelta,
} from "./clip-drag-group.ts";

export interface ClipDragOrigin {
	edge: DragEdge;
	x: number;
	y: number;
}

export type ClipDragResult =
	| { kind: "none" }
	| { delta: number; edge: DragEdge; kind: "tool" }
	| { kind: "trim"; segment: Segment }
	| { kind: "move"; start: number; track: number };

/**
 * Resolve a finished pointer drag on a clip. Deltas are frame-quantized;
 * edges and moves snap to frames and markers. Tool drags (ripple/roll edges,
 * slip/slide bodies, any razor gesture) go to `kind: "tool"` when the editor
 * handles tool edits; otherwise edges trim and the body moves across tracks.
 */
export function resolveClipDrag(input: {
	assetDuration: number;
	fps: number;
	handlesToolEdits: boolean;
	markers: readonly Marker[];
	origin: ClipDragOrigin;
	segment: Segment;
	tool: TrimTool;
	x: number;
	y: number;
	zoom: number;
}): ClipDragResult {
	const { fps, markers, origin, segment, x, y, zoom } = input;
	if (Math.abs(x - origin.x) + Math.abs(y - origin.y) < DRAG_THRESHOLD_PX) {
		return { kind: "none" };
	}
	const delta = Math.round(((x - origin.x) / zoom) * fps) / fps;
	const currentEdge =
		origin.edge === "start"
			? segment.start
			: segment.start + segmentDuration(segment);
	if (input.handlesToolEdits && toolHandlesDrag(input.tool, origin.edge)) {
		if (origin.edge === "move") {
			return { delta, edge: "move", kind: "tool" };
		}
		return {
			delta: snapTimelineTime(currentEdge + delta, fps, markers) - currentEdge,
			edge: origin.edge,
			kind: "tool",
		};
	}
	if (origin.edge !== "move") {
		const snappedEdge = snapTimelineTime(currentEdge + delta, fps, markers);
		return {
			kind: "trim",
			segment: trimSegment(
				segment,
				input.assetDuration,
				origin.edge,
				snappedEdge - currentEdge
			),
		};
	}
	return {
		kind: "move",
		start: Math.max(
			0,
			Math.min(
				TIMELINE_LIMIT - segmentDuration(segment),
				snapTimelineTime(segment.start + (x - origin.x) / zoom, fps, markers)
			)
		),
		track: Math.max(
			0,
			Math.min(
				MAX_DRAG_TRACK,
				segment.track + Math.round((y - origin.y) / TRACK_ROW_PX)
			)
		),
	};
}

/** Tool drags that show the slip/roll/ripple two-up viewer (W1-T12). */
const FEEDBACK_TOOLS = new Set<TrimTool>(["slip", "roll", "ripple"]);

/**
 * Publish the live proposal of an in-flight slip, roll, or ripple tool drag
 * so the preview's two-up viewer shows the source frames releasing the
 * pointer would commit. The proposal comes from the same `resolveClipDrag`
 * result the release commits. Returns whether a proposal is showing.
 */
export function publishToolDragFeedback(
	runtime: Pick<EditorRuntime, "project" | "store">,
	input: Parameters<typeof resolveClipDrag>[0]
): boolean {
	const { project, store } = runtime;
	if (!(project && FEEDBACK_TOOLS.has(input.tool))) {
		return false;
	}
	const result = resolveClipDrag(input);
	const proposal =
		result.kind === "tool"
			? trimProposalForToolDrag(
					project,
					input.tool,
					input.segment,
					result.edge,
					result.delta
				)
			: null;
	const channel = trimFeedbackStoreFor(store);
	if (!proposal) {
		channel.clear();
		return false;
	}
	const drag = store.getState().drag;
	if (drag?.kind !== input.tool || drag.ids[0] !== input.segment.id) {
		store.setState({
			drag: {
				ids: [input.segment.id],
				kind: input.tool as "slip" | "roll" | "ripple",
				originX: input.origin.x,
				originY: input.origin.y,
			},
		});
	}
	channel.set(proposal);
	return true;
}

/** End a tool drag's two-up feedback (release or cancel). */
export function clearToolDragFeedback(store: EditorStore) {
	trimFeedbackStoreFor(store).clear();
	const kind = store.getState().drag?.kind;
	if (kind === "slip" || kind === "roll" || kind === "ripple") {
		store.setState({ drag: null });
	}
}

/** Start time after a one-frame keyboard nudge, kept on the timeline. */
export function nudgedStart(segment: Segment, fps: number, direction: -1 | 1) {
	return Math.max(
		0,
		Math.min(
			TIMELINE_LIMIT - segmentDuration(segment),
			segment.start + direction / fps
		)
	);
}
