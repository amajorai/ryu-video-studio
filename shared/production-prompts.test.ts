import { expect, test } from "bun:test";
import { applySceneDraft } from "./production-prompts.ts";
import { newProject } from "./project.ts";

test("late scene drafts preserve unrelated edits and reject a changed brief", () => {
	const project = { ...newProject(), brief: "A bike restoration" };
	const current = { ...project, title: "New title" };
	const output = {
		scenes: [
			{
				title: "Repair",
				script: "Every part matters.",
				prompt: "Close view of a wheel.",
			},
		],
	};
	const next = applySceneDraft(current, project, output);
	expect(next.title).toBe("New title");
	expect(next.scenes[0]?.approved).toBe(false);
	expect(next.scenes[0]?.assetIds).toEqual([]);
	expect(() =>
		applySceneDraft({ ...current, brief: "A different film" }, project, output)
	).toThrow("brief changed");
	expect(() =>
		applySceneDraft({ ...current, id: crypto.randomUUID() }, project, output)
	).toThrow("brief changed");
});
