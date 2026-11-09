import { clipTempoFilters } from "../../../shared/clip-speed.ts";
import type { Segment } from "../../../shared/project.ts";
import {
	hasSpeedCurve,
	speedCurveAudioGraph,
} from "../../../shared/speed-curve.ts";

/**
 * Speed change for the clip audio: `atempo` keeps pitch; `preservePitch:
 * false` resamples tape-style so pitch follows speed. Clips faster than 16x
 * are silenced unless `muted` is explicitly false. A speed curve plays
 * through `curveTempoGraph` (or its pre-rendered audio) first, so its chain
 * here only mutes.
 */
export function tempoFilters(segment: Segment): string[] {
	return clipTempoFilters(segment);
}

/**
 * The statements that remap a curved clip's audio from `input`, and the
 * label the clip's chain then reads; a constant-speed clip, or a curved
 * clip whose audio was rendered ahead (`remapped`, see `varispeed.ts`),
 * reads `input`. Without that audio a curve keeps pitch through the
 * `atempo` piece plan.
 */
export function curveTempoGraph(
	segment: Segment,
	input: string,
	prefix: string,
	remapped = false
): { label: string; statements: string[] } {
	if (remapped || !hasSpeedCurve(segment)) {
		return { label: input, statements: [] };
	}
	const label = `[${prefix}]`;
	return {
		label,
		statements: speedCurveAudioGraph(segment, input, label, prefix),
	};
}
