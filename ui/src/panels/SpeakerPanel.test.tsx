import { afterAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { ReactNode } from "react";
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
const { SpeakerPanel, detectionSummary, mergeTargets } = await import(
	"./SpeakerPanel.tsx"
);
const { ClipSpeakerTint, speakerTintFor } = await import(
	"../timeline/ClipSpeakerTint.tsx"
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

const host = crypto.randomUUID();
const guest = crypto.randomUUID();

function speakerProject(): Project {
	const { project } = testProject();
	const [first, second] = project.segments;
	return {
		...project,
		captions: [
			{
				end: 1,
				id: crypto.randomUUID(),
				speakerId: host,
				start: 0,
				text: "hello there",
				words: [
					{
						end: 0.5,
						id: crypto.randomUUID(),
						speakerId: host,
						start: 0,
						text: "hello",
					},
					{
						end: 1,
						id: crypto.randomUUID(),
						speakerId: guest,
						start: 0.5,
						text: "there",
					},
				],
			},
		],
		segments: [
			...(first ? [{ ...first, speakerId: host }] : []),
			...(second ? [second] : []),
		],
		speakers: [
			{ color: "#f59e0b", id: host, label: "Host" },
			{ color: "#38bdf8", id: guest, label: "Guest" },
		],
	};
}

type Runtime = ReturnType<typeof createTestRuntime>;

function captureRouteEdits(runtime: Runtime) {
	const edits: [string, Record<string, unknown>][] = [];
	runtime.routeEdit = (action, body) => {
		edits.push([action, body]);
		return Promise.resolve({ status: "ok", extras: {} });
	};
	return edits;
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

describe("SpeakerPanel", () => {
	test("lists speakers with usage and runs detection with the chosen mode", async () => {
		const runtime = createTestRuntime(speakerProject());
		const edits = captureRouteEdits(runtime);
		const view = await render(runtime, <SpeakerPanel />);
		const rows = view.element.querySelectorAll("[data-speaker-id]");
		expect(rows).toHaveLength(2);
		expect(rows[0]?.textContent).toContain("1 word · 1 clip");
		expect(rows[1]?.textContent).toContain("1 word · 0 clips");
		await act(async () => {
			buttonNamed(view.element, "Detect speakers")?.click();
		});
		expect(edits).toEqual([["speakers/detect", { k: 2, mode: "cluster" }]]);
		const select = view.element.querySelector<HTMLSelectElement>(
			'[aria-label="Speaker detection mode"]'
		);
		await act(async () => {
			if (select) {
				select.value = "mic-dominance";
				select.dispatchEvent(new Event("change", { bubbles: true }));
			}
		});
		expect(
			view.element.querySelector('[aria-label="Number of speakers"]')
		).toBeNull();
		await act(async () => {
			buttonNamed(view.element, "Detect speakers")?.click();
		});
		expect(edits.at(-1)).toEqual([
			"speakers/detect",
			{ mode: "mic-dominance" },
		]);
		await view.unmount();
	});

	test("renames on blur and merges into the chosen speaker", async () => {
		const runtime = createTestRuntime(speakerProject());
		const edits = captureRouteEdits(runtime);
		const view = await render(runtime, <SpeakerPanel />);
		const name = view.element.querySelector<HTMLInputElement>(
			'[aria-label="Host name"]'
		);
		await act(async () => {
			if (name) {
				name.focus();
				name.value = "Interviewer";
				name.blur();
			}
		});
		expect(edits[0]).toEqual([
			"speakers",
			{ action: "rename", label: "Interviewer", speakerId: host },
		]);
		const merge = view.element.querySelector<HTMLSelectElement>(
			'[aria-label="Merge Guest into"]'
		);
		await act(async () => {
			if (merge) {
				merge.value = host;
				merge.dispatchEvent(new Event("change", { bubbles: true }));
			}
		});
		const guestRow = view.element.querySelector(`[data-speaker-id="${guest}"]`);
		await act(async () => {
			[...(guestRow?.querySelectorAll("button") ?? [])]
				.find((button) => button.textContent === "Merge")
				?.click();
		});
		expect(edits.at(-1)).toEqual([
			"speakers",
			{ action: "merge", into: host, speakerIds: [guest] },
		]);
		await view.unmount();
	});

	test("detection is disabled until captions exist", async () => {
		const { project } = testProject();
		const runtime = createTestRuntime(project);
		const view = await render(runtime, <SpeakerPanel />);
		expect(buttonNamed(view.element, "Detect speakers")?.disabled).toBe(true);
		expect(view.element.textContent).toContain("Transcribe dialogue first");
		await view.unmount();
	});

	test("summary and merge targets", () => {
		expect(
			detectionSummary({ assigned: 7, speakers: [{}, {}], windows: 9 })
		).toBe("Detected 2 speakers; labelled 7 of 9 words.");
		expect(detectionSummary({})).toBe(
			"Detected 0 speakers; labelled 0 of 0 words."
		);
		const project = speakerProject();
		const [first] = project.speakers ?? [];
		expect(
			first ? mergeTargets(project, first).map((item) => item.id) : []
		).toEqual([guest]);
	});
});

describe("ClipSpeakerTint", () => {
	test("draws a stripe in the clip speaker's color and nothing otherwise", async () => {
		const project = speakerProject();
		const runtime = createTestRuntime(project);
		const [tagged, untagged] = project.segments;
		if (!(tagged && untagged)) {
			throw new Error("fixture needs two clips");
		}
		const slot = { fps: 30, locked: false, selected: false, zoom: 40 };
		const view = await render(
			runtime,
			<>
				<ClipSpeakerTint {...slot} segment={tagged} />
				<ClipSpeakerTint {...slot} segment={untagged} />
				<ClipSpeakerTint
					{...slot}
					segment={{ ...untagged, speakerId: crypto.randomUUID() }}
				/>
			</>
		);
		const stripes = view.element.querySelectorAll<HTMLElement>(
			'[data-testid="clip-speaker-tint"]'
		);
		expect(stripes).toHaveLength(1);
		expect(stripes[0]?.dataset.speakerId).toBe(host);
		expect(stripes[0]?.getAttribute("title")).toBe("Host");
		expect(speakerTintFor(null, tagged)).toBeUndefined();
		await view.unmount();
	});
});
