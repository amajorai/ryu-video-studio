import { type RefObject, useEffect, useLayoutEffect, useRef } from "react";
import type { EditorStore } from "../editor/store.ts";
import { useEditorStore } from "../editor/store.ts";
import {
	anchoredScrollLeft,
	clampZoom,
	fitZoom,
	timeAtViewportX,
	wheelDeltaPx,
	wheelZoom,
} from "./zoom-math.ts";

/** The scroll viewport the timeline lanes sit in. */
export const TIMELINE_SCROLL_SELECTOR = ".studio-timeline-scroll";

/** The scrolling viewport and the lanes element whose left edge is time 0. */
export interface TimelineViewport {
	lanes: HTMLElement;
	scroll: HTMLElement;
}

/** A timeline time pinned at a viewport x position across a zoom change. */
export interface ZoomAnchor {
	time: number;
	/** Pixels from the scroll viewport's left edge. */
	viewportX: number;
}

const viewports = new WeakMap<EditorStore, TimelineViewport>();
const pendingAnchors = new WeakMap<EditorStore, ZoomAnchor>();

/** The mounted timeline viewport of an editor, if its ruler is mounted. */
export function timelineViewport(
	store: EditorStore
): TimelineViewport | undefined {
	return viewports.get(store);
}

/** Where time 0 sits inside the scrolled content, in pixels. */
export function lanesOffsetOf({ lanes, scroll }: TimelineViewport): number {
	return (
		lanes.getBoundingClientRect().left -
		scroll.getBoundingClientRect().left +
		scroll.scrollLeft
	);
}

/** Visible lane width: the viewport minus the track header gutter. */
export function laneWidthOf(viewport: TimelineViewport): number {
	return Math.max(0, viewport.scroll.clientWidth - lanesOffsetOf(viewport));
}

/**
 * The anchor a zoom without a pointer keeps fixed: the playhead when it is
 * on screen, otherwise the time at the viewport's center.
 */
export function defaultZoomAnchor({
	lanesOffset,
	scrollLeft,
	time,
	viewportWidth,
	zoom,
}: {
	lanesOffset: number;
	scrollLeft: number;
	time: number;
	viewportWidth: number;
	zoom: number;
}): ZoomAnchor {
	const playheadX = time * zoom + lanesOffset - scrollLeft;
	if (playheadX >= lanesOffset && playheadX <= viewportWidth) {
		return { time, viewportX: playheadX };
	}
	const viewportX = Math.max(lanesOffset, viewportWidth / 2);
	return {
		time: timeAtViewportX({ lanesOffset, scrollLeft, viewportX, zoom }),
		viewportX,
	};
}

/**
 * Change the timeline zoom, keeping `anchor` fixed on screen. Without an
 * anchor the timeline keeps the playhead (or the viewport center) in place.
 */
export function zoomTimeline(
	store: EditorStore,
	zoom: number,
	anchor?: ZoomAnchor
) {
	const next = clampZoom(zoom);
	if (next === store.getState().zoomPxPerSec) {
		return next;
	}
	if (anchor) {
		pendingAnchors.set(store, anchor);
	}
	store.setState({ zoomPxPerSec: next });
	return next;
}

/** Zoom so `duration` seconds fill the visible lanes, scrolled to the start. */
export function zoomTimelineToFit(store: EditorStore, duration: number) {
	const viewport = timelineViewport(store);
	const laneWidth = viewport ? laneWidthOf(viewport) : 0;
	const lanesOffset = viewport ? lanesOffsetOf(viewport) : 0;
	const zoom = clampZoom(fitZoom(duration, laneWidth > 0 ? laneWidth : 800));
	const anchor = { time: 0, viewportX: lanesOffset };
	if (viewport && zoom === store.getState().zoomPxPerSec) {
		// Already at the fit zoom: no re-render will apply the anchor, so
		// scroll back to the start here.
		viewport.scroll.scrollLeft = anchoredScrollLeft({
			anchorTime: anchor.time,
			lanesOffset,
			viewportX: anchor.viewportX,
			zoom,
		});
		store.setState({ scrollLeft: viewport.scroll.scrollLeft });
		return zoom;
	}
	return zoomTimeline(store, zoom, anchor);
}

/**
 * Wheel zoom and pan for the timeline. Mount it in an element inside the
 * lanes (the ruler); it attaches to the enclosing scroll viewport:
 * - Ctrl/Alt+wheel and trackpad pinch zoom around the pointer;
 * - Shift/Cmd+wheel scrolls horizontally;
 * - a plain wheel keeps the browser's vertical scroll.
 * It also mirrors the viewport's horizontal scroll into `store.scrollLeft`
 * and keeps the anchor fixed whenever the zoom changes.
 */
export function useTimelineZoom({
	anchorRef,
	store,
	time,
}: {
	/** An element inside the lanes; its parent is the lanes element. */
	anchorRef: RefObject<HTMLElement | null>;
	store: EditorStore;
	time: number;
}) {
	const zoom = useEditorStore(store, (state) => state.zoomPxPerSec);
	const previousZoom = useRef(zoom);
	const latestTime = useRef(time);
	useEffect(() => {
		latestTime.current = time;
	}, [time]);

	// A layout effect, so sibling layout effects (the ruler canvas) see the viewport.
	useLayoutEffect(() => {
		const lanes = anchorRef.current?.parentElement;
		const scroll = lanes?.closest<HTMLElement>(TIMELINE_SCROLL_SELECTOR);
		if (!(lanes && scroll)) {
			return;
		}
		const viewport: TimelineViewport = { lanes, scroll };
		viewports.set(store, viewport);
		const onWheel = (event: WheelEvent) => {
			if (event.ctrlKey || event.altKey) {
				event.preventDefault();
				const current = store.getState().zoomPxPerSec;
				const viewportX = event.clientX - scroll.getBoundingClientRect().left;
				const anchorTime = timeAtViewportX({
					lanesOffset: lanesOffsetOf(viewport),
					scrollLeft: scroll.scrollLeft,
					viewportX,
					zoom: current,
				});
				zoomTimeline(store, wheelZoom(current, event.deltaY, event.deltaMode), {
					time: anchorTime,
					viewportX,
				});
				return;
			}
			if (event.shiftKey || event.metaKey) {
				const delta = event.deltaX === 0 ? event.deltaY : event.deltaX;
				if (delta === 0) {
					return;
				}
				event.preventDefault();
				scroll.scrollLeft += wheelDeltaPx(delta, event.deltaMode);
			}
		};
		const onScroll = () => {
			store.setState({ scrollLeft: scroll.scrollLeft });
		};
		scroll.addEventListener("wheel", onWheel, { passive: false });
		scroll.addEventListener("scroll", onScroll, { passive: true });
		return () => {
			scroll.removeEventListener("wheel", onWheel);
			scroll.removeEventListener("scroll", onScroll);
			if (viewports.get(store) === viewport) {
				viewports.delete(store);
			}
		};
	}, [anchorRef, store]);

	useLayoutEffect(() => {
		const previous = previousZoom.current;
		previousZoom.current = zoom;
		const pending = pendingAnchors.get(store);
		pendingAnchors.delete(store);
		if (previous === zoom) {
			return;
		}
		const viewport = timelineViewport(store);
		if (!viewport) {
			return;
		}
		const lanesOffset = lanesOffsetOf(viewport);
		const anchor =
			pending ??
			defaultZoomAnchor({
				lanesOffset,
				// The mirror holds the offset from before the zoom re-rendered the lanes.
				scrollLeft: store.getState().scrollLeft,
				time: latestTime.current,
				viewportWidth: viewport.scroll.clientWidth,
				zoom: previous,
			});
		const nextScroll = anchoredScrollLeft({
			anchorTime: anchor.time,
			lanesOffset,
			viewportX: anchor.viewportX,
			zoom,
		});
		viewport.scroll.scrollLeft = nextScroll;
		store.setState({ scrollLeft: viewport.scroll.scrollLeft });
	}, [store, zoom]);

	return { zoom };
}
