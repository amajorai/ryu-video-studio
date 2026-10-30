import { z } from "zod";
import {
	type GraphicKeyframeChannel,
	graphicChannelSample,
	graphicKeyframeChannels,
	isGraphicKeyframeChannel,
	isTitleKeyframeChannel,
	type KeyframeSample,
	type TitleKeyframeChannel,
	titleChannelSample,
	titleKeyframeChannels,
} from "../../../shared/overlay-keyframes.ts";
import type { Graphic, Keyframe, Title } from "../../../shared/project.ts";
import {
	isColorKeyframeProperty,
	type KeyframeProperty,
} from "../../../shared/schema/keyframe.ts";
import type { KeyframeOwnerRef } from "../keyframes/lane-math.ts";

export const laneViewSchema = z.enum(["lanes", "graph"]);
export type LaneView = z.infer<typeof laneViewSchema>;
/** Shared with the clip lanes, so one choice applies to every lane. */
export const LANE_VIEW_KEY = "keyframes.lane-view";
export const DIAMOND_PX = 10;

/** A keyframed overlay item: a title or a graphic. */
export type OverlayKeyframeOwner =
	| { item: Graphic; kind: "graphics" }
	| { item: Title; kind: "titles" };

export interface DragState {
	channel: string;
	id: string;
	moved: boolean;
	pointerId: number;
	startX: number;
	startY: number;
}

export const sameTime = (a: number, b: number) => Math.abs(a - b) < 1e-6;

export function ownerRef(owner: OverlayKeyframeOwner): KeyframeOwnerRef {
	return owner.kind === "titles"
		? { titleId: owner.item.id }
		: { graphicId: owner.item.id };
}

export function channelsOf(
	owner: OverlayKeyframeOwner
): readonly (GraphicKeyframeChannel | TitleKeyframeChannel)[] {
	return owner.kind === "titles"
		? titleKeyframeChannels
		: graphicKeyframeChannels;
}

export function sampleOf(
	owner: OverlayKeyframeOwner,
	property: KeyframeProperty,
	elapsed: number
): KeyframeSample | null {
	if (owner.kind === "titles") {
		return isTitleKeyframeChannel(property)
			? titleChannelSample(owner.item, property, elapsed)
			: null;
	}
	return isGraphicKeyframeChannel(property)
		? graphicChannelSample(owner.item, property, elapsed)
		: null;
}

/** A diamond's readout: the color, or the value to two decimals. */
export function overlayKeyframeText(frame: Keyframe): string {
	return isColorKeyframeProperty(frame.property)
		? (frame.color ?? "")
		: frame.value.toFixed(2);
}
