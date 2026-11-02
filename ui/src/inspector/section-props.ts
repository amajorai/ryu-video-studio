import { type Segment, trackSettingFor } from "../../../shared/project.ts";
import type { EditorRuntime } from "../editor/runtime.ts";

/** What every clip inspector section receives. */
export interface ClipSectionProps {
	/** True for audio clips (they only show visual controls as a waveform). */
	isAudio: boolean;
	/** Patch the inspected clip (refused with a status on locked tracks). */
	onChange: (patch: Partial<Segment>) => void;
	segment: Segment;
	/** Whether picture controls apply (video, image, or a visualized audio clip). */
	visualControls: boolean;
}

/**
 * Patch the inspected clip unless its track, or the destination track of a
 * move, is locked.
 */
export function changeSelectedSegment(
	runtime: EditorRuntime,
	patch: Partial<Segment>
) {
	const { project, selectedId, selectedTrackLocked } = runtime;
	if (
		project &&
		selectedId &&
		!selectedTrackLocked &&
		(patch.track === undefined || !trackSettingFor(project, patch.track).locked)
	) {
		runtime.edit({
			...project,
			segments: project.segments.map((segment) =>
				segment.id === selectedId ? { ...segment, ...patch } : segment
			),
		});
	} else if (selectedTrackLocked) {
		runtime.setStatus("Unlock this track before editing its clips.");
	} else if (project && patch.track !== undefined) {
		runtime.setStatus(
			"Unlock the destination track before moving a clip there."
		);
	}
}
