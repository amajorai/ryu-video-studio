import { expect, test } from "bun:test";
import { productionPreflightSchema } from "./production-preflight.ts";

test("production preflight schema preserves blockers and next-stage state", () => {
	const value = productionPreflightSchema.parse({
		blockers: [],
		budget: {
			atRiskMicroUsd: 0,
			availableMicroUsd: null,
			canStart: true,
			limitMicroUsd: 0,
			matchedReceipts: 0,
			reservedMicroUsd: 0,
			spentMicroUsd: 0,
			unknownCompleted: 0,
		},
		decisions: 2,
		exportReady: false,
		generations: { needsReview: 1, pending: 0 },
		nextStage: "research",
		ready: false,
		revision: 3,
		stages: { completed: 0, total: 7 },
		warnings: [],
	});

	expect(value.nextStage).toBe("research");
	expect(value.generations.needsReview).toBe(1);
});
