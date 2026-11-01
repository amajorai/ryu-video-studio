import { useLiteralMessages } from "@ryu/i18n/react";
import {
	type PointerEvent as ReactPointerEvent,
	type RefObject,
	useEffect,
	useLayoutEffect,
	useRef,
} from "react";
import type { Marker } from "../../../shared/project.ts";
import { useEditorProject } from "../editor/context.tsx";
import type { EditorStore } from "../editor/store.ts";
import { TimecodeField } from "./TimecodeField.tsx";
import { TimelineMarkers } from "./TimelineMarkers.tsx";
import { startRangeSelect } from "./TimelineRange.tsx";
import { TimelineZoomSlider } from "./TimelineZoomSlider.tsx";
import { useLaneClickSeek, useScrub } from "./useScrub.ts";
import {
	lanesOffsetOf,
	timelineViewport,
	useTimelineZoom,
} from "./useTimelineZoom.ts";
import { rulerTicks } from "./zoom-math.ts";

/** Ruler height in CSS pixels (matches `.studio-ruler`). */
const RULER_HEIGHT = 35;
const MAJOR_TICK_HEIGHT = 10;
const MINOR_TICK_HEIGHT = 4;
/** Widest canvas drawn when the viewport cannot be measured. */
const FALLBACK_CANVAS_WIDTH = 1600;

/** The ruler window to draw: its left offset and width in lane pixels. */
export function rulerWindow({
	lanesOffset,
	rulerWidth,
	scrollLeft,
	viewportWidth,
}: {
	lanesOffset: number;
	rulerWidth: number;
	scrollLeft: number;
	viewportWidth: number;
}): { left: number; width: number } {
	const left = Math.min(
		Math.max(0, rulerWidth),
		Math.max(0, scrollLeft - lanesOffset)
	);
	return {
		left,
		width: Math.max(0, Math.min(rulerWidth - left, viewportWidth)),
	};
}

/**
 * Draw adaptive ticks for the visible part of the ruler. The canvas only
 * ever spans the viewport, so very long or very zoomed timelines stay cheap.
 */
function drawRuler(
	canvas: HTMLCanvasElement,
	ruler: HTMLElement,
	store: EditorStore,
	fps: number
) {
	const { scrollLeft, zoomPxPerSec: zoom } = store.getState();
	const viewport = timelineViewport(store);
	const rulerWidth = ruler.clientWidth || ruler.scrollWidth;
	const { left, width } = viewport
		? rulerWindow({
				lanesOffset: lanesOffsetOf(viewport),
				rulerWidth,
				scrollLeft,
				viewportWidth: viewport.scroll.clientWidth,
			})
		: { left: 0, width: Math.min(rulerWidth, FALLBACK_CANVAS_WIDTH) };
	canvas.style.left = `${left}px`;
	canvas.style.width = `${width}px`;
	const ratio = globalThis.devicePixelRatio || 1;
	const pixelWidth = Math.max(1, Math.round(width * ratio));
	const pixelHeight = Math.round(RULER_HEIGHT * ratio);
	if (canvas.width !== pixelWidth) {
		canvas.width = pixelWidth;
	}
	if (canvas.height !== pixelHeight) {
		canvas.height = pixelHeight;
	}
	const context = canvas.getContext("2d");
	if (!(context && width > 0 && zoom > 0)) {
		return;
	}
	context.setTransform(ratio, 0, 0, ratio, 0, 0);
	context.clearRect(0, 0, width, RULER_HEIGHT);
	const color = getComputedStyle(canvas).color || "currentColor";
	context.strokeStyle = color;
	context.fillStyle = color;
	context.lineWidth = 1;
	context.font = "10px ui-monospace, SFMono-Regular, Menlo, monospace";
	context.textBaseline = "top";
	const { ticks } = rulerTicks({
		endTime: (left + width) / zoom,
		fps,
		startTime: left / zoom,
		zoom,
	});
	context.beginPath();
	for (const tick of ticks) {
		const x = Math.round(tick.x - left) + 0.5;
		const height = tick.major ? MAJOR_TICK_HEIGHT : MINOR_TICK_HEIGHT;
		context.moveTo(x, RULER_HEIGHT);
		context.lineTo(x, RULER_HEIGHT - height);
	}
	context.globalAlpha = 0.55;
	context.stroke();
	context.globalAlpha = 0.9;
	for (const tick of ticks) {
		if (tick.label) {
			context.fillText(tick.label, Math.round(tick.x - left) + 3, 3);
		}
	}
	context.globalAlpha = 1;
}

/** Redraw the ruler canvas on zoom, scroll, resize, and frame-rate changes. */
function useRulerCanvas({
	canvasRef,
	fps,
	rulerRef,
	store,
	tracksWidthKey,
}: {
	canvasRef: RefObject<HTMLCanvasElement | null>;
	fps: number;
	rulerRef: RefObject<HTMLElement | null>;
	store: EditorStore;
	/** Changes whenever the lanes' width may have changed (duration). */
	tracksWidthKey: number;
}) {
	useLayoutEffect(() => {
		const canvas = canvasRef.current;
		const ruler = rulerRef.current;
		if (!(canvas && ruler)) {
			return;
		}
		let frame = 0;
		const redraw = () => {
			cancelAnimationFrame(frame);
			frame = requestAnimationFrame(() => drawRuler(canvas, ruler, store, fps));
		};
		drawRuler(canvas, ruler, store, fps);
		let last = store.getState();
		const unsubscribe = store.subscribe(() => {
			const next = store.getState();
			if (
				next.scrollLeft !== last.scrollLeft ||
				next.zoomPxPerSec !== last.zoomPxPerSec
			) {
				redraw();
			}
			last = next;
		});
		const scroll = timelineViewport(store)?.scroll;
		const observer =
			typeof ResizeObserver === "function" && scroll
				? new ResizeObserver(redraw)
				: null;
		if (observer && scroll) {
			observer.observe(scroll);
		}
		return () => {
			cancelAnimationFrame(frame);
			unsubscribe();
			observer?.disconnect();
		};
	}, [canvasRef, fps, rulerRef, store, tracksWidthKey]);
}

/** Presses that never start a range selection (fields, flags, the corner). */
const RANGE_SELECT_IGNORED =
	"button,input,select,textarea,a,[role=menu],[role=menuitem],[role=slider],[data-no-scrub]";

/**
 * Canvas tick ruler with marker flags. Pressing or dragging on it scrubs the
 * playhead (frame-quantized); Shift+drag marks the I/O range instead (it
 * snaps to clip edges, markers and the playhead); Ctrl/Alt+wheel over the
 * timeline zooms around the pointer. Its sticky corner, above the track headers, holds the go-to
 * timecode field and the zoom slider.
 */
export function TimelineRuler({
	duration,
	markers,
	onSeek,
	zoom,
}: {
	duration: number;
	markers: readonly Marker[];
	onSeek: (time: number) => void;
	zoom: number;
}) {
	const tl = useLiteralMessages();
	const runtime = useEditorProject();
	const { project, store } = runtime;
	const rulerRef = useRef<HTMLDivElement>(null);
	const canvasRef = useRef<HTMLCanvasElement>(null);
	useTimelineZoom({ anchorRef: rulerRef, store, time: runtime.time });
	useLaneClickSeek({ anchorRef: rulerRef, runtime, zoom });
	const { onPointerDown: onScrubPointerDown } = useScrub({
		originOf: () => rulerRef.current,
		runtime,
		zoom,
	});
	const rangeCleanup = useRef<(() => void) | null>(null);
	useEffect(() => () => rangeCleanup.current?.(), []);
	const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
		const ruler = rulerRef.current;
		const target = event.target as Element | null;
		if (
			event.shiftKey &&
			event.button === 0 &&
			ruler &&
			!runtime.busy &&
			!target?.closest?.(RANGE_SELECT_IGNORED)
		) {
			rangeCleanup.current?.();
			rangeCleanup.current = startRangeSelect(
				{ ...runtime, zoom },
				ruler,
				event
			);
			return;
		}
		onScrubPointerDown(event);
	};
	useRulerCanvas({
		canvasRef,
		fps: project.fps,
		rulerRef,
		store,
		tracksWidthKey: duration,
	});
	return (
		<div
			className="studio-ruler cursor-ew-resize touch-none select-none text-muted-foreground"
			data-timeline-ruler=""
			onPointerDown={onPointerDown}
			ref={rulerRef}
		>
			<div
				className="sticky left-0 z-[4] -ml-[11rem] flex h-full w-[11rem] cursor-default items-center gap-1 bg-card/95 px-1"
				data-no-scrub=""
			>
				<TimecodeField
					className="h-7 w-[6.6rem] shrink-0 px-1 font-mono text-[0.65rem]"
					duration={duration}
					fps={project.fps}
					onFocus={() => runtime.setPlaying(false)}
					onInvalid={(text) =>
						runtime.setStatus(
							tl(
								'"{text}" is not a timecode. Use HH:MM:SS:FF, frames, or seconds like 4.5s.',
								{ text }
							)
						)
					}
					onSeek={onSeek}
					time={runtime.time}
				/>
				<TimelineZoomSlider className="min-w-0 flex-1" store={store} />
			</div>
			<div
				aria-hidden="true"
				className="pointer-events-none absolute inset-0 overflow-hidden"
			>
				<canvas className="absolute top-0 h-[35px]" ref={canvasRef} />
			</div>
			<TimelineMarkers markers={markers} onSeek={onSeek} zoom={zoom} />
		</div>
	);
}
