import {
	pasteKeyframesBetweenClips,
	pasteKeyframesRequestSchema,
} from "../../../shared/keyframe-clipboard.ts";
import type { StudioRoute } from "./registry.ts";

/**
 * Keyframe routes beyond `POST /projects/:id/keyframes` (which sets one
 * channel with interpolation, Bezier controls and a target id).
 *
 * The paste route is `paste-keyframes`, next to `paste-clips` and
 * `paste-settings`: the built-in `keyframes` handler matches every
 * `keyframes/*` path, so a `keyframes/paste` subaction would never reach the
 * registry.
 */
export const routes: StudioRoute[] = [
	{
		scope: "project",
		action: "paste-keyframes",
		method: "POST",
		operation: {
			id: "video_studio_paste_keyframes",
			description:
				"Copy keyframes from one clip and paste them onto up to 200 clips as one edit. `at` is the clip-relative time in each target where the earliest copied keyframe lands; relative timing, values, interpolation, Bezier controls and effect/mask targets are kept. `properties`, `keyframeIds` and a clip-relative `range` narrow the copy. A pasted keyframe replaces one on the same channel and time; values are clamped to the property's range; keyframes past a target's end or driving an effect or mask the target lacks are skipped and counted. Returns the saved project with `pasted` and `skipped` counts. Requires the current project revision.",
			body: pasteKeyframesRequestSchema,
		},
		handle: async ({ currentProject, id, json, request, store }) => {
			const input = pasteKeyframesRequestSchema.parse(await request.json());
			const project = currentProject(
				id,
				input.revision,
				"The project changed. Reload before pasting keyframes."
			);
			const result = pasteKeyframesBetweenClips(project, store.assets(), input);
			return json({
				pasted: result.pasted,
				project: store.save(result.project),
				skipped: result.skipped,
			});
		},
	},
];
