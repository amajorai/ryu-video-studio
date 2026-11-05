import { describe, expect, test } from "bun:test";
import { productionReadiness } from "./production-readiness.ts";
import { type Asset, newProject, newSegment } from "./project.ts";

function asset(id = crypto.randomUUID()): Asset {
	return {
		id,
		name: "Footage",
		kind: "video",
		duration: 1,
		width: 1920,
		height: 1080,
		hasAudio: true,
		createdAt: new Date().toISOString(),
	};
}

describe("production readiness", () => {
	test("keeps direct timeline edits exportable without storyboard gates", () => {
		const project = newProject("Direct edit");
		const footage = asset();
		project.segments = [newSegment(footage)];
		const before = productionReadiness(project, [footage], []);

		expect(before.exportReady).toBe(true);
		expect(before.ready).toBe(false);
		expect(before.checks.find((check) => check.id === "delivery")?.status).toBe(
			"blocked"
		);
	});

	test("requires complete scene gates and a passing current delivery review", () => {
		const project = newProject("Gated film");
		const assetId = crypto.randomUUID();
		const footage = asset(assetId);
		project.brief = "A short product story.";
		project.requireApproval = true;
		project.scenes = [
			{
				id: crypto.randomUUID(),
				title: "Opening",
				script: "Welcome.",
				prompt: "A bright opening shot.",
				assetIds: [assetId],
				duration: 1,
				sourceIn: 0,
				approved: true,
			},
		];
		project.segments = [newSegment(footage)];
		const jobs = [
			{
				projectId: project.id,
				revision: project.revision,
				status: "completed",
				review: { passed: true },
			},
		];
		const readiness = productionReadiness(project, [footage], jobs);

		expect(readiness.exportReady).toBe(true);
		expect(readiness.ready).toBe(true);
		expect(readiness.checks.every((check) => check.status !== "blocked")).toBe(
			true
		);
	});

	test("flags still-only timelines for motion review without blocking export", () => {
		const project = newProject("Still sequence");
		const still: Asset = {
			...asset(),
			kind: "image",
			duration: 5,
			hasAudio: false,
		};
		project.segments = [newSegment(still)];
		const readiness = productionReadiness(project, [still], []);

		expect(readiness.exportReady).toBe(true);
		expect(
			readiness.checks.find((check) => check.id === "motion-quality")
		).toEqual(expect.objectContaining({ status: "optional" }));
	});
});
