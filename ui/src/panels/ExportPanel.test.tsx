import { afterAll, afterEach, describe, expect, test } from "bun:test";
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
const { exportActions, exportRange } = await import(
	"../editor/actions/export.ts"
);
const { ExportPanel, exportPanelTab } = await import("./ExportPanel.tsx");

const previousRyu = window.ryu;

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

afterEach(() => {
	window.ryu = previousRyu;
});

interface SentRequest {
	body?: unknown;
	method?: string;
	path: string;
}

const job = (projectId: string) => ({
	id: crypto.randomUUID(),
	progress: 0,
	projectId,
	revision: 0,
	status: "pending",
});

function bridge(
	projectId: string,
	capabilities: {
		encoders: Record<string, boolean>;
		renderer: boolean;
		x265TenBit: boolean;
	} = {
		encoders: { aac: true, libx264: true, "libvpx-vp9": true, libopus: true },
		renderer: true,
		x265TenBit: false,
	}
) {
	const requests: SentRequest[] = [];
	window.ryu = {
		app: {
			request: (input) => {
				requests.push({
					body: input.body,
					method: input.method,
					path: input.path,
				});
				return Promise.resolve(
					input.path === "/capabilities" ? capabilities : job(projectId)
				);
			},
		},
	};
	return requests;
}

function control<T extends Element>(
	host: HTMLElement,
	selector: string,
	type: new () => T
): T {
	const element = host.querySelector(selector);
	if (!(element instanceof type)) {
		throw new Error(`missing ${selector}`);
	}
	return element;
}

function button(host: HTMLElement, text: string): HTMLButtonElement {
	const match = [...host.querySelectorAll("button")].find(
		(item) => item.textContent === text
	);
	if (!match) {
		throw new Error(`missing button ${text}`);
	}
	return match;
}

async function choose(select: HTMLSelectElement, value: string) {
	await act(async () => {
		const setter = Object.getOwnPropertyDescriptor(
			HTMLSelectElement.prototype,
			"value"
		)?.set;
		setter?.call(select, value);
		select.dispatchEvent(new Event("change", { bubbles: true }));
	});
}

async function render() {
	const { project } = testProject();
	const runtime = createTestRuntime(project);
	runtime.refresh();
	const requests = bridge(project.id);
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	await act(async () => {
		root.render(
			<EditorProvider value={{ ...runtime }}>
				<ExportPanel />
			</EditorProvider>
		);
	});
	return {
		host,
		project,
		requests,
		runtime,
		unmount: async () => {
			await act(async () => root.unmount());
			host.remove();
		},
	};
}

describe("ExportPanel", () => {
	test("mounts in the Exports category", () => {
		expect(exportPanelTab).toBeNull();
	});

	test("previews the plan and posts the chosen format", async () => {
		const view = await render();
		expect(view.requests[0]?.path).toBe("/capabilities");
		expect(view.host.textContent).toContain("MP4 · H.264");
		await choose(
			control(
				view.host,
				'select[aria-label="Export format"]',
				HTMLSelectElement
			),
			"webm"
		);
		expect(view.host.textContent).toContain("WebM · VP9");
		expect(
			view.host.querySelector('select[aria-label="Export video codec"]')
		).toBeNull();
		await act(async () => {
			button(view.host, "Export").click();
		});
		const rendered = view.requests.find((entry) =>
			entry.path.endsWith("/render")
		);
		expect(rendered).toEqual({
			body: {
				overrides: { container: "webm" },
				revision: view.project.revision,
			},
			method: "POST",
			path: `/projects/${view.project.id}/render`,
		});
		expect(view.runtime.calls.map(([name]) => name)).toContain("registerJob");
		await view.unmount();
	});

	test("blocks formats the FFmpeg build cannot encode", async () => {
		const view = await render();
		await choose(
			control(
				view.host,
				'select[aria-label="Export video codec"]',
				HTMLSelectElement
			),
			"h265-10bit"
		);
		expect(view.host.querySelector('[role="alert"]')?.textContent).toBe(
			"Requires an FFmpeg build with libx265 (10-bit)."
		);
		expect(button(view.host, "Export").disabled).toBe(true);
		await view.unmount();
	});

	test("save as project default stores the export settings", async () => {
		const view = await render();
		await choose(
			control(
				view.host,
				'select[aria-label="Publish preset"]',
				HTMLSelectElement
			),
			"youtube-1080p"
		);
		await act(async () => {
			button(view.host, "Save as project default").click();
		});
		expect(view.runtime.project?.exportSettings).toEqual({
			container: "mp4",
			platformPreset: "youtube-1080p",
		});
		await view.unmount();
	});
});

describe("export actions", () => {
	test("export.range renders only the I/O range", async () => {
		const { project } = testProject();
		const runtime = createTestRuntime(project);
		const requests = bridge(project.id);
		runtime.range = { start: 1, end: 3.5 };
		await exportRange(runtime);
		expect(requests.at(-1)).toEqual({
			body: { range: { start: 1, end: 3.5 }, revision: project.revision },
			method: "POST",
			path: `/projects/${project.id}/render`,
		});
		expect(runtime.calls).toContainEqual(["setPanel", "exports"]);
	});

	test("export.range refuses an empty range and export.video keeps the empty body", async () => {
		const { project } = testProject();
		const runtime = createTestRuntime(project);
		const requests = bridge(project.id);
		runtime.range = { start: 2, end: 2 };
		exportActions["export.range"]?.(runtime);
		expect(requests).toEqual([]);
		exportActions["export.video"]?.(runtime);
		await Promise.resolve();
		await Promise.resolve();
		expect(requests.at(-1)).toEqual({
			body: undefined,
			method: "POST",
			path: `/projects/${project.id}/render`,
		});
	});

	test("an output resolution keeps the canvas aspect in the request", async () => {
		const view = await render();
		const select = control(
			view.host,
			'select[aria-label="Output resolution"]',
			HTMLSelectElement
		);
		expect(view.host.querySelector('input[aria-label="Output width"]')).toBe(
			null
		);
		const { height, width } = view.project;
		const shortSide = Math.min(width, height);
		const even = (value: number) => Math.round(value / 2) * 2;
		await choose(select, "720p");
		const expected =
			width >= height
				? { outputWidth: even((width * 720) / shortSide), outputHeight: 720 }
				: { outputWidth: 720, outputHeight: even((height * 720) / shortSide) };
		expect(view.host.textContent).toContain(
			`${expected.outputWidth} × ${expected.outputHeight}`
		);
		await choose(select, "custom");
		expect(
			control(view.host, 'input[aria-label="Output width"]', HTMLInputElement)
				.value
		).toBe(String(expected.outputWidth));
		await choose(select, "720p");
		await act(async () => {
			button(view.host, "Export").click();
		});
		const rendered = view.requests.find((entry) =>
			entry.path.endsWith("/render")
		);
		expect(rendered?.body).toEqual({
			overrides: expected,
			revision: view.project.revision,
		});
		await view.unmount();
	});
});
