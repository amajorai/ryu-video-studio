import { afterAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();
const { act, useRef } = await import("react");
const { createRoot } = await import("react-dom/client");
const { newProject } = await import("../../../shared/project.ts");
const { externalRevision, revisionAction, useRevisionWatch } = await import(
	"./use-revision-watch.ts"
);
const { clearSavedBases, recordSavedBase } = await import("./saved-base.ts");
type Project = ReturnType<typeof newProject>;

afterAll(() => {
	GlobalRegistrator.unregister();
});

const project = newProject("Shared history");
const agentEdit: Project = {
	...project,
	revision: project.revision + 1,
	title: "Renamed by the agent",
	updatedAt: new Date(Date.now() + 1000).toISOString(),
};

describe("external revisions", () => {
	test("a newer revision with other content is adopted when the editor is clean", () => {
		expect(
			externalRevision(project, agentEdit, { busy: false, dirty: false })
		).toBe(agentEdit);
	});

	test("unsaved edits, edits in flight and the editor's own saves are left alone", () => {
		expect(
			externalRevision(project, agentEdit, { busy: false, dirty: true })
		).toBeNull();
		expect(
			externalRevision(project, agentEdit, { busy: true, dirty: false })
		).toBeNull();
		const ownSave = { ...project, revision: project.revision + 1 };
		expect(
			externalRevision(project, ownSave, { busy: false, dirty: false })
		).toBeNull();
		expect(
			externalRevision(agentEdit, project, { busy: false, dirty: false })
		).toBeNull();
	});

	test("the watch applies an agent edit as an undoable step", async () => {
		const applied: [Project, Project][] = [];
		const previous = window.ryu;
		window.ryu = {
			app: { request: () => Promise.resolve(agentEdit) },
		} as never;
		function Harness() {
			const latestProject = useRef<Project | null>(project);
			const dirtyRef = useRef(false);
			useRevisionWatch({
				busy: false,
				dirtyRef,
				intervalMs: 10,
				latestProject,
				onExternal: (next, before) => {
					applied.push([next, before]);
					latestProject.current = next;
				},
				projectId: project.id,
			});
			return null;
		}
		const host = document.createElement("div");
		const root = createRoot(host);
		try {
			await act(async () => {
				root.render(<Harness />);
			});
			await act(async () => {
				await Bun.sleep(60);
			});
			expect(applied).toHaveLength(1);
			expect(applied[0]?.[0].title).toBe("Renamed by the agent");
			expect(applied[0]?.[1].revision).toBe(project.revision);
		} finally {
			await act(async () => root.unmount());
			window.ryu = previous;
		}
	});
});

describe("unsaved edits and a newer saved revision", () => {
	test("merge cleanly when the saved base is known", () => {
		clearSavedBases();
		recordSavedBase(project);
		const local = { ...project, brief: "Edited here" };
		const action = revisionAction(local, agentEdit, {
			busy: false,
			dirty: true,
		});
		expect(action.kind).toBe("merge");
		if (action.kind === "merge") {
			expect(action.project).toMatchObject({
				brief: "Edited here",
				revision: agentEdit.revision,
				title: "Renamed by the agent",
			});
		}
	});

	test("report what both sides changed", () => {
		clearSavedBases();
		recordSavedBase(project);
		const local = { ...project, title: "Renamed here" };
		const action = revisionAction(local, agentEdit, {
			busy: false,
			dirty: true,
		});
		expect(action).toMatchObject({
			conflicts: [{ collection: "project", field: "title" }],
			kind: "conflict",
		});
	});

	test("do nothing while busy or without a base", () => {
		clearSavedBases();
		const local = { ...project, brief: "Edited here" };
		expect(
			revisionAction(local, agentEdit, { busy: false, dirty: true }).kind
		).toBe("none");
		recordSavedBase(project);
		expect(
			revisionAction(local, agentEdit, { busy: true, dirty: true }).kind
		).toBe("none");
	});

	test("the watch merges an agent edit under unsaved edits", async () => {
		clearSavedBases();
		recordSavedBase(project);
		const merged: Project[] = [];
		const previous = window.ryu;
		window.ryu = {
			app: { request: () => Promise.resolve(agentEdit) },
		} as never;
		function Harness() {
			const latestProject = useRef<Project | null>({
				...project,
				brief: "Edited here",
			});
			const dirtyRef = useRef(true);
			useRevisionWatch({
				busy: false,
				dirtyRef,
				intervalMs: 10,
				latestProject,
				onExternal: () => {
					throw new Error("unsaved edits must not be replaced");
				},
				onMerge: (next) => {
					merged.push(next);
					latestProject.current = next;
				},
				projectId: project.id,
			});
			return null;
		}
		const host = document.createElement("div");
		const root = createRoot(host);
		try {
			await act(async () => {
				root.render(<Harness />);
			});
			await act(async () => {
				await Bun.sleep(60);
			});
			expect(merged).toHaveLength(1);
			expect(merged[0]).toMatchObject({
				brief: "Edited here",
				title: "Renamed by the agent",
			});
		} finally {
			await act(async () => root.unmount());
			window.ryu = previous;
		}
	});
});
