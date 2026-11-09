import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
	type Asset,
	newProject,
	newSegment,
	type Project,
	type Segment,
} from "../../../../shared/project.ts";

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
const { EditorProvider } = await import("../../editor/context.tsx");
const { createTestRuntime, lastStatus } = await import(
	"../../editor/test-runtime.ts"
);
const { TransitionSection } = await import("./TransitionSection.tsx");
const roots: { unmount: () => void }[] = [];
afterEach(async () => {
	await act(async () => {
		for (const root of roots.splice(0)) {
			root.unmount();
		}
	});
	document.body.innerHTML = "";
});
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

const video: Asset = {
	createdAt: "2026-01-01T00:00:00.000Z",
	duration: 10,
	hasAudio: false,
	height: 1080,
	id: "00000000-0000-4000-8000-000000000001",
	kind: "video",
	name: "Clip",
	width: 1920,
};

function cutProject(): {
	incoming: Segment;
	outgoing: Segment;
	project: Project;
} {
	const outgoing = { ...newSegment(video, 0), sourceOut: 4 };
	const incoming = { ...newSegment(video, 4), sourceIn: 3, sourceOut: 7 };
	return {
		incoming,
		outgoing,
		project: { ...newProject("Cut"), segments: [outgoing, incoming] },
	};
}

async function renderSection(project: Project, segment: Segment) {
	const runtime = createTestRuntime(project, [video]);
	const patches: Partial<Segment>[] = [];
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	roots.push(root);
	await act(async () => {
		root.render(
			<EditorProvider value={runtime}>
				<TransitionSection
					isAudio={false}
					onChange={(patch) => patches.push(patch)}
					segment={segment}
					visualControls
				/>
			</EditorProvider>
		);
	});
	return { container, patches, runtime };
}

const tile = (container: HTMLElement, label: string) =>
	container.querySelector<HTMLButtonElement>(`button[title="${label}"]`);
const select = (container: HTMLElement, label: string) =>
	container.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`);

async function choose(element: HTMLSelectElement | null, value: string) {
	await act(async () => {
		if (element) {
			element.value = value;
			element.dispatchEvent(new Event("change", { bubbles: true }));
		}
	});
}

describe("TransitionSection", () => {
	test("picking a gallery tile applies the transition to the cut as one edit", async () => {
		const { incoming, project } = cutProject();
		const { container, runtime } = await renderSection(project, incoming);
		const tiles = container.querySelectorAll(
			".studio-transition-gallery__tile"
		);
		expect(tiles).toHaveLength(24);
		await act(async () => {
			tile(container, "Wipe from left")?.click();
		});
		const next = runtime.project?.segments.find((s) => s.id === incoming.id);
		expect(next?.transitionIn).toEqual({
			duration: 0.5,
			softness: 0.1,
			type: "wipe-left",
		});
		expect(next?.start).toBe(3.5);
		expect(runtime.calls.filter(([name]) => name === "edit")).toEqual([
			["edit", "Transition: Wipe from left"],
		]);
	});

	test("a clip with no predecessor shows why the gallery is disabled", async () => {
		const { outgoing, project } = cutProject();
		const { container } = await renderSection(project, outgoing);
		expect(container.textContent).toContain(
			"Place this clip right after another clip"
		);
		expect(tile(container, "Dissolve")?.disabled).toBe(true);
	});

	test("refusals surface as a status instead of an edit", async () => {
		const { incoming, outgoing, project } = cutProject();
		const tight = {
			...project,
			segments: [
				{ ...outgoing, sourceIn: 6, sourceOut: 10 },
				{ ...incoming, sourceIn: 0, sourceOut: 4 },
			],
		};
		const { container, runtime } = await renderSection(
			tight,
			tight.segments[1] ?? incoming
		);
		await act(async () => {
			tile(container, "Dissolve")?.click();
		});
		expect(String(lastStatus(runtime))).toContain("extra media");
		expect(runtime.calls.some(([name]) => name === "edit")).toBe(false);
	});

	test("an applied transition can be removed", async () => {
		const { incoming, project } = cutProject();
		const withTransition = {
			...project,
			segments: [
				project.segments[0] ?? incoming,
				{
					...incoming,
					sourceIn: 2,
					start: 3,
					transitionIn: { duration: 1, softness: 0.1, type: "iris" as const },
				},
			],
		};
		const { container, runtime } = await renderSection(
			withTransition,
			withTransition.segments[1] ?? incoming
		);
		expect(
			tile(container, "Iris (diamond)")?.getAttribute("aria-pressed")
		).toBe("true");
		const remove = [...container.querySelectorAll("button")].find(
			(button) => button.textContent === "Remove transition"
		);
		await act(async () => {
			remove?.click();
		});
		const next = runtime.project?.segments.find((s) => s.id === incoming.id);
		expect(next && "transitionIn" in next).toBe(false);
	});

	test("exit and animation selects patch the clip", async () => {
		const { incoming, project } = cutProject();
		const { container, patches } = await renderSection(project, incoming);
		await choose(select(container, "Exit transition"), "slide-left");
		await choose(select(container, "In animation"), "pop");
		await choose(select(container, "Loop animation"), "wobble");
		expect(patches).toEqual([
			{ exitDuration: 0.5, exitTransition: "slide-left" },
			{ animation: { in: "pop" } },
			{ animation: { loop: "wobble" } },
		]);
	});

	test("clearing every move removes the animation field", async () => {
		const { incoming, project } = cutProject();
		const animated = {
			...incoming,
			animation: { in: "fade" as const, inDuration: 1 },
		};
		const { container, patches } = await renderSection(project, animated);
		await choose(select(container, "In animation"), "");
		expect(patches).toEqual([{ animation: undefined }]);
	});

	test("audio clips hide the section", async () => {
		const { incoming, project } = cutProject();
		const runtime = createTestRuntime(project, [video]);
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		roots.push(root);
		await act(async () => {
			root.render(
				<EditorProvider value={runtime}>
					<TransitionSection
						isAudio
						onChange={() => undefined}
						segment={incoming}
						visualControls={false}
					/>
				</EditorProvider>
			);
		});
		expect(container.innerHTML).toBe("");
	});
});
