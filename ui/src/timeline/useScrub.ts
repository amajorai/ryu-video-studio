import type { PointerEvent as ReactPointerEvent, RefObject } from "react";
import { useEffect, useRef } from "react";
import { frameQuantize } from "../../../shared/edit-points.ts";
import type { EditorRuntime } from "../editor/runtime.ts";
import { startsMarquee } from "./useMarquee.ts";

/** Presses on these never start a scrub (marker flags, fields, menus). */
const SCRUB_IGNORED =
	"button,input,select,textarea,a,[role=menu],[role=menuitem],[data-no-scrub]";
/** Pointer travel (px) after which a lane press is a drag, not a seek click. */
export const LANE_CLICK_SLOP_PX = 3;

/**
 * Timeline time under `clientX`, given the client x of time 0: clamped to
 * the timeline and quantized to the frame grid.
 */
export function scrubTime({
	clientX,
	duration,
	fps,
	originX,
	zoom,
}: {
	clientX: number;
	duration: number;
	fps: number;
	originX: number;
	zoom: number;
}): number {
	if (!(zoom > 0)) {
		return 0;
	}
	const end = Math.max(0, duration);
	const quantized = frameQuantize(Math.max(0, (clientX - originX) / zoom), fps);
	// Quantizing can round past the end, so clamp afterwards.
	return Math.min(end, quantized);
}

interface ClosestTarget {
	closest: (selector: string) => unknown;
}

const hasClosest = (
	target: EventTarget | null
): target is EventTarget & ClosestTarget =>
	typeof (target as Partial<ClosestTarget> | null)?.closest === "function";

const closestOf = (target: EventTarget | null, selector: string) =>
	hasClosest(target) && Boolean(target.closest(selector));

type ScrubRuntime = Pick<
	EditorRuntime,
	"busy" | "duration" | "project" | "setPlaying" | "setTime"
>;

/**
 * Pointer scrubbing: pressing seeks to the pointer and dragging keeps
 * seeking, frame-quantized, until release. `originOf` returns the element
 * whose left edge is time 0 (the lanes). Playback pauses while scrubbing.
 */
export function useScrub({
	originOf,
	runtime,
	zoom,
}: {
	originOf: () => HTMLElement | null | undefined;
	runtime: ScrubRuntime;
	zoom: number;
}): {
	onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
} {
	const latest = useRef({ originOf, runtime, zoom });
	useEffect(() => {
		latest.current = { originOf, runtime, zoom };
	});
	const cleanup = useRef<(() => void) | null>(null);
	useEffect(() => () => cleanup.current?.(), []);

	const seekTo = (clientX: number) => {
		const { originOf: origin, runtime: editor, zoom: scale } = latest.current;
		const element = origin();
		if (!(element && editor.project)) {
			return;
		}
		editor.setTime(
			scrubTime({
				clientX,
				duration: editor.duration,
				fps: editor.project.fps,
				originX: element.getBoundingClientRect().left,
				zoom: scale,
			})
		);
	};

	const onPointerDown = (event: ReactPointerEvent<HTMLElement>) => {
		const editor = latest.current.runtime;
		if (
			event.button !== 0 ||
			editor.busy ||
			!editor.project ||
			closestOf(event.target, SCRUB_IGNORED)
		) {
			return;
		}
		event.preventDefault();
		cleanup.current?.();
		const { pointerId } = event;
		const element = event.currentTarget;
		try {
			element.setPointerCapture?.(pointerId);
		} catch {
			// Capture is best effort; window listeners still track the drag.
		}
		editor.setPlaying(false);
		seekTo(event.clientX);
		const onMove = (move: PointerEvent) => {
			if (move.pointerId === pointerId) {
				seekTo(move.clientX);
			}
		};
		const onEnd = (end: PointerEvent) => {
			if (end.pointerId === pointerId) {
				cleanup.current?.();
			}
		};
		window.addEventListener("pointermove", onMove);
		window.addEventListener("pointerup", onEnd);
		window.addEventListener("pointercancel", onEnd);
		cleanup.current = () => {
			window.removeEventListener("pointermove", onMove);
			window.removeEventListener("pointerup", onEnd);
			window.removeEventListener("pointercancel", onEnd);
			try {
				if (element.hasPointerCapture?.(pointerId)) {
					element.releasePointerCapture(pointerId);
				}
			} catch {
				// The element may already be detached.
			}
			cleanup.current = null;
		};
	};

	return { onPointerDown };
}

/**
 * Clicking empty lane space seeks there. A press that travels more than
 * `LANE_CLICK_SLOP_PX` is a marquee or drag, not a click, and is ignored.
 * Listens on the parent of `anchorRef` (the lanes element, time 0 at its
 * left edge).
 */
export function useLaneClickSeek({
	anchorRef,
	runtime,
	zoom,
}: {
	anchorRef: RefObject<HTMLElement | null>;
	runtime: ScrubRuntime;
	zoom: number;
}) {
	const latest = useRef({ runtime, zoom });
	useEffect(() => {
		latest.current = { runtime, zoom };
	});
	useEffect(() => {
		const lanes = anchorRef.current?.parentElement;
		if (!lanes) {
			return;
		}
		let press: { pointerId: number; x: number; y: number } | null = null;
		const onDown = (event: PointerEvent) => {
			press =
				event.button === 0 && startsMarquee(event.target)
					? { pointerId: event.pointerId, x: event.clientX, y: event.clientY }
					: null;
		};
		const onUp = (event: PointerEvent) => {
			const current = press;
			press = null;
			const { runtime: editor, zoom: scale } = latest.current;
			if (
				!current ||
				current.pointerId !== event.pointerId ||
				editor.busy ||
				!editor.project ||
				Math.hypot(event.clientX - current.x, event.clientY - current.y) >
					LANE_CLICK_SLOP_PX
			) {
				return;
			}
			editor.setTime(
				scrubTime({
					clientX: event.clientX,
					duration: editor.duration,
					fps: editor.project.fps,
					originX: lanes.getBoundingClientRect().left,
					zoom: scale,
				})
			);
		};
		lanes.addEventListener("pointerdown", onDown);
		window.addEventListener("pointerup", onUp);
		return () => {
			lanes.removeEventListener("pointerdown", onDown);
			window.removeEventListener("pointerup", onUp);
		};
	}, [anchorRef]);
}
