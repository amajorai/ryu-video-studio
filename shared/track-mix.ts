/**
 * Track mixer: a per-track gain (dB) and balance applied to every clip on the
 * track before the final mix. Applying it per clip is equivalent to a bus
 * because both stages are linear, and it keeps the render graph flat.
 */
import { filterNumber, panGains } from "./audio.ts";
import { dbToGain } from "./decibels.ts";
import { type Project, type TrackSetting, trackSettingFor } from "./project.ts";
import { trackGainOf, trackPanOf } from "./schema/defaults.ts";

/** Resolved mixer state of one track. */
export interface TrackMix {
	gainDb: number;
	pan: number;
}

export function trackMixOf(
	setting: Pick<TrackSetting, "gainDb" | "pan">
): TrackMix {
	return { gainDb: trackGainOf(setting), pan: trackPanOf(setting) };
}

/** Whether the track leaves its clips untouched. */
export function isUnityTrackMix(mix: TrackMix): boolean {
	return mix.gainDb === 0 && mix.pan === 0;
}

/** Linear left/right gains of a track (gain times constant-power balance). */
export function trackMixGains(mix: TrackMix): { left: number; right: number } {
	const gain = dbToGain(mix.gainDb);
	const { left, right } = panGains(mix.pan);
	return { left: gain * left, right: gain * right };
}

/**
 * FFmpeg filters for a track's mix: `volume=<dB>dB`, then a stereo `pan`
 * balance. A unity track adds nothing, so legacy renders stay byte-identical.
 */
export function trackMixFilterChain(mix: TrackMix): string[] {
	if (isUnityTrackMix(mix)) {
		return [];
	}
	const filters: string[] = [];
	if (mix.gainDb !== 0) {
		filters.push(`volume=${filterNumber(mix.gainDb)}dB`);
	}
	if (mix.pan !== 0) {
		const { left, right } = panGains(mix.pan);
		const term = (gain: number, channel: number) =>
			gain === 0 ? "0*c0" : `${filterNumber(gain)}*c${channel}`;
		filters.push(
			"aformat=channel_layouts=stereo",
			`pan=stereo|c0=${term(left, 0)}|c1=${term(right, 1)}`
		);
	}
	return filters;
}

/** The mixer state of `track` in `project`. */
export function projectTrackMix(
	project: Pick<Project, "trackSettings">,
	track: number
): TrackMix {
	return trackMixOf(trackSettingFor(project, track));
}
