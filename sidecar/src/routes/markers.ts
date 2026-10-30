import {
	manageMarker,
	manageMarkerRequestSchema,
} from "../../../shared/markers.ts";
import { ConflictError } from "../store.ts";
import type { StudioRoute } from "./registry.ts";

export const routes: StudioRoute[] = [
	{
		scope: "project",
		action: "markers",
		method: "POST",
		operation: {
			id: "video_studio_manage_markers",
			description:
				"Create, toggle (add or remove within half a frame of time), move (clamped), mark a start..end range, update (label, comment, color, status, time, duration), or delete a revisioned timeline marker, or set whether ripple edits shift markers (action ripple with rippleMarkers).",
			body: manageMarkerRequestSchema,
		},
		handle: async ({ id, json, request, store }) => {
			const input = manageMarkerRequestSchema.parse(await request.json());
			const project = store.project(id);
			if (project.revision !== input.revision) {
				throw new ConflictError(
					"The project changed. Reload before updating timeline markers."
				);
			}
			const result = manageMarker(project, store.assets(), input);
			return json({
				project: store.save(result.project),
				...(result.marker === undefined ? {} : { marker: result.marker }),
				...(result.removed === undefined ? {} : { removed: result.removed }),
			});
		},
	},
];
