import {
	changeMulticamAngles,
	createMulticamGroup,
	multicamRequestSchema,
	ungroupMulticam,
} from "../../../shared/multicam.ts";
import { ConflictError } from "../store.ts";
import type { StudioRoute } from "./registry.ts";

export const routes: StudioRoute[] = [
	{
		scope: "project",
		action: "multicam",
		method: "GET",
		operation: {
			id: "video_studio_get_multicam",
			description:
				"Read durable multicam groups and their switches (angle, optional mic `audio`, optional split-screen `layout`).",
		},
		handle: ({ id, json, store }) =>
			json({ groups: store.project(id).multicamGroups }),
	},
	{
		scope: "project",
		action: "multicam",
		method: "POST",
		operation: {
			id: "video_studio_manage_multicam",
			description:
				"Create, change, or ungroup a multicam session. Creation writes ordinary timeline clips plus a program-audio layer. `change` entries switch over [start, end): `angle` cuts to a full-frame camera, `layout` {layout, angles, fit} shows several angles at once (first angle leads), and `audio` picks the mic member heard as program audio; the timeline clips are regenerated from the switches. Requires the current project revision.",
			body: multicamRequestSchema,
		},
		handle: async ({ id, json, request, store }) => {
			const input = multicamRequestSchema.parse(await request.json());
			const project = store.project(id);
			if (project.revision !== input.revision) {
				throw new ConflictError(
					"The project changed. Reload before updating multicam."
				);
			}
			const result =
				input.action === "create"
					? createMulticamGroup(project, store.assets(), input)
					: input.action === "change"
						? changeMulticamAngles(project, store.assets(), input)
						: {
								project: ungroupMulticam(project, store.assets(), input),
							};
			const saved = store.save(result.project);
			return json(
				"group" in result
					? { group: result.group, project: saved }
					: { project: saved }
			);
		},
	},
];
