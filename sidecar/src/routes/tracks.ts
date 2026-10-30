import { z } from "zod";
import {
	MAX_TRACK_INDEX,
	MAX_TRACKS,
	trackIndexSchema,
} from "../../../shared/limits.ts";
import {
	trackSettingSchema,
	updateTrackSetting,
} from "../../../shared/project.ts";
import {
	addTrack,
	addTrackRequestSchema,
	removeTrack,
	removeTrackRequestSchema,
	reorderTracks,
	reorderTracksRequestSchema,
} from "../../../shared/track-edits.ts";
import { ConflictError } from "../store.ts";
import type { StudioRoute } from "./registry.ts";

const trackFields = trackSettingSchema.shape;

export const updateTrackRequestSchema = z
	.object({
		/** Track gain in dB, applied by the export mixer; 0 resets to unity. */
		gainDb: trackFields.gainDb,
		height: trackFields.height,
		hidden: z.boolean().optional(),
		locked: z.boolean().optional(),
		muted: z.boolean().optional(),
		name: z.string().trim().min(1).max(80).optional(),
		/** Track pan from -1 (left) to 1 (right), applied by the export mixer; 0 centres. */
		pan: trackFields.pan,
		revision: z.number().int().nonnegative(),
		solo: z.boolean().optional(),
		syncLocked: z.boolean().optional(),
		track: trackIndexSchema,
	})
	.strict();
export type UpdateTrackRequest = z.infer<typeof updateTrackRequestSchema>;

/** The setting fields an update request changes (only those it carries). */
export function trackSettingPatch(
	input: UpdateTrackRequest
): Parameters<typeof updateTrackSetting>[2] {
	const { revision: _revision, track: _track, ...fields } = input;
	const patch: Parameters<typeof updateTrackSetting>[2] = {};
	for (const [key, value] of Object.entries(fields) as [
		keyof typeof fields,
		unknown,
	][]) {
		if (value !== undefined) {
			Object.assign(patch, { [key]: value });
		}
	}
	// Unity gain and centre pan clear the field so untouched tracks stay
	// byte-identical.
	if (patch.gainDb === 0) {
		patch.gainDb = undefined;
	}
	if (patch.pan === 0) {
		patch.pan = undefined;
	}
	return patch;
}

export const routes: StudioRoute[] = [
	{
		scope: "project",
		action: "tracks",
		subaction: "reorder",
		method: "POST",
		operation: {
			id: "video_studio_reorder_tracks",
			description:
				"Reorder the visible timeline tracks from bottom to top. Clip lanes and their saved track settings move together and the operation requires the current project revision.",
			body: reorderTracksRequestSchema,
			bodyJsonSchema: {
				type: "object",
				properties: {
					order: {
						type: "array",
						items: { type: "integer", minimum: 0, maximum: MAX_TRACK_INDEX },
						minItems: 1,
						maxItems: MAX_TRACKS,
					},
					revision: { type: "integer", minimum: 0 },
				},
				required: ["order", "revision"],
			},
		},
		handle: async ({ id, json, request, store }) => {
			const input = reorderTracksRequestSchema.parse(await request.json());
			const project = store.project(id);
			if (project.revision !== input.revision) {
				throw new ConflictError(
					"The project changed. Reload before reordering tracks."
				);
			}
			return json(store.save(reorderTracks(project, input.order)));
		},
	},
	{
		scope: "project",
		action: "tracks",
		method: "POST",
		operation: {
			id: "video_studio_update_track",
			description:
				"Update a timeline track: name, mute, solo, lock, hidden (track eye; hides the picture and silences the audio), syncLocked (whether ripple edits on other tracks shift it; absent means sync-locked), height (small, medium, large), and its mixer gain (gainDb -60 to +12 dB) and pan (-1 left to 1 right). Gain and pan apply in the export; 0 resets each to unity. Requires the current project revision.",
			body: updateTrackRequestSchema,
			bodyJsonSchema: {
				type: "object",
				properties: {
					gainDb: { type: "number", minimum: -60, maximum: 12 },
					height: { type: "string", enum: ["small", "medium", "large"] },
					hidden: { type: "boolean" },
					locked: { type: "boolean" },
					muted: { type: "boolean" },
					name: { type: "string", minLength: 1, maxLength: 80 },
					pan: { type: "number", minimum: -1, maximum: 1 },
					revision: { type: "integer", minimum: 0 },
					solo: { type: "boolean" },
					syncLocked: { type: "boolean" },
					track: { type: "integer", minimum: 0, maximum: MAX_TRACK_INDEX },
				},
				required: ["revision", "track"],
			},
		},
		handle: async ({ id, json, request, store }) => {
			const input = updateTrackRequestSchema.parse(await request.json());
			const project = store.project(id);
			if (project.revision !== input.revision) {
				throw new ConflictError(
					"The project changed. Reload before updating a track."
				);
			}
			return json(
				store.save(
					updateTrackSetting(project, input.track, trackSettingPatch(input))
				)
			);
		},
	},
	{
		scope: "project",
		action: "tracks",
		subaction: "add",
		method: "POST",
		operation: {
			id: "video_studio_add_track",
			description:
				"Insert an empty timeline track at index `at` (0 is the bottom). Clips, track settings, and adjustment layers at or above it move up one track. Requires the current project revision.",
			body: addTrackRequestSchema,
		},
		handle: async ({ id, request, revisionedProjectEdit }) => {
			const input = addTrackRequestSchema.parse(await request.json());
			return revisionedProjectEdit(
				id,
				input.revision,
				"The project changed. Reload before adding a track.",
				(project, assets) => addTrack(project, assets, input.at)
			);
		},
	},
	{
		scope: "project",
		action: "tracks",
		subaction: "remove",
		method: "POST",
		operation: {
			id: "video_studio_remove_track",
			description:
				"Remove a timeline track and move every track above it down one. A track with clips is refused unless force is true, which also removes its clips. Locked tracks are refused. Requires the current project revision.",
			body: removeTrackRequestSchema,
		},
		handle: async ({ id, request, revisionedProjectEdit }) => {
			const input = removeTrackRequestSchema.parse(await request.json());
			return revisionedProjectEdit(
				id,
				input.revision,
				"The project changed. Reload before removing a track.",
				(project, assets) =>
					removeTrack(project, assets, input.track, { force: input.force })
			);
		},
	},
];
