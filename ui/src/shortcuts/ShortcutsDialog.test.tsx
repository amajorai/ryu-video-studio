import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

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

const realAudioPreview = await import("../audio-preview.ts");
mock.module("../audio-preview.ts", () => ({
	...realAudioPreview,
	resumePreviewAudio: () => Promise.resolve(),
}));

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { ConnectedShortcutsDialog, ShortcutsDialog } = await import(
	"./ShortcutsDialog.tsx"
);
const { createShortcutStore } = await import("./shortcut-state.ts");
const { shortcutDialogActions, workspaceActions } = await import(
	"../editor/actions/workspace.ts"
);
const { createTestRuntime, testProject } = await import(
	"../editor/test-runtime.ts"
);

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

function memoryArea() {
	const values = new Map<string, string>();
	return {
		getItem: (key: string) => values.get(key) ?? null,
		removeItem: (key: string) => {
			values.delete(key);
		},
		setItem: (key: string, value: string) => {
			values.set(key, value);
		},
	};
}

const throwingArea = {
	getItem: () => {
		throw new Error("blocked");
	},
	removeItem: () => {
		throw new Error("blocked");
	},
	setItem: () => {
		throw new Error("blocked");
	},
};

const cleanups: (() => void)[] = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) {
		cleanup();
	}
});

type Store = ReturnType<typeof createShortcutStore>;

function mount(store: Store, onClose: () => void = () => undefined) {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	act(() => {
		root.render(
			<ShortcutsDialog
				isAvailable={() => true}
				onClose={onClose}
				open
				platform="other"
				store={store}
			/>
		);
	});
	cleanups.push(() => {
		act(() => root.unmount());
		container.remove();
	});
}

const row = (bindingId: string) => {
	const element = document.querySelector(`[data-binding-id="${bindingId}"]`);
	if (!element) {
		throw new Error(`No row for ${bindingId}`);
	}
	return element as HTMLElement;
};

const button = (scope: ParentNode, label: string) => {
	const match = [...scope.querySelectorAll("button")].find(
		(candidate) =>
			candidate.getAttribute("aria-label") === label ||
			candidate.textContent?.trim() === label
	);
	if (!match) {
		throw new Error(`No button "${label}"`);
	}
	return match as HTMLButtonElement;
};

const click = (element: HTMLElement) => {
	act(() => {
		element.click();
	});
};

function pressOnRecorder(init: KeyboardEventInit) {
	const recorder = document.activeElement as HTMLElement | null;
	if (!recorder?.textContent?.includes("Press keys")) {
		throw new Error("The recorder is not focused.");
	}
	act(() => {
		recorder.dispatchEvent(
			new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init })
		);
	});
}

const status = () =>
	document.querySelector('[role="status"]')?.textContent ?? "";

describe("ShortcutsDialog", () => {
	test("lists actions by category and filters by search", () => {
		mount(createShortcutStore(memoryArea()));
		const regions = [...document.querySelectorAll("section[aria-label]")].map(
			(section) => section.getAttribute("aria-label")
		);
		expect(regions.slice(0, 3)).toEqual(["Playback", "Navigation", "Edit"]);
		expect(row("split").textContent).toContain("Split selected clip");
		const search = document.querySelector(
			'input[type="search"]'
		) as HTMLInputElement;
		act(() => {
			const setValue = Object.getOwnPropertyDescriptor(
				HTMLInputElement.prototype,
				"value"
			)?.set;
			setValue?.call(search, "split selected");
			search.dispatchEvent(new Event("input", { bubbles: true }));
		});
		expect(document.querySelectorAll("[data-binding-id]").length).toBe(1);
		expect(row("split")).toBeTruthy();
	});

	test("recording a free chord rebinds the action and persists it", () => {
		const area = memoryArea();
		const store = createShortcutStore(area);
		mount(store);
		click(button(row("split"), "Change shortcut for Split selected clip"));
		pressOnRecorder({ code: "KeyX", key: "x" });
		expect(store.getState().overrides.split).toEqual([
			{ alt: false, cmd: false, key: "x", shift: false },
		]);
		expect(status()).toContain("Split selected clip is now X.");
		expect(row("split").textContent).toContain("Custom");
		// A reload (a new store over the same storage) keeps the binding.
		expect(createShortcutStore(area).getState().overrides.split).toHaveLength(
			1
		);
	});

	test("modifier-only presses keep recording and Escape cancels", () => {
		const store = createShortcutStore(memoryArea());
		mount(store);
		click(button(row("split"), "Add another shortcut for Split selected clip"));
		pressOnRecorder({ code: "ShiftLeft", key: "Shift", shiftKey: true });
		pressOnRecorder({ code: "Escape", key: "Escape" });
		expect(status()).toBe("Recording canceled.");
		expect(store.getState().overrides).toEqual({});
	});

	test("a clashing chord asks before reassigning it", () => {
		const store = createShortcutStore(memoryArea());
		mount(store);
		click(button(row("split"), "Change shortcut for Split selected clip"));
		pressOnRecorder({ code: "KeyD", key: "d" });
		const alert = document.querySelector('[role="alert"]');
		expect(alert?.textContent).toContain("D is already used by");
		expect(alert?.textContent).toContain("Duplicate");
		expect(alert?.querySelector("li")?.textContent).toMatch(/ loses D\.$/);
		expect(store.getState().overrides).toEqual({});
		click(button(alert as HTMLElement, "Reassign"));
		const { bindings } = store.getState();
		expect(bindings.find((binding) => binding.id === "split")?.keys).toEqual([
			{ alt: false, cmd: false, key: "d", shift: false },
		]);
		expect(
			bindings.find((binding) => binding.id === "duplicate")?.keys
		).toEqual([]);
		expect(document.querySelector('[role="alert"]')).toBeNull();
	});

	test("taking Shift+S says Split keeps S, and it does", () => {
		const store = createShortcutStore(memoryArea());
		mount(store);
		click(button(row("duplicate"), "Change shortcut for Duplicate clip"));
		pressOnRecorder({ code: "KeyS", key: "S", shiftKey: true });
		const alert = document.querySelector('[role="alert"]');
		expect(alert?.querySelector("li")?.textContent).toBe(
			"Split selected clip keeps S."
		);
		click(button(alert as HTMLElement, "Reassign"));
		expect(
			store.getState().bindings.find((binding) => binding.id === "split")?.keys
		).toEqual([{ cmd: false, key: "s", shift: false }]);
	});

	test("canceling the clash prompt keeps the existing shortcuts", () => {
		const store = createShortcutStore(memoryArea());
		mount(store);
		click(button(row("split"), "Change shortcut for Split selected clip"));
		pressOnRecorder({ code: "KeyD", key: "d" });
		click(
			button(document.querySelector('[role="alert"]') as HTMLElement, "Cancel")
		);
		expect(store.getState().overrides).toEqual({});
		expect(status()).toBe("Kept the existing shortcuts.");
	});

	test("reset one binding, then reset all after confirming", () => {
		const store = createShortcutStore(memoryArea());
		store.setOverrides({
			duplicate: [{ key: "e" }],
			split: [{ key: "x" }],
		});
		mount(store);
		click(button(row("split"), "Reset Split selected clip to its default"));
		expect(Object.keys(store.getState().overrides)).toEqual(["duplicate"]);
		click(button(document.body, "Reset all"));
		expect(document.body.textContent).toContain("Reset every shortcut?");
		const confirm = [...document.querySelectorAll("button")].filter(
			(candidate) => candidate.textContent === "Reset all"
		);
		click(confirm.at(-1) as HTMLButtonElement);
		expect(store.getState().overrides).toEqual({});
	});

	test("removing a chord unbinds it without touching other bindings", () => {
		const store = createShortcutStore(memoryArea());
		mount(store);
		click(button(row("split"), "Remove S from Split selected clip"));
		expect(store.getState().overrides).toEqual({ split: [] });
		expect(row("split").textContent).toContain("No shortcut");
	});

	test("blocked storage still applies changes for the session and says so", () => {
		const store = createShortcutStore(throwingArea);
		mount(store);
		click(button(row("split"), "Change shortcut for Split selected clip"));
		pressOnRecorder({ code: "KeyX", key: "x" });
		expect(store.getState().persisted).toBe(false);
		expect(
			store.getState().bindings.find((b) => b.id === "split")?.keys
		).toEqual([{ alt: false, cmd: false, key: "x", shift: false }]);
		expect(status()).toContain("isn't keeping preferences");
	});

	test("the printable reference lists bound shortcuts and returns to the list", () => {
		mount(createShortcutStore(memoryArea()));
		click(button(document.body, "Printable reference"));
		const sheet = document.querySelector(".studio-shortcuts-reference");
		expect(sheet?.textContent).toContain("Split selected clip");
		expect(sheet?.textContent).toContain("Ctrl+Z");
		click(button(document.body, "Back to shortcuts"));
		expect(document.querySelector(".studio-shortcuts-reference")).toBeNull();
		expect(row("split")).toBeTruthy();
	});

	test("the ? action opens the connected dialog and Done closes it", () => {
		const store = createShortcutStore(memoryArea());
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		act(() => {
			root.render(<ConnectedShortcutsDialog store={store} />);
		});
		cleanups.push(() => {
			act(() => root.unmount());
			container.remove();
		});
		expect(document.querySelector('[role="dialog"]')).toBeNull();
		act(() => {
			store.openDialog();
		});
		expect(document.querySelector('[role="dialog"]')).toBeTruthy();
		click(button(document.body, "Done"));
		expect(store.getState().dialogOpen).toBe(false);
	});
});

describe("workspace actions", () => {
	test("workspace.shortcuts opens the shared shortcut dialog", async () => {
		const { shortcutStore } = await import("./shortcut-state.ts");
		const runtime = createTestRuntime(testProject().project);
		shortcutStore.closeDialog();
		shortcutDialogActions["workspace.shortcuts"]?.(runtime);
		expect(shortcutStore.getState().dialogOpen).toBe(true);
		shortcutStore.closeDialog();
	});

	test("? is registered now that App mounts the dialog", () => {
		expect(workspaceActions["workspace.shortcuts"]).toBe(
			shortcutDialogActions["workspace.shortcuts"]
		);
	});
});
