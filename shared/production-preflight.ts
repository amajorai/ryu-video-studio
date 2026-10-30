import { z } from "zod";
import { productionBudgetStatusSchema } from "./production-budget.ts";
import { productionReadinessCheckSchema } from "./production-readiness.ts";
import { productionStageIdSchema } from "./production-stages.ts";

export const productionPreflightSchema = z
	.object({
		blockers: z.array(productionReadinessCheckSchema).max(20),
		budget: productionBudgetStatusSchema,
		decisions: z.number().int().nonnegative().max(200),
		exportReady: z.boolean(),
		generations: z
			.object({
				needsReview: z.number().int().nonnegative().max(100),
				pending: z.number().int().nonnegative().max(100),
			})
			.strict(),
		nextStage: productionStageIdSchema.nullable(),
		ready: z.boolean(),
		revision: z.number().int().nonnegative(),
		stages: z
			.object({
				completed: z.number().int().nonnegative().max(7),
				total: z.literal(7),
			})
			.strict(),
		warnings: z.array(productionReadinessCheckSchema).max(20),
	})
	.strict();

export type ProductionPreflight = z.infer<typeof productionPreflightSchema>;
