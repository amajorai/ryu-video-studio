import { z } from "zod";

export const soundtrackMoodSchema = z.enum(["warm", "bright", "tense"]);
export const soundtrackRequestSchema = z
	.object({
		bpm: z.number().finite().min(60).max(180).default(96),
		duration: z.number().finite().min(0.5).max(7200),
		mood: soundtrackMoodSchema.default("warm"),
	})
	.strict();
export type SoundtrackRequest = z.infer<typeof soundtrackRequestSchema>;
