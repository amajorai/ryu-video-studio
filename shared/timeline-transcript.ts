import { z } from "zod";
import type { Project } from "./project.ts";
import { captionsForSource, type Transcript } from "./transcript.ts";

export const timelineTranscriptSchema = z
	.object({
		clips: z
			.array(
				z
					.object({
						assetId: z.uuid(),
						clipId: z.uuid(),
						cues: z.array(z.unknown()).max(5000),
						words: z.array(z.unknown()).max(50_000),
					})
					.strict()
			)
			.max(200),
		projectId: z.uuid(),
		revision: z.number().int().nonnegative(),
		sourceCaptions: z.array(z.unknown()).max(5000),
	})
	.strict();

export function timelineTranscript(
	project: Project,
	transcriptFor: (assetId: string) => Transcript | null,
	track?: number
) {
	const clips = project.segments
		.filter((segment) => track === undefined || segment.track === track)
		.flatMap((segment) => {
			const transcript = transcriptFor(segment.assetId);
			if (transcript?.status !== "completed") {
				return [];
			}
			const cues = captionsForSource(
				{ ...project, segments: [segment] },
				transcript
			);
			const words = captionsForSource(
				{ ...project, segments: [segment] },
				{ ...transcript, cues: transcript.words }
			);
			return [{ assetId: segment.assetId, clipId: segment.id, cues, words }];
		});
	return timelineTranscriptSchema.parse({
		clips,
		projectId: project.id,
		revision: project.revision,
		sourceCaptions: project.captions,
	});
}
