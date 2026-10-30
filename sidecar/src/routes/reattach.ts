import {
	reattachAudio,
	reattachAudioRequestSchema,
} from "../../../shared/detach-audio.ts";
import type { StudioRoute } from "./registry.ts";

export const routes: StudioRoute[] = [
	{
		scope: "project",
		action: "reattach-audio",
		method: "POST",
		operation: {
			id: "video_studio_reattach_audio",
			description:
				"Recover detached camera audio, the inverse of detach-audio. Name either the camera clip or its extracted audio clip. For each detached link group this removes the extracted audio clip, restores the camera clip's volume, volume keyframes (re-based if the audio clip was moved) and audio settings from it, and dissolves the link group. Both tracks must be unlocked. The extracted audio media stays in the library. Requires the current project revision.",
			body: reattachAudioRequestSchema,
		},
		handle: async ({ id, request, revisionedProjectEdit }) => {
			const input = reattachAudioRequestSchema.parse(await request.json());
			return revisionedProjectEdit(
				id,
				input.revision,
				"The project changed. Reload before recovering clip audio.",
				(project, assets) => reattachAudio(project, assets, input)
			);
		},
	},
];
