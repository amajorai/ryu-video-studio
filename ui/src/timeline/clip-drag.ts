import {
	fadeBounds,
	type GroupEditResult,
	groupDuplicate,
	groupMove,
	groupTrim,
	trimBounds,
} from "../../../shared/group-edits.ts";
import { MAX_TRACK_INDEX } from "../../../shared/limits.ts";
import {
	type Asset,
	type Marker,
	type Project,
	type Segment,
	segmentDuration,
	snapTimelineTime,
	trackSettingFor,
	trimSegment,
} from "../../../shared/project.ts";
import { rippleMoveClips } from "../../../shared/ripple-edits.ts";
import { withLinkedPartners } from "../../../shared/selection.ts";
import {
	collectSnapTargets,
	type SnapTarget,
	snap,
} from "../../../shared/timeline-snap.ts";
import { trimEdit } from "../../../shared/trim-modes.ts";
import {
	type DragEdge,
	type TrimTool,
	toolHandlesDrag,
} from "../editing-ui.ts";
import { selectClips } from "../editor/actions/select.ts";
import { message } from "../editor/format.ts";
import type { EditorRuntime } from "../editor/runtime.ts";
import type { EditorStore } from "../editor/store.ts";
import {
	trimFeedbackStoreFor,
	trimProposalForToolDrag,
} from "./trim-feedback.ts";

/** Pointer travel (|dx| + |dy| in px) below which a press is a click, not a drag. */
export const DRAG_THRESHOLD_PX = 4;
/** Width of the trim zone at each clip edge, in px. */
export const EDGE_HANDLE_PX = 10;
/** Height of one track row; vertical drags change track every row. */
export const TRACK_ROW_PX = 54;
/** Highest track a pointer drag can reach. */
export const MAX_DRAG_TRACK = MAX_TRACK_INDEX;
const TIMELINE_LIMIT = 7200;

export interface ClipDragOrigin {
	edge: DragEdge;
	x: number;
	y: number;
}

/** Which part of a clip a press at `clientX` grabs. */
export function dragEdgeAt(
	bounds: { left: number; right: number },
	clientX: number
): DragEdge {
	if (clientX - bounds.left < EDGE_HANDLE_PX) {
		return "start";
	}
	if (bounds.right - clientX < EDGE_HANDLE_PX) {
		return "end";
	}
	return "move";
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

/*
 * Group drag engine. A pointer-tool press on a clip body moves the clip, or
 * the whole selection when the clip is part of it (linked A/V partners move
 * in time with their clip); a press on an edge trims that edge of the clip
 * or selection, with linked partners unless Alt is held (a J/L cut). Alt on
 * release of a body drag duplicates instead of moving. Every candidate edge
 * snaps through the shared snap contract; Shift suspends snapping. Escape
 * (which clears `store.drag`) cancels the gesture.
 */

/** What a group drag reads from the open editor. */
export interface GroupDragContext {
	assets: readonly Asset[];
	project: Project;
	range: { end: number; start: number } | null;
	/**
	 * Ripple mode: edge trims are not limited by the neighbouring clip (later
	 * clips move instead) and the release ripples the trim or move.
	 */
	rippleMode?: boolean;
	selectedIds: readonly string[];
	snapEnabled: boolean;
	time: number | null;
	/** Timeline zoom in pixels per second. */
	zoom: number;
}

/** Where and on which clip a group drag started. */
export interface GroupDragGesture {
	anchorId: string;
	edge: DragEdge;
	originX: number;
	originY: number;
}

/** The latest pointer position and modifiers of a group drag. */
export interface GroupDragPointer {
	altKey: boolean;
	shiftKey: boolean;
	x: number;
	y: number;
}

export type GroupDragPlan =
	| { kind: "none" }
	| {
			/** Clips that change track (the dragged ones, without partners). */
			directIds: string[];
			/** Every clip that moves in time (dragged ones plus linked partners). */
			ids: string[];
			delta: number;
			exact: boolean;
			kind: "move" | "duplicate";
			snapTime: number | null;
			trackDelta: number;
	  }
	| {
			delta: number;
			edge: "start" | "end";
			exact: boolean;
			/** Clips whose edge changes (with partners when `linked`). */
			ids: string[];
			kind: "trim";
			linked: boolean;
			snapTime: number | null;
	  };

const EPSILON = 1e-6;
const clipEnd = (segment: Segment) => segment.start + segmentDuration(segment);

/**
 * Clips a drag of `anchorId` acts on: the selection when the anchor is part
 * of a multi-clip selection (minus clips on locked tracks), else the anchor.
 */
export function dragGroupIds(
	project: Project,
	anchorId: string,
	selectedIds: readonly string[]
): string[] {
	if (!(selectedIds.length > 1 && selectedIds.includes(anchorId))) {
		return [anchorId];
	}
	const wanted = new Set(selectedIds);
	return project.segments
		.filter(
			(segment) =>
				wanted.has(segment.id) &&
				(segment.id === anchorId ||
					!trackSettingFor(project, segment.track).locked)
		)
		.map((segment) => segment.id);
}

function segmentsFor(project: Project, ids: readonly string[]): Segment[] {
	const wanted = new Set(ids);
	return project.segments.filter((segment) => wanted.has(segment.id));
}

interface SnappedDelta {
	delta: number;
	exact: boolean;
	snapTime: number | null;
}

/**
 * Snap a raw timeline delta applied to several edges at once: the edge that
 * lands on the best target (lowest priority, then nearest) decides the
 * delta. With no target the delta is returned raw for frame quantization.
 */
export function snapGroupDelta(
	edges: readonly number[],
	raw: number,
	targets: readonly SnapTarget[],
	options: { enabled: boolean; fps: number; pxPerSec: number }
): SnappedDelta {
	if (!options.enabled) {
		return { delta: raw, exact: false, snapTime: null };
	}
	let best: { adjust: number; target: SnapTarget; time: number } | null = null;
	for (const edge of edges) {
		const result = snap(edge + raw, targets, {
			fps: options.fps,
			pxPerSec: options.pxPerSec,
		});
		if (!result.target) {
			continue;
		}
		const adjust = Math.abs(result.time - (edge + raw));
		if (
			!best ||
			result.target.priority < best.target.priority ||
			(result.target.priority === best.target.priority &&
				adjust < best.adjust - EPSILON)
		) {
			best = { adjust, target: result.target, time: result.time - edge };
		}
	}
	return best
		? { delta: best.time, exact: true, snapTime: best.target.time }
		: { delta: raw, exact: false, snapTime: null };
}

const clamp = (value: number, low: number, high: number) =>
	Math.max(Math.min(low, 0), Math.min(Math.max(high, 0), value));

/**
 * One drag gesture over a fixed project. Snap targets and clamp bounds are
 * computed once; `plan` resolves each pointer position to the edit a
 * release there would make.
 */
export function createGroupDragSession(
	context: GroupDragContext,
	gesture: GroupDragGesture
) {
	const { project } = context;
	const groupIds = dragGroupIds(project, gesture.anchorId, context.selectedIds);
	const direct = segmentsFor(project, groupIds);
	const movers = segmentsFor(project, withLinkedPartners(project, groupIds));
	const targetCache = new Map<boolean, SnapTarget[]>();
	const targetsFor = (excludeLinked: boolean, exclude: readonly string[]) => {
		const cached = targetCache.get(excludeLinked);
		if (cached) {
			return cached;
		}
		const targets = collectSnapTargets(project, {
			exclude: new Set(exclude),
			excludeLinked,
			range: context.range,
			time: context.time,
		});
		targetCache.set(excludeLinked, targets);
		return targets;
	};
	const trimTargetsFor = (linked: boolean) =>
		segmentsFor(
			project,
			linked ? withLinkedPartners(project, groupIds) : groupIds
		);
	const trimLimits = (edge: "start" | "end", linked: boolean) => {
		let low = Number.NEGATIVE_INFINITY;
		let high = Number.POSITIVE_INFINITY;
		for (const segment of trimTargetsFor(linked)) {
			const asset = context.assets.find(
				(candidate) => candidate.id === segment.assetId
			);
			if (!asset) {
				continue;
			}
			// In ripple mode later clips make room, so only the media and the
			// shortest clip bound an edge.
			const bounds = trimBounds(
				context.rippleMode
					? {
							...project,
							segments: project.segments.filter(
								(other) =>
									other.id === segment.id || other.track !== segment.track
							),
						}
					: project,
				segment,
				asset,
				edge
			);
			low = Math.max(low, bounds.low);
			high = Math.min(high, bounds.high);
		}
		return { high, low };
	};
	const snapOptions = (pointer: GroupDragPointer) => ({
		enabled: context.snapEnabled && !pointer.shiftKey,
		fps: project.fps,
		pxPerSec: context.zoom,
	});
	return {
		groupIds,
		plan(pointer: GroupDragPointer): GroupDragPlan {
			const dx = pointer.x - gesture.originX;
			const dy = pointer.y - gesture.originY;
			if (
				!direct.length ||
				Math.abs(dx) + Math.abs(dy) < DRAG_THRESHOLD_PX ||
				context.zoom <= 0
			) {
				return { kind: "none" };
			}
			const raw = dx / context.zoom;
			if (gesture.edge === "move") {
				const snapped = snapGroupDelta(
					movers.flatMap((segment) => [segment.start, clipEnd(segment)]),
					raw,
					targetsFor(true, groupIds),
					snapOptions(pointer)
				);
				const earliest = Math.min(...movers.map((segment) => segment.start));
				const latest = Math.max(...movers.map(clipEnd));
				const lowest = Math.min(...direct.map((segment) => segment.track));
				const highest = Math.max(...direct.map((segment) => segment.track));
				return {
					delta: clamp(snapped.delta, -earliest, TIMELINE_LIMIT - latest),
					directIds: groupIds,
					exact: snapped.exact,
					ids: movers.map((segment) => segment.id),
					kind: pointer.altKey ? "duplicate" : "move",
					snapTime: snapped.snapTime,
					trackDelta:
						clamp(
							Math.round(dy / TRACK_ROW_PX),
							-lowest,
							MAX_DRAG_TRACK - highest
						) || 0,
				};
			}
			const edge = gesture.edge;
			const linked = !pointer.altKey;
			const trimmed = trimTargetsFor(linked);
			const snapped = snapGroupDelta(
				trimmed.map((segment) =>
					edge === "start" ? segment.start : clipEnd(segment)
				),
				raw,
				// Unlinked trims may snap to the partner's edge (to line a cut back up).
				targetsFor(
					linked,
					trimmed.map((segment) => segment.id)
				),
				snapOptions(pointer)
			);
			const limits = trimLimits(edge, linked);
			return {
				delta: clamp(snapped.delta, limits.low, limits.high),
				edge,
				exact: snapped.exact,
				ids: trimmed.map((segment) => segment.id),
				kind: "trim",
				linked,
				snapTime: snapped.snapTime,
			};
		},
	};
}

export interface AppliedGroupDrag {
	label: string;
	project: Project;
	/** Clips to select after the edit. */
	selection: string[];
	status: string;
}

const seconds = (value: number) =>
	`${value >= 0 ? "+" : ""}${value.toFixed(2)}s`;

/**
 * Apply a resolved plan through the shared group edits. Returns null when
 * the plan changes nothing (a click, or a drag clamped to zero).
 */
export function applyGroupDragPlan(
	project: Project,
	assets: readonly Asset[],
	plan: GroupDragPlan,
	directIds: readonly string[],
	options: { ripple?: boolean } = {}
): AppliedGroupDrag | null {
	if (plan.kind === "none") {
		return null;
	}
	if (options.ripple && (plan.kind === "trim" || plan.kind === "move")) {
		return applyRippleDragPlan(project, assets, plan, directIds);
	}
	if (plan.kind === "duplicate") {
		if (plan.delta === 0 && plan.trackDelta === 0) {
			// Dropped back where it started: nothing to copy to.
			return null;
		}
		const result = groupDuplicate(project, assets, {
			clipIds: [...directIds],
			delta: plan.delta,
			revision: project.revision,
			trackDelta: plan.trackDelta,
		});
		return {
			label: "Duplicate clips",
			project: result.project,
			selection: result.newIds,
			status: `Duplicated ${result.newIds.length} clip${result.newIds.length === 1 ? "" : "s"} · ${seconds(plan.delta)}.`,
		};
	}
	const count = plan.ids.length;
	const noun = `${count} clip${count === 1 ? "" : "s"}`;
	if (plan.kind === "trim") {
		const trimmed = groupTrim(project, assets, {
			clipIds: [...directIds],
			delta: plan.delta,
			edge: plan.edge,
			exact: plan.exact,
			linked: plan.linked,
			revision: project.revision,
		});
		return trimmed.project === project
			? null
			: {
					label: count === 1 ? "Trim clip" : "Trim clips",
					project: trimmed.project,
					selection: [...directIds],
					status: `Trimmed the ${plan.edge} of ${noun} ${seconds(trimmed.applied)}${plan.linked ? "" : " (unlinked)"}.`,
				};
	}
	const moved: GroupEditResult = groupMove(project, assets, {
		clipIds: [...directIds],
		delta: plan.delta,
		exact: plan.exact,
		revision: project.revision,
		trackDelta: plan.trackDelta,
	});
	if (moved.project === project) {
		return null;
	}
	const tracks = moved.trackApplied
		? ` · ${moved.trackApplied > 0 ? "+" : ""}${moved.trackApplied} track${Math.abs(moved.trackApplied) === 1 ? "" : "s"}`
		: "";
	return {
		label: count === 1 ? "Move clip" : "Move clips",
		project: moved.project,
		selection: [...directIds],
		status: `Moved ${noun} ${seconds(moved.applied)}${tracks}.`,
	};
}

/**
 * A pointer trim or move in ripple mode, as one edit. A trim goes through
 * the Ripple tool's trim (later clips on the track, linked partners and
 * sync-locked tracks shift by the change); a move extracts the clips,
 * closing the gap they leave, and inserts them at the nearest edit point.
 */
function applyRippleDragPlan(
	project: Project,
	assets: readonly Asset[],
	plan: Exclude<GroupDragPlan, { kind: "none" }>,
	directIds: readonly string[]
): AppliedGroupDrag | null {
	const count = directIds.length;
	const noun = `${count} clip${count === 1 ? "" : "s"}`;
	if (plan.kind === "trim") {
		if (Math.abs(plan.delta) < 1e-9) {
			return null;
		}
		let next = project;
		let applied = 0;
		for (const clipId of directIds) {
			const result = trimEdit(next, assets, {
				clipId,
				delta: plan.delta,
				edge: plan.edge,
				mode: "ripple",
				revision: next.revision,
			});
			next = result.project;
			applied = result.applied;
		}
		return next === project
			? null
			: {
					label: count === 1 ? "Ripple trim clip" : "Ripple trim clips",
					project: next,
					selection: [...directIds],
					status: `Ripple-trimmed the ${plan.edge} of ${noun} ${seconds(applied)}; later clips moved with it.`,
				};
	}
	if (
		plan.kind !== "move" ||
		(Math.abs(plan.delta) < 1e-9 && plan.trackDelta === 0)
	) {
		return null;
	}
	const moved = rippleMoveClips(project, assets, {
		clipIds: directIds,
		delta: plan.delta,
		trackDelta: plan.trackDelta,
	});
	return {
		label: count === 1 ? "Ripple move clip" : "Ripple move clips",
		project: moved.project,
		selection: [...directIds],
		status: `Ripple-moved ${noun} to ${moved.at.toFixed(2)}s; the gap it left closed.`,
	};
}

/** Apply a finished plan as one undoable edit and select the result. */
export function commitGroupDrag(
	runtime: EditorRuntime,
	plan: GroupDragPlan,
	directIds: readonly string[]
): boolean {
	const { project } = runtime;
	if (!project || plan.kind === "none") {
		return false;
	}
	try {
		const applied = applyGroupDragPlan(
			project,
			runtime.assets,
			plan,
			directIds,
			{ ripple: runtime.store.getState().rippleMode }
		);
		if (!applied) {
			return false;
		}
		runtime.edit(applied.project, applied.label);
		selectClips(runtime, applied.selection);
		runtime.setStatus(applied.status);
		return true;
	} catch (error) {
		runtime.setStatus(message(error));
		return false;
	}
}

/** The DOM attribute that marks a clip element with its segment id. */
export const CLIP_ID_ATTRIBUTE = "data-clip-id";
/** Presses inside an element with this attribute are not group drags. */
export const DRAG_IGNORE_ATTRIBUTE = "data-clip-drag-ignore";

interface PreviewedElement {
	element: HTMLElement;
	left: string;
	translate: string;
	width: string;
	zIndex: string;
}

function clipElements(root: ParentNode, ids: readonly string[]) {
	const elements = new Map<string, HTMLElement>();
	for (const element of root.querySelectorAll<HTMLElement>(
		`[${CLIP_ID_ATTRIBUTE}]`
	)) {
		const id = element.getAttribute(CLIP_ID_ATTRIBUTE);
		if (id && ids.includes(id)) {
			elements.set(id, element);
		}
	}
	return elements;
}

/**
 * Show a plan on the timeline without committing it: moved clips translate,
 * trimmed clips change their left edge and width. Returns a restore
 * function. Inline `translate`, `left`, `width`, and `z-index` are used
 * because React owns only the clip's custom properties.
 */
export function previewGroupDrag(
	root: ParentNode,
	project: Project,
	plan: GroupDragPlan,
	pointerDy: number,
	zoom: number
): () => void {
	if (plan.kind === "none") {
		return () => undefined;
	}
	const saved: PreviewedElement[] = [];
	const elements = clipElements(root, plan.ids);
	for (const segment of project.segments) {
		const element = elements.get(segment.id);
		if (!element) {
			continue;
		}
		saved.push({
			element,
			left: element.style.left,
			translate: element.style.translate,
			width: element.style.width,
			zIndex: element.style.zIndex,
		});
		element.style.zIndex = "5";
		if (plan.kind === "trim") {
			const start =
				plan.edge === "start" ? segment.start + plan.delta : segment.start;
			const duration =
				segmentDuration(segment) +
				(plan.edge === "start" ? -plan.delta : plan.delta);
			element.style.left = `${start * zoom}px`;
			element.style.width = `${Math.max(12, duration * zoom)}px`;
		} else {
			const dy = plan.directIds.includes(segment.id) ? pointerDy : 0;
			element.style.translate = `${plan.delta * zoom}px ${dy}px`;
		}
	}
	return () => {
		for (const entry of saved) {
			entry.element.style.left = entry.left;
			entry.element.style.translate = entry.translate;
			entry.element.style.width = entry.width;
			entry.element.style.zIndex = entry.zIndex;
		}
	};
}

/**
 * Attach the group drag engine to one clip element. It takes over
 * primary-button pointer-tool presses on the clip (before React's handlers
 * see them), previews the plan while the pointer moves, commits on release,
 * and swallows the click that follows a drag. Presses with another tool,
 * on a locked clip, or inside `[data-clip-drag-ignore]` pass through.
 */
export function attachClipDragEngine(
	element: HTMLElement,
	segmentId: string,
	getRuntime: () => EditorRuntime | null
): () => void {
	element.setAttribute(CLIP_ID_ATTRIBUTE, segmentId);
	let active: {
		/** Escape cleared `store.drag`: no more previews, snap guides, or commit. */
		cancelled: boolean;
		directIds: string[];
		gesture: GroupDragGesture;
		moved: boolean;
		pointerId: number;
		project: Project;
		restore: () => void;
		session: ReturnType<typeof createGroupDragSession>;
		unsubscribe: () => void;
	} | null = null;
	let suppressClick = false;
	const root = () =>
		element.closest(".studio-tracks") ?? element.ownerDocument ?? document;

	const end = () => {
		const current = active;
		active = null;
		if (!current) {
			return;
		}
		current.restore();
		current.unsubscribe();
		element.removeEventListener("pointermove", onMove);
		element.removeEventListener("pointerup", onUp);
		element.removeEventListener("pointercancel", onCancel);
		const runtime = getRuntime();
		if (runtime && current.moved) {
			runtime.store.setState({ drag: null, snapGuideTime: null });
		}
	};

	function onMove(event: PointerEvent) {
		const current = active;
		const runtime = getRuntime();
		if (
			!(current && runtime) ||
			event.pointerId !== current.pointerId ||
			current.cancelled
		) {
			return;
		}
		const plan = current.session.plan({
			altKey: event.altKey,
			shiftKey: event.shiftKey,
			x: event.clientX,
			y: event.clientY,
		});
		if (plan.kind === "none") {
			return;
		}
		if (!current.moved) {
			current.moved = true;
			runtime.store.setState({
				drag: {
					ids: plan.ids,
					kind: plan.kind === "trim" ? "trim" : "move",
					originX: current.gesture.originX,
					originY: current.gesture.originY,
				},
			});
		}
		current.restore();
		current.restore = previewGroupDrag(
			root(),
			current.project,
			plan,
			event.clientY - current.gesture.originY,
			runtime.zoom
		);
		runtime.store.setState({ snapGuideTime: plan.snapTime });
	}

	function onUp(event: PointerEvent) {
		const current = active;
		if (!current || event.pointerId !== current.pointerId) {
			return;
		}
		const runtime = getRuntime();
		const plan = current.session.plan({
			altKey: event.altKey,
			shiftKey: event.shiftKey,
			x: event.clientX,
			y: event.clientY,
		});
		const cancelled =
			current.cancelled ||
			(current.moved && runtime?.store.getState().drag === null);
		suppressClick = current.moved;
		const { directIds } = current;
		end();
		if (runtime && current.moved && !cancelled) {
			commitGroupDrag(runtime, plan, directIds);
		}
	}

	function onCancel(event: PointerEvent) {
		if (active && event.pointerId === active.pointerId) {
			suppressClick = active.moved;
			end();
		}
	}

	const onDown = (event: PointerEvent) => {
		const runtime = getRuntime();
		const project = runtime?.project;
		if (
			active ||
			event.button !== 0 ||
			!(runtime && project) ||
			runtime.tool !== "pointer" ||
			runtime.busy ||
			(event.target instanceof Element &&
				event.target.closest(`[${DRAG_IGNORE_ATTRIBUTE}]`))
		) {
			return;
		}
		const segment = project.segments.find(
			(candidate) => candidate.id === segmentId
		);
		if (!segment || trackSettingFor(project, segment.track).locked) {
			return;
		}
		event.stopPropagation();
		const gesture: GroupDragGesture = {
			anchorId: segmentId,
			edge: dragEdgeAt(element.getBoundingClientRect(), event.clientX),
			originX: event.clientX,
			originY: event.clientY,
		};
		const state = runtime.store.getState();
		const session = createGroupDragSession(
			{
				assets: runtime.assets,
				project,
				range: runtime.range,
				rippleMode: state.rippleMode,
				selectedIds: state.selection.segmentIds,
				snapEnabled: state.snapEnabled,
				time: runtime.time,
				zoom: runtime.zoom,
			},
			gesture
		);
		active = {
			cancelled: false,
			directIds: session.groupIds,
			gesture,
			moved: false,
			pointerId: event.pointerId,
			project,
			restore: () => undefined,
			session,
			unsubscribe: runtime.store.subscribe(() => {
				const current = active;
				if (
					current?.moved &&
					!current.cancelled &&
					runtime.store.getState().drag === null
				) {
					// Escape cleared the drag: drop the preview and snap guide, and
					// ignore further moves and the release.
					current.cancelled = true;
					runtime.store.setState({ snapGuideTime: null });
					current.restore();
					current.restore = () => undefined;
				}
			}),
		};
		element.addEventListener("pointermove", onMove);
		element.addEventListener("pointerup", onUp);
		element.addEventListener("pointercancel", onCancel);
		try {
			element.setPointerCapture(event.pointerId);
		} catch {
			// Synthetic pointers (tests) cannot be captured; listeners still work.
		}
	};

	const onClick = (event: MouseEvent) => {
		if (suppressClick) {
			suppressClick = false;
			event.stopPropagation();
			event.preventDefault();
		}
	};

	element.addEventListener("pointerdown", onDown, { capture: true });
	element.addEventListener("click", onClick, { capture: true });
	return () => {
		end();
		element.removeEventListener("pointerdown", onDown, { capture: true });
		element.removeEventListener("click", onClick, { capture: true });
		if (element.getAttribute(CLIP_ID_ATTRIBUTE) === segmentId) {
			element.removeAttribute(CLIP_ID_ATTRIBUTE);
		}
	};
}

/** Diameter of a fade knee handle, in px. */
export const FADE_KNEE_PX = 10;

/**
 * Fade length after dragging a knee `dx` pixels from where its drag started:
 * the fade-in knee grows rightward, the fade-out knee leftward. The result is
 * frame-quantized and bounded by the clip and the other fade.
 */
export function fadeFromDrag(
	segment: Segment,
	fade: "in" | "out",
	startSeconds: number,
	dx: number,
	zoom: number,
	fps: number
): number {
	const bounds = fadeBounds(segment);
	const limit = fade === "in" ? bounds.in : bounds.out;
	const moved = zoom > 0 ? (fade === "in" ? dx : -dx) / zoom : 0;
	const quantized = Math.round((startSeconds + moved) * fps) / fps;
	return Math.max(0, Math.min(limit, quantized));
}

/**
 * Horizontal centre of a fade knee inside its clip, in px: where the fade
 * ramp ends, but never over the trim handles.
 */
export function fadeKneeOffset(
	fade: "in" | "out",
	fadeSeconds: number,
	clipWidthPx: number,
	zoom: number
): number {
	const inset = EDGE_HANDLE_PX + FADE_KNEE_PX / 2;
	const reach = Math.max(
		inset,
		Math.min(clipWidthPx - inset, fadeSeconds * zoom)
	);
	return fade === "in" ? reach : clipWidthPx - reach;
}

/** Tooltip text for a fade knee. */
export const fadeLabel = (fade: "in" | "out", fadeSeconds: number) =>
	`Fade ${fade} ${fadeSeconds.toFixed(2)} s`;
