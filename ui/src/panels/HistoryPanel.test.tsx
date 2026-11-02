import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { HostServices } from "@ryu/app-host/rpc";
import type { Project } from "../../../shared/project.ts";

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
const { EditorProvider } = await import("../editor/context.tsx");
const { createTestRuntime, testProject } = await import(
	"../editor/test-runtime.ts"
);
const { HistoryPanel, historyPanelTab, historyTime } = await import(
	"./HistoryPanel.tsx"
);
const { libraryTabs, panelsFor } = await import("./registry.tsx");

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
const savedSummary = {
	current: { revision: 2, updatedAt: "2026-03-04T10:00:00.000Z" },
	revisions: [
		{
			duration: 15,
			revision: 1,
			segmentCount: 2,
			title: "Runtime test",
			updatedAt: "2026-03-04T09:00:00.000Z",
		},
		{
			duration: 0,
			revision: 0,
			segmentCount: 0,
			title: "Runtime test",
			updatedAt: "2026-03-04T08:00:00.000Z",
		},
	],
};
let respond: (input: StudioHostRequest) => unknown = () => savedSummary;

beforeEach(() => {
	received.length = 0;
	respond = () => savedSummary;
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

async function mount() {
	const { project } = testProject();
	const runtime = createTestRuntime(project);
	runtime.setProject = (update) => {
		runtime.project =
			typeof update === "function" ? update(runtime.project) : update;
	};
	for (const title of ["one", "two"]) {
		runtime.edit({ ...(runtime.project as Project), title }, `Title ${title}`);
	}
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	const draw = async () => {
		await act(async () => {
			root.render(
				<EditorProvider value={{ ...runtime }}>
					<HistoryPanel />
				</EditorProvider>
			);
		});
	};
	await draw();
	const rows = () =>
		[...host.querySelectorAll("[data-history-index]")].map((row) => ({
			current: row.getAttribute("aria-current") === "step",
			index: Number(row.getAttribute("data-history-index")),
			text: row.textContent ?? "",
		}));
	return { draw, host, project, root, rows, runtime };
}

describe("HistoryPanel", () => {
	test("registers its own History tab", () => {
		expect(historyPanelTab).toEqual({ label: "History", value: "history" });
		expect(libraryTabs().some((tab) => tab.value === "history")).toBe(true);
		expect(panelsFor("history").map((panel) => panel.id)).toEqual(["history"]);
	});

	test("lists labelled edits newest first and jumps to any of them", async () => {
		const view = await mount();
		expect(view.rows().map((row) => row.index)).toEqual([2, 1, 0]);
		expect(view.rows()[0]).toMatchObject({ current: true });
		expect(view.rows()[0]?.text).toContain("Title two");
		expect(view.rows()[2]?.text).toContain("Opened");
		const origin = view.host.querySelector<HTMLButtonElement>(
			'[data-history-index="0"]'
		);
		await act(async () => {
			origin?.click();
		});
		await view.draw();
		expect(view.runtime.project?.title).toBe(view.project.title);
		expect(view.rows().find((row) => row.current)?.index).toBe(0);
		expect(view.rows()[0]?.text).toContain("redo available");
		await act(async () => {
			view.root.unmount();
		});
	});

	test("lists saved revisions and restores one", async () => {
		const view = await mount();
		expect(received[0]).toEqual({
			method: "GET",
			path: `/projects/${view.project.id}/history?summary=1`,
		});
		const saved = [...view.host.querySelectorAll("[data-revision]")];
		expect(saved.map((row) => row.getAttribute("data-revision"))).toEqual([
			"1",
			"0",
		]);
		expect(saved[0]?.textContent).toContain("2 clips");
		const before = view.runtime.project as Project;
		const restored = { ...before, revision: before.revision + 1 };
		respond = () => restored;
		const restore = view.host.querySelector<HTMLButtonElement>(
			'[aria-label="Restore revision 0"]'
		);
		await act(async () => {
			restore?.click();
		});
		expect(received.at(-1)).toEqual({
			body: { historyRevision: 0, revision: before.revision },
			method: "POST",
			path: `/projects/${before.id}/history`,
		});
		await act(async () => {
			view.root.unmount();
		});
	});

	test("shows the load error when revisions cannot be read", async () => {
		respond = () => ({ code: "NOT_FOUND", message: "Project not found." });
		const view = await mount();
		expect(view.host.textContent).toContain("Project not found.");
		await act(async () => {
			view.root.unmount();
		});
	});

	test("asks for a project when none is open", async () => {
		const host = document.createElement("div");
		const root = createRoot(host);
		await act(async () => {
			root.render(
				<EditorProvider value={createTestRuntime(null)}>
					<HistoryPanel />
				</EditorProvider>
			);
		});
		expect(host.textContent).toContain("Open a project");
		await act(async () => {
			root.unmount();
		});
	});

	test("formats edit and save times, and names the session start", () => {
		expect(historyTime(null)).toBe("Start of this session");
		expect(historyTime("not a date")).toBe("");
		expect(historyTime(0)).not.toBe("");
	});

	test("adds the date to a save from another day, not to one from today", () => {
		const now = new Date(2026, 9, 14, 15, 0, 0);
		const today = new Date(2026, 9, 14, 10, 0, 0);
		const yesterday = new Date(2026, 9, 13, 10, 0, 0);
		const todayText = historyTime(today.toISOString(), now);
		const yesterdayText = historyTime(yesterday.toISOString(), now);
		expect(todayText).toBe(
			today.toLocaleTimeString(undefined, {
				hour: "2-digit",
				minute: "2-digit",
				second: "2-digit",
			})
		);
		expect(yesterdayText).not.toBe(todayText);
		expect(yesterdayText).toContain("2026");
		expect(yesterdayText).toContain("13");
		expect(historyTime(new Date(2025, 9, 14, 10).getTime(), now)).toContain(
			"2025"
		);
	});
});
