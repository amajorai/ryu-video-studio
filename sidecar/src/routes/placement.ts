import {
	overwriteRequest,
	overwriteRequestSchema,
} from "../../../shared/overwrite.ts";
import {
	moveToNewTrackRequestSchema,
	placeOnNewTrack,
} from "../../../shared/track-placement.ts";
import type { StudioRoute } from "./registry.ts";

/** Drag-and-drop placement: overwrite edits and move or duplicate to a new track. */
export const routes: StudioRoute[] = [
	{
		scope: "project",
		action: "overwrite",
		method: "POST",
		operation: {
			id: "video_studio_overwrite_clips",
			description:
				"Place library clips back to back at a timeline time on one track, overwriting what is there: clips underneath are trimmed, split around the new clips, or removed, and their linked partners are cut over the same range. Nothing else moves (use insert to ripple). Requires the current project revision.",
			body: overwriteRequestSchema,
		},
		handle: async ({ id, request, revisionedProjectEdit }) => {
			const input = overwriteRequestSchema.parse(await request.json());
			return revisionedProjectEdit(
				id,
				input.revision,
				"The project changed. Reload before placing clips.",
				(project, assets) => overwriteRequest(project, assets, input)
			);
		},
	},
	{
		scope: "project",
		action: "move-to-new-track",
		method: "POST",
		operation: {
			id: "video_studio_move_to_new_track",
			description:
				"Move clips, or copy them with duplicate: true, to the first free, unlocked, visible tracks above them. A multi-track selection keeps its stacking; copies get fresh ids and re-minted link groups. Requires the current project revision.",
			body: moveToNewTrackRequestSchema,
		},
		handle: async ({ id, request, revisionedProjectEdit }) => {
			const input = moveToNewTrackRequestSchema.parse(await request.json());
			return revisionedProjectEdit(
				id,
				input.revision,
				"The project changed. Reload before moving clips to a new track.",
				(project, assets) => placeOnNewTrack(project, assets, input).project
			);
		},
	},
];
