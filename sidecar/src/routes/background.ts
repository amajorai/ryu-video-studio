import {
	applyBackgroundEdit,
	backgroundEditRequestSchema,
} from "../../../shared/background.ts";
import type { StudioRoute } from "./registry.ts";

export const routes: StudioRoute[] = [
	{
		scope: "project",
		action: "background",
		method: "POST",
		operation: {
			id: "video_studio_set_background",
			description:
				'Set the project canvas background behind every clip: {type:"color",color}, {type:"gradient",color,color2,angle} (CSS angle: 0 up, 90 right), {type:"blur",amount,dim} (a blurred, dimmed fill under each base-track video or image clip without a key or mask), or {type:"image",assetId} (library image or video scaled to cover, looped). null returns to the style profile color. With clipId, sets the own fill of that clip instead (color, gradient, blur, or {type:"image",assetId}: a library image, or the first frame of a video, scaled to cover the clip box; shown only while the clip plays); null clears it so the clip uses the project canvas again. Requires the current project revision.',
			body: backgroundEditRequestSchema,
		},
		handle: async ({ id, request, revisionedProjectEdit }) => {
			const input = backgroundEditRequestSchema.parse(await request.json());
			return revisionedProjectEdit(
				id,
				input.revision,
				"The project changed. Reload before changing the background.",
				(project, assets) => applyBackgroundEdit(project, assets, input)
			);
		},
	},
];
