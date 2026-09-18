import { describe, expect, test } from "bun:test";
import { productionActivity } from "./production-activity.ts";

describe("production activity ledger", () => {
	test("combines saved project, generation, and export state newest first", () => {
		const activity = productionActivity(
			{
				id: "project-1",
				revision: 3,
				title: "Launch film",
				updatedAt: "2026-09-09T10:00:00.000Z",
			},
			[
				{
					createdAt: "2026-09-09T10:02:00.000Z",
					id: "generation-1",
					message: "",
					request: {
						kind: "image",
						model: "local",
						prompt: "A blue launch card",
						rationale: "",
						route: "local",
					},
					status: "completed",
				},
			],
			[
				{
					createdAt: "2026-09-09T10:04:00.000Z",
					id: "render-1",
					revision: 3,
					review: { passed: true },
					status: "completed",
				},
			]
		);
		expect(
			activity.events
				.filter((event) => event.kind !== "stage")
				.map((event) => event.id)
		).toEqual([
			"render:render-1",
			"generation:generation-1",
			"project:project-1",
		]);
		expect(activity.events[0]?.detail).toContain("delivery review passed");
		expect(
			activity.events
				.filter((event) => event.kind === "stage")
				.map((event) => event.title)
		).toEqual(["Brief", "Storyboard", "Takes", "Approval", "Assembly"]);
	});

	test("surfaces requested changes in the approval stage", () => {
		const activity = productionActivity(
			{
				id: "project-2",
				revision: 4,
				title: "Review pass",
				updatedAt: "2026-09-09T10:00:00.000Z",
				requireApproval: true,
				scenes: [
					{
						approved: false,
						assetIds: ["asset-1"],
						reviewStatus: "changes-requested",
					},
				],
			},
			[],
			[]
		);
		const approval = activity.events.find(
			(event) => event.id === "stage:approval"
		);
		expect(approval?.status).toBe("waiting");
		expect(approval?.detail).toBe("1 scene has requested changes.");
	});
});
