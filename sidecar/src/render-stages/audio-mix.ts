import type { Project } from "../../../shared/project.ts";
import {
	projectTrackMix,
	trackMixFilterChain,
} from "../../../shared/track-mix.ts";

/**
 * Track gain and pan applied to each clip on `track` before the final mix.
 * Tracks at 0 dB and centre add nothing.
 */
export function trackMixFilters(project: Project, track: number): string[] {
	return trackMixFilterChain(projectTrackMix(project, track));
}
