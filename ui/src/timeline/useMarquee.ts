import { type RefObject, useEffect, useRef, useState } from "react";
import type { Project } from "../../../shared/project.ts";
import {
	clipsInRect,
	marqueeSelection,
	rectFromPoints,
	type TimelineRect,
	type TrackRow,
	timelineLayout,
} from "../../../shared/selection.ts";
import { trackOrderFor } from "../../../shared/track-edits.ts";
import { selectClips } from "../editor/actions/select.ts";
import type { EditorRuntime } from "../editor/runtime.ts";

/** Pointer travel (px) before a press on empty lane space becomes a marquee. */
export const MARQUEE_THRESHOLD_PX = 3;

/** Presses on these never start a marquee (clips, headers, controls, menus). */
const IGNORED_TARGETS =
	".studio-timeline-clip,.studio-track-label,button,input,select,textarea,[role=menu],[role=menuitem],[contenteditable=true]";

/** Lane elements, in the order `trackOrderFor` renders them. */
const TRACK_ROW_SELECTOR = ":scope > .studio-track";

interface ClosestTarget {
	closest: (selector: string) => unknown;
}

const hasClosest = (
	target: EventTarget | null
): target is EventTarget & ClosestTarget =>
	typeof (target as Partial<ClosestTarget> | null)?.closest === "function";

const closestOf = (target: EventTarget | null, selector: string): boolean =>
	hasClosest(target) && Boolean(target.closest(selector));

/** Whether a press on `target` is on empty lane space. */
export function startsMarquee(target: EventTarget | null): boolean {
	return (
		closestOf(target, ".studio-track") && !closestOf(target, IGNORED_TARGETS)
	);
}

/** Measure each rendered track row relative to the lanes container. */
export function measureTrackRows(
	container: HTMLElement,
	project: Pick<Project, "segments" | "trackSettings">
): TrackRow[] {
	const order = trackOrderFor(project);
	const origin = container.getBoundingClientRect();
	return [...container.querySelectorAll<HTMLElement>(TRACK_ROW_SELECTOR)]
		.slice(0, order.length)
		.map((element, index) => {
			const box = element.getBoundingClientRect();
			return {
				bottom: box.bottom - origin.top,
				top: box.top - origin.top,
				track: order[index] ?? index,
			};
		});
}

/** Clip ids under a marquee drawn over the lanes. */
export function marqueeHits(
	project: Project,
	rows: readonly TrackRow[],
	zoom: number,
	rect: TimelineRect
): string[] {
	return clipsInRect(timelineLayout(project, rows, zoom), rect);
}

interface Gesture {
	additive: boolean;
	initial: string[];
	moved: boolean;
	origin: { x: number; y: number };
	pointerId: number;
	rows: TrackRow[];
}

/**
 * Rubber-band selection: dragging on empty lane space draws a rectangle and
 * selects every clip it touches; Shift or Ctrl/Cmd extends the selection
 * the marquee started from. A plain click on empty space clears the
 * selection. Escape (which clears `store.drag`) cancels and restores it.
 * Listeners attach to the parent of `layerRef` (the lanes container).
 */
export function useMarquee({
	layerRef,
	runtime,
	zoom,
}: {
	layerRef: RefObject<HTMLElement | null>;
	runtime: EditorRuntime;
	zoom: number;
}): { rect: TimelineRect | null } {
	const [rect, setRect] = useState<TimelineRect | null>(null);
	// Handlers read the latest render through refs, so listeners attach once.
	const latest = useRef({ runtime, zoom });
	useEffect(() => {
		latest.current = { runtime, zoom };
	});

	useEffect(() => {
		const container = layerRef.current?.parentElement;
		if (!container) {
			return;
		}
		let gesture: Gesture | null = null;
		const point = (event: PointerEvent) => {
			const box = container.getBoundingClientRect();
			return { x: event.clientX - box.left, y: event.clientY - box.top };
		};
		const finish = () => {
			gesture = null;
			setRect(null);
			window.removeEventListener("pointermove", onMove);
			window.removeEventListener("pointerup", onUp);
			window.removeEventListener("pointercancel", onCancel);
		};
		const restore = () => {
			const current = gesture;
			if (current) {
				const { runtime: editor } = latest.current;
				selectClips(editor, current.initial);
			}
			finish();
		};
		const select = (ids: readonly string[]) => {
			const { runtime: editor } = latest.current;
			editor.store.setState((state) => ({
				selection: {
					...state.selection,
					primaryId: ids.at(-1) ?? null,
					segmentIds: [...ids],
				},
			}));
		};
		function onMove(event: PointerEvent) {
			const current = gesture;
			const { runtime: editor, zoom: scale } = latest.current;
			if (!(current && event.pointerId === current.pointerId)) {
				return;
			}
			if (current.moved && editor.store.getState().drag === null) {
				// Escape cleared the drag: cancel and restore the selection.
				restore();
				return;
			}
			const next = point(event);
			if (
				!current.moved &&
				Math.hypot(next.x - current.origin.x, next.y - current.origin.y) <
					MARQUEE_THRESHOLD_PX
			) {
				return;
			}
			if (!current.moved) {
				current.moved = true;
				editor.store.setState({
					drag: {
						ids: [],
						kind: "marquee",
						originX: event.clientX,
						originY: event.clientY,
					},
				});
			}
			const area = rectFromPoints(current.origin, next);
			setRect(area);
			const project = editor.project;
			if (project) {
				select(
					marqueeSelection(
						current.initial,
						marqueeHits(project, current.rows, scale, area),
						current.additive
					)
				);
			}
		}
		function onUp(event: PointerEvent) {
			const current = gesture;
			if (!(current && event.pointerId === current.pointerId)) {
				return;
			}
			const { runtime: editor } = latest.current;
			if (current.moved) {
				const cancelled = editor.store.getState().drag === null;
				editor.store.setState({ drag: null });
				if (cancelled) {
					restore();
					return;
				}
				selectClips(editor, editor.store.getState().selection.segmentIds);
			} else if (!current.additive) {
				selectClips(editor, []);
			}
			finish();
		}
		function onCancel(event: PointerEvent) {
			if (gesture && event.pointerId === gesture.pointerId) {
				latest.current.runtime.store.setState({ drag: null });
				restore();
			}
		}
		const onDown = (event: PointerEvent) => {
			const { runtime: editor } = latest.current;
			if (
				event.button !== 0 ||
				gesture ||
				editor.busy ||
				!editor.project ||
				!startsMarquee(event.target)
			) {
				return;
			}
			gesture = {
				additive: event.shiftKey || event.ctrlKey || event.metaKey,
				initial: [...editor.store.getState().selection.segmentIds],
				moved: false,
				origin: point(event),
				pointerId: event.pointerId,
				rows: measureTrackRows(container, editor.project),
			};
			window.addEventListener("pointermove", onMove);
			window.addEventListener("pointerup", onUp);
			window.addEventListener("pointercancel", onCancel);
		};
		container.addEventListener("pointerdown", onDown);
		return () => {
			container.removeEventListener("pointerdown", onDown);
			finish();
		};
	}, [layerRef]);

	return { rect };
}
