import {
	addOverlayKeyframe,
	type GraphicKeyframeChannel,
	graphicChannelSample,
	overlayKeyframeBounds,
	removeOverlayKeyframe,
	setOverlayKeyframeInterpolation,
} from "../../shared/overlay-keyframes.ts";
import type { Graphic } from "../../shared/project.ts";
import type { KeyframeInterpolation } from "../../shared/schema/keyframe.ts";

/** Shape-specific names for the shared keyframe channel labels. */
export const keyframeLabels: Partial<Record<GraphicKeyframeChannel, string>> = {
	scale: "Scale (about the center)",
	x: "Left",
	y: "Top",
};

export const graphicBounds = (property: GraphicKeyframeChannel) =>
	overlayKeyframeBounds("graphic", property);

type OptionalGraphicField =
	| "blendMode"
	| "cornerRadius"
	| "innerRadius"
	| "keyframes"
	| "points"
	| "rotation"
	| "sides"
	| "strokeAlign"
	| "masks";

/**
 * Returns the graphic with optional fields set, or removed when the value is
 * `undefined`, so cleared fields leave no key behind in the saved project.
 */
export function withGraphicFields(
	graphic: Graphic,
	fields: { [Key in OptionalGraphicField]?: Graphic[Key] | undefined }
): Graphic {
	const next: Graphic = { ...graphic };
	for (const [key, value] of Object.entries(fields) as [
		OptionalGraphicField,
		unknown,
	][]) {
		if (value === undefined) {
			delete next[key];
		} else {
			Object.assign(next, { [key]: value });
		}
	}
	return next;
}

/**
 * Adds (or replaces) a keyframe of `property` at the playhead with the
 * graphic's current value there. Returns the graphic unchanged when the
 * playhead is outside the graphic or the keyframe limit is reached.
 */
export function addGraphicKeyframe(
	graphic: Graphic,
	property: GraphicKeyframeChannel,
	time: number,
	id: string
): Graphic {
	return addOverlayKeyframe(
		graphic,
		property,
		graphicChannelSample(graphic, property, time - graphic.start),
		time,
		id,
		graphicBounds(property)
	);
}

/**
 * Sets the easing from one keyframe to the next (see
 * `setOverlayKeyframeInterpolation`).
 */
export function setGraphicKeyframeInterpolation(
	graphic: Graphic,
	id: string,
	interpolation: KeyframeInterpolation
): Graphic {
	return setOverlayKeyframeInterpolation(graphic, id, interpolation);
}

/** Removes one keyframe; the field disappears with the last one. */
export function removeGraphicKeyframe(graphic: Graphic, id: string): Graphic {
	return removeOverlayKeyframe(graphic, id);
}
