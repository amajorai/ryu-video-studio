import { afterAll, afterEach, describe, expect, test } from "bun:test";
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
const { GenerationPanel } = await import("./GenerationPanel.tsx");
const { testVideo } = await import("./editor/test-runtime.ts");

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
	document.body.innerHTML = "";
	localStorage.clear();
});

const projectId = "4c7c0d8e-2f3a-4b8e-9c1d-1a2b3c4d5e6f";
const hero = {
	...testVideo("Hero shot.png"),
	id: "8b0a2c1e-1111-4222-8333-944455556666",
	kind: "image" as const,
	name: "Hero shot.png",
};

const budgetStatus = {
	atRiskMicroUsd: 0,
	availableMicroUsd: 1_500_000,
	canStart: true,
	limitMicroUsd: 2_000_000,
	matchedReceipts: 1,
	reservedMicroUsd: 0,
	spentMicroUsd: 500_000,
	unknownCompleted: 0,
};

function setValue(
	element: HTMLTextAreaElement | HTMLSelectElement,
	value: string
) {
	const prototype =
		element instanceof HTMLTextAreaElement
			? HTMLTextAreaElement.prototype
			: HTMLSelectElement.prototype;
	Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(
		element,
		value
	);
	if (element instanceof HTMLTextAreaElement) {
		element.setSelectionRange(value.length, value.length);
	}
	element.dispatchEvent(
		new Event(element instanceof HTMLTextAreaElement ? "input" : "change", {
			bubbles: true,
		})
	);
}

async function mount(completions: string[] = []) {
	const prompts: { prompt: string; system?: string }[] = [];
	window.ryu = {
		app: {
			request: (input) =>
				Promise.resolve(
					input.path.endsWith("/budget") ? budgetStatus : { entries: [] }
				),
		},
		catalog: {
			models: () => Promise.resolve({ models: [] }),
			snapshot: () =>
				Promise.resolve({
					current: { model: "flux-pro", provider: "fal" },
					providers: [
						{
							configured: true,
							id: "fal",
							label: "Fal",
							suggestedModels: ["flux-pro", "veo-3"],
						},
					],
				}),
		},
		model: {
			complete: (input) => {
				prompts.push(input);
				return Promise.resolve(completions.shift() ?? "");
			},
		},
	};
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	await act(async () => {
		root.render(
			<GenerationPanel
				assets={[hero]}
				onAsset={() => undefined}
				onStatus={() => undefined}
				productionBudget={{ limitMicroUsd: 2_000_000 }}
				projectId={projectId}
			/>
		);
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
	const flush = () =>
		act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
	return { container, flush, prompts, root };
}

const button = (container: HTMLElement, text: string) =>
	[...container.querySelectorAll("button")].find(
		(item) => item.textContent === text
	);

describe("generation panel", () => {
	test("offers catalog models and shows the cost estimate against the budget", async () => {
		const { container, root } = await mount();
		const select = container.querySelector<HTMLSelectElement>(
			'[aria-label="Generation model"]'
		);
		expect([...(select?.options ?? [])].map((option) => option.text)).toEqual([
			"Node default",
			"flux-pro · Fal",
			"veo-3 · Fal",
			"Custom…",
		]);
		expect(
			container.querySelector("[data-generation-cost]")?.textContent
		).toContain(
			"Planning estimate: $0.25 per image. $1.50 of the $2.00 project budget is left."
		);
		await act(async () => {
			root.unmount();
			await Promise.resolve();
		});
	});

	test("@ suggests library images and inserts the mention", async () => {
		const { container, flush, root } = await mount();
		const direction = container.querySelector<HTMLTextAreaElement>(
			'[aria-label="Direction"]'
		);
		if (!direction) {
			throw new Error("Direction field missing");
		}
		await act(async () => {
			setValue(direction, "Poster featuring @he");
			await Promise.resolve();
		});
		await flush();
		const suggestion = button(container, "@Hero-shot");
		expect(suggestion).toBeDefined();
		await act(async () => {
			suggestion?.click();
			await Promise.resolve();
		});
		expect(direction.value).toBe("Poster featuring @Hero-shot ");
		await act(async () => {
			root.unmount();
			await Promise.resolve();
		});
	});

	test("Enhance rewrites the prompt through the model and can be undone; drafts persist", async () => {
		const { container, prompts, root } = await mount([
			'Prompt: "A cinematic poster of @Hero-shot at dusk"',
		]);
		const direction = container.querySelector<HTMLTextAreaElement>(
			'[aria-label="Direction"]'
		);
		if (!direction) {
			throw new Error("Direction field missing");
		}
		await act(async () => {
			setValue(direction, "poster @Hero-shot");
			await Promise.resolve();
		});
		await act(async () => {
			button(container, "Enhance prompt")?.click();
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
		expect(prompts[0]?.prompt).toBe("poster @Hero-shot");
		expect(direction.value).toBe("A cinematic poster of @Hero-shot at dusk");
		await act(async () => {
			button(container, "Save draft")?.click();
			await Promise.resolve();
		});
		await act(async () => {
			button(container, "Undo enhance")?.click();
			await Promise.resolve();
		});
		expect(direction.value).toBe("poster @Hero-shot");
		const drafts = container.querySelector<HTMLSelectElement>(
			'[aria-label="Prompt drafts"]'
		);
		expect(drafts?.options[1]?.text).toBe(
			"A cinematic poster of @Hero-shot at dusk"
		);
		const stored = localStorage.getItem(
			`ryu.video-studio.generation-drafts.${projectId}`
		);
		expect(stored).toContain("A cinematic poster of @Hero-shot at dusk");
		await act(async () => {
			if (drafts) {
				setValue(drafts, drafts.options[1]?.value ?? "");
			}
			await Promise.resolve();
		});
		expect(direction.value).toBe("A cinematic poster of @Hero-shot at dusk");
		await act(async () => {
			root.unmount();
			await Promise.resolve();
		});
	});
});
