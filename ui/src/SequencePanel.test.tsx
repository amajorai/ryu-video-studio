import { afterAll, afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { Root } from "react-dom/client";
import {
	type Asset,
	newProject,
	newSegment,
	type Project,
} from "../../shared/project.ts";

GlobalRegistrator.register();
// React must load after happy-dom so its input-event support check sees a DOM.
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const previousActEnvironment = Object.getOwnPropertyDescriptor(
	globalThis,
	"IS_REACT_ACT_ENVIRONMENT"
);
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
	value: true,
	configurable: true,
	writable: true,
});
const { SequencePanel } = await import("./SequencePanel.tsx");
const { EditorProvider } = await import("./editor/context.tsx");
const { createTestRuntime, testVideo } = await import(
	"./editor/test-runtime.ts"
);
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

const mounted: { container: HTMLElement; root: Root }[] = [];
afterEach(() => {
	for (const { container, root } of mounted.splice(0)) {
		act(() => root.unmount());
		container.remove();
	}
});

function setup(selected: "none" | "plain" | "sequence") {
	const camera = testVideo("camera.mp4", 10);
	const child = newProject("Nested intro");
	const sequence: Asset = {
		...testVideo("Sequence · Nested intro", 4),
		sequenceProjectId: child.id,
	};
	const plain = newSegment(camera, 0, 0);
	const nestedClip = newSegment(sequence, 12, 0);
	const project: Project = {
		...newProject("Parent"),
		segments: [plain, nestedClip],
	};
	const runtime = createTestRuntime(project, [camera, sequence]);
	runtime.projects = [project, child];
	const ids = { none: [], plain: [plain.id], sequence: [nestedClip.id] }[
		selected
	];
	runtime.selectedIds = ids;
	runtime.selectedId = ids[0] ?? null;
	const routed: [string, Record<string, unknown>][] = [];
	runtime.routeEdit = (action, body) => {
		routed.push([action, body]);
		return Promise.resolve({ extras: {}, status: "ok" });
	};
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	mounted.push({ container, root });
	act(() =>
		root.render(
			<EditorProvider value={runtime}>
				<SequencePanel
					busy={false}
					currentProjectId={project.id}
					onCreate={() => undefined}
					projects={runtime.projects}
				/>
			</EditorProvider>
		)
	);
	const button = (label: string) =>
		[...container.querySelectorAll("button")].find((item) =>
			item.textContent?.startsWith(label)
		);
	return { button, container, nestedClip, plain, routed };
}

test("nest and decompose follow the timeline selection", () => {
	const empty = setup("none");
	expect(empty.button("Nest")?.disabled).toBe(true);
	expect(empty.button("Decompose")?.disabled).toBe(true);
	expect(empty.button("Open nested")?.disabled).toBe(true);
	// Another project can still be added as a sequence clip.
	expect(empty.button("Add sequence clip")).toBeDefined();

	const plain = setup("plain");
	expect(plain.button("Nest")?.disabled).toBe(false);
	expect(plain.button("Decompose")?.disabled).toBe(true);

	const sequence = setup("sequence");
	expect(sequence.button("Decompose")?.disabled).toBe(false);
	expect(sequence.button("Open nested")?.disabled).toBe(false);
});

test("buttons route nest and decompose edits", async () => {
	const plain = setup("plain");
	const input = plain.container.querySelector("input");
	expect(input?.getAttribute("aria-label")).toBe("Nested sequence title");
	await act(async () => {
		plain.button("Nest")?.click();
		await Bun.sleep(0);
	});
	expect(plain.routed).toEqual([["nest", { clipIds: [plain.plain.id] }]]);

	const sequence = setup("sequence");
	await act(async () => {
		sequence.button("Decompose")?.click();
		await Bun.sleep(0);
	});
	expect(sequence.routed).toEqual([
		["decompose", { clipId: sequence.nestedClip.id }],
	]);
});
