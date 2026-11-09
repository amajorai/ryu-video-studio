import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";

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
// React DOM detects input-event support when it loads, so it loads after the DOM.
const { createRoot } = await import("react-dom/client");
const { newProject, newSegment } = await import("../../../shared/project.ts");
const { EditorProvider } = await import("../editor/context.tsx");
const { createTestRuntime, testVideo } = await import(
	"../editor/test-runtime.ts"
);
const { MediaMismatchPrompt, mediaMismatchText } = await import(
	"./MediaMismatchPrompt.tsx"
);
const { ProjectSettingsPanel } = await import("./ProjectSettingsPanel.tsx");

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

beforeEach(() => {
	localStorage.clear();
});

type Runtime = ReturnType<typeof createTestRuntime>;

async function render(runtime: Runtime, panel = false) {
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	await act(async () => {
		root.render(
			<EditorProvider value={{ ...runtime }}>
				{panel ? <ProjectSettingsPanel /> : <MediaMismatchPrompt />}
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

const buttonNamed = (host: HTMLElement, name: string) =>
	[...host.querySelectorAll("button")].find(
		(button) => button.textContent === name
	);

function firstClipRuntime(frameRate?: number) {
	const asset = {
		...testVideo("Drone.mov"),
		frameRate,
		height: 1080,
		width: 1440,
	};
	const project = {
		...newProject("Mismatch"),
		segments: [newSegment(asset, 0)],
	};
	const runtime = createTestRuntime(project, [asset]);
	const routed: [string, Record<string, unknown>][] = [];
	runtime.routeEdit = (action, body) => {
		routed.push([action, body]);
		return Promise.resolve({ extras: {}, status: "ok" as const });
	};
	return { asset, project, routed, runtime };
}

describe("media mismatch prompt", () => {
	test("offers to match a differing first clip through the match-media route", async () => {
		const { asset, routed, runtime } = firstClipRuntime(50);
		const view = await render(runtime);
		expect(view.host.textContent).toContain("Media settings differ");
		expect(view.host.textContent).toContain("1440×1080 at 50 fps");
		expect(view.host.textContent).toContain(
			"Matching sets the canvas to 1440×1080 and the rate to 50 fps."
		);
		await act(async () => {
			buttonNamed(view.host, "Match project to media")?.click();
		});
		expect(routed).toEqual([["match-media", { assetId: asset.id }]]);
		await view.unmount();
	});

	test("declining hides the prompt and is remembered per viewer", async () => {
		const { runtime } = firstClipRuntime(30);
		const view = await render(runtime);
		await act(async () => {
			buttonNamed(view.host, "Keep project settings")?.click();
		});
		expect(view.host.textContent).toBe("");
		await view.unmount();
		const again = await render(runtime);
		expect(again.host.textContent).toBe("");
		await again.unmount();
	});

	test("stays hidden for matching media and multi-clip timelines", async () => {
		const asset = { ...testVideo(), frameRate: 30, height: 1080, width: 1920 };
		const matching = createTestRuntime(
			{ ...newProject("Same"), segments: [newSegment(asset, 0)] },
			[asset]
		);
		const view = await render(matching);
		expect(view.host.textContent).toBe("");
		await view.unmount();
		const other = testVideo();
		const busy = createTestRuntime(
			{
				...newProject("Busy"),
				segments: [newSegment(other, 0), newSegment(other, 10)],
			},
			[other]
		);
		const second = await render(busy);
		expect(second.host.textContent).toBe("");
		await second.unmount();
	});

	test("text explains a rate the project cannot export yet", () => {
		const project = { ...newProject("Text"), height: 1080, width: 1920 };
		expect(
			mediaMismatchText(
				project,
				{ height: 1080, name: "Cam.mov", width: 1920 },
				{ assetId: "a", mediaFrameRate: 29.97, unsupportedFps: 29.97 }
			)
		).toBe(
			"“Cam.mov” is 1920×1080 at 29.97 fps; the project is 1920×1080 at 30 fps. Its 29.97 fps rate cannot be exported yet, so the project keeps its settings."
		);
	});
});

describe("project settings panel", () => {
	test("lists every frame rate and a custom canvas entry", async () => {
		const { runtime } = firstClipRuntime(50);
		runtime.project = { ...runtime.project!, height: 1080, width: 1440 };
		const view = await render(runtime, true);
		const options = [
			...view.host.querySelectorAll('[aria-label="Frame rate"] option'),
		].map((option) => option.textContent);
		expect(options).toHaveLength(10);
		expect(options).toContain("120 fps");
		expect(options.some((label) => label?.startsWith("29.97 fps (NTSC)"))).toBe(
			true
		);
		const format = view.host.querySelector<HTMLSelectElement>(
			'[aria-label="Output format"]'
		);
		expect(format?.value).toBe("1440x1080");
		expect(format?.textContent).toContain("Classic 4:3");
		for (const preset of ["4096x2160", "7680x4320", "1080x1350", "2560x1080"]) {
			expect(
				[...(format?.options ?? [])].map((option) => option.value)
			).toContain(preset);
		}
		expect(format?.textContent).toContain("Custom size…");
		await view.unmount();
	});

	test("a custom size shows width and height fields that save even edges", async () => {
		const { runtime } = firstClipRuntime();
		runtime.project = { ...runtime.project!, height: 700, width: 1000 };
		const view = await render(runtime, true);
		const format = view.host.querySelector<HTMLSelectElement>(
			'[aria-label="Output format"]'
		);
		expect(format?.value).toBe("custom");
		expect(format?.textContent).toContain("Custom · 1000×700");
		const width = [
			...view.host.querySelectorAll<HTMLInputElement>("input"),
		].find(
			(input) =>
				input
					.closest(".ryu-app-field, [data-slot='field'], label")
					?.textContent?.includes("Canvas width") ?? false
		);
		expect(width).toBeDefined();
		await act(async () => {
			Object.getOwnPropertyDescriptor(
				HTMLInputElement.prototype,
				"value"
			)?.set?.call(width, "4097");
			width?.dispatchEvent(new window.Event("input", { bubbles: true }));
			width?.dispatchEvent(
				new window.KeyboardEvent("keydown", { bubbles: true, key: "Enter" })
			);
		});
		expect(runtime.project?.width).toBe(4098);
		expect(runtime.project?.height).toBe(700);
		await view.unmount();
	});

	test("choosing Custom size from a preset reveals the fields", async () => {
		const { runtime } = firstClipRuntime();
		runtime.project = { ...runtime.project!, height: 1080, width: 1920 };
		const view = await render(runtime, true);
		expect(view.host.textContent).not.toContain("Canvas width");
		const format = view.host.querySelector<HTMLSelectElement>(
			'[aria-label="Output format"]'
		);
		await act(async () => {
			if (format) {
				format.value = "custom";
				format.dispatchEvent(new window.Event("change", { bubbles: true }));
			}
		});
		expect(view.host.textContent).toContain("Canvas width");
		expect(runtime.project?.width).toBe(1920);
		await view.unmount();
	});
});
