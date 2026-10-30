import {
	editOverlay,
	overlayEditRequestSchema,
} from "../../../shared/overlay-edits.ts";
import type { StudioRoute } from "./registry.ts";

/** Timing edits for titles, graphics, captions, avatars, and adjustment layers. */
export const routes: StudioRoute[] = [
	{
		scope: "project",
		action: "overlay-edit",
		method: "POST",
		operation: {
			id: "video_studio_overlay_edit",
			description:
				"Move, trim, delete, or duplicate one overlay item: a title, graphic, avatar, adjustment layer, or a caption on the active caption track (`kind`: titles | graphics | avatars | adjustmentLayers | captions). `move` sets `start` and keeps the duration (clamped to the timeline); titles and graphics also take a `lane` (0-7). `trim` moves the `start` or `end` edge to `time`, keeping at least one frame, fitting fades and entry animations, and re-basing keyframes and caption words. `duplicate` copies the item with fresh ids to `at` (default: right after the original). Optional `snap` ({pxPerSec, thresholdPx?, time?}) sticks the moved edge to markers, clip and overlay edges, or the playhead `time`, otherwise to the frame grid. Returns the saved project and the edited or new item id. Requires the current project revision.",
			body: overlayEditRequestSchema,
		},
		handle: async ({ currentProject, id, json, request, store }) => {
			const { revision, ...edit } = overlayEditRequestSchema.parse(
				await request.json()
			);
			const project = currentProject(
				id,
				revision,
				"The project changed. Reload before editing overlays."
			);
			const result = editOverlay(project, store.assets(), edit);
			return json({
				id: result.id ?? null,
				project: store.save(result.project),
			});
		},
	},
];
