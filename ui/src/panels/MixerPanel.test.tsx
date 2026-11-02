import { afterAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, type ReactNode } from "react";
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
const { newProject, newSegment, trackSettingFor, updateTrackSetting } =
	await import("../../../shared/project.ts");
const { EditorProvider } = await import("../editor/context.tsx");
const { createTestRuntime, testVideo } = await import(
	"../editor/test-runtime.ts"
);
const { MixerPanel, mixerPanelTab } = await import("./MixerPanel.tsx");
const { panFromPercent, panLabel, setTrackMix, TrackMixerControls } =
	await import("../timeline/TrackMixerControls.tsx");
const { SpeedSection } = await import("../inspector/sections/SpeedSection.tsx");
const { nextMeterLevels } = await import("../audio/MasterMeter.tsx");

type Segment = ReturnType<typeof newSegment>;
type Runtime = ReturnType<typeof createTestRuntime>;

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

async function mount(runtime: Runtime, node: ReactNode) {
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	await act(async () => {
		root.render(<EditorProvider value={{ ...runtime }}>{node}</EditorProvider>);
	});
	return {
		host,
		unmount: async () => {
			await act(async () => root.unmount());
			host.remove();
		},
	};
}

function input(host: HTMLElement, label: string): HTMLInputElement {
	const element = host.querySelector(`input[aria-label="${label}"]`);
	if (!(element instanceof HTMLInputElement)) {
		throw new Error(`missing input ${label}`);
	}
	return element;
}

async function commit(host: HTMLElement, label: string, value: string) {
	const element = input(host, label);
	await act(async () => {
		element.focus();
		element.value = value;
		element.blur();
	});
}

describe("track mix edits", () => {
	test("pan helpers round and label", () => {
		expect(panFromPercent(-42.4)).toBe(-0.42);
		expect(panFromPercent(250)).toBe(1);
		expect(panFromPercent(Number.NaN)).toBe(0);
		expect(panLabel(0)).toBe("C");
		expect(panLabel(-0.4)).toBe("L40");
		expect(panLabel(1)).toBe("R100");
	});

	test("stores clamped gain and pan, and clears unity values", () => {
		const runtime = createTestRuntime(newProject("Mix"));
		setTrackMix(runtime, 1, { gainDb: -80, pan: 0.333 });
		expect(trackSettingFor(runtime.project ?? newProject(), 1)).toMatchObject({
			gainDb: -60,
			pan: 0.33,
		});
		setTrackMix(runtime, 1, { gainDb: 0, pan: 0 });
		const reset = trackSettingFor(runtime.project ?? newProject(), 1);
		expect(reset.gainDb).toBeUndefined();
		expect(reset.pan).toBeUndefined();
		expect(JSON.stringify(reset)).not.toContain("gainDb");
	});

	test("unchanged values do not record an edit", () => {
		const runtime = createTestRuntime(newProject("Mix"));
		setTrackMix(runtime, 0, { gainDb: 0 });
		expect(runtime.calls.filter(([name]) => name === "edit")).toEqual([]);
	});
});

describe("TrackMixerControls", () => {
	test("edits gain and pan from the track header", async () => {
		const runtime = createTestRuntime(
			updateTrackSetting(newProject("Mix"), 0, { name: "Dialogue" })
		);
		const view = await mount(runtime, <TrackMixerControls track={0} />);
		await commit(view.host, "Dialogue gain (dB)", "-6");
		expect(trackSettingFor(runtime.project ?? newProject(), 0).gainDb).toBe(-6);
		await commit(view.host, "Dialogue pan (-100 left to 100 right)", "-50");
		expect(trackSettingFor(runtime.project ?? newProject(), 0).pan).toBe(-0.5);
		await view.unmount();
	});
});

describe("MixerPanel", () => {
	test("has its own tab and lists every track with gain, pan and the meter", async () => {
		expect(mixerPanelTab).toEqual({ label: "Mixer", value: "mixer" });
		const runtime = createTestRuntime(
			updateTrackSetting(newProject("Mix"), 1, { gainDb: -3, pan: 0.25 })
		);
		const view = await mount(runtime, <MixerPanel />);
		expect(view.host.textContent).toContain("-3.0 dB · R25");
		expect(input(view.host, "Track 1 gain (dB)").value).toBe("0");
		expect(view.host.querySelectorAll('[role="meter"]')).toHaveLength(2);
		expect(view.host.textContent).toContain("Play audio while scrubbing");
		await view.unmount();
	});

	test("labels a hidden track silent, since hiding silences it", async () => {
		const runtime = createTestRuntime(
			updateTrackSetting(newProject("Mix"), 1, { hidden: true })
		);
		const view = await mount(runtime, <MixerPanel />);
		expect(view.host.textContent).toContain("(silent)");
		await view.unmount();
	});
});

describe("SpeedSection", () => {
	async function renderSpeed(patch: Partial<Segment> = {}) {
		const asset = testVideo();
		const segment = { ...newSegment(asset), ...patch };
		const runtime = createTestRuntime(
			{ ...newProject("Speed"), segments: [segment] },
			[asset]
		);
		const patches: Partial<Segment>[] = [];
		const view = await mount(
			runtime,
			<SpeedSection
				isAudio={false}
				onChange={(next) => patches.push(next)}
				segment={segment}
				visualControls
			/>
		);
		return { ...view, patches, runtime };
	}

	const presetButton = (host: HTMLElement, label: string) =>
		[...host.querySelectorAll("button")].find(
			(button) => button.textContent === label
		);

	test("offers presets across 0.1x-100x and the custom speed field", async () => {
		const view = await renderSpeed();
		await act(async () => presetButton(view.host, "100x")?.click());
		expect(view.runtime.project?.segments[0]?.speed).toBe(100);
		await commit(view.host, "Custom speed (0.1x-100x)", "0.1");
		expect(view.runtime.project?.segments[0]?.speed).toBe(0.1);
		// Speed goes through the validated helper, never a raw clip patch.
		expect(view.patches).toEqual([]);
		await view.unmount();
	});

	test("presets that would invalidate the clip are disabled", async () => {
		const view = await renderSpeed({ fadeOut: 1, sourceOut: 10 });
		expect(presetButton(view.host, "8x")?.disabled).toBe(false);
		expect(presetButton(view.host, "16x")?.disabled).toBe(true);
		expect(presetButton(view.host, "100x")?.disabled).toBe(true);
		expect(view.host.textContent).toContain("up to 10x for this clip");
		await view.unmount();
	});

	test("shows volume in dB and stores it linear", async () => {
		const view = await renderSpeed({ volume: 0.5 });
		const field = view.host.querySelector('input[aria-label^="Volume (dB)"]');
		if (!(field instanceof HTMLInputElement)) {
			throw new Error("missing volume field");
		}
		expect(field.value).toBe("-6");
		await act(async () => {
			field.focus();
			field.value = "6";
			field.blur();
		});
		expect(view.patches.at(-1)?.volume).toBeCloseTo(1.9953, 4);
		await view.unmount();
	});

	test("explains high-speed muting only above 16x", async () => {
		const normal = await renderSpeed({ speed: 8 });
		expect(normal.host.textContent).not.toContain("Keep audio above 16x");
		expect(normal.host.textContent).toContain("Preserve pitch");
		await normal.unmount();
		const fast = await renderSpeed({ speed: 32 });
		expect(fast.host.textContent).toContain("Keep audio above 16x");
		await fast.unmount();
	});
});

describe("MasterMeter levels", () => {
	test("rise instantly, fall with release, and carry clip flags", () => {
		const loud = nextMeterLevels(
			{ clipped: [false, false], peakDb: [-96, -96], rmsDb: [-96, -96] },
			{ clipped: [true, false], peak: [1, 0.5], rms: [0.5, 0.25] },
			0
		);
		expect(loud.clipped).toEqual([true, false]);
		expect(loud.peakDb[0]).toBe(0);
		expect(loud.rmsDb[1]).toBeCloseTo(-12.04, 2);
		const falling = nextMeterLevels(
			loud,
			{ clipped: [false, false], peak: [0, 0], rms: [0, 0] },
			0.5
		);
		expect(falling.peakDb[0]).toBe(-12);
	});
});
