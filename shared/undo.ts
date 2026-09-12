import { z } from "zod";

export const undoRequestSchema = z
	.object({
		historyRevision: z.number().int().nonnegative().optional(),
		revision: z.number().int().nonnegative(),
	})
	.strict();
