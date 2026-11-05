/**
 * Preview playback for a clip. Mirrors
 * `sidecar/src/render-stages/audio-tempo.ts` and
 * `sidecar/src/render-stages/audio-mix.ts`: the element plays at the clip
 * speed, clamped to what browsers accept; `preservesPitch` is always set so a
 * reused element never keeps a stale tape-style setting (a tape-style speed
 * curve sets it false, so pitch follows the curve's playback rate); muted clips (explicit
 * or above 16x) say so; and the track mixer's gain and balance are resolved
 * to linear factors the caller multiplies into the clip gain.
 */
import { previewPlaybackRate } from "../../../shared/audio.ts";
import { clipAudioMutedOf } from "../../../shared/clip-speed.ts";
import { dbToGain } from "../../../shared/decibels.ts";
import type { Project, Segment } from "../../../shared/project.ts";
import { preservePitchOf } from "../../../shared/schema/defaults.ts";
import { curvePreservesPitch } from "../../../shared/schema/speed-curve.ts";
import { clipSpeedAt, hasSpeedCurve } from "../../../shared/speed-curve.ts";
import { projectTrackMix, trackMixGains } from "../../../shared/track-mix.ts";

export interface PreviewTempo {
	/** True when the clip's own audio is silenced (clip mute or above 16x). */
	muted: boolean;
	playbackRate: number;
	/** Always set: `true` (browser default) unless the clip is tape-style. */
	preservesPitch: boolean;
}

/**
 * The clip's preview tempo `clipTime` seconds in. A speed curve plays at the
 * curve's speed at that moment, with pitch kept unless the curve is
 * tape-style (`speedCurve.preservePitch: false`), as the export does.
 */
export function previewTempo(
	segment: Pick<Segment, "muted" | "preservePitch" | "speed"> &
		Partial<Pick<Segment, "sourceIn" | "sourceOut" | "speedCurve">>,
	clipTime = 0
): PreviewTempo {
	const { sourceIn, sourceOut, speedCurve } = segment;
	if (
		sourceIn !== undefined &&
		sourceOut !== undefined &&
		hasSpeedCurve({ speedCurve })
	) {
		return {
			muted: clipAudioMutedOf(segment),
			playbackRate: previewPlaybackRate(
				clipSpeedAt(
					{ sourceIn, sourceOut, speed: segment.speed, speedCurve },
					clipTime
				)
			),
			preservesPitch: curvePreservesPitch(speedCurve),
		};
	}
	return {
		muted: clipAudioMutedOf(segment),
		playbackRate: previewPlaybackRate(segment.speed),
		preservesPitch: preservePitchOf(segment),
	};
}

/** Linear track-mixer factors for one clip in the preview. */
export interface PreviewTrackMix {
	/** Mono-equivalent gain: the mean of `left` and `right`. */
	gain: number;
	left: number;
	right: number;
}

/** The track gain (dB) and balance of the clip's track as linear factors. */
export function previewTrackMix(
	project: Pick<Project, "trackSettings">,
	track: number
): PreviewTrackMix {
	const { left, right } = trackMixGains(projectTrackMix(project, track));
	return { gain: (left + right) / 2, left, right };
}

/**
 * The gain the preview should give a clip before its own volume automation:
 * zero when muted, otherwise the track's mono-equivalent gain.
 */
export function previewClipMixGain(
	project: Pick<Project, "trackSettings">,
	segment: Pick<Segment, "muted" | "speed" | "track">
): number {
	if (clipAudioMutedOf(segment)) {
		return 0;
	}
	return previewTrackMix(project, segment.track).gain;
}

/**
 * The clip gain for a clip whose audio runs through the preview graph: the
 * track's dB gain alone, because the graph's pan insert applies the track
 * balance per channel (`previewPanMatrix`). Zero when the clip is muted.
 */
export function previewClipGraphGain(
	project: Pick<Project, "trackSettings">,
	segment: Pick<Segment, "muted" | "speed" | "track">
): number {
	if (clipAudioMutedOf(segment)) {
		return 0;
	}
	return dbToGain(projectTrackMix(project, segment.track).gainDb);
}

/** The clip's track balance (-1..1) for the preview pan insert. */
export function previewTrackPan(
	project: Pick<Project, "trackSettings">,
	track: number
): number {
	return projectTrackMix(project, track).pan;
}
