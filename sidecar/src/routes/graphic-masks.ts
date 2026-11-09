import {
	graphicMasksRequestSchema,
	setGraphicMasks,
} from "../../../shared/graphic-masks.ts";
import type { StudioRoute } from "./registry.ts";

/** Masks on shape graphics, the counterpart of clip masks in clip-properties. */
export const routes: StudioRoute[] = [
	{
		scope: "project",
		action: "graphic-masks",
		method: "POST",
		operation: {
			id: "video_studio_set_graphic_masks",
			description:
				"Replace the masks of one shape graphic (`graphicId`): up to four masks in the graphic's own box before its rotation (x/y center in -1..1 across the box, width/height as fractions of it, rotation, feather, invert, opacity, shape fields, and an optional outline stroke: strokeWidth as a fraction of the box height, strokeColor, strokeAlign center|inside|outside). Every mask shape except text. Masks clip the graphic to its box. `null` or [] removes them. Requires the current project revision.",
			body: graphicMasksRequestSchema,
		},
		handle: async ({ id, request, revisionedProjectEdit }) => {
			const input = graphicMasksRequestSchema.parse(await request.json());
			return revisionedProjectEdit(
				id,
				input.revision,
				"The project changed. Reload before changing graphic masks.",
				(project) => setGraphicMasks(project, input)
			);
		},
	},
];
