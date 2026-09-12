import { describe, expect, test } from "bun:test";
import {
	canStartGeneration,
	productionBudgetSchema,
	productionBudgetStatus,
} from "./production-budget.ts";
import { newProject } from "./project.ts";

const job = (
	projectId: string,
	kind: "image" | "video" | "audio",
	status: "requested" | "completed" | "incomplete" | "interrupted",
	id = crypto.randomUUID()
) => ({
	createdAt: new Date().toISOString(),
	id,
	message: "",
	projectRevision: 0,
	request: {
		id,
		kind,
		model: "",
		projectId,
		provider: "",
		prompt: "make a scene",
		rationale: "",
		route: "node-default" as const,
		speed: 1,
		voice: "",
		language: "",
	},
	status,
	assetIds: [],
	updatedAt: new Date().toISOString(),
});

describe("production budget admission", () => {
	test("matches exact Gateway receipts and reserves requested work", () => {
		const project = {
			...newProject(),
			productionBudget: productionBudgetSchema.parse({
				estimates: { image: 250_000, video: 1_000_000, audio: 100_000 },
				limitMicroUsd: 1_000_000,
			}),
		};
		const receiptId = crypto.randomUUID();
		const pendingId = crypto.randomUUID();
		const receiptJob = job(project.id, "image", "completed", receiptId);
		const pendingJob = job(project.id, "video", "requested", pendingId);
		const status = productionBudgetStatus(
			project,
			[receiptJob, pendingJob],
			[{ request_id: receiptId, cost_micro_usd: 250_000 }]
		);
		expect(status.spentMicroUsd).toBe(250_000);
		expect(status.reservedMicroUsd).toBe(1_000_000);
		expect(status.matchedReceipts).toBe(1);
		expect(
			canStartGeneration(project, [receiptJob, pendingJob], "image", [
				{ request_id: receiptId, cost_micro_usd: 250_000 },
			]).allowed
		).toBe(false);
	});

	test("holds an unsettled completed request against the cap", () => {
		const project = {
			...newProject(),
			productionBudget: productionBudgetSchema.parse({
				limitMicroUsd: 300_000,
			}),
		};
		const completed = job(project.id, "image", "completed");
		const status = productionBudgetStatus(project, [completed]);
		expect(status.unknownCompleted).toBe(1);
		expect(status.atRiskMicroUsd).toBe(250_000);
		expect(canStartGeneration(project, [completed], "audio").allowed).toBe(
			false
		);
	});
});
