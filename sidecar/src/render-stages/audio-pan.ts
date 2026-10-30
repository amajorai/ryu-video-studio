import { animationExpression } from "../../../shared/animation.ts";
import { clipPanFilterChain } from "../../../shared/audio.ts";
import type { Segment } from "../../../shared/project.ts";

/**
 * Clip balance and channel mode. A static balance is one `pan` matrix; a
 * keyframed balance renders per-channel gain expressions through `aeval`.
 * Centred stereo adds nothing.
 */
export function clipPanFilters(segment: Segment): string[] {
	const animated = segment.keyframes.some(
		(keyframe) => keyframe.property === "pan" && keyframe.target === undefined
	);
	return clipPanFilterChain({
		channelMode: segment.channelMode ?? "stereo",
		pan: segment.pan ?? 0,
		...(animated && {
			panExpression: animationExpression(segment, "pan", "t"),
		}),
	});
}
