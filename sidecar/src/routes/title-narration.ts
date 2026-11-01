import {
	placeTitleNarration,
	titleNarrationRequestSchema,
} from "../../../shared/title-narration.ts";
import type { StudioRoute } from "./registry.ts";

/** Text to speech for title layers: place the spoken title at its start. */
export const routes: StudioRoute[] = [
	{
		scope: "project",
		action: "title-narration",
		method: "POST",
		operation: {
			id: "video_studio_place_title_narration",
			description:
				"Place a generated narration audio asset as a clip that starts with a title layer, on the lowest free unlocked audio track at or above track 1. Generate the audio first with Ryu's text-to-speech from the title's text. Requires the current project revision.",
			body: titleNarrationRequestSchema,
		},
		handle: async ({ id, request, revisionedProjectEdit }) => {
			const input = titleNarrationRequestSchema.parse(await request.json());
			return revisionedProjectEdit(
				id,
				input.revision,
				"The project changed. Reload before placing the narration.",
				(project, assets) => placeTitleNarration(project, assets, input).project
			);
		},
	},
];
