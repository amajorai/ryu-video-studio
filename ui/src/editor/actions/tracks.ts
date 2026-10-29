import {
	clipAudioMutedOf,
	HIGH_SPEED_MUTE_ABOVE,
} from "../../../../shared/clip-speed.ts";
import {
	type Project,
	type Segment,
	type TrackSetting,
	trackSettingFor,
	updateTrackSetting,
} from "../../../../shared/project.ts";
import {
	addTrack,
	removeTrack,
	reorderTracks,
	trackOrderFor,
} from "../../../../shared/track-edits.ts";
import type { EditorRuntime } from "../runtime.ts";
import type { ActionHandlers } from "./types.ts";

const errorMessage = (error: unknown) =>
	error instanceof Error ? error.message : String(error);

export function setTrackSetting(
	runtime: EditorRuntime,
	track: number,
	patch: Parameters<typeof updateTrackSetting>[2]
) {
	if (!runtime.project) {
		return;
	}
	runtime.edit(
		updateTrackSetting(runtime.project, track, patch),
		"Change track"
	);
}

/** Rename a track; an empty name restores `Track N`. */
export function renameTrack(
	runtime: EditorRuntime,
	track: number,
	value: string
) {
	const setting = runtime.project
		? trackSettingFor(runtime.project, track)
		: undefined;
	if (!setting) {
		return;
	}
	const name = value.trim() || `Track ${track + 1}`;
	if (name !== setting.name) {
		setTrackSetting(runtime, track, { name });
	}
}

/** Swap a track with its neighbour in the stacking order. */
export function moveTrack(
	runtime: EditorRuntime,
	track: number,
	direction: -1 | 1
) {
	const { project } = runtime;
	if (!project) {
		return;
	}
	const order = trackOrderFor(project);
	const index = order.indexOf(track);
	const destination = index + direction;
	if (index < 0 || destination < 0 || destination >= order.length) {
		return;
	}
	const currentTrack = order[index];
	const destinationTrack = order[destination];
	if (currentTrack === undefined || destinationTrack === undefined) {
		return;
	}
	order[index] = destinationTrack;
	order[destination] = currentTrack;
	runtime.edit(reorderTracks(project, order), "Reorder tracks");
}

/** Show or hide a track's picture (the track eye). */
export function toggleTrackHidden(runtime: EditorRuntime, track: number) {
	if (!runtime.project) {
		return;
	}
	const hidden = trackSettingFor(runtime.project, track).hidden ?? false;
	setTrackSetting(runtime, track, { hidden: !hidden });
}

/** Toggle whether ripple edits on other tracks shift this one. */
export function toggleTrackSyncLock(runtime: EditorRuntime, track: number) {
	if (!runtime.project) {
		return;
	}
	const syncLocked = trackSettingFor(runtime.project, track).syncLocked ?? true;
	setTrackSetting(runtime, track, { syncLocked: !syncLocked });
}

export function setTrackHeight(
	runtime: EditorRuntime,
	track: number,
	height: NonNullable<TrackSetting["height"]>
) {
	if (!runtime.project) {
		return;
	}
	if ((trackSettingFor(runtime.project, track).height ?? "medium") !== height) {
		setTrackSetting(runtime, track, { height });
	}
}

/** Insert an empty track at `at`; tracks at or above it move up one. */
export function addTrackAt(runtime: EditorRuntime, at: number) {
	if (!runtime.project) {
		return;
	}
	try {
		runtime.edit(addTrack(runtime.project, runtime.assets, at), "Add track");
	} catch (error) {
		runtime.setStatus(errorMessage(error));
	}
}

/** Remove a track; `force` also removes the clips on it. */
export function removeTrackAt(
	runtime: EditorRuntime,
	track: number,
	force = false
) {
	if (!runtime.project) {
		return;
	}
	try {
		runtime.edit(
			removeTrack(runtime.project, runtime.assets, track, { force }),
			"Remove track"
		);
	} catch (error) {
		runtime.setStatus(errorMessage(error));
	}
}

type ClipFlag = "hidden" | "muted";

/**
 * Set or clear a clip flag; `false` drops the key so the clip stays
 * byte-identical. Clip mute follows `clipAudioMutedOf`: a clip above
 * `HIGH_SPEED_MUTE_ABOVE` is silent unless `muted: false` opts it in, so
 * unmuting it writes that opt-in instead of dropping the key.
 */
function withClipFlag(segment: Segment, flag: ClipFlag, on: boolean): Segment {
	if (on) {
		return { ...segment, [flag]: true };
	}
	const { [flag]: _cleared, ...rest } = segment;
	if (flag === "muted" && segment.speed > HIGH_SPEED_MUTE_ABOVE) {
		return { ...rest, muted: false };
	}
	return rest;
}

/** Whether a clip has the flag as the viewer experiences it. */
function clipFlagOn(segment: Segment, flag: ClipFlag): boolean {
	return flag === "muted" ? clipAudioMutedOf(segment) : segment[flag] === true;
}

/**
 * Toggle a flag on the selected clips (the primary clip when nothing else is
 * selected). Clips on locked tracks are left alone. When every target already
 * has the flag it is cleared, otherwise every target gets it.
 */
export function toggleClipFlag(
	project: Project,
	ids: readonly string[],
	flag: ClipFlag
): Project | null {
	const wanted = new Set(ids);
	const targets = project.segments.filter(
		(segment) =>
			wanted.has(segment.id) && !trackSettingFor(project, segment.track).locked
	);
	if (!targets.length) {
		return null;
	}
	const on = !targets.every((segment) => clipFlagOn(segment, flag));
	const targetIds = new Set(targets.map((segment) => segment.id));
	return {
		...project,
		segments: project.segments.map((segment) =>
			targetIds.has(segment.id) ? withClipFlag(segment, flag, on) : segment
		),
	};
}

function selectedClipIds(runtime: EditorRuntime): string[] {
	if (runtime.selectedIds.length) {
		return runtime.selectedIds;
	}
	return runtime.selectedId ? [runtime.selectedId] : [];
}

function toggleSelectedClips(
	runtime: EditorRuntime,
	flag: ClipFlag,
	label: string
) {
	const { project } = runtime;
	if (!project) {
		return false;
	}
	const next = toggleClipFlag(project, selectedClipIds(runtime), flag);
	if (!next) {
		return false;
	}
	runtime.edit(next, label);
	return;
}

/** Track handlers: clip mute (Shift+M) and clip hide (Shift+H). */
export const trackActions: ActionHandlers = {
	"tracks.toggleClipHidden": (runtime) =>
		toggleSelectedClips(runtime, "hidden", "Toggle clip visibility"),
	"tracks.toggleClipMute": (runtime) =>
		toggleSelectedClips(runtime, "muted", "Toggle clip mute"),
};
