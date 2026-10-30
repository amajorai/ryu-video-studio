import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";

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
const { newProject, newSegment } = await import(
	"../../../../shared/project.ts"
);
const { MAX_AUDIO_EFFECTS } = await import(
	"../../../../shared/schema/audio-ext.ts"
);
const { EditorProvider } = await import("../../editor/context.tsx");
const { createTestRuntime, testVideo } = await import(
	"../../editor/test-runtime.ts"
);
const { AudioSection } = await import("./AudioSection.tsx");
const { loadAudioFilterSupport, resetAudioFilterSupport } = await import(
	"./audio-capabilities.ts"
);
const {
	addEffect,
	cleanupPatch,
	cleanupPresetPatch,
	moveEffect,
	removeEffect,
	updateEffect,
} = await import("./audio-stack.ts");

type Segment = ReturnType<typeof newSegment>;

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

beforeEach(() => {
	resetAudioFilterSupport();
});

describe("audio stack edits", () => {
	const segment = newSegment(testVideo());

	test("the first graded edit starts from the legacy preset", () => {
		expect(
			cleanupPatch({ audioProcessing: "voice-enhance" }, { normalize: true })
		).toEqual({
			audioCleanup: {
				denoise: 0.4,
				enhance: 0.6,
				normalize: true,
				voiceIsolation: 0,
			},
			audioProcessing: "none",
		});
	});

	test("cleanup edits clear the legacy preset the preview still reads", () => {
		const legacy = { audioProcessing: "denoise" as const };
		expect(cleanupPatch(legacy, { denoise: 0 })).toMatchObject({
			audioCleanup: { denoise: 0 },
			audioProcessing: "none",
		});
		expect(cleanupPresetPatch("off")).toEqual({
			audioCleanup: {
				denoise: 0,
				enhance: 0,
				normalize: false,
				voiceIsolation: 0,
			},
			audioProcessing: "none",
		});
	});

	test("add, update, move, and remove keep the stack ordered", () => {
		const added = addEffect(segment, "echo");
		expect(added?.audioEffects?.map((effect) => effect.type)).toEqual(["echo"]);
		const two = {
			...segment,
			...addEffect({ ...segment, ...added }, "reverb"),
		};
		expect(
			moveEffect(two, 1, -1).audioEffects?.map((effect) => effect.type)
		).toEqual(["reverb", "echo"]);
		expect(moveEffect(two, 0, -1).audioEffects).toEqual(two.audioEffects);
		expect(updateEffect(two, 0, { enabled: false }).audioEffects?.[0]).toEqual({
			amount: 0.5,
			enabled: false,
			type: "echo",
		});
		expect(
			removeEffect(two, 0).audioEffects?.map((effect) => effect.type)
		).toEqual(["reverb"]);
	});

	test("adding past the limit is refused", () => {
		let current: Segment = segment;
		for (let index = 0; index < MAX_AUDIO_EFFECTS; index++) {
			current = { ...current, ...addEffect(current, "tremolo") };
		}
		expect(addEffect(current, "tremolo")).toBeNull();
	});
});

describe("capability probe", () => {
	test("reads the filters once and treats failure as unknown", async () => {
		let calls = 0;
		const probe = () => {
			calls++;
			return Promise.resolve({
				filters: { arnndn: false, rubberband: true },
			});
		};
		expect(await loadAudioFilterSupport(probe)).toEqual({
			arnndn: false,
			rubberband: true,
		});
		await loadAudioFilterSupport(probe);
		expect(calls).toBe(1);
		resetAudioFilterSupport();
		expect(
			await loadAudioFilterSupport(() => Promise.reject(new Error("offline")))
		).toEqual({ arnndn: undefined, rubberband: undefined });
	});
});

async function render(segment: Segment, isAudio = false) {
	const asset = testVideo();
	const project = { ...newProject("Audio"), segments: [segment] };
	const runtime = createTestRuntime(project, [
		{ ...asset, id: segment.assetId },
	]);
	const patches: Partial<Segment>[] = [];
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	await act(async () => {
		root.render(
			<EditorProvider value={{ ...runtime }}>
				<AudioSection
					isAudio={isAudio}
					onChange={(patch) => patches.push(patch)}
					segment={segment}
					visualControls={!isAudio}
				/>
			</EditorProvider>
		);
	});
	return {
		host,
		patches,
		unmount: async () => {
			await act(async () => root.unmount());
			host.remove();
		},
	};
}

function select(host: HTMLElement, label: string): HTMLSelectElement {
	const element = host.querySelector(`select[aria-label="${label}"]`);
	if (!(element instanceof HTMLSelectElement)) {
		throw new Error(`missing select ${label}`);
	}
	return element;
}

async function choose(host: HTMLElement, label: string, value: string) {
	const element = select(host, label);
	await act(async () => {
		element.value = value;
		element.dispatchEvent(new Event("change", { bubbles: true }));
	});
}

describe("AudioSection", () => {
	test("video clips with audio get cleanup, effects, and pan controls", async () => {
		await loadAudioFilterSupport(() =>
			Promise.resolve({ filters: { arnndn: false, rubberband: false } })
		);
		const segment = {
			...newSegment(testVideo()),
			audioEffects: [{ amount: 0.5, enabled: true, type: "chipmunk" as const }],
		};
		const view = await render(segment);
		expect(select(view.host, "Audio cleanup").value).toBe("off");
		expect(view.host.textContent).toContain("Voice isolation is unavailable");
		expect(view.host.textContent).toContain("tape-style shift");
		expect(
			view.host.querySelector('[aria-label="Duck under other audio"]')
		).toBeNull();

		await choose(view.host, "Audio cleanup", "podcast");
		await choose(view.host, "Add audio effect", "reverb");
		await choose(view.host, "Channels", "mono");
		await choose(view.host, "Audio effect preset", "phone-call");
		expect(view.patches).toEqual([
			{
				audioCleanup: {
					denoise: 0.4,
					enhance: 0.6,
					normalize: true,
					voiceIsolation: 0,
				},
				audioProcessing: "none",
			},
			{
				audioEffects: [
					{ amount: 0.5, enabled: true, type: "chipmunk" },
					{ amount: 0.5, enabled: true, type: "reverb" },
				],
			},
			{ channelMode: "mono" },
			{ audioEffects: [{ amount: 0.6, enabled: true, type: "telephone" }] },
		]);

		const bypass = [...view.host.querySelectorAll("button")].find(
			(button) => button.textContent === "Bypass Chipmunk"
		);
		await act(async () => bypass?.click());
		expect(view.patches.at(-1)).toEqual({
			audioEffects: [{ amount: 0.5, enabled: false, type: "chipmunk" }],
		});
		expect(bypass?.getAttribute("aria-pressed")).toBe("false");
		await view.unmount();
	});

	test("a bypassed effect keeps its toggle name and reports pressed", async () => {
		const view = await render({
			...newSegment(testVideo()),
			audioEffects: [{ amount: 0.5, enabled: false, type: "echo" }],
		});
		const toggles = [...view.host.querySelectorAll("button")].filter((button) =>
			button.hasAttribute("aria-pressed")
		);
		expect(toggles.map((button) => button.textContent)).toEqual([
			"Bypass Echo",
		]);
		expect(toggles[0]?.getAttribute("aria-pressed")).toBe("true");
		await view.unmount();
	});

	test("effect fields match what each effect type reads", async () => {
		const segment = {
			...newSegment(testVideo()),
			audioEffects: [
				{
					amount: 0.5,
					enabled: true,
					type: "chipmunk" as const,
					semitones: -5,
				},
				{ amount: 0.5, enabled: true, type: "deep-voice" as const },
				{
					amount: 0.5,
					enabled: true,
					frequency: 1000,
					gainDb: 3,
					type: "eq" as const,
				},
				{ amount: 0.5, enabled: true, type: "echo" as const },
			],
		};
		const view = await render(segment);
		const field = (label: string) =>
			view.host.querySelector<HTMLInputElement>(`[aria-label="${label}"]`);
		expect(field("Chipmunk amount (%)")).toBeNull();
		expect(field("Deep voice amount (%)")).toBeNull();
		expect(field("EQ band amount (%)")).toBeNull();
		expect(field("Echo amount (%)")).not.toBeNull();
		const chipmunk = field("Chipmunk semitones");
		expect(chipmunk?.value).toBe("5");
		expect(chipmunk?.getAttribute("aria-valuemin")).toBe("0");
		const deep = field("Deep voice semitones");
		expect(deep?.value).toBe("-7");
		expect(deep?.getAttribute("aria-valuemax")).toBe("0");
		await view.unmount();
	});

	test("audio-file clips keep ducking and visualization", async () => {
		const view = await render(newSegment(testVideo()), true);
		expect(select(view.host, "Duck under other audio").value).toBe("no");
		expect(
			view.host.querySelector('[aria-label="Voice isolation (%)"]')
		).not.toBeNull();
		await view.unmount();
	});

	test("ducked clips set the amount, attack and release", async () => {
		const plain = await render(newSegment(testVideo()), true);
		expect(
			plain.host.querySelector('input[aria-label="Duck amount (dB)"]')
		).toBeNull();
		await choose(plain.host, "Duck under other audio", "yes");
		expect(plain.patches).toEqual([{ duckUnderVoice: true }]);
		await plain.unmount();

		const view = await render(
			{
				...newSegment(testVideo()),
				duckUnderVoice: true,
				ducking: { amountDb: 12 },
			},
			true
		);
		const field = (label: string) => {
			const element = view.host.querySelector(`input[aria-label="${label}"]`);
			if (!(element instanceof HTMLInputElement)) {
				throw new Error(`missing field ${label}`);
			}
			return element;
		};
		expect(field("Duck amount (dB)").value).toBe("12");
		expect(field("Duck attack (ms)").value).toBe("20");
		expect(field("Duck release (ms)").value).toBe("250");
		const release = field("Duck release (ms)");
		await act(async () => {
			release.value = "600";
			release.dispatchEvent(new Event("blur", { bubbles: true }));
			release.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
		});
		expect(view.patches).toEqual([
			{ ducking: { amountDb: 12, attackMs: 20, releaseMs: 600 } },
		]);
		await view.unmount();
	});
});
