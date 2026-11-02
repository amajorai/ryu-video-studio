import {
	splitClips,
	splitClipsRequestSchema,
	splitInputFromRequest,
} from "../../../shared/cut-ops.ts";
import { rippleRemoveClips } from "../../../shared/ripple-edits.ts";
import {
	removeClips,
	removeClipsRequestSchema,
} from "../../../shared/timeline-edits.ts";
import type { StudioRoute } from "./registry.ts";

export const routes: StudioRoute[] = [
	{
		scope: "project",
		action: "split",
		method: "POST",
		operation: {
			id: "video_studio_split_clip",
			description:
				"Split clips at one or more timeline times as one edit, preserving source timing and keyframes. Send `times` (up to 64) and optionally `clipIds` (up to 200); without clip ids every clip under each time on an unlocked track is cut. Linked audio/video partners are always cut together, and the pieces right of each cut get a fresh link group. The legacy `{clipId, time}` body still works. Requires the current project revision.",
			body: splitClipsRequestSchema,
		},
		handle: async ({ id, request, revisionedProjectEdit }) => {
			const input = splitClipsRequestSchema.parse(await request.json());
			return revisionedProjectEdit(
				id,
				input.revision,
				"The project changed. Reload before splitting clips.",
				(project, assets) =>
					splitClips(project, assets, splitInputFromRequest(input)).project
			);
		},
	},
	{
		scope: "project",
		action: "remove",
		method: "POST",
		operation: {
			id: "video_studio_remove_clips",
			description:
				"Remove one or more unlocked clips (with their linked partners) and clean up empty multicam metadata. With `ripple: true` each contiguous removed span is closed by rippling later clips, titles, captions, and markers left. Requires the current project revision.",
			body: removeClipsRequestSchema,
		},
		handle: async ({ id, request, revisionedProjectEdit }) => {
			const input = removeClipsRequestSchema.parse(await request.json());
			return revisionedProjectEdit(
				id,
				input.revision,
				"The project changed. Reload before removing clips.",
				(project, assets) =>
					input.ripple
						? rippleRemoveClips(project, assets, input.clipIds).project
						: removeClips(project, assets, input)
			);
		},
	},
];
