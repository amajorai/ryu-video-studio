import {
	audioCleanupFilters,
	audioProcessingFilters,
	cleanupNeedsIsolation,
} from "../../../shared/audio.ts";
import type { Segment } from "../../../shared/project.ts";
import { audioCleanupOf } from "../../../shared/schema/defaults.ts";
import {
	type AudioRenderEnvironment,
	audioEnvironment,
} from "./audio-environment.ts";

/**
 * Denoise, enhance, voice isolation and loudness cleanup.
 *
 * Clips that only carry the legacy `audioProcessing` preset keep its exact
 * filter chain, so existing projects render byte-identically; the inspector
 * shows those presets as graded values through `audioCleanupOf`. Once a clip
 * stores `audioCleanup`, the graded chain renders. Voice isolation needs
 * `arnndn` and is skipped (not failed) on FFmpeg builds without it.
 */
export function cleanupFilters(
	segment: Segment,
	environment: AudioRenderEnvironment = audioEnvironment()
): string[] {
	if (!segment.audioCleanup) {
		return audioProcessingFilters(segment.audioProcessing ?? "none");
	}
	const cleanup = audioCleanupOf(segment);
	const isolate =
		cleanupNeedsIsolation(cleanup) && environment.hasFilter("arnndn");
	return audioCleanupFilters(cleanup, {
		rnnoiseModel: isolate ? environment.rnnoiseModel() : null,
	});
}
