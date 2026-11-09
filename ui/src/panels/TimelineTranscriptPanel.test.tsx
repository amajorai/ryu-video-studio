import { afterAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { ReactNode } from "react";
import type { TimelineTranscript } from "../../../shared/filler-words.ts";
import type { Project } from "../../../shared/project.ts";

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
const { TimelineTranscriptPanel, rangesSeconds, transcriptTracks, wordClass } =
	await import("./TimelineTranscriptPanel.tsx");

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

/** Words 0.4 s apart and 0.3 s long. */
const TEXT = "I went to the I went to the store today";

function transcriptFor(project: Project, clipId: string): TimelineTranscript {
	return {
		clips: [
			{
				assetId: crypto.randomUUID(),
				clipId,
				cues: [],
				words: TEXT.split(" ").map((text, index) => ({
					end: index * 0.4 + 0.3,
					id: crypto.randomUUID(),
					start: index * 0.4,
					text,
				})),
			},
		],
		projectId: project.id,
		revision: project.revision,
		sourceCaptions: [],
	};
}

function setup() {
	const { first, project } = testProject();
	const runtime = createTestRuntime(project);
	const requests: string[] = [];
	runtime.api = (path) => {
		requests.push(path);
		return Promise.resolve(transcriptFor(project, first.id));
	};
	const edits: [string, Record<string, unknown>, unknown][] = [];
	runtime.routeEdit = (action, body, _describe, options) => {
		edits.push([action, body, options]);
		return Promise.resolve({ extras: {}, status: "ok" });
	};
	return { edits, requests, runtime };
}

async function render(runtime: Runtime, node: ReactNode) {
	const element = document.createElement("div");
	document.body.append(element);
	const root = createRoot(element);
	await act(async () => {
		root.render(<EditorProvider value={runtime}>{node}</EditorProvider>);
	});
	return {
		element,
		rerender: async () => {
			await act(async () => {
				// A fresh context value, as App builds a new runtime every render.
				root.render(
					<EditorProvider value={{ ...runtime }}>{node}</EditorProvider>
				);
			});
		},
		unmount: async () => {
			await act(async () => root.unmount());
			element.remove();
		},
	};
}

const word = (element: HTMLElement, index: number) => {
	const found = element.querySelector<HTMLButtonElement>(
		`[data-token-index="${index}"]`
	);
	if (!found) {
		throw new Error(`word ${index} is not rendered`);
	}
	return found;
};
const buttonStartingWith = (element: HTMLElement, text: string) =>
	[...element.querySelectorAll("button")].find((button) =>
		button.textContent?.trim().startsWith(text)
	);

describe("TimelineTranscriptPanel", () => {
	test("loads the saved timeline transcript and seeks on click", async () => {
		const { requests, runtime } = setup();
		const view = await render(runtime, <TimelineTranscriptPanel />);
		expect(requests).toEqual([`/projects/${runtime.project?.id}/transcript`]);
		expect(view.element.querySelectorAll("[data-token-index]").length).toBe(10);
		await act(async () => {
			word(view.element, 8).click();
		});
		expect(runtime.calls.at(-1)).toEqual(["setTime", 3.2]);
		runtime.time = 3.3;
		await view.rerender();
		expect(word(view.element, 8).className).toContain("bg-primary");
		await view.unmount();
	});

	test("shift-click selects a range and Delete removes it without reaching the editor", async () => {
		const { edits, runtime } = setup();
		const view = await render(runtime, <TimelineTranscriptPanel />);
		const globalKeys: string[] = [];
		const listener = (event: KeyboardEvent) => globalKeys.push(event.key);
		window.addEventListener("keydown", listener);
		await act(async () => {
			word(view.element, 8).click();
			word(view.element, 9).dispatchEvent(
				new MouseEvent("click", { bubbles: true, shiftKey: true })
			);
		});
		expect(word(view.element, 9).getAttribute("aria-pressed")).toBe("true");
		expect(buttonStartingWith(view.element, "Delete 2 words")).toBeDefined();
		await act(async () => {
			word(view.element, 9).dispatchEvent(
				new KeyboardEvent("keydown", { bubbles: true, key: "Delete" })
			);
		});
		window.removeEventListener("keydown", listener);
		expect(globalKeys).toEqual([]);
		expect(edits).toHaveLength(1);
		const [action, body, options] = edits[0] ?? [];
		expect(action).toBe("remove-words");
		expect(body).toEqual({ ranges: [{ end: 3.9, start: 3.2 }] });
		expect(options).toMatchObject({ planStamp: expect.any(String) });
		expect(word(view.element, 9).getAttribute("aria-pressed")).toBe("false");
		await view.unmount();
	});

	test("clicking a word focuses it, so Delete reaches the panel and not the editor", async () => {
		const { edits, runtime } = setup();
		const view = await render(runtime, <TimelineTranscriptPanel />);
		const globalKeys: string[] = [];
		const listener = (event: KeyboardEvent) => globalKeys.push(event.key);
		window.addEventListener("keydown", listener);
		(document.activeElement as HTMLElement | null)?.blur?.();
		await act(async () => {
			for (const [index, shiftKey] of [
				[8, false],
				[9, true],
			] as const) {
				const target = word(view.element, index);
				// Like WebKit: a pointer press does not focus the button by itself.
				target.dispatchEvent(
					new PointerEvent("pointerdown", { bubbles: true, shiftKey })
				);
				target.dispatchEvent(
					new MouseEvent("click", { bubbles: true, shiftKey })
				);
			}
		});
		expect(document.activeElement).toBe(word(view.element, 9));
		await act(async () => {
			document.activeElement?.dispatchEvent(
				new KeyboardEvent("keydown", { bubbles: true, key: "Delete" })
			);
		});
		window.removeEventListener("keydown", listener);
		expect(globalKeys).toEqual([]);
		expect(edits).toHaveLength(1);
		expect(edits[0]?.[1]).toEqual({ ranges: [{ end: 3.9, start: 3.2 }] });
		await view.unmount();
	});

	test("search highlights every hit and steps between them", async () => {
		const { runtime } = setup();
		const view = await render(runtime, <TimelineTranscriptPanel />);
		const search = view.element.querySelector<HTMLInputElement>(
			'[aria-label="Search the timeline transcript"]'
		);
		await act(async () => {
			if (search) {
				const setter = Object.getOwnPropertyDescriptor(
					HTMLInputElement.prototype,
					"value"
				)?.set;
				setter?.call(search, "went to");
				search.dispatchEvent(new Event("input", { bubbles: true }));
			}
		});
		expect(view.element.textContent).toContain("1 of 2");
		expect(word(view.element, 5).className).toContain("bg-accent");
		await act(async () => {
			view.element
				.querySelector<HTMLButtonElement>('[aria-label="Next match"]')
				?.click();
		});
		expect(view.element.textContent).toContain("2 of 2");
		expect(runtime.calls.at(-1)).toEqual(["setTime", 2]);
		await view.unmount();
	});

	test("repeated phrases are removable in one click", async () => {
		const { edits, runtime } = setup();
		const view = await render(runtime, <TimelineTranscriptPanel />);
		const plans = view.element.querySelectorAll("[data-plan-id]");
		expect(plans).toHaveLength(1);
		expect(plans[0]?.textContent).toContain("I went to the");
		await act(async () => {
			[...(plans[0]?.querySelectorAll("button") ?? [])]
				.find((button) => button.textContent === "Remove")
				?.click();
		});
		expect(edits[0]?.[1]).toEqual({ ranges: [{ end: 1.6, start: 0 }] });
		await view.unmount();
	});

	test("a changed timeline marks the words stale and blocks deletion", async () => {
		const { edits, runtime } = setup();
		const view = await render(runtime, <TimelineTranscriptPanel />);
		const project = runtime.project;
		if (!project) {
			throw new Error("fixture needs a project");
		}
		runtime.edit({
			...project,
			segments: project.segments.map((segment) => ({
				...segment,
				start: segment.start + 1,
			})),
		});
		await view.rerender();
		expect(view.element.textContent).toContain("The timeline changed");
		await act(async () => {
			word(view.element, 1).dispatchEvent(
				new MouseEvent("click", { bubbles: true, metaKey: true })
			);
		});
		expect(buttonStartingWith(view.element, "Delete 1 word")?.disabled).toBe(
			true
		);
		expect(edits).toEqual([]);
		await view.unmount();
	});

	test("helpers", () => {
		expect(
			rangesSeconds([
				{ end: 1.5, start: 1 },
				{ end: 3.25, start: 3 },
			])
		).toBe(0.75);
		const { project } = testProject();
		expect(
			transcriptTracks({
				...project,
				segments: [
					...project.segments,
					...project.segments.map((segment) => ({ ...segment, track: 2 })),
				],
			})
		).toEqual([0, 2]);
		const base = {
			active: false,
			currentHit: false,
			hit: false,
			selected: false,
		};
		expect(wordClass({ ...base, selected: true, unit: "word" })).toContain(
			"line-through"
		);
		expect(wordClass({ ...base, unit: "cue" })).toContain("italic");
	});
});
