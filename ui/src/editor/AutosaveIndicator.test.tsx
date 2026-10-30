import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { HostServices } from "@ryu/app-host/rpc";
import type { AutosaveScheduler } from "./autosave.ts";

const ownsDom = !GlobalRegistrator.isRegistered;
if (ownsDom) {
	GlobalRegistrator.register();
}
const previousActEnvironment = Object.getOwnPropertyDescriptor(
	globalThis,
	"IS_REACT_ACT_ENVIRONMENT"
);
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
	configurable: true,
	value: true,
	writable: true,
});
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { EditorProvider } = await import("./context.tsx");
const { createTestRuntime, testProject } = await import("./test-runtime.ts");
const { AutosaveConflictBanner, AutosaveIndicator, AutosaveProvider } =
	await import("./AutosaveIndicator.tsx");
const { autosaveFor } = await import("./autosave-registry.ts");
const { recordSavedBase } = await import("./saved-base.ts");

afterAll(() => {
	if (ownsDom) {
		GlobalRegistrator.unregister();
	}
	if (previousActEnvironment) {
		Object.defineProperty(
			globalThis,
			"IS_REACT_ACT_ENVIRONMENT",
			previousActEnvironment
		);
	} else {
		Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
	}
});

type StudioHostRequest = Parameters<NonNullable<HostServices["appRequest"]>>[0];
const received: StudioHostRequest[] = [];
let respond: (input: StudioHostRequest) => unknown = () => null;

beforeEach(() => {
	received.length = 0;
	Object.defineProperty(window, "ryu", {
		configurable: true,
		value: {
			app: {
				request: async (input: StudioHostRequest) => {
					received.push(input);
					return await respond(input);
				},
			},
		},
	});
});

/** Timers that fire only when the test calls `fire`. */
function manualTimers() {
	const pending = new Map<number, () => void>();
	let nextId = 1;
	const scheduler: AutosaveScheduler = {
		clearTimeout: (handle) => {
			pending.delete(handle as number);
		},
		setTimeout: (run) => {
			const id = nextId++;
			pending.set(id, run);
			return id;
		},
	};
	return {
		fire() {
			const runs = [...pending.values()];
			pending.clear();
			for (const run of runs) {
				run();
			}
		},
		scheduler,
	};
}

async function mount() {
	const { project } = testProject();
	const runtime = createTestRuntime(project);
	runtime.setProject = (update) => {
		runtime.project =
			typeof update === "function" ? update(runtime.project) : update;
	};
	const timers = manualTimers();
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	const draw = async () => {
		await act(async () => {
			root.render(
				<EditorProvider value={{ ...runtime }}>
					<AutosaveProvider timing={{ scheduler: timers.scheduler }}>
						<div data-toolbar="">
							<AutosaveIndicator />
						</div>
						<div data-banner="">
							<AutosaveConflictBanner />
						</div>
					</AutosaveProvider>
				</EditorProvider>
			);
		});
	};
	await draw();
	const chip = () =>
		host
			.querySelector("[data-autosave-status]")
			?.getAttribute("data-autosave-status");
	const settle = async () => {
		await act(async () => {
			for (let index = 0; index < 10; index++) {
				await Promise.resolve();
			}
		});
		await draw();
	};
	return { chip, draw, host, project, root, runtime, settle, timers };
}

describe("AutosaveIndicator", () => {
	test("registers its autosave for manual saves while mounted", async () => {
		const view = await mount();
		expect(autosaveFor(view.runtime.store)).toBeDefined();
		await act(async () => {
			view.root.unmount();
		});
		expect(autosaveFor(view.runtime.store)).toBeUndefined();
	});

	test("an edit is saved after the quiet time without pressing save", async () => {
		const view = await mount();
		expect(view.chip()).toBe("saved");
		view.runtime.edit({ ...view.project, title: "Autosaved title" }, "Rename");
		await view.draw();
		expect(view.chip()).toBe("unsaved");
		expect(received).toHaveLength(0);
		respond = (input) => ({
			...(input.body as object),
			revision: view.project.revision + 1,
		});
		await act(async () => {
			view.timers.fire();
		});
		await view.settle();
		expect(received).toHaveLength(1);
		expect(received[0]).toMatchObject({
			body: { title: "Autosaved title" },
			method: "PUT",
			path: `/projects/${view.project.id}`,
		});
		expect(view.runtime.dirty).toBe(false);
		expect(view.chip()).toBe("saved");
		await act(async () => {
			view.root.unmount();
		});
	});

	test("hiding the page saves pending edits immediately", async () => {
		const view = await mount();
		view.runtime.edit({ ...view.project, title: "Hidden" }, "Rename");
		await view.draw();
		respond = (input) => ({
			...(input.body as object),
			revision: view.project.revision + 1,
		});
		Object.defineProperty(document, "visibilityState", {
			configurable: true,
			value: "hidden",
		});
		await act(async () => {
			document.dispatchEvent(new Event("visibilitychange"));
		});
		await view.settle();
		Reflect.deleteProperty(document, "visibilityState");
		expect(received.map((input) => input.method)).toEqual(["PUT"]);
		await act(async () => {
			view.root.unmount();
		});
	});

	test("leaving with unsaved edits asks for confirmation", async () => {
		const view = await mount();
		const clean = new Event("beforeunload", { cancelable: true });
		await act(async () => {
			window.dispatchEvent(clean);
		});
		expect(clean.defaultPrevented).toBe(false);
		view.runtime.edit({ ...view.project, title: "Dirty" }, "Rename");
		await view.draw();
		respond = () => new Promise(() => undefined);
		const dirty = new Event("beforeunload", { cancelable: true });
		await act(async () => {
			window.dispatchEvent(dirty);
		});
		expect(dirty.defaultPrevented).toBe(true);
		await act(async () => {
			view.root.unmount();
		});
	});

	test("a conflict shows a reload banner that loads the latest revision", async () => {
		const view = await mount();
		view.runtime.edit({ ...view.project, title: "Mine" }, "Rename");
		await view.draw();
		respond = () => ({ code: "CONFLICT", message: "Changed elsewhere" });
		await act(async () => {
			view.timers.fire();
		});
		await view.settle();
		// Autosave first gives one of this editor's own saves time to land.
		expect(view.chip()).toBe("saving");
		await act(async () => {
			view.timers.fire();
		});
		await view.settle();
		expect(view.chip()).toBe("conflict");
		const banner = view.host.querySelector('[role="alert"]');
		expect(banner?.textContent).toContain("autosave paused");
		// The notice renders in the banner region, never inside the toolbar row.
		expect(view.host.querySelector('[data-toolbar] [role="alert"]')).toBeNull();
		expect(banner?.closest("[data-banner]")).not.toBeNull();
		const theirs = {
			...view.project,
			revision: view.project.revision + 3,
			title: "Theirs",
		};
		respond = () => theirs;
		const reload = [...view.host.querySelectorAll("button")].find(
			(button) => button.textContent === "Reload project"
		);
		await act(async () => {
			reload?.click();
		});
		await view.settle();
		expect(received.at(-1)).toMatchObject({
			method: "GET",
			path: `/projects/${view.project.id}`,
		});
		expect(view.runtime.project?.title).toBe("Theirs");
		expect(view.runtime.store.getState().history.past).toEqual([]);
		expect(view.chip()).toBe("saved");
		expect(view.host.querySelector('[role="alert"]')).toBeNull();
		await act(async () => {
			view.root.unmount();
		});
	});

	test("the conflict banner lists what both sides changed", async () => {
		const view = await mount();
		recordSavedBase(view.project);
		view.runtime.edit({ ...view.project, title: "Mine" }, "Rename");
		await view.draw();
		const theirs = {
			...view.project,
			revision: view.project.revision + 1,
			title: "Theirs",
		};
		respond = (input) =>
			input.method === "PUT"
				? { code: "CONFLICT", message: "Changed elsewhere" }
				: theirs;
		for (let round = 0; round < 3; round++) {
			await act(async () => {
				view.timers.fire();
			});
			await view.settle();
		}
		expect(view.chip()).toBe("conflict");
		const list = view.host.querySelector("[data-merge-conflicts]");
		expect(list?.textContent).toContain("Changed both here and elsewhere:");
		expect(list?.textContent).toContain(
			"Project: title changed here and elsewhere"
		);
		await act(async () => {
			view.root.unmount();
		});
	});
});
