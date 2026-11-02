import { expect, test } from "bun:test";
import { mergeApprovalPolicy } from "./approval-policy.ts";
import { newProject, type Project } from "./project.ts";

test("a delayed policy response keeps queued edits, dirty state and undo/redo snapshots", async () => {
	const saved = {
		...newProject("Policy draft"),
		revision: 3,
		requireApproval: true,
	};
	let current: Project = { ...saved, brief: "Initial unsaved draft" };
	let history = [saved];
	let future: Project[] = [];
	let dirty = true;
	const response = Promise.withResolvers<Project>();
	const pending = (async () => {
		const policy = await response.promise;
		current = mergeApprovalPolicy(current, policy);
		history = history.map((snapshot) => mergeApprovalPolicy(snapshot, policy));
		future = future.map((snapshot) => mergeApprovalPolicy(snapshot, policy));
	})();
	history.push(current);
	current = { ...current, brief: "Queued during policy update" };
	future = [{ ...current, brief: "Local redo snapshot" }];
	dirty = true;
	response.resolve({
		...saved,
		revision: 4,
		requireApproval: false,
		updatedAt: "2026-10-04T08:00:00.000Z",
	});
	await pending;
	expect(current.brief).toBe("Queued during policy update");
	expect(current.requireApproval).toBe(false);
	expect(current.revision).toBe(4);
	expect(dirty).toBe(true);
	expect(history.at(-1)?.brief).toBe("Initial unsaved draft");
	expect(history.at(-1)?.requireApproval).toBe(false);
	expect(history.at(-1)?.revision).toBe(4);
	expect(future[0]?.brief).toBe("Local redo snapshot");
	expect(future[0]?.requireApproval).toBe(false);
});

test("policy responses cannot replace another selected project or a newer revision", () => {
	const current = {
		...newProject("Current"),
		revision: 5,
		requireApproval: true,
	};
	expect(
		mergeApprovalPolicy(current, {
			...current,
			revision: 4,
			requireApproval: false,
		})
	).toBe(current);
	expect(
		mergeApprovalPolicy(current, {
			...current,
			id: crypto.randomUUID(),
			revision: 6,
			requireApproval: false,
		})
	).toBe(current);
});
