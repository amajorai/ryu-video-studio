import type { KeyframeGroup } from "../../../shared/animation.ts";
import { setClipProperties } from "../../../shared/clip-edits.ts";
import { setKeyframes } from "../../../shared/keyframe-edits.ts";
import type { Keyframe, Project } from "../../../shared/project.ts";
import { message } from "../editor/format.ts";
import type { EditorRuntime } from "../editor/runtime.ts";
import {
	channelRequest,
	type KeyframeOwnerRef,
	ownerChannelRequest,
} from "./lane-math.ts";

/**
 * Replace one keyframe channel as a single undoable edit, through the same
 * `setKeyframes` validation the `/keyframes` route runs (value bounds,
 * interpolation and Bezier pairing, unique times). Returns the new project,
 * or `null` (with the reason in the status line) when the edit is refused.
 */
export function commitChannel(
	runtime: Pick<EditorRuntime, "assets" | "edit" | "project" | "setStatus">,
	segmentId: string,
	group: KeyframeGroup,
	frames: readonly Keyframe[],
	label: string
): Project | null {
	const { project } = runtime;
	if (!project) {
		return null;
	}
	try {
		const next = setKeyframes(
			project,
			runtime.assets,
			channelRequest({ id: segmentId }, group, frames, project.revision)
		);
		runtime.edit(next, label);
		return next;
	} catch (error) {
		runtime.setStatus(message(error));
		return null;
	}
}

/**
 * Replace one keyframe channel of a title or graphic (or clip) as a single
 * undoable edit, through the `/keyframes` route's `setKeyframes`.
 */
export function commitOwnerChannel(
	runtime: Pick<EditorRuntime, "assets" | "edit" | "project" | "setStatus">,
	owner: KeyframeOwnerRef,
	group: KeyframeGroup,
	frames: readonly Keyframe[],
	label: string
): Project | null {
	const { project } = runtime;
	if (!project) {
		return null;
	}
	try {
		const next = setKeyframes(
			project,
			runtime.assets,
			ownerChannelRequest(owner, group, frames, project.revision)
		);
		runtime.edit(next, label);
		return next;
	} catch (error) {
		runtime.setStatus(message(error));
		return null;
	}
}

/** Set a clip's static volume as one undoable edit. */
export function commitVolume(
	runtime: Pick<EditorRuntime, "assets" | "edit" | "project" | "setStatus">,
	segmentId: string,
	volume: number
): Project | null {
	const { project } = runtime;
	if (!project) {
		return null;
	}
	try {
		const next = setClipProperties(project, runtime.assets, {
			clipId: segmentId,
			patch: { volume },
			revision: project.revision,
		});
		runtime.edit(next, "Clip volume");
		return next;
	} catch (error) {
		runtime.setStatus(message(error));
		return null;
	}
}
