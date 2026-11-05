/**
 * Sync-lock and visibility rules shared by ripple edits, the render, and the
 * preview.
 *
 * A ripple edit (range delete, insert, transcript removal, opt-in ripple trim)
 * changes the tracks it targets plus every sync-locked track, so content on
 * those tracks stays in sync. A track whose `syncLocked` is `false` keeps its
 * clips in place. Tracks are sync-locked unless explicitly unlocked
 * (`syncLockedOf`), so legacy projects ripple every track exactly as before.
 */
import { highSpeedMutedOf } from "./clip-speed.ts";
import { MAX_TRACK_INDEX } from "./limits.ts";
import {
	isTrackAudible,
	type Project,
	type Segment,
	trackSettingFor,
} from "./project.ts";
import { syncLockedOf, trackHiddenOf } from "./schema/defaults.ts";

/** Every track index the schema allows, bottom to top. */
const ALL_TRACKS = Array.from(
	{ length: MAX_TRACK_INDEX + 1 },
	(_, track) => track
);

/** Whether a ripple that does not target `track` still shifts it. */
export function trackSyncLocked(
	project: Pick<Project, "trackSettings">,
	track: number
): boolean {
	return syncLockedOf(trackSettingFor(project, track));
}

/** The tracks a ripple edit changes: the edited tracks plus every sync-locked track. */
export function affectedTracks(
	project: Pick<Project, "trackSettings">,
	editedTracks: Iterable<number> = []
): ReadonlySet<number> {
	const affected = new Set<number>(editedTracks);
	for (const track of ALL_TRACKS) {
		if (trackSyncLocked(project, track)) {
			affected.add(track);
		}
	}
	return affected;
}

/**
 * Whether markers move with ripple edits. Markers have always rippled, so an
 * absent `rippleMarkers` keeps that behaviour and only an explicit `false`
 * pins them to their timeline times.
 */
export const rippleMarkersOf = (project: Pick<Project, "rippleMarkers">) =>
	project.rippleMarkers ?? true;

/** Whether a track's picture is hidden (the track eye). */
export function trackHidden(
	project: Pick<Project, "trackSettings">,
	track: number
): boolean {
	return trackHiddenOf(trackSettingFor(project, track));
}

/** Whether a clip draws its picture: neither the clip nor its track is hidden. */
export function clipVisible(
	project: Pick<Project, "trackSettings">,
	segment: Pick<Segment, "hidden" | "track">
): boolean {
	return !(segment.hidden || trackHidden(project, segment.track));
}

/**
 * Whether a clip reaches the mix: the clip is not muted, its track is audible
 * (track mute and solo), and neither the clip nor its track is hidden. Hiding
 * silences as well as hides, in the preview and the export alike.
 */
export function clipAudible(
	project: Pick<Project, "trackSettings">,
	segment: Pick<Segment, "hidden" | "muted" | "track">
): boolean {
	return (
		!segment.muted &&
		clipVisible(project, segment) &&
		isTrackAudible(project, segment.track)
	);
}

/**
 * Whether the listener hears a clip's audio: it reaches the mix
 * (`clipAudible`: not muted or hidden, on an audible visible track), it is not
 * past the high-speed mute (`highSpeedMutedOf`), and it has a non-zero volume
 * or a volume keyframe above zero. The export (`segmentAudible`), dead-air
 * detection, speaker attribution, and lip-sync sources share this rule.
 */
export function clipHeard(
	project: Pick<Project, "trackSettings">,
	segment: Pick<
		Segment,
		"hidden" | "keyframes" | "muted" | "speed" | "track" | "volume"
	>
): boolean {
	return (
		clipAudible(project, segment) &&
		!highSpeedMutedOf(segment) &&
		(segment.volume > 0 ||
			segment.keyframes.some(
				(keyframe) => keyframe.property === "volume" && keyframe.value > 0
			))
	);
}
