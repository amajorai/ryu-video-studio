import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import type { HostServices } from "@ryu/app-host/rpc";
import type { Project } from "../../../shared/project.ts";
import { StudioRequestError } from "../bridge.ts";
import {
	AUTOSAVE_DELAY_MS,
	AUTOSAVE_RETRY_MS,
	type AutosaveScheduler,
	autosaveOnce,
	createAutosaveController,
	saveLatestProject,
} from "./autosave.ts";
import { clearSavedBases, recordSavedBase } from "./saved-base.ts";
import { createTestRuntime, testProject } from "./test-runtime.ts";

/** A manual clock: timers and idle callbacks run only when the test advances. */
function fakeScheduler(withIdle = false) {
	let now = 0;
	let nextId = 1;
	const timers = new Map<number, { at: number; run: () => void }>();
	const idle: (() => void)[] = [];
	const scheduler: AutosaveScheduler = {
		clearTimeout: (handle) => {
			timers.delete(handle as number);
		},
		requestIdle: withIdle
			? (run) => {
					idle.push(run);
					return () => {
						const index = idle.indexOf(run);
						if (index >= 0) {
							idle.splice(index, 1);
						}
					};
				}
			: undefined,
		setTimeout: (run, ms) => {
			const id = nextId++;
			timers.set(id, { at: now + ms, run });
			return id;
		},
	};
	return {
		advance(ms: number) {
			now += ms;
			for (const [id, timer] of [...timers]) {
				if (timer.at <= now) {
					timers.delete(id);
					timer.run();
				}
			}
		},
		idle,
		pendingTimers: () => timers.size,
		scheduler,
	};
}

/** A save the test resolves or rejects by hand. */
function manualSave() {
	const calls: {
		reject: (error: unknown) => void;
		resolve: (newer: boolean) => void;
	}[] = [];
	const save = () =>
		new Promise<boolean>((resolve, reject) => {
			calls.push({ reject, resolve });
		});
	return { calls, save };
}

const flushMicrotasks = async () => {
	for (let index = 0; index < 5; index++) {
		await Promise.resolve();
	}
};

describe("autosave controller", () => {
	test("saves once, 2 s after the last of several edits", async () => {
		const clock = fakeScheduler();
		const { calls, save } = manualSave();
		const autosave = createAutosaveController({
			save,
			scheduler: clock.scheduler,
		});
		expect(autosave.getStatus()).toBe("saved");
		autosave.notifyEdit();
		expect(autosave.getStatus()).toBe("unsaved");
		clock.advance(1500);
		autosave.notifyEdit();
		clock.advance(1500);
		expect(calls).toHaveLength(0);
		clock.advance(AUTOSAVE_DELAY_MS - 1500);
		expect(calls).toHaveLength(1);
		expect(autosave.getStatus()).toBe("saving");
		calls[0]?.resolve(false);
		await flushMicrotasks();
		expect(autosave.getStatus()).toBe("saved");
		clock.advance(60_000);
		expect(calls).toHaveLength(1);
	});

	test("waits for an idle moment once the quiet time has passed", () => {
		const clock = fakeScheduler(true);
		const { calls, save } = manualSave();
		const autosave = createAutosaveController({
			save,
			scheduler: clock.scheduler,
		});
		autosave.notifyEdit();
		clock.advance(AUTOSAVE_DELAY_MS);
		expect(calls).toHaveLength(0);
		expect(clock.idle).toHaveLength(1);
		clock.idle.shift()?.();
		expect(calls).toHaveLength(1);
	});

	test("an edit during the quiet-time idle wait cancels the idle save", () => {
		const clock = fakeScheduler(true);
		const { calls, save } = manualSave();
		const autosave = createAutosaveController({
			save,
			scheduler: clock.scheduler,
		});
		autosave.notifyEdit();
		clock.advance(AUTOSAVE_DELAY_MS);
		autosave.notifyEdit();
		expect(clock.idle).toHaveLength(0);
		expect(calls).toHaveLength(0);
	});

	test("edits made while saving schedule exactly one follow-up save", async () => {
		const clock = fakeScheduler();
		const { calls, save } = manualSave();
		const autosave = createAutosaveController({
			save,
			scheduler: clock.scheduler,
		});
		autosave.notifyEdit();
		clock.advance(AUTOSAVE_DELAY_MS);
		autosave.notifyEdit();
		autosave.notifyEdit();
		void autosave.flush();
		expect(calls).toHaveLength(1);
		calls[0]?.resolve(false);
		await flushMicrotasks();
		expect(autosave.getStatus()).toBe("unsaved");
		clock.advance(AUTOSAVE_DELAY_MS);
		expect(calls).toHaveLength(2);
		calls[1]?.resolve(false);
		await flushMicrotasks();
		expect(autosave.getStatus()).toBe("saved");
	});

	test("a save that reports newer edits schedules another save", async () => {
		const clock = fakeScheduler();
		const { calls, save } = manualSave();
		const autosave = createAutosaveController({
			save,
			scheduler: clock.scheduler,
		});
		autosave.notifyEdit();
		clock.advance(AUTOSAVE_DELAY_MS);
		calls[0]?.resolve(true);
		await flushMicrotasks();
		expect(autosave.getStatus()).toBe("unsaved");
		clock.advance(AUTOSAVE_DELAY_MS);
		expect(calls).toHaveLength(2);
	});

	test("flush saves immediately (visibility hidden) and is a no-op when clean", async () => {
		const clock = fakeScheduler();
		const { calls, save } = manualSave();
		const autosave = createAutosaveController({
			save,
			scheduler: clock.scheduler,
		});
		await autosave.flush();
		expect(calls).toHaveLength(0);
		autosave.notifyEdit();
		const flushed = autosave.flush();
		expect(calls).toHaveLength(1);
		expect(clock.pendingTimers()).toBe(0);
		calls[0]?.resolve(false);
		await flushed;
		expect(autosave.getStatus()).toBe("saved");
		await autosave.settled();
	});

	test("waits while another operation is busy", () => {
		const clock = fakeScheduler();
		const { calls, save } = manualSave();
		let busy = true;
		const autosave = createAutosaveController({
			canSave: () => !busy,
			save,
			scheduler: clock.scheduler,
		});
		autosave.notifyEdit();
		clock.advance(AUTOSAVE_DELAY_MS);
		expect(calls).toHaveLength(0);
		expect(autosave.getStatus()).toBe("unsaved");
		busy = false;
		clock.advance(AUTOSAVE_DELAY_MS);
		expect(calls).toHaveLength(1);
	});

	test("a revision conflict stops autosave until it is resolved", async () => {
		const clock = fakeScheduler();
		const { calls, save } = manualSave();
		const autosave = createAutosaveController({
			isConflict: (error) =>
				error instanceof StudioRequestError && error.code === "CONFLICT",
			save,
			scheduler: clock.scheduler,
		});
		autosave.notifyEdit();
		clock.advance(AUTOSAVE_DELAY_MS);
		calls[0]?.reject(new StudioRequestError("Changed", "CONFLICT"));
		await flushMicrotasks();
		expect(autosave.getStatus()).toBe("conflict");
		autosave.notifyEdit();
		autosave.markSaved();
		await autosave.flush();
		clock.advance(60_000);
		expect(calls).toHaveLength(1);
		expect(autosave.getStatus()).toBe("conflict");
		autosave.resolveConflict();
		expect(autosave.getStatus()).toBe("saved");
		autosave.notifyEdit();
		clock.advance(AUTOSAVE_DELAY_MS);
		expect(calls).toHaveLength(2);
	});

	test("other failures report and retry later", async () => {
		const clock = fakeScheduler();
		const { calls, save } = manualSave();
		const errors: unknown[] = [];
		const autosave = createAutosaveController({
			onError: (error) => errors.push(error),
			save,
			scheduler: clock.scheduler,
		});
		autosave.notifyEdit();
		clock.advance(AUTOSAVE_DELAY_MS);
		calls[0]?.reject(new Error("offline"));
		await flushMicrotasks();
		expect(autosave.getStatus()).toBe("error");
		expect(errors).toHaveLength(1);
		clock.advance(AUTOSAVE_RETRY_MS - 1);
		expect(calls).toHaveLength(1);
		clock.advance(1);
		expect(calls).toHaveLength(2);
	});

	test("markSaved clears pending work; dispose stops timers and listeners", () => {
		const clock = fakeScheduler();
		const { calls, save } = manualSave();
		const autosave = createAutosaveController({
			save,
			scheduler: clock.scheduler,
		});
		const seen: string[] = [];
		autosave.subscribe(() => seen.push(autosave.getStatus()));
		autosave.notifyEdit();
		autosave.markSaved();
		expect(seen).toEqual(["unsaved", "saved"]);
		expect(clock.pendingTimers()).toBe(0);
		autosave.notifyEdit();
		autosave.dispose();
		clock.advance(AUTOSAVE_DELAY_MS);
		expect(calls).toHaveLength(0);
	});
});

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

describe("saveLatestProject", () => {
	test("saves the latest project with its revision and marks it clean", async () => {
		const { project } = testProject();
		const runtime = createTestRuntime(project);
		runtime.dirty = true;
		const saved = { ...project, revision: project.revision + 1 };
		respond = () => saved;
		const updates: Project[] = [];
		runtime.setProject = (update) => {
			const next =
				typeof update === "function" ? update(runtime.project) : update;
			if (next) {
				updates.push(next);
				runtime.project = next;
			}
		};
		expect(await saveLatestProject(() => runtime)).toBe(false);
		expect(received).toEqual([
			{
				body: project,
				method: "PUT",
				path: `/projects/${project.id}`,
			},
		]);
		expect(runtime.dirty).toBe(false);
		expect(runtime.latestProject.current?.revision).toBe(saved.revision);
		expect(updates.at(-1)?.revision).toBe(saved.revision);
	});

	test("keeps edits made during the save and rebases them on the new revision", async () => {
		const { project } = testProject();
		const runtime = createTestRuntime(project);
		runtime.dirty = true;
		const newer = { ...project, title: "Edited while saving" };
		respond = () => {
			runtime.latestProject.current = newer;
			runtime.project = newer;
			return { ...project, revision: project.revision + 1 };
		};
		runtime.setProject = (update) => {
			const next =
				typeof update === "function" ? update(runtime.project) : update;
			runtime.project = next;
		};
		expect(await saveLatestProject(() => runtime)).toBe(true);
		expect(runtime.dirty).toBe(true);
		expect(runtime.project).toMatchObject({
			revision: project.revision + 1,
			title: "Edited while saving",
		});
		expect(runtime.latestProject.current?.revision).toBe(project.revision + 1);
	});

	test("a stale revision surfaces as a conflict error", async () => {
		const { project } = testProject();
		const runtime = createTestRuntime(project);
		respond = () => ({ code: "CONFLICT", message: "Changed elsewhere" });
		const failure = await saveLatestProject(() => runtime).catch(
			(error: unknown) => error
		);
		expect(failure).toBeInstanceOf(StudioRequestError);
		expect((failure as StudioRequestError).code).toBe("CONFLICT");
	});

	test("does nothing without a project", async () => {
		const runtime = createTestRuntime(null);
		expect(await saveLatestProject(() => runtime)).toBe(false);
		expect(received).toEqual([]);
	});
});

test("a pending save settles without writing once nothing is dirty", async () => {
	const clock = fakeScheduler();
	const { calls, save } = manualSave();
	let dirty = true;
	const autosave = createAutosaveController({
		isDirty: () => dirty,
		save,
		scheduler: clock.scheduler,
	});
	autosave.notifyEdit();
	dirty = false;
	clock.advance(AUTOSAVE_DELAY_MS);
	await autosave.settled();
	expect(calls).toHaveLength(0);
	expect(autosave.getStatus()).toBe("saved");
});

describe("manual save through the controller", () => {
	test("waits for an in-flight save, then saves once if still dirty", async () => {
		const clock = fakeScheduler();
		const { calls, save } = manualSave();
		let dirty = true;
		const autosave = createAutosaveController({
			isDirty: () => dirty,
			save,
			scheduler: clock.scheduler,
		});
		autosave.notifyEdit();
		void autosave.flush();
		const manual = autosave.saveNow();
		expect(calls).toHaveLength(1);
		calls[0]?.resolve(false);
		await flushMicrotasks();
		expect(calls).toHaveLength(2);
		dirty = false;
		calls[1]?.resolve(false);
		expect(await manual).toBe("saved");
	});

	test("does not save again when the in-flight save left nothing dirty", async () => {
		const clock = fakeScheduler();
		const { calls, save } = manualSave();
		let dirty = true;
		const autosave = createAutosaveController({
			isDirty: () => dirty,
			save,
			scheduler: clock.scheduler,
		});
		autosave.notifyEdit();
		void autosave.flush();
		const manual = autosave.saveNow();
		dirty = false;
		calls[0]?.resolve(false);
		expect(await manual).toBe("saved");
		expect(calls).toHaveLength(1);
	});

	test("saves even while busy, and reports a conflict without saving", async () => {
		const clock = fakeScheduler();
		const { calls, save } = manualSave();
		const autosave = createAutosaveController({
			canSave: () => false,
			isConflict: () => true,
			save,
			scheduler: clock.scheduler,
		});
		const manual = autosave.saveNow();
		expect(calls).toHaveLength(1);
		calls[0]?.reject(new StudioRequestError("Changed", "CONFLICT"));
		expect(await manual).toBe("conflict");
		expect(await autosave.saveNow()).toBe("conflict");
		expect(calls).toHaveLength(1);
	});
});

describe("autosaveOnce", () => {
	/** A runtime whose `act` marks it busy, like App's. */
	function busyRuntime() {
		const { project } = testProject();
		const runtime = createTestRuntime(project);
		runtime.dirty = true;
		runtime.act = async (operation) => {
			runtime.busy = true;
			try {
				await operation();
			} finally {
				runtime.busy = false;
			}
		};
		runtime.setProject = (update) => {
			runtime.project =
				typeof update === "function" ? update(runtime.project) : update;
		};
		return { project, runtime };
	}

	test("marks the editor busy while the write is out", async () => {
		const { project, runtime } = busyRuntime();
		let busyDuringSave = false;
		respond = () => {
			busyDuringSave = runtime.busy;
			return { ...project, revision: project.revision + 1 };
		};
		expect(
			await autosaveOnce(
				() => runtime,
				() => Promise.resolve()
			)
		).toBe(false);
		expect(busyDuringSave).toBe(true);
		expect(runtime.busy).toBe(false);
		expect(runtime.dirty).toBe(false);
	});

	test("a conflict with this editor's own save just before is not a conflict", async () => {
		const { project, runtime } = busyRuntime();
		respond = () => ({ code: "CONFLICT", message: "Changed elsewhere" });
		const waits: number[] = [];
		const result = await autosaveOnce(
			() => runtime,
			(ms) => {
				waits.push(ms);
				// Meanwhile the action that raced autosave lands its save.
				runtime.latestProject.current = {
					...project,
					revision: project.revision + 1,
				};
				runtime.dirty = false;
				return Promise.resolve();
			},
			25
		);
		expect(result).toBe(false);
		expect(waits).toEqual([25]);
	});

	test("waits while the editor stays busy, then reports a real conflict", async () => {
		const { runtime } = busyRuntime();
		respond = () => ({ code: "CONFLICT", message: "Changed elsewhere" });
		const waits: number[] = [];
		const failure = await autosaveOnce(
			() => runtime,
			(ms) => {
				waits.push(ms);
				runtime.busy = waits.length < 3;
				return Promise.resolve();
			},
			10
		).catch((error: unknown) => error);
		expect(failure).toBeInstanceOf(StudioRequestError);
		expect((failure as StudioRequestError).code).toBe("CONFLICT");
		expect(waits).toEqual([10, 10, 10]);
	});

	test("other failures are rethrown without waiting", async () => {
		const { runtime } = busyRuntime();
		respond = () => {
			throw new Error("offline");
		};
		let waited = false;
		const failure = await autosaveOnce(
			() => runtime,
			() => {
				waited = true;
				return Promise.resolve();
			}
		).catch((error: unknown) => error);
		expect((failure as Error).message).toBe("offline");
		expect(waited).toBe(false);
	});
});

describe("merging a save from elsewhere under unsaved edits", () => {
	function dirtyRuntime() {
		clearSavedBases();
		const { project, first, second } = testProject();
		const base = { ...project, revision: 3 };
		recordSavedBase(base);
		const local = { ...base, title: "Renamed here" };
		const runtime = createTestRuntime(local);
		runtime.dirty = true;
		runtime.setProject = (update) => {
			runtime.project =
				typeof update === "function" ? update(runtime.project) : update;
		};
		return { base, first, local, runtime, second };
	}

	test("a clean merge keeps the edits unsaved on the newer revision", async () => {
		const { base, first, runtime } = dirtyRuntime();
		const remote = {
			...base,
			revision: 4,
			segments: base.segments.map((segment) =>
				segment.id === first.id ? { ...segment, volume: 0.25 } : segment
			),
		};
		respond = (input) =>
			input.method === "PUT"
				? { code: "CONFLICT", message: "Changed elsewhere" }
				: remote;
		const result = await autosaveOnce(
			() => runtime,
			() => Promise.resolve(),
			1
		);
		expect(result).toBe(true);
		expect(runtime.dirty).toBe(true);
		expect(runtime.project).toMatchObject({
			revision: 4,
			title: "Renamed here",
		});
		expect(
			runtime.project?.segments.find((segment) => segment.id === first.id)
				?.volume
		).toBe(0.25);
		expect(runtime.latestProject.current).toBe(runtime.project);
		expect(runtime.store.getState().mergeConflicts).toEqual([]);
	});

	test("records the merge as an undoable Agent edit", async () => {
		const { base, local, runtime } = dirtyRuntime();
		respond = (input) =>
			input.method === "PUT"
				? { code: "CONFLICT", message: "Changed elsewhere" }
				: { ...base, brief: "Agent brief", revision: 4 };
		expect(
			await autosaveOnce(
				() => runtime,
				() => Promise.resolve(),
				1
			)
		).toBe(true);
		const { history } = runtime.store.getState();
		expect(history.past.at(-1)?.label).toBe("Agent edit");
		expect(history.past.at(-1)?.project).toBe(local);
	});

	test("an edit made while the newer revision loads is kept", async () => {
		const { base, first, runtime } = dirtyRuntime();
		const remote = { ...base, brief: "Agent brief", revision: 4 };
		let reads = 0;
		respond = (input) => {
			if (input.method === "PUT") {
				return { code: "CONFLICT", message: "Changed elsewhere" };
			}
			reads += 1;
			if (reads === 1) {
				// The viewer drags a clip while the first read is out.
				const current = runtime.latestProject.current ?? runtime.project;
				if (current) {
					const edited = {
						...current,
						segments: current.segments.map((segment) =>
							segment.id === first.id ? { ...segment, volume: 0.5 } : segment
						),
					};
					runtime.latestProject.current = edited;
					runtime.project = edited;
				}
			}
			return remote;
		};
		expect(
			await autosaveOnce(
				() => runtime,
				() => Promise.resolve(),
				1
			)
		).toBe(true);
		expect(reads).toBe(2);
		expect(runtime.project).toMatchObject({
			brief: "Agent brief",
			revision: 4,
			title: "Renamed here",
		});
		expect(
			runtime.project?.segments.find((segment) => segment.id === first.id)
				?.volume
		).toBe(0.5);
		expect(runtime.latestProject.current).toBe(runtime.project);
	});

	test("merges while the editor is busy, so the revision watch stands aside", async () => {
		const { base, runtime } = dirtyRuntime();
		let busyDuringRead = false;
		runtime.act = async (operation) => {
			runtime.busy = true;
			try {
				await operation();
			} finally {
				runtime.busy = false;
			}
		};
		respond = (input) => {
			if (input.method === "PUT") {
				return { code: "CONFLICT", message: "Changed elsewhere" };
			}
			busyDuringRead = runtime.busy;
			return { ...base, brief: "Agent brief", revision: 4 };
		};
		expect(
			await autosaveOnce(
				() => runtime,
				() => Promise.resolve(),
				1
			)
		).toBe(true);
		expect(busyDuringRead).toBe(true);
	});

	test("a conflicting merge is listed and the conflict stands", async () => {
		const { base, runtime } = dirtyRuntime();
		const remote = { ...base, revision: 4, title: "Renamed by the agent" };
		respond = (input) =>
			input.method === "PUT"
				? { code: "CONFLICT", message: "Changed elsewhere" }
				: remote;
		const failure = await autosaveOnce(
			() => runtime,
			() => Promise.resolve(),
			1
		).catch((error: unknown) => error);
		expect((failure as StudioRequestError).code).toBe("CONFLICT");
		expect(runtime.project?.title).toBe("Renamed here");
		expect(runtime.store.getState().mergeConflicts).toEqual([
			{ collection: "project", field: "title", kind: "both-changed" },
		]);
	});

	test("without the saved base of the editor's revision nothing is merged", async () => {
		const { base, runtime } = dirtyRuntime();
		clearSavedBases();
		respond = (input) =>
			input.method === "PUT"
				? { code: "CONFLICT", message: "Changed elsewhere" }
				: { ...base, revision: 4, brief: "Agent brief" };
		const failure = await autosaveOnce(
			() => runtime,
			() => Promise.resolve(),
			1
		).catch((error: unknown) => error);
		expect((failure as StudioRequestError).code).toBe("CONFLICT");
		expect(runtime.project?.revision).toBe(3);
	});
});
