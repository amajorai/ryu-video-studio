import { z } from "zod";
import type { GenerationJob } from "./generation.ts";
import type { Project } from "./project.ts";

const microUsd = z.number().int().nonnegative().max(1_000_000_000);

export const productionBudgetSchema = z
	.object({
		estimates: z
			.object({
				audio: microUsd.default(100_000),
				image: microUsd.default(250_000),
				video: microUsd.default(1_000_000),
			})
			.strict()
			.default({ audio: 100_000, image: 250_000, video: 1_000_000 }),
		limitMicroUsd: microUsd.default(0),
	})
	.strict();

export type ProductionBudget = z.infer<typeof productionBudgetSchema>;
export type ProductionKind = "image" | "video" | "audio";

export interface ProductionBudgetStatus {
	atRiskMicroUsd: number;
	availableMicroUsd: number | null;
	canStart: boolean;
	limitMicroUsd: number;
	matchedReceipts: number;
	reservedMicroUsd: number;
	spentMicroUsd: number;
	unknownCompleted: number;
}

export const productionBudgetStatusSchema = z
	.object({
		atRiskMicroUsd: microUsd,
		availableMicroUsd: microUsd.nullable(),
		canStart: z.boolean(),
		limitMicroUsd: microUsd,
		matchedReceipts: z.number().int().nonnegative(),
		reservedMicroUsd: microUsd,
		spentMicroUsd: microUsd,
		unknownCompleted: z.number().int().nonnegative(),
	})
	.strict();

function auditReceipt(
	value: unknown
): { cost: number | null; requestId: string } | null {
	if (typeof value !== "object" || value === null) {
		return null;
	}
	const entry = value as Record<string, unknown>;
	if (typeof entry.request_id !== "string" || !entry.request_id) {
		return null;
	}
	if (entry.cost_micro_usd === null) {
		return { cost: null, requestId: entry.request_id };
	}
	return typeof entry.cost_micro_usd === "number" &&
		Number.isSafeInteger(entry.cost_micro_usd) &&
		entry.cost_micro_usd >= 0
		? { cost: entry.cost_micro_usd, requestId: entry.request_id }
		: null;
}

export function estimateForKind(
	budget: ProductionBudget,
	kind: ProductionKind
): number {
	return budget.estimates[kind];
}

export function productionBudgetStatus(
	project: Project,
	jobs: GenerationJob[],
	auditEntries: unknown[] = []
): ProductionBudgetStatus {
	const budget = productionBudgetSchema.parse(project.productionBudget);
	const receipts = new Map<string, number | null>();
	for (const value of auditEntries) {
		const receipt = auditReceipt(value);
		if (receipt) {
			receipts.set(receipt.requestId, receipt.cost);
		}
	}
	let atRiskMicroUsd = 0;
	let matchedReceipts = 0;
	let reservedMicroUsd = 0;
	let spentMicroUsd = 0;
	let unknownCompleted = 0;
	for (const job of jobs) {
		const receipt = receipts.get(job.id);
		if (receipt !== undefined && receipt !== null) {
			spentMicroUsd += receipt;
			matchedReceipts += 1;
			continue;
		}
		const estimate = estimateForKind(budget, job.request.kind);
		if (job.status === "requested") {
			reservedMicroUsd += estimate;
		} else if (job.status === "incomplete" || job.status === "interrupted") {
			atRiskMicroUsd += estimate;
		} else if (job.status === "completed") {
			unknownCompleted += 1;
			atRiskMicroUsd += estimate;
		}
	}
	const committedMicroUsd = spentMicroUsd + reservedMicroUsd + atRiskMicroUsd;
	const availableMicroUsd =
		budget.limitMicroUsd > 0
			? Math.max(0, budget.limitMicroUsd - committedMicroUsd)
			: null;
	return {
		atRiskMicroUsd,
		availableMicroUsd,
		canStart:
			budget.limitMicroUsd === 0 || committedMicroUsd < budget.limitMicroUsd,
		limitMicroUsd: budget.limitMicroUsd,
		matchedReceipts,
		reservedMicroUsd,
		spentMicroUsd,
		unknownCompleted,
	};
}

export function canStartGeneration(
	project: Project,
	jobs: GenerationJob[],
	kind: ProductionKind,
	auditEntries: unknown[] = []
): {
	estimateMicroUsd: number;
	status: ProductionBudgetStatus;
	allowed: boolean;
} {
	const status = productionBudgetStatus(project, jobs, auditEntries);
	const budget = productionBudgetSchema.parse(project.productionBudget);
	const estimateMicroUsd = estimateForKind(budget, kind);
	return {
		estimateMicroUsd,
		status: {
			...status,
			canStart:
				budget.limitMicroUsd === 0 ||
				status.spentMicroUsd +
					status.reservedMicroUsd +
					status.atRiskMicroUsd +
					estimateMicroUsd <=
					budget.limitMicroUsd,
		},
		allowed:
			budget.limitMicroUsd === 0 ||
			status.spentMicroUsd +
				status.reservedMicroUsd +
				status.atRiskMicroUsd +
				estimateMicroUsd <=
				budget.limitMicroUsd,
	};
}
