import {
	effectLabelPrefix,
	effectStackFilters,
	visualEffectFilters,
} from "../../../shared/effects.ts";
import type { Segment } from "../../../shared/project.ts";

/**
 * The legacy single visual effect followed by the effect stack (W2-V6).
 * Branching library effects label their links after the clip id, so every
 * clip's statements stay unique in the composite graph; `effectAmount`
 * keyframes animate the stack through the clip's own keyframes.
 */
export function segmentEffectFilters(segment: Segment): string[] {
	return [
		...visualEffectFilters(segment.visualEffect ?? "none"),
		...effectStackFilters(segment.effects, {
			label: effectLabelPrefix(segment.id),
			segment,
		}),
	];
}
