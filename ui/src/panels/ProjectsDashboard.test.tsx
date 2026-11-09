import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { newProject, type Project } from "../../../shared/project.ts";
import type { ProjectSummary } from "../../../shared/project-summary.ts";

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
const { createTestRuntime, lastStatus } = await import(
	"../editor/test-runtime.ts"
);
const { ProjectsDashboard } = await import("./ProjectsDashboard.tsx");
const { ProjectTabs } = await import("../projects/ProjectTabs.tsx");
const { reloadProjectTabs } = await import("../projects/project-tabs-model.ts");

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

afterEach(() => {
	localStorage.clear();
	reloadProjectTabs();
	Reflect.deleteProperty(window, "ryu");
});

interface Call {
	body?: unknown;
	method: string;
	path: string;
}

function project(title: string, updatedAt: string, revision = 0): Project {
	return { ...newProject(title), revision, updatedAt };
}

function summaryOf(item: Project, createdAt: string): ProjectSummary {
	return {
		createdAt,
		duration: 12,
		height: item.height,
		id: item.id,
		posterUrl: `/projects/${item.id}/poster`,
		revision: item.revision,
		segmentCount: 2,
		title: item.title,
		updatedAt: item.updatedAt,
		width: item.width,
	};
}

/** Stub the host bridge with an in-memory sidecar for the dashboard routes. */
function installSidecar(
	library: Project[],
	created: Record<string, string>,
	refuse: Record<string, { code: string; message: string }> = {}
) {
	const calls: Call[] = [];
	const projects = new Map(library.map((item) => [item.id, item]));
	const requestStub = (input: Call) => {
		calls.push(input);
		const { method = "GET", path } = input;
		if (path === "/project-summaries") {
			return Promise.resolve({
				projects: [...projects.values()].map((item) =>
					summaryOf(item, created[item.id] ?? item.updatedAt)
				),
			});
		}
		const poster = path.match(/^\/projects\/([^/]+)\/poster$/);
		if (poster) {
			return Promise.resolve({ code: "NO_POSTER", message: "No poster." });
		}
		const removal = path.match(/^\/projects\/([^/]+)\/delete\?revision=(\d+)$/);
		if (removal && method === "DELETE") {
			const [, id = "", revision] = removal;
			const refusal = refuse[id];
			if (refusal) {
				return Promise.resolve(refusal);
			}
			const item = projects.get(id);
			if (!item || item.revision !== Number(revision)) {
				return Promise.resolve({ code: "CONFLICT", message: "Stale." });
			}
			projects.delete(id);
			return Promise.resolve({
				deleted: { id, jobIds: [], title: item.title },
			});
		}
		const single = path.match(/^\/projects\/([^/?]+)$/);
		if (single) {
			const item = projects.get(single[1] ?? "");
			if (method === "PUT" && item) {
				const saved = {
					...(input.body as Project),
					revision: item.revision + 1,
				};
				projects.set(saved.id, saved);
				return Promise.resolve(saved);
			}
			return Promise.resolve(
				item ?? { code: "INVALID_REQUEST", message: "Project not found." }
			);
		}
		return Promise.resolve({ code: "NOT_FOUND", message: path });
	};
	Object.defineProperty(window, "ryu", {
		configurable: true,
		value: { app: { request: requestStub } },
		writable: true,
	});
	return { calls, projects };
}

async function flush() {
	for (let index = 0; index < 6; index++) {
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
	}
}

async function mount(runtime: ReturnType<typeof createTestRuntime>) {
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	await act(async () => {
		root.render(
			<EditorProvider value={{ ...runtime }}>
				{/* App mounts the open-project strip under its toolbar. */}
				<ProjectTabs />
				<ProjectsDashboard />
			</EditorProvider>
		);
	});
	await flush();
	return {
		host,
		titles: () =>
			[
				...host.querySelectorAll<HTMLElement>(
					'[aria-label="Projects"] li [data-project-title]'
				),
			].map((node) => node.textContent),
		unmount: async () => {
			await act(async () => root.unmount());
			host.remove();
		},
	};
}

function button(scope: ParentNode, label: string): HTMLButtonElement {
	const match = [...scope.querySelectorAll("button")].find(
		(node) => node.textContent?.trim() === label
	);
	if (!match) {
		throw new Error(`Missing button ${label}.`);
	}
	return match;
}

function control<T extends Element>(scope: ParentNode, label: string): T {
	const element = scope.querySelector<T>(`[aria-label="${label}"]`);
	if (!element) {
		throw new Error(`Missing ${label}.`);
	}
	return element;
}

/** Set a form control's value so React's change tracking sees the edit. */
function setNativeValue(
	element: HTMLInputElement | HTMLSelectElement,
	value: string
) {
	const prototype = Object.getPrototypeOf(element) as object;
	Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(
		element,
		value
	);
}

async function click(element: HTMLElement) {
	await act(async () => {
		element.click();
	});
	await flush();
}

function fixture() {
	const alpha = project("Alpha cut", "2026-03-01T00:00:00.000Z", 2);
	const beta = project("Beta trip", "2026-03-05T00:00:00.000Z", 1);
	const gamma = project("Gamma trip", "2026-03-03T00:00:00.000Z");
	const created = {
		[alpha.id]: "2026-02-10T00:00:00.000Z",
		[beta.id]: "2026-02-01T00:00:00.000Z",
		[gamma.id]: "2026-02-20T00:00:00.000Z",
	};
	return { alpha, beta, created, gamma };
}

describe("ProjectsDashboard", () => {
	test("lists, searches, and sorts summaries, remembering the sort", async () => {
		const { alpha, beta, created, gamma } = fixture();
		installSidecar([alpha, beta, gamma], created);
		const runtime = createTestRuntime(alpha);
		const view = await mount(runtime);
		expect(view.titles()).toEqual(["Beta trip", "Gamma trip", "Alpha cut"]);

		const search = control<HTMLInputElement>(view.host, "Search projects");
		await act(async () => {
			setNativeValue(search, "TRIP");
			search.dispatchEvent(new Event("input", { bubbles: true }));
		});
		expect(view.titles()).toEqual(["Beta trip", "Gamma trip"]);
		await act(async () => {
			setNativeValue(search, "");
			search.dispatchEvent(new Event("input", { bubbles: true }));
		});

		const sort = control<HTMLSelectElement>(view.host, "Sort projects");
		for (const [value, expected] of [
			["created", ["Gamma trip", "Alpha cut", "Beta trip"]],
			["title", ["Alpha cut", "Beta trip", "Gamma trip"]],
		] as const) {
			await act(async () => {
				setNativeValue(sort, value);
				sort.dispatchEvent(new Event("change", { bubbles: true }));
			});
			expect(view.titles()).toEqual([...expected]);
		}
		expect(
			JSON.parse(
				localStorage.getItem("ryu.video-studio.projects-dashboard") ?? "{}"
			)
		).toEqual({ sort: "title", view: "grid" });

		await click(button(view.host, "List"));
		expect(
			control<HTMLElement>(view.host, "Projects").getAttribute("data-view")
		).toBe("list");
		await view.unmount();
	});

	test("deletes several projects after confirmation", async () => {
		const { alpha, beta, created, gamma } = fixture();
		const sidecar = installSidecar([alpha, beta, gamma], created);
		const runtime = createTestRuntime(alpha);
		const view = await mount(runtime);
		for (const title of ["Beta trip", "Gamma trip"]) {
			await click(control<HTMLInputElement>(view.host, `Select ${title}`));
		}
		await click(button(view.host, "Delete selected"));
		const alert = view.host.querySelector('[role="alert"]');
		expect(alert?.textContent).toContain("Delete 2 projects?");
		expect(sidecar.calls.some((call) => call.method === "DELETE")).toBe(false);

		await click(button(view.host, "Delete permanently"));
		expect(
			sidecar.calls
				.filter((call) => call.method === "DELETE")
				.map((call) => call.path)
		).toEqual([
			`/projects/${beta.id}/delete?revision=1`,
			`/projects/${gamma.id}/delete?revision=0`,
		]);
		expect(view.titles()).toEqual(["Alpha cut"]);
		expect(lastStatus(runtime)).toBe("Deleted 2 projects.");
		expect(runtime.calls.some(([name]) => name === "setProject")).toBe(false);
		await view.unmount();
	});

	test("drops tabs of deleted projects instead of letting them fill the strip", async () => {
		const { alpha, beta, created, gamma } = fixture();
		installSidecar([alpha, beta, gamma], created);
		const dead = Array.from({ length: 6 }, () => crypto.randomUUID());
		localStorage.setItem(
			"ryu.video-studio.project-tabs",
			JSON.stringify([...dead.slice(0, 3), beta.id, ...dead.slice(3), gamma.id])
		);
		reloadProjectTabs();
		const runtime = createTestRuntime(alpha);
		runtime.projects = [alpha, beta, gamma];
		const view = await mount(runtime);
		const stored = () =>
			JSON.parse(localStorage.getItem("ryu.video-studio.project-tabs") ?? "[]");
		expect(stored()).toEqual([alpha.id, beta.id, gamma.id]);

		await click(control<HTMLInputElement>(view.host, "Select Beta trip"));
		await click(button(view.host, "Delete selected"));
		await click(button(view.host, "Delete permanently"));
		expect(stored()).toEqual([alpha.id, gamma.id]);
		const strip = control<HTMLElement>(view.host, "Open projects");
		expect(
			[...strip.querySelectorAll("[data-project-tab]")].map(
				(tab) => tab.textContent
			)
		).toEqual(["Alpha cut", "Gamma trip"]);
		await view.unmount();
	});

	test("cancel keeps every project", async () => {
		const { alpha, beta, created } = fixture();
		const sidecar = installSidecar([alpha, beta], created);
		const view = await mount(createTestRuntime(alpha));
		await click(control<HTMLInputElement>(view.host, "Select Beta trip"));
		await click(button(view.host, "Delete selected"));
		await click(button(view.host, "Cancel"));
		expect(view.host.querySelector('[role="alert"]')).toBeNull();
		expect(sidecar.calls.some((call) => call.method === "DELETE")).toBe(false);
		expect(view.titles()).toEqual(["Beta trip", "Alpha cut"]);
		await view.unmount();
	});

	test("deleting the open project opens another one", async () => {
		const { alpha, beta, created } = fixture();
		installSidecar([alpha, beta], created);
		const runtime = createTestRuntime(alpha);
		runtime.projects = [alpha, beta];
		// A range marked in Alpha must not scope edits or the agent in Beta.
		runtime.setRangeStart(2);
		runtime.setRangeEnd(5);
		runtime.setRangeMarked(true);
		const view = await mount(runtime);
		await click(control<HTMLInputElement>(view.host, "Select Alpha cut"));
		await click(button(view.host, "Delete selected"));
		await click(button(view.host, "Delete permanently"));
		const opened = runtime.calls.findLast(([name]) => name === "setProject");
		expect((opened?.[1] as Project | null)?.id).toBe(beta.id);
		expect(runtime.dirty).toBe(false);
		expect(runtime.rangeMarked).toBe(false);
		expect(runtime.range).toEqual({ end: 1, start: 0 });
		expect(lastStatus(runtime)).toBe("Deleted 1 project.");
		await view.unmount();
	});

	test("reports a refused delete and keeps that project", async () => {
		const { alpha, beta, created } = fixture();
		installSidecar([alpha, beta], created, {
			[beta.id]: { code: "RENDER_ACTIVE", message: "An export is running." },
		});
		const runtime = createTestRuntime(alpha);
		const view = await mount(runtime);
		await click(control<HTMLInputElement>(view.host, "Select Beta trip"));
		await click(button(view.host, "Delete selected"));
		await click(button(view.host, "Delete permanently"));
		expect(view.titles()).toEqual(["Beta trip", "Alpha cut"]);
		expect(lastStatus(runtime)).toBe(
			'Deleted 0 projects. "Beta trip": An export is running.'
		);
		await view.unmount();
	});

	test("renames a project that is not open with a revision-checked save", async () => {
		const { alpha, beta, created } = fixture();
		const sidecar = installSidecar([alpha, beta], created);
		const runtime = createTestRuntime(alpha);
		const view = await mount(runtime);
		const card = view.host.querySelector(`[data-project-id="${beta.id}"]`);
		if (!(card instanceof HTMLElement)) {
			throw new Error("Missing card.");
		}
		await click(button(card, "Rename"));
		const field = control<HTMLInputElement>(card, "New title for Beta trip");
		await act(async () => {
			setNativeValue(field, "Beta final");
			field.dispatchEvent(new Event("input", { bubbles: true }));
		});
		await click(button(card, "Save"));
		const put = sidecar.calls.find((call) => call.method === "PUT");
		expect(put?.path).toBe(`/projects/${beta.id}`);
		expect((put?.body as Project).title).toBe("Beta final");
		expect((put?.body as Project).revision).toBe(1);
		expect(lastStatus(runtime)).toBe('Renamed to "Beta final".');
		await view.unmount();
	});

	test("renaming the open project is an undoable edit", async () => {
		const { alpha, created } = fixture();
		const sidecar = installSidecar([alpha], created);
		const runtime = createTestRuntime(alpha);
		const view = await mount(runtime);
		await click(button(view.host, "Rename"));
		const field = control<HTMLInputElement>(
			view.host,
			"New title for Alpha cut"
		);
		await act(async () => {
			setNativeValue(field, "Alpha v2");
			field.dispatchEvent(new Event("input", { bubbles: true }));
		});
		await click(button(view.host, "Save"));
		expect(runtime.project?.title).toBe("Alpha v2");
		expect(runtime.store.getState().history.past.at(-1)?.label).toBe(
			"Rename project"
		);
		expect(sidecar.calls.some((call) => call.method === "PUT")).toBe(false);
		await view.unmount();
	});

	test("shows project info and the open-project tab strip", async () => {
		const { alpha, beta, created } = fixture();
		installSidecar([alpha, beta], created);
		const runtime = createTestRuntime(alpha);
		runtime.projects = [alpha, beta];
		const view = await mount(runtime);
		const card = view.host.querySelector(`[data-project-id="${beta.id}"]`);
		if (!(card instanceof HTMLElement)) {
			throw new Error("Missing card.");
		}
		await click(button(card, "Info"));
		const info = control<HTMLElement>(view.host, "About Beta trip");
		expect(info.textContent).toContain("0:12");
		expect(info.textContent).toContain("Revision1");
		const tabs = control<HTMLElement>(view.host, "Open projects");
		expect(tabs.tagName).toBe("NAV");
		expect(tabs.querySelector('[role="tab"], [role="tablist"]')).toBeNull();
		const entries = [...tabs.querySelectorAll("[data-project-tab]")];
		expect(entries.map((tab) => tab.textContent)).toEqual(["Alpha cut"]);
		expect(entries[0]?.getAttribute("aria-current")).toBe("true");
		expect(
			JSON.parse(localStorage.getItem("ryu.video-studio.project-tabs") ?? "[]")
		).toEqual([alpha.id]);
		await view.unmount();
	});
});
