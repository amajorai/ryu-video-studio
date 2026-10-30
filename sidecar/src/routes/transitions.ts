import {
	applyRevealTransition,
	revealTransitionRequestSchema,
} from "../../../shared/transitions.ts";
import type { StudioRoute } from "./registry.ts";

/**
 * Reveal transitions on cuts. The UI applies the same edit locally from a
 * gallery drop on a cut and from the inspector's "Transition in" control; this
 * route is the agent's equivalent.
 */
export const routes: StudioRoute[] = [
	{
		scope: "project",
		action: "transition",
		method: "POST",
		operation: {
			id: "video_studio_set_transition",
			description:
				"Set the reveal transition on the cut into `clipId` (dissolve, wipes, push, iris, zoom, blur, …) with its duration and softness, or remove it with `transition: null`. Adding one creates the overlap it needs: the incoming clip extends its head under the previous clip (roll-style, program length unchanged), or the previous clip extends its tail when the incoming clip has no earlier source. A push also gives the previous clip the matching exit slide. Refused for audio clips, clips without a same-track predecessor, locked tracks, or when neither clip has enough extra media. Requires the current project revision.",
			body: revealTransitionRequestSchema,
		},
		handle: async ({ id, request, revisionedProjectEdit }) => {
			const input = revealTransitionRequestSchema.parse(await request.json());
			return revisionedProjectEdit(
				id,
				input.revision,
				"The project changed. Reload before changing the transition.",
				(project, assets) =>
					applyRevealTransition(project, assets, input.clipId, input.transition)
			);
		},
	},
];
