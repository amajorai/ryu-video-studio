import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import type { HostServices } from "@ryu/app-host/rpc";
import type { Project } from "../../../../shared/project.ts";
import { dispatchShortcut } from "../../shortcuts/registry.ts";
import { autosaveOnce, createAutosaveController } from "../autosave.ts";
import { registerAutosave } from "../autosave-registry.ts";
import { createTestRuntime, lastStatus, testProject } from "../test-runtime.ts";
import {
	jumpToHistory,
	loadSavedHistory,
	restoreSavedRevision,
	saveProjectNow,
} from "./history.ts";

type StudioHostRequest = Parameters<NonNullable<HostServices["appRequest"]>>[0];
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
const received: StudioHostRequest[] = [];
let respond: (input: StudioHostRequest) => unknown = () => null;

beforeEach(() => {
	received.length = 0;
	Object.defineProperty(globalThis, "window", {
		configurable: true,
		value: {
			ryu: {
				app: {
					request: async (input: StudioHostRequest) => {
						received.push(input);
						return await respond(input);
					},
				},
			},
		},
	});
});

afterAll(() => {
	if (originalWindow) {
		Object.defineProperty(globalThis, "window", originalWindow);
	} else {
		Reflect.deleteProperty(globalThis, "window");
	}
});

/** A runtime whose `setProject` applies, with three labelled edits made. */
function editedRuntime() {
	const { project } = testProject();
	const runtime = createTestRuntime(project);
	runtime.setProject = (update) => {
		runtime.project =
			typeof update === "function" ? update(runtime.project) : update;
	};
	for (const title of ["one", "two", "three"]) {
		const current = runtime.project as Project;
		runtime.edit({ ...current, title }, `Title ${title}`);
	}
	runtime.dirty = false;
	return { project, runtime };
}

describe("jumpToHistory", () => {
	test("shows the chosen step and keeps later steps to redo", () => {
		const { project, runtime } = editedRuntime();
		expect(jumpToHistory(runtime, 1)).toBe(true);
		expect(runtime.project?.title).toBe("one");
		expect(runtime.latestProject.current?.title).toBe("one");
		expect(runtime.dirty).toBe(true);
		const { history } = runtime.store.getState();
		expect(history.past.map((entry) => entry.label)).toEqual(["Title one"]);
		expect(history.future.map((entry) => entry.label)).toEqual([
			"Title two",
			"Title three",
		]);
		expect(jumpToHistory(runtime, 0)).toBe(true);
		expect(runtime.project?.title).toBe(project.title);
		expect(jumpToHistory(runtime, 3)).toBe(true);
		expect(runtime.project?.title).toBe("three");
	});

	test("refuses the current step, a bad index, or no project", () => {
		const { runtime } = editedRuntime();
		runtime.dirty = false;
		expect(jumpToHistory(runtime, 3)).toBe(false);
		expect(jumpToHistory(runtime, 9)).toBe(false);
		expect(runtime.dirty).toBe(false);
		expect(jumpToHistory(createTestRuntime(null), 0)).toBe(false);
	});
});

describe("history shortcuts", () => {
	test("Ctrl+Y redoes like Cmd/Ctrl+Shift+Z", () => {
		const { runtime } = editedRuntime();
		runtime.undo();
		expect(runtime.project?.title).toBe("two");
		const event = {
			altKey: false,
			code: "KeyY",
			ctrlKey: true,
			key: "y",
			metaKey: false,
			preventDefault: () => undefined,
			shiftKey: false,
			target: null,
		};
		dispatchShortcut(event as unknown as KeyboardEvent, runtime);
		expect(runtime.project?.title).toBe("three");
	});
});

describe("saved revisions", () => {
	test("loadSavedHistory asks for the summary list", async () => {
		respond = () => ({
			current: { revision: 4, updatedAt: "2026-01-01T00:00:00.000Z" },
			revisions: [
				{
					duration: 12,
					revision: 3,
					segmentCount: 2,
					title: "Cut",
					updatedAt: "2026-01-01T00:00:00.000Z",
				},
			],
		});
		const history = await loadSavedHistory("abc");
		expect(received).toEqual([
			{ method: "GET", path: "/projects/abc/history?summary=1" },
		]);
		expect(history.revisions[0]?.revision).toBe(3);
	});

	test("restoring posts the saved revision and keeps an undo step", async () => {
		const { runtime } = editedRuntime();
		const before = runtime.project as Project;
		const restored = { ...before, revision: before.revision + 1, title: "Old" };
		const committed: [Project, Project | undefined][] = [];
		runtime.commitServerProject = (next, previous) => {
			committed.push([next, previous]);
			runtime.project = next;
		};
		respond = () => restored;
		await restoreSavedRevision(runtime, 0);
		expect(received).toEqual([
			{
				body: { historyRevision: 0, revision: before.revision },
				method: "POST",
				path: `/projects/${before.id}/history`,
			},
		]);
		expect(committed).toEqual([[restored, before]]);
		expect(lastStatus(runtime)).toBe(
			`Restored saved revision 0 as revision ${restored.revision}.`
		);
	});

	test("a stale restore reloads the latest revision and clears history", async () => {
		const { runtime } = editedRuntime();
		const before = runtime.project as Project;
		const latest = { ...before, revision: before.revision + 5, title: "New" };
		respond = (input) =>
			input.method === "POST"
				? { code: "CONFLICT", message: "Changed" }
				: latest;
		await restoreSavedRevision(runtime, 0);
		expect(received.map((input) => input.method)).toEqual(["POST", "GET"]);
		expect(runtime.project).toEqual(latest);
		expect(runtime.dirty).toBe(false);
		expect(runtime.store.getState().history.past).toEqual([]);
		expect(String(lastStatus(runtime))).toContain("changed elsewhere");
	});
});

/**
 * A sidecar that keeps one revision and refuses stale saves, answering each
 * request only when the test releases it.
 */
function revisionCheckedSidecar(saved: Project) {
	let revision = saved.revision;
	const waiting: (() => void)[] = [];
	respond = (input) =>
		new Promise((resolve) => {
			waiting.push(() => {
				const body = input.body as Project;
				if (input.method !== "PUT") {
					revision += 1;
					resolve({ ...saved, revision });
					return;
				}
				if (body.revision !== revision) {
					resolve({ code: "CONFLICT", message: "Changed elsewhere" });
					return;
				}
				revision += 1;
				resolve({ ...body, revision });
			});
		});
	return {
		release: async () => {
			for (let index = 0; index < 10 && waiting.length === 0; index++) {
				await Promise.resolve();
			}
			waiting.shift()?.();
			for (let index = 0; index < 10; index++) {
				await Promise.resolve();
			}
		},
		revision: () => revision,
	};
}

/** An edited runtime whose `act` marks it busy, with autosave registered. */
function autosavedRuntime() {
	const { runtime } = editedRuntime();
	runtime.dirty = true;
	runtime.act = async (operation) => {
		runtime.busy = true;
		try {
			await operation();
		} finally {
			runtime.busy = false;
		}
	};
	const autosave = createAutosaveController({
		isDirty: () => runtime.dirty,
		save: () =>
			autosaveOnce(
				() => runtime,
				() => Promise.resolve()
			),
		scheduler: {
			clearTimeout: () => undefined,
			setTimeout: () => 0,
		},
	});
	const unregister = registerAutosave(runtime.store, autosave);
	return { autosave, runtime, unregister };
}

describe("manual save with autosave", () => {
	test("Cmd+S during an in-flight autosave waits instead of conflicting", async () => {
		const { autosave, runtime, unregister } = autosavedRuntime();
		const sidecar = revisionCheckedSidecar(runtime.project as Project);
		autosave.notifyEdit();
		const autosaving = autosave.flush();
		expect(runtime.busy).toBe(true);
		const manual = saveProjectNow(runtime);
		await sidecar.release();
		await autosaving;
		await manual;
		expect(received.map((input) => input.method)).toEqual(["PUT"]);
		expect(runtime.dirty).toBe(false);
		expect(autosave.getStatus()).toBe("saved");
		expect(lastStatus(runtime)).toBe("Project saved.");
		expect(runtime.project?.revision).toBe(sidecar.revision());
		unregister();
	});

	test("edits made during the autosave are saved by Cmd+S on the new revision", async () => {
		const { autosave, runtime, unregister } = autosavedRuntime();
		const sidecar = revisionCheckedSidecar(runtime.project as Project);
		autosave.notifyEdit();
		const autosaving = autosave.flush();
		runtime.edit({ ...(runtime.project as Project), title: "four" }, "Four");
		const manual = saveProjectNow(runtime);
		await sidecar.release();
		await autosaving;
		await sidecar.release();
		await manual;
		expect(received.map((input) => input.method)).toEqual(["PUT", "PUT"]);
		expect(received.map((input) => (input.body as Project).revision)).toEqual([
			sidecar.revision() - 2,
			sidecar.revision() - 1,
		]);
		expect((received[1]?.body as Project).title).toBe("four");
		expect(runtime.dirty).toBe(false);
		expect(lastStatus(runtime)).toBe("Project saved.");
		unregister();
	});

	test("Cmd+S without autosave saves directly", async () => {
		const { runtime } = editedRuntime();
		await saveProjectNow(runtime);
		expect(runtime.calls).toContainEqual(["save"]);
	});

	test("restoring waits for an in-flight autosave before saving", async () => {
		const { autosave, runtime, unregister } = autosavedRuntime();
		const sidecar = revisionCheckedSidecar(runtime.project as Project);
		const order: string[] = [];
		runtime.ensureSaved = () => {
			order.push(`ensureSaved:${runtime.dirty}`);
			return Promise.resolve(runtime.project ?? undefined);
		};
		autosave.notifyEdit();
		const autosaving = autosave.flush();
		const restoring = restoreSavedRevision(runtime, 0);
		await Promise.resolve();
		expect(order).toEqual([]);
		await sidecar.release();
		await autosaving;
		await sidecar.release();
		await restoring;
		expect(order).toEqual(["ensureSaved:false"]);
		expect(received.map((input) => input.method)).toEqual(["PUT", "POST"]);
		expect((received[1]?.body as { revision: number }).revision).toBe(
			sidecar.revision() - 1
		);
		unregister();
	});
});
