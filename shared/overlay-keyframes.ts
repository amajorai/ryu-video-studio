/**
 * Keyframe authoring for overlay items (titles and graphics): record a
 * channel's current value at the playhead, retime or re-value one keyframe,
 * change its easing, or remove it. Pure functions over the item, shared by
 * the Titles and Graphics panels; the keyframe lanes and the
 * `POST /projects/:id/keyframes` route replace whole channels instead
 * (`setKeyframes`).
 */
import type { Graphic, Keyframe, Title } from "./project.ts";
import {
	isColorKeyframeProperty,
	type KeyframeInterpolation,
	type KeyframeProperty,
	keyframeValueBounds,
	titleColorKeyframeProperties,
	titleStyleKeyframeProperties,
} from "./schema/keyframe.ts";
import {
	graphicAnimatedValue,
	graphicColorKeyframes,
	graphicColorValue,
	graphicKeyframeProperties,
} from "./shape-geometry.ts";
import {
	titleColorKeyValue,
	titleKeyValue,
	titleStyleKeyValue,
} from "./text-animation.ts";

/** Keyframes closer than this (seconds) are treated as the same keyframe. */
export const OVERLAY_KEYFRAME_EPSILON = 0.001;
export const MAX_OVERLAY_KEYFRAMES = 200;

/** A keyframe's payload: a number, or a color for color channels. */
export type KeyframeSample = { color: string } | { value: number };

export interface OverlayKeyframeItem {
	end: number;
	keyframes?: Keyframe[];
	start: number;
}

/** Title channels the panels and lanes offer, in display order. */
export const titleKeyframeChannels = [
	"x",
	"y",
	"scale",
	"rotation",
	"opacity",
	...titleStyleKeyframeProperties,
	...titleColorKeyframeProperties,
] as const satisfies readonly KeyframeProperty[];
export type TitleKeyframeChannel = (typeof titleKeyframeChannels)[number];

/** Graphic channels the panels and lanes offer, in display order. */
export const graphicKeyframeChannels = [
	...graphicKeyframeProperties,
	...graphicColorKeyframes,
] as const satisfies readonly KeyframeProperty[];
export type GraphicKeyframeChannel = (typeof graphicKeyframeChannels)[number];

const titleChannelSet: ReadonlySet<string> = new Set(titleKeyframeChannels);
const graphicChannelSet: ReadonlySet<string> = new Set(graphicKeyframeChannels);
export const isTitleKeyframeChannel = (
	property: string
): property is TitleKeyframeChannel => titleChannelSet.has(property);
export const isGraphicKeyframeChannel = (
	property: string
): property is GraphicKeyframeChannel => graphicChannelSet.has(property);

/**
 * The range a panel or lane offers for a channel. Title and graphic
 * positions are canvas fractions, so they use a narrower range than the
 * clip pixel offsets the schema bounds.
 */
export function overlayKeyframeBounds(
	owner: "graphic" | "title",
	property: KeyframeProperty
): readonly [number, number] {
	if (property === "x" || property === "y") {
		return owner === "title" ? [0, 1] : [-1, 1];
	}
	return keyframeValueBounds(property);
}

/** A title channel's animated value at title-relative `elapsed` seconds. */
export function titleChannelSample(
	title: Title,
	property: TitleKeyframeChannel,
	elapsed: number
): KeyframeSample {
	switch (property) {
		case "color":
		case "backgroundColor":
			return {
				color:
					titleColorKeyValue(title, property, elapsed) ??
					(property === "color" ? title.color : "#000000"),
			};
		case "fontSize":
		case "letterSpacing":
		case "lineHeight":
		case "backgroundPadding":
		case "backgroundRadius":
			return { value: titleStyleKeyValue(title, property, elapsed) };
		default:
			return { value: titleKeyValue(title, property, elapsed) };
	}
}

/** A graphic channel's animated value at graphic-relative `elapsed` seconds. */
export function graphicChannelSample(
	graphic: Graphic,
	property: GraphicKeyframeChannel,
	elapsed: number
): KeyframeSample {
	if (property === "fill" || property === "stroke") {
		return { color: graphicColorValue(graphic, property, elapsed) };
	}
	return { value: graphicAnimatedValue(graphic, property, elapsed) };
}

/** Keyframe fields for a sample, clamped (numbers) to `bounds`. */
function samplePayload(
	property: KeyframeProperty,
	sample: KeyframeSample,
	bounds: readonly [number, number]
): Pick<Keyframe, "color" | "value"> {
	if (isColorKeyframeProperty(property)) {
		return {
			color: "color" in sample ? sample.color.toLowerCase() : "#ffffff",
			value: 0,
		};
	}
	const value = "value" in sample ? sample.value : 0;
	return {
		value: Number(Math.min(bounds[1], Math.max(bounds[0], value)).toFixed(4)),
	};
}

/**
 * Returns the item with `keyframes` set, or removed when empty, so a
 * cleared channel leaves no key behind in the saved project.
 */
export function withOverlayKeyframes<Item extends OverlayKeyframeItem>(
	item: Item,
	keyframes: readonly Keyframe[]
): Item {
	const { keyframes: _previous, ...rest } = item;
	if (keyframes.length === 0) {
		return rest as Item;
	}
	return {
		...rest,
		keyframes: [...keyframes].sort((a, b) => a.time - b.time),
	} as Item;
}

/**
 * Adds (or replaces) a keyframe of `property` at timeline `time` holding
 * `sample`. Returns the item unchanged when the time is outside it or the
 * keyframe limit is reached.
 */
export function addOverlayKeyframe<Item extends OverlayKeyframeItem>(
	item: Item,
	property: KeyframeProperty,
	sample: KeyframeSample,
	time: number,
	id: string,
	bounds: readonly [number, number] = keyframeValueBounds(property)
): Item {
	const elapsed = Number((time - item.start).toFixed(4));
	if (elapsed < 0 || elapsed > item.end - item.start) {
		return item;
	}
	const kept = (item.keyframes ?? []).filter(
		(keyframe) =>
			keyframe.property !== property ||
			Math.abs(keyframe.time - elapsed) > OVERLAY_KEYFRAME_EPSILON
	);
	if (kept.length >= MAX_OVERLAY_KEYFRAMES) {
		return item;
	}
	return withOverlayKeyframes(item, [
		...kept,
		{ id, property, time: elapsed, ...samplePayload(property, sample, bounds) },
	]);
}

/** Sets one keyframe's value (or color), clamped to `bounds`. */
export function setOverlayKeyframeValue<Item extends OverlayKeyframeItem>(
	item: Item,
	id: string,
	sample: KeyframeSample,
	bounds?: readonly [number, number]
): Item {
	const keyframes = item.keyframes ?? [];
	const target = keyframes.find((keyframe) => keyframe.id === id);
	if (!target) {
		return item;
	}
	const payload = samplePayload(
		target.property,
		sample,
		bounds ?? keyframeValueBounds(target.property)
	);
	return withOverlayKeyframes(
		item,
		keyframes.map((keyframe) =>
			keyframe.id === id ? { ...keyframe, ...payload } : keyframe
		)
	);
}

/**
 * Sets the easing from one keyframe to the next. `linear` removes the field
 * (absent means linear); any easing but `bezier` drops the curve points,
 * which only a `bezier` keyframe may carry. Choosing `bezier` for a keyframe
 * without points leaves the item unchanged.
 */
export function setOverlayKeyframeInterpolation<
	Item extends OverlayKeyframeItem,
>(item: Item, id: string, interpolation: KeyframeInterpolation): Item {
	const keyframes = item.keyframes ?? [];
	const target = keyframes.find((keyframe) => keyframe.id === id);
	if (!target || (interpolation === "bezier" && !target.bezier)) {
		return item;
	}
	return withOverlayKeyframes(
		item,
		keyframes.map((keyframe) => {
			if (keyframe.id !== id) {
				return keyframe;
			}
			const { bezier, interpolation: _previous, ...rest } = keyframe;
			if (interpolation === "linear") {
				return rest;
			}
			return interpolation === "bezier"
				? { ...rest, bezier, interpolation }
				: { ...rest, interpolation };
		})
	);
}

/** Removes one keyframe; the field disappears with the last one. */
export function removeOverlayKeyframe<Item extends OverlayKeyframeItem>(
	item: Item,
	id: string
): Item {
	return withOverlayKeyframes(
		item,
		(item.keyframes ?? []).filter((keyframe) => keyframe.id !== id)
	);
}
