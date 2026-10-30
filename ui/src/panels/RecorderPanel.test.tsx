import { afterAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type {
	MediaRecordingInput,
	MediaRecordingResult,
} from "@ryu/app-host/media-recording";
import type { CaptureMediaRecorder } from "../recording/screen.ts";

GlobalRegistrator.register();
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const previousActEnvironment = Object.getOwnPropertyDescriptor(
	globalThis,
	"IS_REACT_ACT_ENVIRONMENT"
);
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
	configurable: true,
	value: true,
	writable: true,
});
const { EditorProvider } = await import("../editor/context.tsx");
const { createTestRuntime, testProject } = await import(
	"../editor/test-runtime.ts"
);
const { RecorderPanel, recorderPanelTab } = await import("./RecorderPanel.tsx");
const { panelsFor } = await import("./registry.tsx");
const { CaptureRecorder } = await import("../recording/screen.ts");

type Dependencies = NonNullable<
	Parameters<typeof RecorderPanel>[0]
>["dependencies"];

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

function mockHost() {
	const calls: string[] = [];
	let state: MediaRecordingResult["state"] = "idle";
	const bridge = (input: MediaRecordingInput) => {
		calls.push(input.action);
		if (input.action === "start") {
			state = "recording";
		} else if (input.action === "stop") {
			state = "pending";
		} else if (input.action === "discard") {
			state = "idle";
		}
		return Promise.resolve({
			available: true,
			background: false,
			state,
			...(state === "idle"
				? {}
				: {
						durationMs: 2000,
						id: "take-1",
						startedAt: new Date().toISOString(),
					}),
			...(input.action === "read"
				? { audio: `data:audio/wav;base64,${btoa("RIFF")}` }
				: {}),
		});
	};
	return { bridge, calls };
}

const importedAudio = {
	createdAt: new Date(0).toISOString(),
	duration: 2,
	folder: "Recordings",
	hasAudio: true,
	height: 0,
	id: crypto.randomUUID(),
	kind: "audio",
	name: "Voiceover",
	width: 0,
};

async function mount(
	runtime: ReturnType<typeof createTestRuntime>,
	dependencies: Dependencies
) {
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	await act(async () => {
		root.render(
			<EditorProvider value={{ ...runtime }}>
				<RecorderPanel dependencies={dependencies} />
			</EditorProvider>
		);
	});
	return {
		host,
		unmount: async () => {
			await act(async () => root.unmount());
			host.remove();
		},
	};
}

const button = (host: HTMLElement, label: string) =>
	Array.from(host.querySelectorAll("button")).find(
		(candidate) => candidate.textContent?.trim() === label
	);

async function click(element: HTMLElement | undefined) {
	if (!element) {
		throw new Error("missing button");
	}
	await act(async () => {
		element.click();
		// Let the recorder's chained host calls and the import settle.
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
}

const instantWait = (_ms: number, signal: AbortSignal) =>
	signal.aborted ? Promise.reject(signal.reason) : Promise.resolve();

describe("RecorderPanel", () => {
	test("has its own Record tab in the registry", () => {
		expect(recorderPanelTab).toEqual({ label: "Record", value: "record" });
		expect(panelsFor("record").map((panel) => panel.id)).toEqual(["recorder"]);
	});

	test("explains when the host has not granted any capture", async () => {
		const { project } = testProject();
		const runtime = createTestRuntime(project);
		const view = await mount(runtime, {
			capture: new CaptureRecorder({ environment: {} }),
			voiceover: { bridge: null },
		});
		const text = view.host.textContent ?? "";
		expect(text).toContain(
			"Ryu has not granted Video Studio microphone capture"
		);
		expect(text).toContain(
			"Ryu has not granted Video Studio screen or camera capture"
		);
		expect(button(view.host, "Record voiceover")).toBeUndefined();
		expect(button(view.host, "Record screen")).toBeUndefined();
		await view.unmount();
	});

	test("a mocked recording produces an asset and a clip at the playhead", async () => {
		const { asset, project } = testProject();
		const runtime = createTestRuntime(project, [asset]);
		runtime.time = 5;
		const host = mockHost();
		const imports: unknown[] = [];
		const view = await mount(runtime, {
			capture: new CaptureRecorder({ environment: {} }),
			importer: {
				importAsset: (body) => {
					imports.push(body);
					return Promise.resolve({ ...importedAudio, name: body.name });
				},
				upload: () => Promise.reject(new Error("unused")),
			},
			voiceover: { bridge: host.bridge, wait: instantWait },
		});
		await click(button(view.host, "Record voiceover"));
		expect(button(view.host, "Stop and add")).toBeDefined();
		await click(button(view.host, "Stop and add"));
		expect(host.calls).toEqual(["status", "start", "stop", "read", "discard"]);
		expect(imports).toHaveLength(1);
		expect(imports[0]).toMatchObject({
			folder: "Recordings",
			source: { bytes: btoa("RIFF"), mimeType: "audio/wav" },
		});
		const clip = runtime.project?.segments.find(
			(segment) => segment.assetId === importedAudio.id
		);
		expect(clip).toMatchObject({ start: 5, track: 1 });
		expect(view.host.textContent).toContain("Voiceover added at 0:05.0.");
		await view.unmount();
	});

	test("draws the count-in over the preview and cancels without recording", async () => {
		const frame = document.createElement("div");
		frame.className = "studio-preview-frame";
		document.body.append(frame);
		const { project } = testProject();
		const runtime = createTestRuntime(project);
		const host = mockHost();
		const view = await mount(runtime, {
			capture: new CaptureRecorder({ environment: {} }),
			voiceover: {
				bridge: host.bridge,
				wait: (_ms, signal) =>
					new Promise((_resolve, reject) => {
						signal.addEventListener("abort", () => reject(signal.reason));
					}),
			},
		});
		await click(button(view.host, "Record voiceover"));
		const overlay = frame.querySelector("[data-recorder-count-in]");
		expect(overlay?.textContent).toBe("3");
		await click(button(view.host, "Cancel"));
		expect(frame.querySelector("[data-recorder-count-in]")).toBeNull();
		expect(button(view.host, "Record voiceover")).toBeDefined();
		expect(host.calls).toEqual(["status"]);
		await view.unmount();
		frame.remove();
	});

	test("plays the timeline from a count-in before the playhead when enabled", async () => {
		const { project } = testProject();
		const runtime = createTestRuntime(project);
		runtime.time = 8;
		const host = mockHost();
		const view = await mount(runtime, {
			capture: new CaptureRecorder({ environment: {} }),
			voiceover: { bridge: host.bridge, wait: instantWait },
		});
		const toggle = view.host.querySelector<HTMLElement>(
			'[aria-label="Play the timeline while recording"]'
		);
		await click(toggle ?? undefined);
		await click(button(view.host, "Record voiceover"));
		expect(runtime.calls).toContainEqual(["setTime", 5]);
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 5));
		});
		expect(runtime.calls).toContainEqual(["setPlaying", true]);
		await view.unmount();
	});

	test("records the screen and places it above the picture at the playhead", async () => {
		const { asset, project } = testProject();
		const runtime = createTestRuntime(project, [asset]);
		runtime.time = 2;
		const track = { addEventListener: () => undefined, stop: () => undefined };
		const screenAsset = {
			...importedAudio,
			duration: 3,
			height: 720,
			id: crypto.randomUUID(),
			kind: "video",
			width: 1280,
		};
		const capture = new CaptureRecorder({
			environment: {
				createRecorder: () => {
					let handlers: Parameters<CaptureMediaRecorder["listen"]>[0] = null;
					let state = "inactive";
					return {
						listen: (next) => {
							handlers = next;
						},
						mimeType: "video/webm",
						start: () => {
							state = "recording";
						},
						get state() {
							return state;
						},
						stop: () => {
							state = "inactive";
							handlers?.data(new Blob(["webm"]));
							handlers?.stop();
						},
					};
				},
				getDisplayMedia: () => Promise.resolve({ getTracks: () => [track] }),
			},
			schedule: () => () => undefined,
		});
		const view = await mount(runtime, {
			capture,
			importer: {
				importAsset: (body) =>
					Promise.resolve({ ...screenAsset, name: body.name }),
				upload: () => Promise.reject(new Error("unused")),
			},
			voiceover: { bridge: null },
		});
		expect(button(view.host, "Record camera")?.disabled).toBe(true);
		await click(button(view.host, "Record screen"));
		await click(button(view.host, "Stop and add"));
		const clip = runtime.project?.segments.find(
			(segment) => segment.assetId === screenAsset.id
		);
		expect(clip).toMatchObject({ start: 2, track: 1 });
		expect(view.host.textContent).toContain(
			"Screen recording added at 0:02.0."
		);
		await view.unmount();
	});
});
