import {
	editSpeakers,
	speakerDetectRequestSchema,
	speakerEditRequestSchema,
} from "../../../shared/speakers.ts";
import { detectSpeakers } from "../speaker-detect.ts";
import { ConflictError } from "../store.ts";
import type { StudioRoute } from "./registry.ts";

const CONFLICT = "The project changed. Reload before detecting speakers.";

export const routes: StudioRoute[] = [
	{
		scope: "project",
		action: "speakers",
		subaction: "detect",
		method: "POST",
		operation: {
			id: "video_studio_detect_speakers",
			description:
				"Label active caption words with speakers and save them to the project speaker list, caption words, captions (majority), and clips dominated by one speaker. mode 'mic-dominance' picks the loudest audible linked or multicam mic per word; mode 'cluster' groups single-mic words by voice features into k (2-6, default 2) speakers. Re-running reuses existing speaker ids, colors, and custom names by order of first appearance. Requires the current project revision.",
			body: speakerDetectRequestSchema,
		},
		handle: async ({
			currentProject,
			id,
			json,
			mediaSignal,
			request,
			store,
		}) => {
			const input = speakerDetectRequestSchema.parse(await request.json());
			const project = currentProject(id, input.revision, CONFLICT);
			const result = await detectSpeakers(
				store,
				project,
				input,
				mediaSignal(request)
			);
			if (store.project(id).revision !== project.revision) {
				throw new ConflictError(CONFLICT);
			}
			return json({
				assigned: result.assigned,
				mode: result.mode,
				project: store.save(result.project),
				speakers: result.speakers,
				unassigned: result.unassigned,
				windows: result.windows,
			});
		},
	},
	{
		scope: "project",
		action: "speakers",
		method: "POST",
		operation: {
			id: "video_studio_edit_speakers",
			description:
				"Rename or recolor a project speaker, or merge speakers into another one (every caption, word, and clip reference moves to the target and the merged speakers are removed). Requires the current project revision.",
			body: speakerEditRequestSchema,
		},
		handle: async ({ id, json, request, store }) => {
			const input = speakerEditRequestSchema.parse(await request.json());
			const project = store.project(id);
			if (project.revision !== input.revision) {
				throw new ConflictError(
					"The project changed. Reload before editing speakers."
				);
			}
			return json({ project: store.save(editSpeakers(project, input)) });
		},
	},
];
