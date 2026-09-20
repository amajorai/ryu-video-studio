import { z } from "zod";
import { idSchema } from "./project.ts";

export const createSequenceRequestSchema = z
	.object({
		name: z.string().trim().min(1).max(200).optional(),
		revision: z.number().int().nonnegative(),
		sourceProjectId: idSchema,
	})
	.strict();

export const refreshSequenceRequestSchema = z.object({}).strict();
