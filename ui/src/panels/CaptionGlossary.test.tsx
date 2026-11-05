import { afterAll, expect, test } from "bun:test";
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
const { EditorProvider } = await import("../editor/context.tsx");
const { createTestRuntime, testProject } = await import(
	"../editor/test-runtime.ts"
);
const { CaptionGlossary, glossarySummary } = await import(
	"./CaptionGlossary.tsx"
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

const button = (host: HTMLElement, name: string) =>
	[...host.querySelectorAll("button")].find(
		(candidate) => candidate.textContent === name
	);

async function type(host: HTMLElement, label: string, value: string) {
	const input = host.querySelector<HTMLInputElement>(
		`input[aria-label="${label}"]`
	);
	await act(async () => {
		Object.getOwnPropertyDescriptor(
			HTMLInputElement.prototype,
			"value"
		)?.set?.call(input, value);
		input?.dispatchEvent(new window.Event("input", { bubbles: true }));
	});
}

test("fix names and terms: add pairs, take Ryu's suggestions, apply through the route", async () => {
	const runtime = createTestRuntime({
		...testProject().project,
		captions: [
			{ end: 2, id: crypto.randomUUID(), start: 0, text: "Meet rye you" },
		],
	});
	const routed: [string, Record<string, unknown>][] = [];
	runtime.routeEdit = (action, body) => {
		routed.push([action, body]);
		return Promise.resolve({ extras: {}, status: "ok" as const });
	};
	const previous = window.ryu;
	window.ryu = {
		model: {
			complete: () =>
				Promise.resolve('{"fixes":[{"from":"cubernetes","to":"Kubernetes"}]}'),
		},
	};
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	try {
		await act(async () => {
			root.render(
				<EditorProvider value={{ ...runtime }}>
					<CaptionGlossary />
				</EditorProvider>
			);
		});
		expect(button(host, "Fix captions and transcripts")?.disabled).toBe(true);
		await type(host, "Heard as", "rye you");
		await type(host, "Correct spelling", "Ryu");
		await act(async () => {
			button(host, "Add fix")?.click();
		});
		expect(
			host.querySelector('[aria-label="Name and term fixes"]')?.textContent
		).toContain("rye you → Ryu");
		await act(async () => {
			button(host, "Suggest fixes with Ryu")?.click();
		});
		expect(
			host.querySelector('[aria-label="Suggested fixes"]')?.textContent
		).toContain("cubernetes → Kubernetes");
		await act(async () => {
			button(host, "Add suggestions")?.click();
		});
		await act(async () => {
			button(host, "Fix captions and transcripts")?.click();
		});
		expect(routed).toEqual([
			[
				"caption-glossary",
				{
					allTracks: false,
					glossary: [
						{ from: "rye you", to: "Ryu" },
						{ from: "cubernetes", to: "Kubernetes" },
					],
					transcripts: true,
				},
			],
		]);
	} finally {
		window.ryu = previous;
		await act(async () => root.unmount());
		host.remove();
	}
});

test("the status line counts caption and transcript fixes", () => {
	expect(glossarySummary({ replacements: 3, transcripts: ["a"] })).toBe(
		"Fixed 3 names and terms in the captions and 1 transcript."
	);
	expect(glossarySummary({ replacements: 1 })).toBe(
		"Fixed 1 name and term in the captions."
	);
});
