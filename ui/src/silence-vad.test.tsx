import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { ReactNode } from "react";
import type { Project } from "../../shared/project.ts";

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
const { EditorProvider } = await import("./editor/context.tsx");
const { createTestRuntime, testProject } = await import(
	"./editor/test-runtime.ts"
);
const {
	audibleSourceIds,
	clearSilenceCache,
	clipSilenceBands,
	DEFAULT_SILENCE_SETTINGS,
	loadSilence,
	setSilenceSettings,
	silenceOverlayEnabled,
	silencePath,
	silenceSettings,
	timelineSilenceSummary,
} = await import("./silence-vad.ts");
const { ClipSilenceBands, ClipSilenceOverlay } = await import(
	"./timeline/ClipSilenceOverlay.tsx"
);
const { CleanupPanel, liveCountText } = await import("./CleanupPanel.tsx");

interface HostRequest {
	body?: unknown;
	method?: string;
	path: string;
}

const requests: HostRequest[] = [];
let respond: (input: HostRequest) => unknown = () => ({});

Object.defineProperty(window, "ryu", {
	configurable: true,
	value: {
		app: {
			request: async (input: HostRequest) => {
				requests.push(input);
				return await respond(input);
			},
		},
	},
});

afterEach(() => {
	requests.length = 0;
	respond = () => ({});
	clearSilenceCache();
	setSilenceSettings(DEFAULT_SILENCE_SETTINGS);
});

afterAll(() => {
	Reflect.deleteProperty(window, "ryu");
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

const vadResponse = (assetId: string, ranges: [number, number][]) => ({
	assetId,
	method: "vad",
	noiseFloorDb: -60,
	params: {},
	ranges,
});

describe("silence mapping", () => {
	test("bands map source spans through the clip's range and speed", () => {
		const segment = { sourceIn: 2, sourceOut: 6, speed: 2, start: 10 };
		expect(
			clipSilenceBands(segment, [
				[0, 1],
				[3, 4],
				[5, 9],
			])
		).toEqual([
			{ end: 11, leftPercent: 25, start: 10.5, widthPercent: 25 },
			{ end: 12, leftPercent: 75, start: 11.5, widthPercent: 25 },
		]);
		expect(clipSilenceBands({ ...segment, sourceOut: 2 }, [[2, 3]])).toEqual(
			[]
		);
	});

	test("the live summary counts spans on audible clips and merges overlaps", () => {
		const { asset, first, second } = testProject();
		const ranges = new Map([
			[
				asset.id,
				[
					[1, 2],
					[4, 4.5],
				] as [number, number][],
			],
		]);
		const timeline = (
			segments: Project["segments"],
			trackSettings: Project["trackSettings"] = []
		) => ({ segments, trackSettings });
		expect(timelineSilenceSummary(timeline([first, second]), ranges)).toEqual({
			count: 4,
			seconds: 3,
		});
		expect(
			timelineSilenceSummary(
				timeline([first, { ...second, muted: true }]),
				ranges
			)
		).toEqual({ count: 2, seconds: 1.5 });
		const stacked = { ...first, id: crypto.randomUUID(), track: 1 };
		expect(timelineSilenceSummary(timeline([first, stacked]), ranges)).toEqual({
			count: 4,
			seconds: 1.5,
		});
	});

	test("the live summary skips muted and solo-silenced tracks", () => {
		const { asset, first } = testProject();
		const ranges = new Map([[asset.id, [[1, 2]] as [number, number][]]]);
		const other = { ...first, id: crypto.randomUUID(), start: 10, track: 1 };
		const setting = { locked: false, muted: false, name: "Track", solo: false };
		expect(
			timelineSilenceSummary(
				{
					segments: [first, other],
					trackSettings: [{ ...setting, muted: true, track: 1 }],
				},
				ranges
			)
		).toEqual({ count: 1, seconds: 1 });
		expect(
			timelineSilenceSummary(
				{
					segments: [first, other],
					trackSettings: [{ ...setting, solo: true, track: 1 }],
				},
				ranges
			).count
		).toBe(1);
	});

	test("audible sources skip muted clips and media without audio", () => {
		const { asset, first, second } = testProject();
		const silent = { ...asset, hasAudio: false, id: crypto.randomUUID() };
		const other = { ...first, assetId: silent.id, id: crypto.randomUUID() };
		const timeline = (
			segments: Project["segments"],
			trackSettings: Project["trackSettings"] = []
		) => ({ segments, trackSettings });
		expect(
			audibleSourceIds(timeline([first, second, other]), [asset, silent])
		).toEqual([asset.id]);
		expect(
			audibleSourceIds(timeline([{ ...first, muted: true }]), [asset])
		).toEqual([]);
		expect(audibleSourceIds(timeline([first, other]), undefined)).toEqual([
			asset.id,
			silent.id,
		]);
		const onTrackOne = { ...other, track: 1 };
		const setting = { locked: false, muted: false, name: "Track", solo: false };
		expect(
			audibleSourceIds(
				timeline([first, onTrackOne], [{ ...setting, muted: true, track: 1 }]),
				undefined
			)
		).toEqual([asset.id]);
		expect(
			audibleSourceIds(
				timeline([first, onTrackOne], [{ ...setting, solo: true, track: 1 }]),
				undefined
			)
		).toEqual([silent.id]);
	});
});

describe("silence loading and settings", () => {
	test("requests are shared per path and failures are retried", async () => {
		let calls = 0;
		const fetcher = (path: string) => {
			calls += 1;
			return calls === 1
				? Promise.reject(new Error(path))
				: Promise.resolve([[1, 2]] as [number, number][]);
		};
		const path = silencePath("asset", DEFAULT_SILENCE_SETTINGS.params);
		expect(path).toBe(
			"/assets/asset/silence?method=vad&threshold=10&minPause=0.6&padding=0.05&minSpeech=0.1"
		);
		await expect(loadSilence(path, fetcher)).rejects.toThrow();
		const [first, second] = await Promise.all([
			loadSilence(path, fetcher),
			loadSilence(path, fetcher),
		]);
		expect(first).toEqual([[1, 2]]);
		expect(second).toBe(first);
		expect(calls).toBe(2);
	});

	test("settings merge parameter patches and persist per viewer", () => {
		setSilenceSettings({ overlay: true, params: { threshold: 18 } });
		expect(silenceSettings()).toEqual({
			...DEFAULT_SILENCE_SETTINGS,
			overlay: true,
			params: { ...DEFAULT_SILENCE_SETTINGS.params, threshold: 18 },
		});
		expect(
			JSON.parse(localStorage.getItem("ryu.video-studio.cleanup.silence") ?? "")
		).toEqual(silenceSettings());
	});

	test("the live count text describes loading, results and failures", () => {
		expect(
			liveCountText({ failed: 0, loading: true, summary: null })
		).toContain("Listening");
		expect(
			liveCountText({
				failed: 1,
				loading: false,
				summary: { count: 1, seconds: 0.5 },
			})
		).toBe("1 non-speech span · 0.5s · 1 source unavailable");
	});
});

describe("clip silence overlay", () => {
	test("bands render as red spans positioned by percent", async () => {
		const { first } = testProject();
		const view = await render(
			createTestRuntime(null),
			<ClipSilenceBands ranges={[[2, 4]]} segment={first} />
		);
		const band = view.element.querySelector<HTMLElement>(
			"[data-silence-start]"
		);
		expect(band?.style.left).toBe("20%");
		expect(band?.style.width).toBe("20%");
		await view.unmount();
	});

	test("the overlay fetches VAD spans only when enabled", async () => {
		const { asset, first, project } = testProject();
		respond = ({ path }) =>
			path.includes("/silence") ? vadResponse(asset.id, [[1, 3]]) : {};
		const slot = {
			asset,
			fps: 30,
			locked: false,
			segment: first,
			selected: false,
			zoom: 70,
		};
		const runtime = createTestRuntime(project, [asset]);
		const hidden = await render(runtime, <ClipSilenceOverlay {...slot} />);
		expect(requests).toHaveLength(0);
		expect(hidden.element.innerHTML).toBe("");
		await hidden.unmount();
		setSilenceSettings({ overlay: true });
		const shown = await render(runtime, <ClipSilenceOverlay {...slot} />);
		await act(async () => {
			await Bun.sleep(0);
		});
		expect(requests[0]?.path).toBe(
			silencePath(asset.id, DEFAULT_SILENCE_SETTINGS.params)
		);
		expect(
			shown.element.querySelector("[data-testid=clip-silence-overlay]")
		).not.toBeNull();
		await shown.unmount();
		setSilenceSettings({ vad: false });
		const vadOff = await render(runtime, <ClipSilenceOverlay {...slot} />);
		expect(vadOff.element.innerHTML).toBe("");
		await vadOff.unmount();
	});
});

test("the clip overlay needs voice activity on as well as the toggle", () => {
	const audio = { hasAudio: true };
	expect(silenceOverlayEnabled({ overlay: true, vad: true }, audio)).toBe(true);
	expect(silenceOverlayEnabled({ overlay: true, vad: false }, audio)).toBe(
		false
	);
	expect(silenceOverlayEnabled({ overlay: false, vad: true }, audio)).toBe(
		false
	);
	expect(
		silenceOverlayEnabled({ overlay: true, vad: true }, { hasAudio: false })
	).toBe(false);
	expect(silenceOverlayEnabled({ overlay: true, vad: true }, undefined)).toBe(
		false
	);
});

describe("Cleanup panel voice activity", () => {
	function panel(project: Project) {
		return (
			<CleanupPanel
				busy={false}
				ensureSaved={() => Promise.resolve(project)}
				onError={() => undefined}
				onGuides={() => undefined}
				onRemoveRanges={() => Promise.resolve({ extras: {}, status: "ok" })}
				onSeek={() => undefined}
				project={project}
			/>
		);
	}

	test("shows a live count and plans dead air with VAD settings", async () => {
		const { asset, project } = testProject();
		respond = ({ path }) => {
			if (path.includes("/silence")) {
				return vadResponse(asset.id, [[1, 2]]);
			}
			return { ranges: [], removedSeconds: 0, revision: project.revision };
		};
		const view = await render(
			createTestRuntime(project, [asset]),
			panel(project)
		);
		const countText = () =>
			view.element.querySelector("[data-testid=cleanup-vad-count]")
				?.textContent;
		// Poll past the panel's live-count debounce instead of sleeping a fixed
		// interval tied to its delay constant.
		const deadline = Date.now() + 5000;
		while (countText() !== "2 non-speech spans · 2s" && Date.now() < deadline) {
			await act(async () => {
				await Bun.sleep(10);
			});
		}
		expect(countText()).toBe("2 non-speech spans · 2s");
		const find = [...view.element.querySelectorAll("button")].find(
			(button) => button.textContent === "Find dead air"
		);
		await act(async () => {
			find?.click();
			await Bun.sleep(0);
		});
		const plan = requests.find((input) =>
			input.path.endsWith("/dead-air-plan")
		);
		expect(plan?.body).toEqual({
			keepPause: 0.2,
			minPause: 0.6,
			minSpeech: 0.1,
			padding: 0.05,
			threshold: 10,
			vad: true,
		});
		await view.unmount();
	});

	test("turning VAD off hides its controls and sends a transcript-only plan", async () => {
		const { asset, project } = testProject();
		setSilenceSettings({ vad: false });
		respond = () => ({ ranges: [], revision: project.revision });
		const view = await render(
			createTestRuntime(project, [asset]),
			panel(project)
		);
		expect(
			view.element.querySelector("[data-testid=cleanup-vad-count]")
		).toBeNull();
		const find = [...view.element.querySelectorAll("button")].find(
			(button) => button.textContent === "Find dead air"
		);
		await act(async () => {
			find?.click();
			await Bun.sleep(0);
		});
		expect(requests.map((input) => input.path)).toEqual([
			`/projects/${project.id}/dead-air-plan`,
		]);
		expect(requests[0]?.body).toEqual({
			keepPause: 0.2,
			minPause: 0.6,
			padding: 0.05,
		});
		await view.unmount();
	});
});
