import {
	audioEffectChainFilters,
	stackShiftsPitch,
} from "../../../shared/audio-effects.ts";
import type { Segment } from "../../../shared/project.ts";
import {
	type AudioRenderEnvironment,
	audioEnvironment,
} from "./audio-environment.ts";

/**
 * Voice and creative audio effects, in stack order. Pitch effects use
 * `rubberband` when FFmpeg has it and a resample-and-retime shift otherwise.
 */
export function audioEffectFilters(
	segment: Segment,
	environment: AudioRenderEnvironment = audioEnvironment()
): string[] {
	const effects = segment.audioEffects;
	if (!effects?.length) {
		return [];
	}
	return audioEffectChainFilters(effects, {
		rubberband:
			stackShiftsPitch(effects) && environment.hasFilter("rubberband"),
	});
}
