import { afterAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";

GlobalRegistrator.register();
const previousActEnvironment = Object.getOwnPropertyDescriptor(
	globalThis,
	"IS_REACT_ACT_ENVIRONMENT"
);
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
	configurable: true,
	value: true,
	writable: true,
});
const { EditorProvider } = await import("../editor/context.tsx");
const { createTestRuntime, testProject } = await import(
	"../editor/test-runtime.ts"
);
const { WorkspaceLayout } = await import("./WorkspaceLayout.tsx");
const { maximizePanelAction } = await import("./maximize.ts");
const { hasActionHandler } = await import("../shortcuts/registry.ts");
const { TOUR_STEPS } = await import("./tour-state.ts");
const { LAYOUT_PRESETS } = await import("./layout-presets.ts");

afterAll(() => {
	GlobalRegistrator.unregister();
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

type Area = Pick<Storage, "getItem" | "removeItem" | "setItem">;

function memoryArea(): Area {
	const data = new Map<string, string>();
	return {
		getItem: (key) => data.get(key) ?? null,
		removeItem: (key) => {
			data.delete(key);
		},
		setItem: (key, value) => {
			data.set(key, value);
		},
	};
}

function newRuntime() {
	const { asset, project } = testProject();
	return createTestRuntime(project, [asset]);
}

async function render(runtime: ReturnType<typeof newRuntime>, storage: Area) {
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	await act(async () => {
		root.render(
			<EditorProvider value={{ ...runtime }}>
				<WorkspaceLayout
					busy={false}
					inspector={<aside className="studio-inspector">Inspector</aside>}
					library={
						<aside className="studio-library">
							<button type="button">Library item</button>
						</aside>
					}
					stage={<main className="studio-stage">Stage</main>}
					storage={storage}
					timeline={<section className="studio-timeline">Timeline</section>}
				/>
			</EditorProvider>
		);
	});
	return {
		host,
		unmount: async () => {
			await act(async () => root.unmount());
			host.remove();
		},
	};
}

const button = (host: HTMLElement, label: string | RegExp) =>
	[...host.querySelectorAll("button")].find((candidate) => {
		const text =
			candidate.getAttribute("aria-label") ?? candidate.textContent ?? "";
		return typeof label === "string" ? text === label : label.test(text);
	});

const click = async (element: Element | undefined) => {
	if (!element) {
		throw new Error("Expected the control to be rendered.");
	}
	await act(async () => {
		(element as HTMLElement).click();
	});
};

/** Report a fixed `offsetWidth`/`offsetHeight` for every element; returns the undo. */
function withElementBox(size: number): () => void {
	const keys = ["offsetWidth", "offsetHeight"] as const;
	const previous = keys.map((key) =>
		Object.getOwnPropertyDescriptor(HTMLElement.prototype, key)
	);
	for (const key of keys) {
		Object.defineProperty(HTMLElement.prototype, key, {
			configurable: true,
			get: () => size,
		});
	}
	return () => {
		for (const [index, key] of keys.entries()) {
			const descriptor = previous[index];
			if (descriptor) {
				Object.defineProperty(HTMLElement.prototype, key, descriptor);
			} else {
				Reflect.deleteProperty(HTMLElement.prototype, key);
			}
		}
	};
}

const panel = (host: HTMLElement, id: string) =>
	host.querySelector(`[data-workspace-panel="${id}"]`);

describe("workspace layout", () => {
	test("renders resizable library, stage, inspector, and timeline panels", async () => {
		const view = await render(newRuntime(), memoryArea());
		for (const id of ["library", "stage", "inspector", "timeline"]) {
			expect(panel(view.host, id)).not.toBeNull();
		}
		expect(view.host.querySelector(".studio-workspace")).not.toBeNull();
		expect(
			view.host.querySelectorAll('[data-slot="resizable-handle"]')
		).toHaveLength(3);
		await view.unmount();
	});

	test("a chosen preset persists across a reload", async () => {
		const storage = memoryArea();
		const first = await render(newRuntime(), storage);
		const select = first.host.querySelector<HTMLSelectElement>(
			'select[aria-label="Workspace layout"]'
		);
		expect(select?.value).toBe("edit");
		await act(async () => {
			if (select) {
				select.value = "audio";
				select.dispatchEvent(new Event("change", { bubbles: true }));
			}
		});
		await first.unmount();
		const second = await render(newRuntime(), storage);
		expect(
			second.host.querySelector<HTMLSelectElement>(
				'select[aria-label="Workspace layout"]'
			)?.value
		).toBe("audio");
		const stored = JSON.parse(
			storage.getItem("ryu.video-studio.workspace.layout") ?? "{}"
		);
		expect(stored.sizes).toEqual(LAYOUT_PRESETS.audio.sizes);
		await click(button(second.host, "Save current layout"));
		expect(
			[
				...second.host.querySelectorAll<HTMLOptionElement>(
					'select[aria-label="Workspace layout"] option'
				),
			].map((option) => option.textContent)
		).toContain("My layout");
		await second.unmount();
	});

	test("every preset reaches the splitters in DOM order and stays selected", async () => {
		// The splitter defers layouts until its group has a size, which
		// happy-dom never reports; give every element a box so `setLayout` runs
		// its real constraint checks (they compare by DOM position).
		const restore = withElementBox(800);
		const storage = memoryArea();
		const view = await render(newRuntime(), storage);
		const select = () =>
			view.host.querySelector<HTMLSelectElement>(
				'select[aria-label="Workspace layout"]'
			);
		const grow = (id: string) =>
			Number.parseFloat(
				view.host.querySelector<HTMLElement>(`#studio-${id}-panel`)?.style
					.flexGrow ?? "NaN"
			);
		for (const id of ["review", "color", "audio", "edit"] as const) {
			await act(async () => {
				const element = select();
				if (element) {
					element.value = id;
					element.dispatchEvent(new Event("change", { bubbles: true }));
				}
			});
			expect(select()?.value).toBe(id);
			const { sizes } = LAYOUT_PRESETS[id];
			for (const [panelId, share] of Object.entries({
				...sizes.columns,
				...sizes.rows,
			})) {
				expect(grow(panelId)).toBeCloseTo(share, 0);
			}
			const stored = JSON.parse(
				storage.getItem("ryu.video-studio.workspace.layout") ?? "{}"
			);
			expect(stored.choice).toBe(id);
			expect(stored.sizes).toEqual(sizes);
		}
		await view.unmount();
		restore();
	});

	test("maximize hides the other panels and toggles back", async () => {
		const runtime = newRuntime();
		const view = await render(runtime, memoryArea());
		const libraryButton = button(view.host, "Library item");
		await act(async () => {
			libraryButton?.focus();
		});
		await click(button(view.host, "Maximize library"));
		expect(runtime.store.getState().maximizedPanel).toBe("library");
		expect(
			panel(view.host, "library")?.hasAttribute("data-workspace-hidden")
		).toBe(false);
		for (const id of ["stage", "inspector", "timeline"]) {
			expect(panel(view.host, id)?.hasAttribute("data-workspace-hidden")).toBe(
				true
			);
		}
		await click(button(view.host, /^Restore panels/));
		expect(runtime.store.getState().maximizedPanel).toBeNull();
		expect(view.host.querySelector("[data-workspace-hidden]")).toBeNull();
		await view.unmount();
	});

	test("the backtick action maximizes the focused panel and restores", async () => {
		const runtime = newRuntime();
		const view = await render(runtime, memoryArea());
		const stage = panel(view.host, "stage");
		await act(async () => {
			maximizePanelAction(runtime, {
				altKey: false,
				code: "Backquote",
				ctrlKey: false,
				key: "`",
				metaKey: false,
				preventDefault: () => undefined,
				shiftKey: false,
				target: stage?.firstElementChild ?? null,
			});
		});
		expect(runtime.store.getState().maximizedPanel).toBe("stage");
		await act(async () => {
			maximizePanelAction(runtime);
		});
		expect(runtime.store.getState().maximizedPanel).toBeNull();
		if (!hasActionHandler("workspace.maximizePanel")) {
			// Until the registry handles it, the layout answers backtick itself.
			await act(async () => {
				window.dispatchEvent(
					new KeyboardEvent("keydown", { code: "Backquote", key: "`" })
				);
			});
			expect(runtime.store.getState().maximizedPanel).toBe("stage");
		}
		await view.unmount();
	});
});

describe("first-run tour", () => {
	test("opens once, walks six steps, and can be relaunched", async () => {
		const storage = memoryArea();
		const view = await render(newRuntime(), storage);
		const tour = () => view.host.querySelector(".studio-tour");
		expect(tour()?.textContent).toContain(TOUR_STEPS[0]?.title ?? "");
		expect(panel(view.host, "library")?.hasAttribute("data-tour-target")).toBe(
			true
		);
		const seen: string[] = [];
		while (tour()) {
			seen.push(tour()?.getAttribute("data-tour-step") ?? "");
			await click(button(view.host, /^(Next|Done)$/));
		}
		expect(seen).toEqual(TOUR_STEPS.map((step) => step.id));
		expect(storage.getItem("ryu.video-studio.workspace.tour")).toBe(
			JSON.stringify({ seen: true })
		);
		await view.unmount();

		const again = await render(newRuntime(), storage);
		expect(again.host.querySelector(".studio-tour")).toBeNull();
		await click(button(again.host, "Take the tour"));
		expect(again.host.querySelector(".studio-tour")).not.toBeNull();
		await click(button(again.host, "Skip tour"));
		expect(again.host.querySelector(".studio-tour")).toBeNull();
		await again.unmount();
	});

	test("Escape dismisses the tour from outside the card and remembers it", async () => {
		const storage = memoryArea();
		const view = await render(newRuntime(), storage);
		const outside = button(view.host, "Library item");
		await act(async () => {
			outside?.dispatchEvent(
				new KeyboardEvent("keydown", { bubbles: true, key: "Escape" })
			);
		});
		expect(view.host.querySelector(".studio-tour")).toBeNull();
		expect(storage.getItem("ryu.video-studio.workspace.tour")).not.toBeNull();
		await view.unmount();
	});

	test("Escape while typing leaves the tour open", async () => {
		const view = await render(newRuntime(), memoryArea());
		const input = document.createElement("input");
		view.host.append(input);
		await act(async () => {
			input.dispatchEvent(
				new KeyboardEvent("keydown", { bubbles: true, key: "Escape" })
			);
		});
		expect(view.host.querySelector(".studio-tour")).not.toBeNull();
		input.remove();
		await view.unmount();
	});
});

describe("phone width", () => {
	test("stacks panels without splitters or layout presets", async () => {
		const original = window.matchMedia;
		window.matchMedia = ((query: string) => ({
			addEventListener: () => undefined,
			matches: query.includes("max-width"),
			media: query,
			removeEventListener: () => undefined,
		})) as unknown as typeof window.matchMedia;
		try {
			const view = await render(newRuntime(), memoryArea());
			expect(
				view.host
					.querySelector(".studio-workspace-shell")
					?.hasAttribute("data-stacked")
			).toBe(true);
			expect(
				view.host.querySelector('[data-slot="resizable-handle"]')
			).toBeNull();
			expect(
				view.host.querySelector('select[aria-label="Workspace layout"]')
			).toBeNull();
			expect(panel(view.host, "stage")).not.toBeNull();
			expect(button(view.host, /^Maximize/)).toBeDefined();
			await view.unmount();
		} finally {
			window.matchMedia = original;
		}
	});
});
