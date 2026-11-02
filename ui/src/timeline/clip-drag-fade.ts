import { formatMessage } from "@ryu/i18n/core";
import type { LiteralMessage } from "@ryu/i18n/react";
import { fadeBounds } from "../../../shared/group-edits.ts";
import type { Segment } from "../../../shared/project.ts";
import { EDGE_HANDLE_PX } from "./clip-drag-geometry.ts";

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

/** English fallback until a caller passes the Companion's `tl`. */
const englishMessages: LiteralMessage = (source, values) =>
	formatMessage(source, values, "en");

/** Tooltip text for a fade knee. */
export const fadeLabel = (
	fade: "in" | "out",
	fadeSeconds: number,
	tl: LiteralMessage = englishMessages
) =>
	tl("Fade {direction, select, in {in} other {out}} {seconds} s", {
		direction: fade,
		seconds: fadeSeconds.toFixed(2),
	});
