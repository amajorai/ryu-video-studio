import { afterAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { ReactNode } from "react";
import type { Project } from "../../../shared/project.ts";

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
	CaptionStylePanel,
	importSummary,
	numberFieldText,
	parseNumberField,
	parseProfanityList,
	rechunkBody,
	storedStyle,
	styleTargetTrackId,
} = await import("./CaptionStylePanel.tsx");
const { importReport } = await import("../TranscriptPanel.tsx");
const { resetImportedFontFaces } = await import("../imported-fonts.ts");
const { transcribeInput } = await import("../bridge.ts");

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

function captionProject(): Project {
	const { project } = testProject();
	return {
		...project,
		captions: [
			{
				end: 1,
				id: crypto.randomUUID(),
				start: 0,
				text: "hello there",
				words: [
					{ end: 0.5, id: crypto.randomUUID(), start: 0, text: "hello" },
					{ end: 1, id: crypto.randomUUID(), start: 0.5, text: "there" },
				],
			},
		],
	};
}

function captureRouteEdits(runtime: Runtime) {
	const edits: [string, Record<string, unknown>][] = [];
	runtime.routeEdit = (action, body) => {
		edits.push([action, body]);
		return Promise.resolve({ extras: {}, status: "ok" });
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

const choose = async (element: HTMLElement, label: string, value: string) => {
	const select = element.querySelector<HTMLSelectElement>(
		`[aria-label="${label}"]`
	);
	await act(async () => {
		if (select) {
			select.value = value;
			select.dispatchEvent(new Event("change", { bubbles: true }));
		}
	});
};

/** Type into a controlled input one keystroke at a time, like a keyboard. */
const typeInto = async (element: HTMLElement, label: string, text: string) => {
	const input = element.querySelector<HTMLInputElement>(
		`[aria-label="${label}"]`
	);
	if (!input) {
		throw new Error(`No input labelled ${label}`);
	}
	const setValue = Object.getOwnPropertyDescriptor(
		HTMLInputElement.prototype,
		"value"
	)?.set;
	const seen: string[] = [];
	for (const value of ["", ...[...text].map((_, i) => text.slice(0, i + 1))]) {
		await act(async () => {
			setValue?.call(input, value);
			input.dispatchEvent(new Event("input", { bubbles: true }));
		});
		seen.push(input.value);
	}
	return { input, seen };
};

const blur = async (input: HTMLInputElement) => {
	await act(async () => {
		input.focus();
		input.blur();
		input.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
	});
};

describe("number fields", () => {
	test("parseNumberField clears, waits, or clamps", () => {
		expect(parseNumberField("", 0.1, 5)).toBeNull();
		expect(parseNumberField("  ", 0.1, 5)).toBeNull();
		expect(parseNumberField("abc", 0.1, 5)).toBeUndefined();
		expect(parseNumberField("0", 0.1, 5)).toBe(0.1);
		expect(parseNumberField("9", 0.1, 5)).toBe(5);
		expect(parseNumberField("0.5", 0.1, 5)).toBe(0.5);
		expect(numberFieldText(undefined)).toBe("");
		expect(numberFieldText(1 / 3)).toBe("0.3333");
	});

	test("intermediate keystrokes stay visible and the value commits", async () => {
		const runtime = createTestRuntime(captionProject());
		const edits = captureRouteEdits(runtime);
		const view = await render(runtime, <CaptionStylePanel />);
		const min = await typeInto(view.element, "Min duration (s)", "0.5");
		expect(min.seen).toEqual(["", "0", "0.", "0.5"]);
		const chars = await typeInto(view.element, "Max characters", "40");
		expect(chars.seen).toEqual(["", "4", "40"]);
		await act(async () => {
			buttonNamed(view.element, "Rechunk captions")?.click();
		});
		expect(edits.at(-1)?.[1]).toMatchObject({
			chunking: { maxChars: 40, minDuration: 0.5, mode: "words" },
		});
		await view.unmount();
	});

	test("an unset min duration shows empty and can be cleared again", async () => {
		const runtime = createTestRuntime(captionProject());
		const edits = captureRouteEdits(runtime);
		const view = await render(runtime, <CaptionStylePanel />);
		const field = view.element.querySelector<HTMLInputElement>(
			'[aria-label="Min duration (s)"]'
		);
		expect(field?.value).toBe("");
		const typed = await typeInto(view.element, "Min duration (s)", "0.4");
		await blur(typed.input);
		expect(typed.input.value).toBe("0.4");
		const cleared = await typeInto(view.element, "Min duration (s)", "");
		await blur(cleared.input);
		expect(cleared.input.value).toBe("");
		await act(async () => {
			buttonNamed(view.element, "Rechunk captions")?.click();
		});
		const body = edits.at(-1)?.[1] as { chunking: Record<string, unknown> };
		expect("minDuration" in body.chunking).toBe(false);
		await view.unmount();
	});

	test("out-of-range input is clamped on blur", async () => {
		const runtime = createTestRuntime(captionProject());
		const edits = captureRouteEdits(runtime);
		const view = await render(runtime, <CaptionStylePanel />);
		const size = await typeInto(view.element, "Size (% of height)", "10");
		expect(size.seen).toEqual(["", "1", "10"]);
		const typed = await typeInto(view.element, "Min duration (s)", "0");
		await blur(typed.input);
		expect(typed.input.value).toBe("0.1");
		await act(async () => {
			buttonNamed(view.element, "Apply style")?.click();
		});
		expect(edits.at(-1)?.[1]).toMatchObject({ style: { fontSize: 0.1 } });
		await view.unmount();
	});
});

describe("CaptionStylePanel", () => {
	test("applying a preset replaces the project caption style", async () => {
		const runtime = createTestRuntime(captionProject());
		const edits = captureRouteEdits(runtime);
		const view = await render(runtime, <CaptionStylePanel />);
		const presets = view.element.querySelectorAll("[data-caption-preset]");
		expect(presets).toHaveLength(12);
		await act(async () => {
			view.element
				.querySelector<HTMLButtonElement>('[data-caption-preset="karaoke"]')
				?.click();
		});
		expect(edits[0]?.[0]).toBe("caption-style");
		expect(edits[0]?.[1]).toMatchObject({
			mode: "replace",
			style: { presetId: "karaoke", wordAnimation: "karaoke" },
			trackId: null,
		});
		await view.unmount();
	});

	test("the style form saves only the changed fields", async () => {
		const runtime = createTestRuntime(captionProject());
		const edits = captureRouteEdits(runtime);
		const view = await render(runtime, <CaptionStylePanel />);
		await choose(view.element, "Caption word animation", "bounce");
		await choose(view.element, "Caption font", "oswald");
		await act(async () => {
			buttonNamed(view.element, "Apply style")?.click();
		});
		expect(edits.at(-1)).toEqual([
			"caption-style",
			{
				mode: "replace",
				style: {
					fontFamily: "oswald",
					presetId: undefined,
					wordAnimation: "bounce",
				},
				trackId: null,
			},
		]);
		await act(async () => {
			buttonNamed(view.element, "Reset to default")?.click();
		});
		expect(edits.at(-1)).toEqual([
			"caption-style",
			{ mode: "replace", style: {}, trackId: null },
		]);
		await view.unmount();
	});

	test("an imported or system font can be chosen for captions", async () => {
		const previous = window.ryu;
		const fontId = "6f1d2b8e-6f0a-4a43-9b0c-2f0f6a1d2c3e";
		resetImportedFontFaces();
		window.ryu = {
			app: {
				request: (input) =>
					input.path === "/system-fonts"
						? Promise.resolve({ available: true, fonts: ["DejaVu Sans"] })
						: Promise.resolve({
								fonts: [
									{
										createdAt: "2026-10-15T00:00:00.000Z",
										family: "Ryufont",
										format: "truetype",
										id: fontId,
										name: "Ryufont",
										size: 1234,
									},
								],
							}),
			},
		};
		try {
			const runtime = createTestRuntime(captionProject());
			const edits = captureRouteEdits(runtime);
			const view = await render(runtime, <CaptionStylePanel />);
			await act(async () => {
				await Promise.resolve();
				await Promise.resolve();
			});
			const label = "Caption Imported or system font";
			await choose(view.element, label, "system:DejaVu Sans");
			await act(async () => {
				buttonNamed(view.element, "Apply style")?.click();
			});
			expect(edits.at(-1)?.[1].style).toEqual({
				customFont: undefined,
				presetId: undefined,
				systemFont: "DejaVu Sans",
			});
			await choose(view.element, label, fontId);
			await act(async () => {
				buttonNamed(view.element, "Apply style")?.click();
			});
			expect(edits.at(-1)?.[1].style).toEqual({
				customFont: { family: "Ryufont", id: fontId },
				presetId: undefined,
				systemFont: undefined,
			});
			await view.unmount();
		} finally {
			window.ryu = previous;
			resetImportedFontFaces();
		}
	});

	test("rechunk sends the chosen grouping", async () => {
		const runtime = createTestRuntime(captionProject());
		const edits = captureRouteEdits(runtime);
		const view = await render(runtime, <CaptionStylePanel />);
		await choose(view.element, "Caption grouping", "single-word");
		await choose(view.element, "Caption profanity", "mask");
		await act(async () => {
			buttonNamed(view.element, "Rechunk captions")?.click();
		});
		expect(edits.at(-1)).toEqual([
			"caption-rechunk",
			{ chunking: { mode: "single-word", profanity: "mask" }, trackId: null },
		]);
		await view.unmount();
	});

	test("emoji suggestions need the model service", async () => {
		const runtime = createTestRuntime(captionProject());
		const view = await render(runtime, <CaptionStylePanel />);
		expect(buttonNamed(view.element, "Suggest emoji")?.disabled).toBe(true);
		await view.unmount();
	});

	test("emoji suggestions are applied only after confirmation", async () => {
		const project = captionProject();
		const caption = project.captions[0];
		const previous = window.ryu;
		window.ryu = {
			model: {
				complete: () =>
					Promise.resolve(
						JSON.stringify({
							suggestions: [{ emoji: "👋", id: caption?.id }],
						})
					),
			},
		};
		try {
			const runtime = createTestRuntime(project);
			const edits = captureRouteEdits(runtime);
			const view = await render(runtime, <CaptionStylePanel />);
			await act(async () => {
				buttonNamed(view.element, "Suggest emoji")?.click();
			});
			expect(edits).toEqual([]);
			expect(view.element.textContent).toContain("hello there 👋");
			await act(async () => {
				buttonNamed(view.element, "Apply 1 emoji")?.click();
			});
			const [action, body] = edits[0] ?? [];
			expect(action).toBe("captions");
			expect(body).toMatchObject({ action: "replace", trackId: null });
			expect(
				(body?.captions as { text: string }[] | undefined)?.[0]?.text
			).toBe("hello there 👋");
			await view.unmount();
		} finally {
			window.ryu = previous;
		}
	});
});

describe("caption panel helpers", () => {
	test("targets the active track and its stored style", () => {
		const project = captionProject();
		expect(styleTargetTrackId(project)).toBeNull();
		const track = {
			captions: [],
			id: crypto.randomUUID(),
			label: "FR",
			language: "fr",
			style: { color: "#00ff00" },
		};
		const withTrack = {
			...project,
			captionStyle: { color: "#ff0000" },
			captionTrackId: track.id,
			captionTracks: [track],
		};
		expect(styleTargetTrackId(withTrack)).toBe(track.id);
		expect(storedStyle(withTrack)).toEqual({ color: "#00ff00" });
		expect(storedStyle({ ...withTrack, captionTrackId: null })).toEqual({
			color: "#ff0000",
		});
	});

	test("import reports and profanity lists", () => {
		expect(importSummary({ imported: 3, skipped: [] })).toBe(
			"Imported 3 captions."
		);
		expect(
			importSummary({
				imported: 1,
				skipped: [
					{ line: 6, reason: "Caption end must follow its start." },
					{ line: 10, reason: "Invalid subtitle timestamp." },
				],
			})
		).toBe(
			"Imported 1 caption. Skipped 2 malformed cues. First: line 6, Caption end must follow its start."
		);
		expect(importReport(2, [{ line: 4, reason: "Bad" }])).toBe(
			"Imported 2 cues with their original timings. Skipped 1 malformed cue (line 4: Bad)."
		);
		expect(parseProfanityList("heck, frak\nheck")).toEqual(["heck", "frak"]);
		expect(parseProfanityList("bad word!")).toEqual([]);
		expect(rechunkBody({ mode: "words" }, ["heck"], null)).toEqual({
			chunking: { mode: "words" },
			trackId: null,
		});
		expect(
			rechunkBody({ mode: "words", profanity: "remove" }, ["heck"], "t")
		).toEqual({
			chunking: { mode: "words", profanity: "remove" },
			profanityWords: ["heck"],
			trackId: "t",
		});
	});

	test("transcription input carries the language hint", () => {
		// An explicit auto-detect is forwarded so it overrides a language
		// saved in the engine's transcription settings.
		expect(transcribeInput("data:", "auto")).toEqual({
			audio: "data:",
			detailed: true,
			filename: "source-window.wav",
			language: "auto",
		});
		expect(transcribeInput("data:", undefined).language).toBeUndefined();
		expect(transcribeInput("data:", "pt-BR").language).toBe("pt-BR");
	});
});
