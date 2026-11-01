import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, useState } from "react";
import type { Project, Title } from "../../../shared/project.ts";
import type { TtsVoiceChoice } from "../../../shared/tts-voices.ts";

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
const { createRoot } = await import("react-dom/client");
const { VoicePicker } = await import("./VoicePicker.tsx");
const { TitlesPanel } = await import("../TitlesPanel.tsx");
const { EditorProvider } = await import("../editor/context.tsx");
const { createTestRuntime, testProject } = await import(
	"../editor/test-runtime.ts"
);
const { OverlayLanes } = await import("../timeline/OverlayLanes.tsx");

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

let cleanup: (() => Promise<void>) | null = null;
afterEach(async () => {
	await cleanup?.();
	cleanup = null;
	document.body.innerHTML = "";
	localStorage.clear();
});

async function render(node: React.ReactNode) {
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	await act(async () => {
		root.render(node);
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
	cleanup = async () => {
		await act(async () => root.unmount());
		host.remove();
	};
	return host;
}

function choose(select: HTMLSelectElement, value: string) {
	Object.getOwnPropertyDescriptor(
		HTMLSelectElement.prototype,
		"value"
	)?.set?.call(select, value);
	select.dispatchEvent(new Event("change", { bubbles: true }));
}

const listing = {
	data: [
		{
			display_name: "Kokoro",
			id: "kokoro",
			installed: true,
			languages: ["en-us", "fr-fr"],
			voices: ["af_heart", "ff_siwis"],
		},
		{
			display_name: "Chatterbox",
			id: "chatterbox",
			installed: false,
			voices: [],
		},
	],
};

function Harness({
	listEngines,
	onChoice,
}: {
	listEngines?: () => Promise<unknown>;
	onChoice: (choice: TtsVoiceChoice) => void;
}) {
	const [value, setValue] = useState<TtsVoiceChoice>({
		engine: "",
		language: "",
		voice: "",
	});
	return (
		<VoicePicker
			listEngines={listEngines}
			onChange={(next) => {
				setValue(next);
				onChoice(next);
			}}
			value={value}
			voiceAriaLabel="Narration voice"
			voiceLabel="Voice (optional)"
		/>
	);
}

describe("voice picker", () => {
	test("groups host voices by engine and language and sets both on choice", async () => {
		const choices: TtsVoiceChoice[] = [];
		const host = await render(
			<Harness
				listEngines={() => Promise.resolve(listing)}
				onChoice={(choice) => choices.push(choice)}
			/>
		);
		const voice = host.querySelector<HTMLSelectElement>(
			'select[aria-label="Narration voice"]'
		);
		expect(voice).not.toBeNull();
		expect(
			[...(voice?.querySelectorAll("optgroup") ?? [])].map((group) =>
				group.getAttribute("label")
			)
		).toEqual(["Kokoro · English (US)", "Kokoro · French"]);
		expect(host.textContent).toContain("Not installed: Chatterbox");
		await act(async () => {
			if (voice) {
				choose(voice, "kokoro/ff_siwis");
			}
		});
		expect(choices.at(-1)).toEqual({
			engine: "kokoro",
			language: "fr-fr",
			voice: "ff_siwis",
		});
		const language = host.querySelector<HTMLSelectElement>(
			'select[aria-label="Narration language"]'
		);
		expect(language?.value).toBe("fr-fr");
	});

	test("keeps the free-text voice field when the host lists no voices", async () => {
		const choices: TtsVoiceChoice[] = [];
		const host = await render(
			<Harness
				listEngines={() => Promise.reject(new Error("no engines"))}
				onChoice={(choice) => choices.push(choice)}
			/>
		);
		const input = host.querySelector<HTMLInputElement>(
			'input[aria-label="Narration voice"]'
		);
		expect(input).not.toBeNull();
		expect(host.querySelector("select")).toBeNull();
	});
});

const title: Title = {
	animation: "fade",
	color: "#ffffff",
	end: 4,
	fadeIn: 0.2,
	fadeOut: 0.2,
	fontSize: 0.08,
	id: "55555555-5555-4555-8555-555555555555",
	start: 1.5,
	text: "Opening",
	x: 0.5,
	y: 0.5,
};

describe("title text to speech", () => {
	test("the Titles panel speaks one title with the stored voice", async () => {
		const narrated: [string, string][] = [];
		const host = await render(
			<TitlesPanel
				narrationAvailable
				onChange={() => undefined}
				onNarrate={(titleId, voice) => {
					narrated.push([titleId, voice.voice]);
					return Promise.resolve(true);
				}}
				time={0}
				titles={[title]}
			/>
		);
		const speak = host.querySelector<HTMLButtonElement>(
			'button[aria-label="Text to speech for title 1"]'
		);
		expect(speak?.textContent).toBe("Text to speech");
		await act(async () => {
			speak?.click();
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
		expect(narrated).toEqual([[title.id, ""]]);
		expect(host.textContent).toContain("Text to speech voice");
	});

	test("the title lane menu offers text to speech for that title", async () => {
		const fixture = testProject();
		const project: Project = { ...fixture.project, titles: [title] };
		const runtime = createTestRuntime(project, [fixture.asset]);
		runtime.zoom = 50;
		const host = await render(
			<EditorProvider value={{ ...runtime }}>
				<OverlayLanes zoom={50} />
			</EditorProvider>
		);
		const item = host.querySelector<HTMLElement>(
			`[data-overlay-id="${title.id}"]`
		);
		expect(item?.closest("[data-title-menu]")).not.toBeNull();
		await act(async () => {
			item?.dispatchEvent(
				new MouseEvent("contextmenu", {
					bubbles: true,
					button: 2,
					cancelable: true,
					clientX: 100,
					clientY: 10,
				})
			);
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
		const menu = document.querySelector("[data-slot='context-menu-content']");
		expect(menu?.getAttribute("aria-label")).toBe("Title actions");
		const speak = document.querySelector<HTMLElement>(
			'[data-menu-item="text-to-speech"]'
		);
		expect(speak?.textContent).toBe("Text to speech");
		// Without a host speech bridge the action is shown but disabled.
		expect(speak?.hasAttribute("data-disabled")).toBe(true);
		await act(async () => {
			document
				.querySelector<HTMLElement>('[data-menu-item="duplicate"]')
				?.click();
		});
		expect(runtime.project?.titles).toHaveLength(2);
	});
});
