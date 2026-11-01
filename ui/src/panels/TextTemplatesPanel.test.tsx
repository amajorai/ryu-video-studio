import { afterAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { ReactNode } from "react";

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
const { TEXT_TEMPLATES } = await import("../../../shared/text-templates.ts");
const { TextTemplatesPanel, placeTemplate, templatesByCategory } = await import(
	"./TextTemplatesPanel.tsx"
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

type Runtime = ReturnType<typeof createTestRuntime>;

async function render(runtime: Runtime, node: ReactNode) {
	const element = document.createElement("div");
	document.body.append(element);
	const root = createRoot(element);
	await act(async () => {
		root.render(<EditorProvider value={runtime}>{node}</EditorProvider>);
	});
	return {
		element,
		unmount: async () => {
			await act(async () => root.unmount());
			element.remove();
		},
	};
}

describe("text templates panel", () => {
	test("groups every template under its category", () => {
		const groups = templatesByCategory();
		expect(groups.flatMap(([, templates]) => templates)).toHaveLength(
			TEXT_TEMPLATES.length
		);
		expect(groups.map(([category]) => category)).toContain("lower-third");
	});

	test("placing reports errors instead of throwing", () => {
		const { asset, project } = testProject();
		const template = TEXT_TEMPLATES[0];
		if (!template) {
			throw new Error("no templates");
		}
		const placed = placeTemplate(project, [asset], template, 2, "Custom");
		expect("project" in placed && placed.project.titles[0]?.text).toBe(
			"Custom"
		);
		const broken = placeTemplate(
			project,
			[asset],
			{ ...template, id: "missing" },
			2,
			""
		);
		expect("error" in broken && broken.error).toContain("Unknown");
		const styled = placeTemplate(project, [asset], template, 2, "", {
			systemFont: "DejaVu Sans",
		});
		expect(
			"project" in styled &&
				styled.project.titles.every(
					(title) => title.systemFont === "DejaVu Sans"
				)
		).toBe(true);
	});

	test("Add places the template at the playhead as one undoable edit", async () => {
		const { asset, project } = testProject();
		const runtime = createTestRuntime(project, [asset]);
		runtime.time = 3;
		const view = await render(runtime, <TextTemplatesPanel />);
		const cards = view.element.querySelectorAll("[data-text-template]");
		expect(cards).toHaveLength(TEXT_TEMPLATES.length);
		const add = view.element.querySelector<HTMLButtonElement>(
			'[data-text-template="title-bold-pop"] button'
		);
		await act(async () => add?.click());
		expect(runtime.calls.some(([name]) => name === "edit")).toBe(true);
		expect(runtime.project?.titles).toHaveLength(1);
		expect(runtime.project?.titles[0]).toMatchObject({
			start: 3,
			templateId: "title-bold-pop",
		});
		await view.unmount();
	});
});
