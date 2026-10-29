import { useLiteralMessages } from "@ryu/i18n/react";
import {
	type KeyboardEvent,
	type PointerEvent as ReactPointerEvent,
	useEffect,
	useRef,
} from "react";
import { quantizeToFrame } from "../../../shared/timeline-snap.ts";
import {
	clearSnapGuide,
	createDragSnapper,
} from "../editor/actions/snapping.ts";
import { useEditorProject } from "../editor/context.tsx";
import { clock } from "../editor/format.ts";
import type { EditorRuntime } from "../editor/runtime.ts";
import type { EditorTimelineStyle } from "./timeline-style.ts";
import "./TimelineRange.css";

/** Shortest range an edge drag or a Shift+drag keeps, in seconds. */
export const MIN_RANGE_SECONDS = 0.04;

export type RangeEdge = "end" | "start";

interface Range {
	end: number;
	start: number;
}

/**
 * Move one edge of the range to `time`, clamped to the timeline and kept at
 * least `MIN_RANGE_SECONDS` from the other edge.
 */
export function moveRangeEdge(
	range: Range,
	edge: RangeEdge,
	time: number,
	duration: number
): Range {
	const end = Math.max(MIN_RANGE_SECONDS, duration);
	if (edge === "start") {
		return {
			end: range.end,
			start: Math.max(0, Math.min(time, range.end - MIN_RANGE_SECONDS)),
		};
	}
	return {
		end: Math.min(end, Math.max(time, range.start + MIN_RANGE_SECONDS)),
		start: range.start,
	};
}

/** The range a Shift+drag on the ruler spans from `anchor` to `time`. */
export function rangeBetween(
	anchor: number,
	time: number,
	duration: number
): Range {
	const limit = Math.max(MIN_RANGE_SECONDS, duration);
	const start = Math.max(0, Math.min(anchor, time));
	const end = Math.min(limit, Math.max(anchor, time));
	return end - start >= MIN_RANGE_SECONDS
		? { end, start }
		: { end: Math.min(limit, start + MIN_RANGE_SECONDS), start };
}

type RangeRuntime = Pick<
	EditorRuntime,
	| "duration"
	| "project"
	| "range"
	| "selectedId"
	| "setPlaying"
	| "setRangeEnd"
	| "setRangeMarked"
	| "setRangeStart"
	| "store"
	| "time"
	| "zoom"
>;

const applyRange = (runtime: RangeRuntime, next: Range) => {
	// Order the writes so start never passes end in between.
	if (next.start >= runtime.range.end) {
		runtime.setRangeEnd(next.end);
		runtime.setRangeStart(next.start);
	} else {
		runtime.setRangeStart(next.start);
		runtime.setRangeEnd(next.end);
	}
	runtime.setRangeMarked(true);
};

/**
 * Track one pointer gesture over the lanes: `onTime` receives each snapped
 * timeline time (clip edges, markers, the playhead; Alt suspends snapping).
 * `origin` is the element whose left edge is time 0.
 */
export function trackRangePointer(
	runtime: RangeRuntime,
	origin: HTMLElement,
	event: ReactPointerEvent<HTMLElement>,
	onTime: (time: number) => void
): () => void {
	// The range's own edges are not snap targets while it moves.
	const snapper = createDragSnapper({
		...runtime,
		range: { end: 0, start: 0 },
	});
	const fps = runtime.project?.fps ?? 30;
	const timeAt = (clientX: number, altKey: boolean) => {
		const raw = Math.max(
			0,
			(clientX - origin.getBoundingClientRect().left) / runtime.zoom
		);
		return altKey ? quantizeToFrame(raw, fps) : snapper(raw).time;
	};
	const { pointerId } = event;
	onTime(timeAt(event.clientX, event.altKey));
	const onMove = (move: PointerEvent) => {
		if (move.pointerId === pointerId) {
			onTime(timeAt(move.clientX, move.altKey));
		}
	};
	const stop = (end: PointerEvent) => {
		if (end.pointerId === pointerId) {
			cleanup();
		}
	};
	const cleanup = () => {
		window.removeEventListener("pointermove", onMove);
		window.removeEventListener("pointerup", stop);
		window.removeEventListener("pointercancel", stop);
		clearSnapGuide(runtime);
	};
	window.addEventListener("pointermove", onMove);
	window.addEventListener("pointerup", stop);
	window.addEventListener("pointercancel", stop);
	return cleanup;
}

/**
 * Start a Shift+drag range selection on the ruler: the press is one edge and
 * the pointer the other. Returns the cleanup for an interrupted gesture.
 */
export function startRangeSelect(
	runtime: RangeRuntime,
	origin: HTMLElement,
	event: ReactPointerEvent<HTMLElement>
): () => void {
	event.preventDefault();
	runtime.setPlaying(false);
	let anchor: number | null = null;
	return trackRangePointer(runtime, origin, event, (time) => {
		anchor ??= time;
		applyRange(runtime, rangeBetween(anchor, time, runtime.duration));
	});
}

const KEY_STEPS: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1 };

/**
 * The marked I/O range drawn across the ruler and every lane, with
 * draggable, keyboard-operable In and Out edges that snap like clip edges.
 * Hidden until a range is marked (I/O, the range fields, or Shift+drag on
 * the ruler).
 */
export function TimelineRange({ zoom }: { zoom: number }) {
	const tl = useLiteralMessages();
	const runtime = useEditorProject();
	const { duration, project, range, rangeMarked } = runtime;
	const bandRef = useRef<HTMLDivElement>(null);
	const latest = useRef(runtime);
	const cleanup = useRef<(() => void) | null>(null);
	useEffect(() => {
		latest.current = runtime;
	});
	useEffect(() => () => cleanup.current?.(), []);
	if (!(rangeMarked && range.end > range.start)) {
		return null;
	}
	const bandStyle: EditorTimelineStyle = {
		"--studio-range-left": `${range.start * zoom}px`,
		"--studio-range-width": `${Math.max(2, (range.end - range.start) * zoom)}px`,
	};
	const startDrag =
		(edge: RangeEdge) => (event: ReactPointerEvent<HTMLDivElement>) => {
			const origin = bandRef.current?.parentElement;
			if (event.button !== 0 || !origin) {
				return;
			}
			event.preventDefault();
			event.stopPropagation();
			cleanup.current?.();
			runtime.setPlaying(false);
			cleanup.current = trackRangePointer(runtime, origin, event, (time) => {
				const current = latest.current;
				applyRange(
					current,
					moveRangeEdge(current.range, edge, time, current.duration)
				);
			});
		};
	const onKeyDown =
		(edge: RangeEdge) => (event: KeyboardEvent<HTMLDivElement>) => {
			const direction = KEY_STEPS[event.key];
			if (!direction || event.altKey || event.metaKey || event.ctrlKey) {
				return;
			}
			event.preventDefault();
			event.stopPropagation();
			const step = event.shiftKey ? 1 : 1 / (project.fps || 30);
			const from = edge === "start" ? range.start : range.end;
			applyRange(
				runtime,
				moveRangeEdge(range, edge, from + direction * step, duration)
			);
		};
	const edgeProps = (edge: RangeEdge) => {
		const value = edge === "start" ? range.start : range.end;
		return {
			"aria-label": edge === "start" ? "Range in" : "Range out",
			"aria-orientation": "horizontal" as const,
			"aria-valuemax": Number(duration.toFixed(3)),
			"aria-valuemin": 0,
			"aria-valuenow": Number(value.toFixed(3)),
			"aria-valuetext": clock(value),
			"data-range-edge": edge,
			onKeyDown: onKeyDown(edge),
			onPointerDown: startDrag(edge),
			role: "slider",
			tabIndex: 0,
		};
	};
	return (
		<div
			className="studio-timeline-range"
			data-timeline-range=""
			ref={bandRef}
			style={bandStyle}
			title={tl("Range {start}–{end}", {
				end: clock(range.end),
				start: clock(range.start),
			})}
		>
			<div
				className="studio-timeline-range-edge left-0 -translate-x-1/2"
				{...edgeProps("start")}
			/>
			<div
				className="studio-timeline-range-edge right-0 translate-x-1/2"
				{...edgeProps("end")}
			/>
		</div>
	);
}
