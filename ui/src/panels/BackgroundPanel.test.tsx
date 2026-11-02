import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { ReactNode } from "react";
import {
	type Asset,
	newProject,
	newSegment,
	type Project,
	type Segment,
	segmentSchema,
} from "../../../shared/project.ts";
import type { TestRuntime } from "../editor/test-runtime.ts";

// Another file may have left happy-dom registered; only own what we start.
const ownsDom = !GlobalRegistrator.isRegistered;
if (ownsDom) {
	GlobalRegistrator.register();
}
const previousActEnvironment = Object.getOwnPropertyDescriptor(
	globalThis,
	"IS_REACT_ACT_ENVIRONMENT"
);
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
	value: true,
	configurable: true,
	writable: true,
});
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { EditorProvider } = await import("../editor/context.tsx");
const { createTestRuntime } = await import("../editor/test-runtime.ts");
const { BackgroundPanel, backgroundPanelTab } = await import(
	"./BackgroundPanel.tsx"
);
const { BackgroundSection } = await import(
	"../inspector/sections/BackgroundSection.tsx"
);
const { panelsFor } = await import("./registry.tsx");
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

const roots: ReturnType<typeof createRoot>[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) {
		act(() => root.unmount());
	}
	document.body.innerHTML = "";
});

const video: Asset = {
	createdAt: "2026-01-01T00:00:00.000Z",
	duration: 4,
	hasAudio: false,
	height: 1080,
	id: "00000000-0000-4000-8000-000000000001",
	kind: "video",
	name: "Clip",
	width: 1920,
};
const still: Asset = {
	...video,
	id: "00000000-0000-4000-8000-000000000002",
	kind: "image",
	name: "Poster",
};

async function mount(node: ReactNode) {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	roots.push(root);
	await act(async () => {
		root.render(node);
	});
	return { container, root };
}

async function renderPanel(project: Project, assets: Asset[] = []) {
	const runtime: TestRuntime = createTestRuntime(project, assets);
	const draw = () => (
		<EditorProvider value={runtime}>
			<BackgroundPanel />
		</EditorProvider>
	);
	const { container, root } = await mount(draw());
	const rerender = async () => {
		await act(async () => {
			root.render(draw());
		});
	};
	return { container, rerender, runtime };
}

const select = (container: HTMLElement, label: string) =>
	container.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`);

async function choose(container: HTMLElement, label: string, value: string) {
	const element = select(container, label);
	await act(async () => {
		if (element) {
			element.value = value;
			element.dispatchEvent(new Event("change", { bubbles: true }));
		}
	});
}

async function type(container: HTMLElement, label: string, value: string) {
	const input = container.querySelector<HTMLInputElement>(
		`input[aria-label="${label}"]`
	);
	await act(async () => {
		if (input) {
			input.value = value;
			input.dispatchEvent(new FocusEvent("blur", { bubbles: true }));
			input.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
		}
	});
}

describe("BackgroundPanel", () => {
	test("mounts inside the Graphics category", () => {
		expect(backgroundPanelTab).toBeNull();
		expect(panelsFor("graphics").map((entry) => entry.id)).toContain(
			"background"
		);
	});

	test("a legacy project shows the style color; images need media", async () => {
		const { container } = await renderPanel(newProject("Legacy"));
		const element = select(container, "Canvas background");
		expect(element?.value).toBe("none");
		expect([...(element?.options ?? [])].map((option) => option.value)).toEqual(
			["none", "color", "gradient", "blur", "image"]
		);
		const image = [...(element?.options ?? [])].find(
			(option) => option.value === "image"
		);
		expect(image?.disabled).toBe(true);
	});

	test("switching types records undoable edits and clearing restores the legacy project", async () => {
		const project = newProject("Edits");
		const { container, rerender, runtime } = await renderPanel(project, [
			video,
			still,
		]);
		await choose(container, "Canvas background", "gradient");
		expect(runtime.project?.background).toEqual({
			angle: 180,
			color: "#000000",
			color2: "#000000",
			type: "gradient",
		});
		await rerender();
		await type(container, "Canvas gradient angle (°)", "90");
		expect(runtime.project?.background).toMatchObject({ angle: 90 });
		await rerender();
		await choose(container, "Canvas background", "blur");
		await rerender();
		await type(container, "Canvas blur dim (%)", "40");
		expect(runtime.project?.background).toEqual({
			amount: 0.5,
			dim: 0.4,
			type: "blur",
		});
		await rerender();
		await choose(container, "Canvas background", "image");
		expect(runtime.project?.background).toEqual({
			assetId: video.id,
			type: "image",
		});
		await rerender();
		await choose(container, "Canvas background image", still.id);
		expect(runtime.project?.background).toEqual({
			assetId: still.id,
			type: "image",
		});
		await rerender();
		await choose(container, "Canvas background", "none");
		expect(JSON.stringify(runtime.project)).toBe(JSON.stringify(project));
		expect(runtime.calls.filter(([name]) => name === "edit")).toHaveLength(7);
	});
});

describe("BackgroundSection", () => {
	async function renderSection(
		segment: Segment,
		visualControls = true,
		isAudio = !visualControls
	) {
		const patches: Partial<Segment>[] = [];
		const { container } = await mount(
			<BackgroundSection
				isAudio={isAudio}
				onChange={(patch) => patches.push(patch)}
				segment={segment}
				visualControls={visualControls}
			/>
		);
		return { container, patches };
	}

	test("offers color, gradient, blur and image; Project clears the field", async () => {
		const segment = segmentSchema.parse({
			...newSegment(video),
			background: { color: "#123456", type: "color" },
			track: 1,
		});
		const { container, patches } = await renderSection(segment);
		const element = select(container, "Clip background");
		expect(element?.value).toBe("color");
		expect([...(element?.options ?? [])].map((option) => option.value)).toEqual(
			["none", "color", "gradient", "blur", "image"]
		);
		await choose(container, "Clip background", "blur");
		await choose(container, "Clip background", "none");
		expect(patches).toEqual([
			{ background: { amount: 0.5, dim: 0.2, type: "blur" } },
			{ background: undefined },
		]);
	});

	test("base-track clips mention the project blur fill", async () => {
		const { container } = await renderSection(newSegment(video));
		expect(container.textContent).toContain("project blur fill");
	});

	test("audio clips without a visualization hide the control", async () => {
		const { container } = await renderSection(newSegment(video), false);
		expect(select(container, "Clip background")).toBeNull();
	});

	test("visualized audio clips (waveforms) get no clip background", async () => {
		const { container } = await renderSection(newSegment(video), true, true);
		expect(select(container, "Clip background")).toBeNull();
	});

	test("masked base-track clips skip the project blur fill", async () => {
		const segment = {
			...newSegment(video),
			masks: [{ id: "m1" }],
		} as unknown as Segment;
		const { container } = await renderSection(segment);
		expect(container.textContent).not.toContain("project blur fill");
	});
});
