import { z } from "zod";
import type { Project } from "./project.ts";

export const productionDecisionSchema = z
	.object({
		category: z.string().trim().min(1).max(80),
		createdAt: z.iso.datetime(),
		decision: z.string().trim().min(1).max(500),
		id: z.uuid(),
		optionsConsidered: z.array(z.string().trim().min(1).max(200)).max(12),
		rationale: z.string().trim().max(2000),
		rejectedBecause: z.string().trim().max(1000).optional(),
		subject: z.string().trim().min(1).max(160),
	})
	.strict();

export type ProductionDecision = z.infer<typeof productionDecisionSchema>;

export const appendDecisionRequestSchema = z
	.object({
		category: z.string().trim().min(1).max(80),
		decision: z.string().trim().min(1).max(500),
		optionsConsidered: z
			.array(z.string().trim().min(1).max(200))
			.max(12)
			.default([]),
		rationale: z.string().trim().max(2000).default(""),
		rejectedBecause: z.string().trim().max(1000).optional(),
		revision: z.number().int().nonnegative(),
		subject: z.string().trim().min(1).max(160),
	})
	.strict();

export function appendDecision(project: Project, input: unknown): Project {
	const request = appendDecisionRequestSchema.parse(input);
	if (project.decisions.length >= 200) {
		throw new Error("The decision log is limited to 200 entries.");
	}
	const { revision: _revision, ...decisionInput } = request;
	const decision = productionDecisionSchema.parse({
		...decisionInput,
		createdAt: new Date().toISOString(),
		id: crypto.randomUUID(),
	});
	return {
		...project,
		decisions: [...project.decisions, decision],
	};
}
