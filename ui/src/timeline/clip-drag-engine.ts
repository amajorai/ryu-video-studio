import {
	type Project,
	segmentDuration,
	trackSettingFor,
} from "../../../shared/project.ts";
import type { EditorRuntime } from "../editor/runtime.ts";
import { commitGroupDrag } from "./clip-drag-apply.ts";
import { dragEdgeAt } from "./clip-drag-geometry.ts";
import {
	createGroupDragSession,
	type GroupDragGesture,
	type GroupDragPlan,
} from "./clip-drag-group.ts";

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
