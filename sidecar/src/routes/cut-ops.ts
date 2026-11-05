import {
	trimToPlayhead,
	trimToPlayheadRequestSchema,
} from "../../../shared/cut-ops.ts";
import {
	rippleDeleteGap,
	rippleDeleteGapRequestSchema,
} from "../../../shared/ripple-edits.ts";
import type { StudioRoute } from "./registry.ts";

/** Trim-to-playhead and Ripple Delete Gap. */
export const routes: StudioRoute[] = [
	{
		scope: "project",
		action: "trim-to-playhead",
		method: "POST",
		operation: {
			id: "video_studio_trim_to_playhead",
			description:
				"Trim the start or end of clips to a timeline time as one edit. Without `clipIds` every clip under the time on an unlocked track is trimmed; linked partners under the time are always trimmed with their clip. `ripple: true` closes the trimmed span once by rippling later content on the trimmed tracks and every sync-locked track left, with titles, captions, and markers; a clip still inside the span on a track that moves limits the ripple instead of being cut (`limited` counts the trims left partly open). `ripple: false` leaves a gap. Requires the current project revision.",
			body: trimToPlayheadRequestSchema,
		},
		handle: async ({ id, request, revisionedProjectEdit }) => {
			const input = trimToPlayheadRequestSchema.parse(await request.json());
			return revisionedProjectEdit(
				id,
				input.revision,
				"The project changed. Reload before trimming clips.",
				(project, assets) => trimToPlayhead(project, assets, input).project
			);
		},
	},
	{
		scope: "project",
		action: "ripple-delete-gap",
		method: "POST",
		operation: {
			id: "video_studio_ripple_delete_gap",
			description:
				"Close the empty span between clips on one track at a timeline time, rippling later clips, titles, captions, and markers left. Refused when the track is locked, when there is no gap at that time (or it is shorter than 0.04 s), or when clips on another sync-locked track sit inside the gap. Requires the current project revision.",
			body: rippleDeleteGapRequestSchema,
		},
		handle: async ({ id, request, revisionedProjectEdit }) => {
			const input = rippleDeleteGapRequestSchema.parse(await request.json());
			return revisionedProjectEdit(
				id,
				input.revision,
				"The project changed. Reload before deleting the gap.",
				(project, assets) => rippleDeleteGap(project, assets, input).project
			);
		},
	},
];
