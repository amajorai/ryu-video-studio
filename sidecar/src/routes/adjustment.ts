import {
	adjustmentLayerEditRequestSchema,
	editAdjustmentLayers,
} from "../../../shared/adjustment.ts";
import { ConflictError } from "../store.ts";
import type { StudioRoute } from "./registry.ts";

export const routes: StudioRoute[] = [
	{
		scope: "project",
		action: "adjustment-layers",
		method: "POST",
		operation: {
			id: "video_studio_edit_adjustment_layers",
			description:
				"Create, update, duplicate, or delete a revisioned adjustment layer: a timed grade, effect stack, masks, opacity, and blend mode applied to every clip on its track and below. Update patches fields; null clears an optional field.",
			body: adjustmentLayerEditRequestSchema,
		},
		handle: async ({ id, json, request, store }) => {
			const input = adjustmentLayerEditRequestSchema.parse(
				await request.json()
			);
			const project = store.project(id);
			if (project.revision !== input.revision) {
				throw new ConflictError(
					"The project changed. Reload before editing adjustment layers."
				);
			}
			const result = editAdjustmentLayers(project, store.assets(), input);
			const saved = store.save(result.project);
			return json(
				result.layer
					? { layer: result.layer, project: saved }
					: { project: saved }
			);
		},
	},
];
