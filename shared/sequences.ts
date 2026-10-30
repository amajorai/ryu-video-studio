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

/** `POST /projects/:id/nest`: move clips into a new nested sequence. */
export const nestRequestSchema = z
	.object({
		clipIds: z.array(idSchema).min(1).max(500),
		revision: z.number().int().nonnegative(),
		/** Title of the nested project; defaults to "<parent> · nest". */
		title: z.string().trim().min(1).max(200).optional(),
	})
	.strict();
export type NestRequest = z.infer<typeof nestRequestSchema>;

/** `POST /projects/:id/decompose`: expand a sequence clip back into clips. */
export const decomposeRequestSchema = z
	.object({
		clipId: idSchema,
		revision: z.number().int().nonnegative(),
	})
	.strict();
export type DecomposeRequest = z.infer<typeof decomposeRequestSchema>;
