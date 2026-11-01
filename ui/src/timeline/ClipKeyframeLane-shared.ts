import type { KeyboardEvent, SyntheticEvent } from "react";
import { z } from "zod";
import { formatDb, gainToDb } from "../../../shared/decibels.ts";
import type { KeyframeProperty } from "../../../shared/schema/keyframe.ts";

/** Marks the lane overlay that sits beside a clip, with the clip's id. */
export const KEYFRAME_LANES_ATTRIBUTE = "data-keyframe-lanes-for";

export const laneViewSchema = z.enum(["lanes", "graph"]);
export type LaneView = z.infer<typeof laneViewSchema>;
export const LANE_VIEW_KEY = "keyframes.lane-view";

export const DIAMOND_PX = 10;

/** The selected keyframe, by channel and time (saves re-mint keyframe ids). */
export interface LaneSelection {
	channel: string;
	time: number;
}

export interface DiamondDragState {
	channel: string;
	id: string;
	moved: boolean;
	pointerId: number;
	startX: number;
	startY: number;
}

export const noSubscription = () => () => undefined;

/** A value readout for a keyframe of `property`. */
export function keyframeValueText(property: KeyframeProperty, value: number) {
	if (property === "volume") {
		return formatDb(gainToDb(value));
	}
	return value.toFixed(2);
}

export const sameTime = (a: number, b: number) => Math.abs(a - b) < 1e-6;

/** Keep pointer events inside the lanes from reaching the clip. */
export const contain = (event: SyntheticEvent) => event.stopPropagation();

const CLIP_NUDGE_KEYS = new Set([
	"ArrowDown",
	"ArrowLeft",
	"ArrowRight",
	"ArrowUp",
]);

/**
 * Keys pressed inside the lanes reach the window's shortcuts (undo, playback)
 * as usual; only Alt+Arrow, which the clip (reached through the portal)
 * would take as a clip nudge, stops here. Keys the diamonds handle stop in
 * their own handler.
 */
export const containClipKeys = (event: KeyboardEvent) => {
	if (event.altKey && CLIP_NUDGE_KEYS.has(event.key)) {
		event.stopPropagation();
	}
};
