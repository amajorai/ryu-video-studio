import { PROJECT_FRAME_RATES } from "../../../shared/frame-rate.ts";
import { isWritableProjectFps } from "../../../shared/project.ts";
import {
	matchMediaRequestSchema,
	matchProjectToMedia,
	projectSettingsRequestSchema,
	updateProjectSettings,
} from "../../../shared/settings.ts";
import { ConflictError } from "../store.ts";
import type { StudioRoute } from "./registry.ts";

/**
 * Rates `updateProjectSettings` accepts today. Derived from the save gate so
 * the agent-facing description never advertises a rate the route rejects.
 */
export const WRITABLE_FRAME_RATES = PROJECT_FRAME_RATES.filter((fps) =>
	isWritableProjectFps(fps)
);

export const routes: StudioRoute[] = [
	{
		scope: "project",
		action: "settings",
		method: "POST",
		operation: {
			id: "video_studio_update_project_settings",
			description: `Update bounded canvas, aspect ratio, quality preset, frame rate, export codec, export preset, or visual style settings with a current project revision. Frame rates are ${WRITABLE_FRAME_RATES.join(", ")}. Explicit dimensions cannot be combined with aspect ratio or quality.`,
			body: projectSettingsRequestSchema,
		},
		handle: async ({ id, json, request, store }) => {
			const input = projectSettingsRequestSchema.parse(await request.json());
			const project = store.project(id);
			if (project.revision !== input.revision) {
				throw new ConflictError(
					"The project changed. Reload before updating settings."
				);
			}
			return json(
				store.save(updateProjectSettings(project, store.assets(), input))
			);
		},
	},
	{
		scope: "project",
		action: "match-media",
		method: "POST",
		operation: {
			id: "video_studio_match_project_to_media",
			description:
				"Match the project canvas and frame rate to a library video or image (Match project to media) with a current project revision. The canvas keeps the media aspect ratio with even edges inside the canvas limit; the frame rate changes only when the media rate is a project rate. Returns the saved project and the applied mismatch; fails when nothing differs.",
			body: matchMediaRequestSchema,
		},
		handle: async ({ id, json, request, store }) => {
			const input = matchMediaRequestSchema.parse(await request.json());
			const project = store.project(id);
			if (project.revision !== input.revision) {
				throw new ConflictError(
					"The project changed. Reload before matching it to media."
				);
			}
			const result = matchProjectToMedia(project, store.assets(), input);
			return json({
				mismatch: result.mismatch,
				project: store.save(result.project),
			});
		},
	},
];
