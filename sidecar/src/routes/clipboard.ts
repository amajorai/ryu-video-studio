import {
	pasteSettingsFromClip,
	pasteSettingsRequestSchema,
} from "../../../shared/clip-edits.ts";
import {
	duplicateClipsTo,
	pasteClipsRequestSchema,
} from "../../../shared/clipboard.ts";
import type { StudioRoute } from "./registry.ts";

/** Clip clipboard routes: duplicate-to-time and grouped settings paste. */
export const routes: StudioRoute[] = [
	{
		scope: "project",
		action: "paste-clips",
		method: "POST",
		operation: {
			id: "video_studio_paste_clips",
			description:
				"Duplicate clips (with their linked audio/video partners) to a timeline time as one edit. Relative timing and track spacing are kept; ids, link groups, masks, and keyframes are re-minted. Without `track`, clips stay on their tracks when free over the span, otherwise move to the first free tracks; with `track`, the lowest pasted clip lands on it and overwrites what is underneath. `mode: insert` first ripples later content right by the pasted span. Returns the saved project and the new clip ids. Requires the current project revision.",
			body: pasteClipsRequestSchema,
		},
		handle: async ({ currentProject, id, json, request, store }) => {
			const input = pasteClipsRequestSchema.parse(await request.json());
			const project = currentProject(
				id,
				input.revision,
				"The project changed. Reload before pasting clips."
			);
			const result = duplicateClipsTo(project, store.assets(), input);
			return json({
				newIds: result.newIds,
				project: store.save(result.project),
			});
		},
	},
	{
		scope: "project",
		action: "paste-settings",
		method: "POST",
		operation: {
			id: "video_studio_paste_clip_settings",
			description:
				"Copy chosen settings groups (transform, color, effects, audio, masks, animation) from one clip to up to 200 others. Keyframes travel with the group owning their property; fades and exit durations are fitted to each target, and a reveal transition is dropped where the target has no covering predecessor. Media, placement, and timing are kept. Requires the current project revision.",
			body: pasteSettingsRequestSchema,
		},
		handle: async ({ id, request, revisionedProjectEdit }) => {
			const input = pasteSettingsRequestSchema.parse(await request.json());
			return revisionedProjectEdit(
				id,
				input.revision,
				"The project changed. Reload before pasting clip settings.",
				(project, assets) => pasteSettingsFromClip(project, assets, input)
			);
		},
	},
];
