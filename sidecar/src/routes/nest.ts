import {
	decomposeRequestSchema,
	nestRequestSchema,
} from "../../../shared/sequences.ts";
import { decomposeSequenceClip, nestClips } from "../sequence.ts";
import type { StudioRoute } from "./registry.ts";

/** Nest and decompose (W4-N1). */
export const routes: StudioRoute[] = [
	{
		scope: "project",
		action: "nest",
		method: "POST",
		operation: {
			id: "video_studio_nest_clips",
			description:
				"Nest clips into a new nested project with this project's canvas settings: the selected clips (re-based so the span starts at 0) and the titles and graphics fully inside their span move into the child, the child renders through the sequence path, and the selection becomes one sequence clip on the lowest selected video track (or the first free track above it). Returns `{project, asset, sequenceProject, clipId}`. Multicam, template-slot, lip-sync source, and locked-track clips are refused. Requires the current project revision.",
			body: nestRequestSchema,
		},
		handle: async ({ id, json, mediaSignal, request, store }) => {
			const input = nestRequestSchema.parse(await request.json());
			return json(
				await nestClips(store, id, input, { signal: mediaSignal(request) }),
				201
			);
		},
	},
	{
		scope: "project",
		action: "decompose",
		method: "POST",
		operation: {
			id: "video_studio_decompose_sequence",
			description:
				"Decompose a nested sequence clip back into its child project's clips, titles, and graphics at `clip.start - clip.sourceIn`, clipped and trimmed to the clip's source range with fresh ids. The child's lowest video track lands on the clip's track; the block moves up when tracks are taken. Each copy keeps its child track's state: copies from muted, solo-excluded, or hidden child tracks come back muted or hidden, and child track gain and pan fold into the clip volume and pan (refused when they cannot). A muted or hidden sequence clip mutes or hides every copy, audible copies only land on audible tracks, and copies cut by the clip's range drop the fade, entry animation, and edge transition of the cut edge. An avatar lip-synced to the sequence clip keeps the sequence media but loses the clip pin. Other clip-level adjustments on the sequence clip itself are not carried over, and a speed other than 100% is refused. Returns `{project, clipIds, titleIds, graphicIds, trackDelta}`. Requires the current project revision.",
			body: decomposeRequestSchema,
		},
		handle: async ({ id, json, request, store }) => {
			const input = decomposeRequestSchema.parse(await request.json());
			return json(decomposeSequenceClip(store, id, input));
		},
	},
];
