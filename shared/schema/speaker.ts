import { z } from "zod";
import { hexColorSchema, idSchema } from "./primitives.ts";

export const MAX_SPEAKERS = 16;

export const speakerSchema = z
	.object({
		id: idSchema,
		label: z.string().trim().min(1).max(40),
		color: hexColorSchema,
	})
	.strict();
export type Speaker = z.infer<typeof speakerSchema>;
