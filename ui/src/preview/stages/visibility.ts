/**
 * Preview stage: clip visibility and audibility. Mirrors
 * `sidecar/src/render-stages/visibility.ts` through the shared rules in
 * `shared/sync-lock.ts`: a hidden clip or hidden track draws no picture and is
 * silent, and a muted clip, muted track, or a track outside the solo set is
 * silent.
 */
import {
	type Project,
	type Segment,
	segmentDuration,
} from "../../../../shared/project.ts";
import { clipAudible, clipVisible } from "../../../../shared/sync-lock.ts";

/** Whether the playhead at `time` lies inside the clip. */
export function segmentActiveAt(segment: Segment, time: number): boolean {
	return (
		time >= segment.start && time < segment.start + segmentDuration(segment)
	);
}

/** Whether the clip's picture is drawn at all (independent of the playhead). */
export function previewSegmentVisible(
	project: Project,
	segment: Segment
): boolean {
	return clipVisible(project, segment);
}

/** Whether the clip's audio reaches the preview mix. */
export function previewSegmentAudible(
	project: Project,
	segment: Segment
): boolean {
	return clipAudible(project, segment);
}
