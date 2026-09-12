import { z } from "zod";
import {
	type Asset,
	type Caption,
	captionSchema,
	type Project,
	validateProject,
	withActiveCaptions,
} from "./project.ts";

export const captionEditRequestSchema = z
	.object({
		action: z.enum(["append", "remove", "replace"]),
		captionIds: z.array(z.uuid()).max(5000).default([]),
		captions: z.array(captionSchema).max(5000).default([]),
		revision: z.number().int().nonnegative(),
		trackId: z.uuid().nullable().default(null),
	})
	.strict();

export type CaptionEditRequest = z.infer<typeof captionEditRequestSchema>;

/** Apply one bounded caption edit to the source or an existing language track. */
export function editCaptions(
	project: Project,
	assets: readonly Asset[],
	input: unknown
): Project {
	const request = captionEditRequestSchema.parse(input);
	const current = request.trackId
		? project.captionTracks.find((track) => track.id === request.trackId)
				?.captions
		: project.captions;
	if (!current) {
		throw new Error("Caption track not found.");
	}
	let captions: Caption[];
	if (request.action === "replace") {
		captions = request.captions;
	} else if (request.action === "append") {
		captions = [...current, ...request.captions];
	} else {
		const removed = new Set(request.captionIds);
		captions = current.filter((caption) => !removed.has(caption.id));
	}
	const next = request.trackId
		? {
				...project,
				captionTracks: project.captionTracks.map((track) =>
					track.id === request.trackId ? { ...track, captions } : track
				),
			}
		: withActiveCaptions({ ...project, captionTrackId: null }, captions);
	return validateProject(next, [...assets]);
}
