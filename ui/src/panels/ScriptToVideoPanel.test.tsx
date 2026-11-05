import { afterAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

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
const {
	ScriptToVideoPanel,
	assemblySummary,
	sceneStatusText,
	scriptToVideoPanelTab,
} = await import("./ScriptToVideoPanel.tsx");
const { PANEL_REGISTRY, panelsFor } = await import("./registry.tsx");

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

async function render(runtime: Runtime) {
	const element = document.createElement("div");
	document.body.append(element);
	const root = createRoot(element);
	await act(async () => {
		root.render(
			<EditorProvider value={runtime}>
				<ScriptToVideoPanel />
			</EditorProvider>
		);
	});
	return {
		element,
		unmount: async () => {
			await act(async () => root.unmount());
			element.remove();
		},
	};
}

const buttonNamed = (element: HTMLElement, name: string) =>
	[...element.querySelectorAll("button")].find(
		(button) => button.textContent?.trim() === name
	);

async function typeInto(element: HTMLElement, label: string, value: string) {
	const field = element.querySelector<HTMLTextAreaElement>(
		`textarea[aria-label="${label}"]`
	);
	if (!field) {
		throw new Error(`missing ${label}`);
	}
	await act(async () => {
		Object.getOwnPropertyDescriptor(
			HTMLTextAreaElement.prototype,
			"value"
		)?.set?.call(field, value);
		field.dispatchEvent(new window.Event("input", { bubbles: true }));
	});
}

describe("ScriptToVideoPanel", () => {
	test("mounts in the Plan tab", () => {
		expect(scriptToVideoPanelTab).toBeNull();
		expect(
			panelsFor("storyboard", PANEL_REGISTRY).map((entry) => entry.id)
		).toContain("script-to-video");
	});

	test("splits the script locally without a model and lists editable scenes", async () => {
		const runtime = createTestRuntime(testProject().project);
		const view = await render(runtime);
		expect(buttonNamed(view.element, "Split into scenes")?.disabled).toBe(true);
		await typeInto(
			view.element,
			"Script",
			"The harbor wakes before dawn.\n\nFishing boats head out to sea."
		);
		await act(async () => {
			buttonNamed(view.element, "Split into scenes")?.click();
		});
		const rows = view.element.querySelectorAll("[data-script-scene]");
		expect(rows).toHaveLength(2);
		const narration = view.element.querySelector<HTMLTextAreaElement>(
			'textarea[aria-label="Scene 2 narration"]'
		);
		expect(narration?.value).toBe("Fishing boats head out to sea.");
		const search = view.element.querySelector<HTMLInputElement>(
			'input[aria-label="Scene 1 stock search"]'
		);
		expect(search?.value).toBe("harbor wakes dawn");
		expect(buttonNamed(view.element, "Assemble timeline")?.disabled).toBe(true);
		expect(runtime.calls.at(-1)?.[1]).toContain("planned locally");
		await act(async () => {
			buttonNamed(view.element, "Remove")?.click();
		});
		expect(view.element.querySelectorAll("[data-script-scene]")).toHaveLength(
			1
		);
		await view.unmount();
	});

	test("offers a music bed and a presenter avatar for the assembly", async () => {
		const runtime = createTestRuntime(testProject().project);
		const view = await render(runtime);
		await typeInto(view.element, "Script", "One scene only.");
		await act(async () => {
			buttonNamed(view.element, "Split into scenes")?.click();
		});
		const music = view.element.querySelector<HTMLSelectElement>(
			'select[aria-label="Music bed"]'
		);
		const avatar = view.element.querySelector<HTMLSelectElement>(
			'select[aria-label="Presenter avatar"]'
		);
		expect(music?.value).toBe("none");
		expect([...(avatar?.options ?? [])].map((option) => option.value)).toEqual([
			"none",
			"presenter-right",
			"presenter-left",
			"corner",
		]);
		expect(
			view.element.querySelector('textarea[aria-label="Music bed description"]')
		).toBeNull();
		await act(async () => {
			if (music) {
				music.value = "cinematic";
				music.dispatchEvent(new window.Event("change", { bubbles: true }));
			}
		});
		expect(
			view.element.querySelector('textarea[aria-label="Music bed description"]')
		).not.toBeNull();
		await view.unmount();
	});

	test("writes a script from a topic with Ryu and reuses storyboard scripts", async () => {
		const { project } = testProject();
		const runtime = createTestRuntime({
			...project,
			scenes: [
				{
					approved: false,
					assetIds: [],
					duration: 5,
					id: crypto.randomUUID(),
					prompt: "",
					script: "Scene one words.",
					sourceIn: 0,
					title: "One",
				},
				{
					approved: false,
					assetIds: [],
					duration: 5,
					id: crypto.randomUUID(),
					prompt: "",
					script: "Scene two words.",
					sourceIn: 0,
					title: "Two",
				},
			],
		});
		const requests: { prompt: string; system?: string }[] = [];
		const previous = window.ryu;
		window.ryu = {
			model: {
				complete: (input) => {
					requests.push(input);
					return Promise.resolve(
						"# Tides\n\nNarrator: The sea rises twice a day."
					);
				},
			},
		};
		try {
			const view = await render(runtime);
			expect(buttonNamed(view.element, "Write script with Ryu")?.disabled).toBe(
				true
			);
			await typeInto(view.element, "Script topic", "How tides work");
			await act(async () => {
				buttonNamed(view.element, "Write script with Ryu")?.click();
			});
			expect(JSON.parse(requests[0]?.prompt ?? "{}").topic).toBe(
				"How tides work"
			);
			const script = view.element.querySelector<HTMLTextAreaElement>(
				'textarea[aria-label="Script"]'
			);
			expect(script?.value).toBe("The sea rises twice a day.");
			await act(async () => {
				buttonNamed(view.element, "Use storyboard scripts")?.click();
			});
			expect(script?.value).toBe("Scene one words.\n\nScene two words.");
			await view.unmount();
		} finally {
			window.ryu = previous;
		}
	});

	test("status text describes each production state", () => {
		const scene = {
			imagePrompt: "p",
			narration: "n",
			visualQuery: "q",
		};
		expect(sceneStatusText({ id: "a", scene, status: "pending" })).toBe(
			"Not produced yet"
		);
		expect(
			sceneStatusText({ id: "a", scene, status: "working", step: "visual" })
		).toBe("Finding visual…");
		expect(
			sceneStatusText({
				error: "No results",
				id: "a",
				scene,
				status: "failed",
				step: "visual",
			})
		).toBe("Failed while finding visual: No results");
		expect(
			sceneStatusText({ id: "a", scene, status: "ready", transcribed: true })
		).toBe("Ready · word-timed");
		expect(sceneStatusText({ id: "a", scene, status: "ready" })).toBe(
			"Ready · estimated caption timing"
		);
	});

	test("assembly summary reads the route extras", () => {
		expect(
			assemblySummary({
				captions: 3,
				duration: 12.34,
				replacedCaptions: 1,
				scenes: [{}, {}],
			})
		).toBe(
			"Assembled 2 scenes (12.3 s) with 3 captions; replaced 1 overlapping. Review rights for stock media before publishing."
		);
		expect(
			assemblySummary({
				avatars: [{}, {}],
				captions: 0,
				duration: 4,
				scenes: [{}, {}],
			})
		).toBe(
			"Assembled 2 scenes (4.0 s) with 0 captions, a presenter avatar in 2 scenes. Review rights for stock media before publishing."
		);
	});
});
