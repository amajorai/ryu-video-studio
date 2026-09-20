import { z } from "zod";
import type { Project } from "./project.ts";

export const productionStageIdSchema = z.enum([
	"research",
	"proposal",
	"script",
	"scene_plan",
	"assets",
	"edit",
	"compose",
]);
export type ProductionStageId = z.infer<typeof productionStageIdSchema>;

export const productionStageStateSchema = z
	.object({
		completedAt: z.iso.datetime().optional(),
		id: productionStageIdSchema,
		note: z.string().trim().max(2000).optional(),
		startedAt: z.iso.datetime().optional(),
		status: z.enum(["pending", "active", "complete", "blocked"]),
	})
	.strict();
export type ProductionStageState = z.infer<typeof productionStageStateSchema>;

export const stageTransitionRequestSchema = z
	.object({
		action: z.enum(["start", "complete", "block", "reset"]),
		note: z.string().trim().max(2000).optional(),
		revision: z.number().int().nonnegative(),
		stage: productionStageIdSchema,
	})
	.strict();

export const productionStageIds = productionStageIdSchema.options;

export function defaultProductionStages(): ProductionStageState[] {
	return productionStageIds.map((id) => ({ id, status: "pending" as const }));
}

export function transitionProductionStage(
	project: Project,
	input: unknown
): Project {
	const request = stageTransitionRequestSchema.parse(input);
	const index = productionStageIds.indexOf(request.stage);
	const current = project.stages[index];
	if (!current) {
		throw new Error("Production stage is not available.");
	}
	const now = new Date().toISOString();
	if (
		request.action === "start" &&
		index > 0 &&
		project.stages[index - 1]?.status !== "complete"
	) {
		throw new Error("Complete the previous production stage first.");
	}
	if (request.action === "complete" && current.status !== "active") {
		throw new Error("Start the production stage before completing it.");
	}
	if (request.action === "block" && current.status !== "active") {
		throw new Error("Start the production stage before blocking it.");
	}
	const nextStatus =
		request.action === "start"
			? "active"
			: request.action === "complete"
				? "complete"
				: request.action === "block"
					? "blocked"
					: "pending";
	return {
		...project,
		stages: project.stages.map((stage, stageIndex) => {
			if (stageIndex < index || stageIndex === index) {
				return stageIndex === index
					? {
							...stage,
							...(request.action === "start" ? { startedAt: now } : {}),
							...(request.action === "complete" ? { completedAt: now } : {}),
							...(request.note === undefined ? {} : { note: request.note }),
							status: nextStatus,
						}
					: stage;
			}
			return request.action === "reset"
				? { id: stage.id, status: "pending" as const }
				: stage;
		}),
	};
}
