import type { Asset, Project, Segment } from "../../../shared/project.ts";
import { clipHeard, clipVisible } from "../../../shared/sync-lock.ts";

/**
 * Whether a clip draws video: neither the clip (`hidden`) nor its track (the
 * track eye) is hidden. A hidden clip is also silent (`clipAudible`), in the
 * export as in the preview.
 */
export function segmentVisible(project: Project, segment: Segment): boolean {
	return clipVisible(project, segment);
}

/**
 * Whether a clip contributes audio: the asset has an audio stream, the clip and
 * its track are visible (hiding silences, matching the preview), the clip is
 * not muted or past the high-speed mute threshold, the track is audible (mute
 * and solo), and the clip has a non-zero volume or a non-zero volume keyframe.
 */
export function segmentAudible(
	project: Project,
	segment: Segment,
	asset: Asset | undefined
): boolean {
	return Boolean(asset?.hasAudio && clipHeard(project, segment));
}

/**
 * Whether a clip draws a picture: any non-audio clip, or an audio clip shown as
 * a waveform, that is also visible.
 */
export function segmentDrawsVideo(
	project: Project,
	segment: Segment,
	asset: Asset | undefined
): boolean {
	const visualize =
		asset?.kind === "audio" && segment.visualization === "waveform";
	return (
		(asset?.kind !== "audio" || visualize) && segmentVisible(project, segment)
	);
}

/**
 * The previous clip that draws a picture on the same track, keyed by clip id.
 * It is computed from every clip in track then start order, so a frame preview
 * and an export hand the same `previous` to the reveal stage.
 */
export function previousDrawnClips(
	project: Project,
	assets: Asset[]
): Map<string, Segment> {
	const previous = new Map<string, Segment>();
	const lastOnTrack = new Map<number, Segment>();
	const ordered = [...project.segments].sort(
		(a, b) => a.track - b.track || a.start - b.start
	);
	for (const segment of ordered) {
		const prior = lastOnTrack.get(segment.track);
		if (prior) {
			previous.set(segment.id, prior);
		}
		const asset = assets.find((item) => item.id === segment.assetId);
		if (segmentDrawsVideo(project, segment, asset)) {
			lastOnTrack.set(segment.track, segment);
		}
	}
	return previous;
}
