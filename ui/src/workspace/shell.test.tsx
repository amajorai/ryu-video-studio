import { afterAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";

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
const { ClipInspector } = await import("../inspector/ClipInspector.tsx");
const { Timeline } = await import("../timeline/Timeline.tsx");
const { LIBRARY_TABS, PANEL_REGISTRY, libraryTabs, panelsFor } = await import(
	"../panels/registry.tsx"
);
const { WorkspaceLayout } = await import("./WorkspaceLayout.tsx");

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

type Runtime = ReturnType<typeof createTestRuntime>;

async function render(runtime: Runtime) {
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	const draw = async () => {
		await act(async () => {
			root.render(
				<EditorProvider value={{ ...runtime }}>
					<WorkspaceLayout
						busy={runtime.busy}
						inspector={<ClipInspector />}
						library={<aside className="studio-library" />}
						stage={<main className="studio-stage" />}
						timeline={<Timeline />}
					/>
				</EditorProvider>
			);
		});
	};
	await draw();
	return {
		draw,
		host,
		unmount: async () => {
			await act(async () => root.unmount());
			host.remove();
		},
	};
}

const buttonNamed = (host: HTMLElement, name: string | RegExp) =>
	[...host.querySelectorAll("button")].find((button) => {
		const label = button.getAttribute("aria-label") ?? button.textContent ?? "";
		return typeof name === "string" ? label === name : name.test(label);
	});

describe("editor shell", () => {
	test("renders the timeline, tracks, clips, and project settings", async () => {
		const { project } = testProject();
		const runtime = createTestRuntime(project, [testProject().asset]);
		const view = await render(runtime);
		expect(
			view.host.querySelector('section[aria-label="Video timeline"]')
		).not.toBeNull();
		expect(view.host.querySelectorAll(".studio-timeline-clip")).toHaveLength(2);
		expect(view.host.querySelector(".studio-workspace")).not.toBeNull();
		expect(view.host.textContent).toContain("Project settings");
		// Every toolbar action has a button, the snapping magnet included.
		for (const label of [
			"Razor tool",
			"Ripple trim start to playhead",
			"Ripple trim end to playhead",
			"Ripple mode",
			"Snapping",
			"Loop playback",
			"Preview guides",
			"Export range",
		]) {
			expect({
				found: buttonNamed(view.host, label) !== undefined,
				label,
			}).toEqual({
				found: true,
				label,
			});
		}
		await view.unmount();
	});

	test("clicking a clip selects it and the inspector shows its sections", async () => {
		const { asset, first, project } = testProject();
		const runtime = createTestRuntime(project, [asset]);
		const view = await render(runtime);
		const clip = buttonNamed(view.host, /^Select clip\.mp4 at 0\.00 seconds/);
		expect(clip).toBeDefined();
		await act(async () => {
			clip?.click();
		});
		runtime.refresh();
		expect(runtime.selectedId).toBe(first.id);
		await view.draw();
		expect(view.host.textContent).toContain("Clip inspector");
		for (const label of ["Timeline start", "Track", "Scale", "Exposure"]) {
			expect(view.host.querySelector(`[aria-label="${label}"]`)).not.toBeNull();
		}
		expect(view.host.textContent).toContain("Animation");
		await view.unmount();
	});

	test("timeline buttons run the same edits as their shortcuts", async () => {
		const { asset, first, project } = testProject();
		const runtime = createTestRuntime(project, [asset]);
		runtime.setSelected(first.id);
		runtime.time = 4;
		const view = await render(runtime);
		await act(async () => {
			buttonNamed(view.host, "Split at playhead")?.click();
		});
		expect(runtime.project?.segments).toHaveLength(3);
		await view.draw();
		await act(async () => {
			buttonNamed(view.host, "Undo")?.click();
		});
		expect(runtime.project?.segments).toHaveLength(2);
		await view.unmount();
	});

	test("toolbar buttons run their actions and show their toggle state", async () => {
		const { asset, project } = testProject();
		const runtime = createTestRuntime(project, [asset]);
		const view = await render(runtime);
		const magnet = buttonNamed(view.host, "Snapping");
		expect(magnet?.getAttribute("aria-pressed")).toBe("true");
		expect(magnet?.getAttribute("title")).toBe("Snapping (N)");
		await act(async () => {
			magnet?.click();
		});
		expect(runtime.store.getState().snapEnabled).toBe(false);
		await view.draw();
		expect(
			buttonNamed(view.host, "Snapping")?.getAttribute("aria-pressed")
		).toBe("false");
		await act(async () => {
			buttonNamed(view.host, "Razor tool")?.click();
		});
		expect(runtime.store.getState().tool).toBe("razor");
		await view.unmount();
	});
});

/** Panels with real content; every other registry entry is a planned stub. */
const SHIPPED_PANELS = new Set([
	"adjustment-layers",
	"auto-cut",
	"background",
	"caption-style",
	"export",
	"history",
	"looks",
	"markers",
	"mixer",
	"projects",
	"recorder",
	"reframe",
	"script-to-video",
	"speakers",
	"stickers",
	"templates",
	"text-templates",
	"timeline-transcript",
	"tracking",
]);

describe("panel registry", () => {
	test("panels mount under their home category or their own tab", () => {
		// Planned panels have no tab and render nothing; shipped panels that
		// declare a tab (e.g. Looks, Record) append it after the built-in tabs
		// in registry order. Panel bodies use editor hooks once they ship, so
		// only their homes are checked here; each panel's own test covers its
		// content.
		const shipped = PANEL_REGISTRY.flatMap((entry) =>
			entry.tab ? [{ id: entry.id, tab: entry.tab }] : []
		);
		expect(libraryTabs()).toEqual([
			...LIBRARY_TABS,
			...shipped.map((entry) => entry.tab),
		]);
		expect(shipped.map((entry) => entry.id)).toEqual(
			expect.arrayContaining(["history", "looks", "markers", "projects"])
		);
		const values = new Set(LIBRARY_TABS.map((tab) => tab.value));
		for (const entry of PANEL_REGISTRY) {
			expect(values.has(entry.home)).toBe(true);
		}
		expect(shipped.find((entry) => entry.tab.value === "record")?.tab).toEqual({
			label: "Record",
			value: "record",
		});
		expect(panelsFor("looks").map((entry) => entry.id)).toEqual(["looks"]);
		expect(panelsFor("exports").map((entry) => entry.id)).toContain("export");
	});

	test("every registered panel renders inside the editor", () => {
		// Panels are real components (they may call hooks), so render each one
		// in the editor context instead of calling it as a function.
		const { asset, project } = testProject();
		const runtime = createTestRuntime(project, [asset]);
		for (const { Component, id } of PANEL_REGISTRY) {
			const markup = renderToStaticMarkup(
				<EditorProvider value={{ ...runtime }}>
					<Component />
				</EditorProvider>
			);
			// Planned panels render nothing until they ship; shipped panels
			// render content in their home or tab.
			expect({ empty: markup === "", id }).toEqual({
				empty: !SHIPPED_PANELS.has(id),
				id,
			});
		}
		const looks = PANEL_REGISTRY.find((entry) => entry.id === "looks");
		if (!looks) {
			throw new Error("The Looks panel is not registered.");
		}
		const markup = renderToStaticMarkup(
			<EditorProvider value={{ ...runtime }}>
				<looks.Component />
			</EditorProvider>
		);
		expect(markup).toContain("Warm film");
	});

	test("a panel that declares a tab moves out of its home category", () => {
		const registry = [
			{
				Component: () => null,
				home: "exports",
				id: "markers",
				tab: { label: "Markers", value: "markers" },
			},
		];
		expect(libraryTabs(registry).at(-1)).toEqual({
			label: "Markers",
			value: "markers",
		});
		expect(panelsFor("exports", registry)).toEqual([]);
		expect(panelsFor("markers", registry)).toHaveLength(1);
	});
});
