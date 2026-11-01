import { afterAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

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
const { createTestRuntime, testProject, testVideo } = await import(
	"../editor/test-runtime.ts"
);
const {
	AutoCutPanel,
	autoCutBody,
	autoCutPanelTab,
	autoCutSources,
	autoCutSummary,
	shortsBody,
} = await import("./AutoCutPanel.tsx");
const { PANEL_REGISTRY, panelsFor } = await import("./registry.tsx");
const { newProject } = await import("../../../shared/project.ts");

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

async function render(runtime: Runtime) {
	const element = document.createElement("div");
	document.body.append(element);
	const root = createRoot(element);
	await act(async () => {
		root.render(
			<EditorProvider value={runtime}>
				<AutoCutPanel />
			</EditorProvider>
		);
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

const lastStatus = (runtime: Runtime) =>
	runtime.calls.filter(([name]) => name === "setStatus").at(-1)?.[1];

const audio = {
	...testVideo("song.mp3", 30),
	height: 0,
	kind: "audio" as const,
	width: 0,
};

describe("AutoCut panel helpers", () => {
	test("bodies clamp and omit empty music", () => {
		const body = autoCutBody({
			aspect: "9:16",
			assetIds: ["a"],
			captions: true,
			duration: 2,
			musicAssetId: "",
			style: "smooth",
		});
		expect(body).toEqual({
			aspect: "9:16",
			assetIds: ["a"],
			captions: true,
			duration: 5,
			style: "smooth",
		});
		expect(
			shortsBody(
				{
					aspect: "1:1",
					captions: false,
					count: 2,
					exportShorts: true,
					maxSeconds: 10,
					minSeconds: 20,
				},
				7
			)
		).toEqual({
			aspect: "1:1",
			captions: false,
			count: 2,
			export: true,
			maxSeconds: 20,
			minSeconds: 20,
			revision: 7,
		});
	});

	test("summary and source filter", () => {
		const project = { ...newProject("Recap") };
		expect(
			autoCutSummary({
				beatSource: "detected",
				captions: 4,
				duration: 12,
				project,
				slots: [
					{ end: 6, start: 0 },
					{ end: 12, start: 6 },
				],
				transitions: 1,
			})
		).toBe(
			"Recap: 2 clips over 12.0 s, cut on detected beats, 1 transition, 4 captions."
		);
		const video = testVideo();
		expect(autoCutSources([video, audio])).toEqual([video]);
	});

	test("mounts inside the Highlights tab", () => {
		expect(autoCutPanelTab).toBeNull();
		expect(
			panelsFor("highlights", PANEL_REGISTRY).map((entry) => entry.id)
		).toContain("auto-cut");
	});
});

describe("AutoCut panel", () => {
	test("creates an AutoCut from the chosen sources and music", async () => {
		const { asset, project } = testProject();
		const runtime = createTestRuntime(project, [asset, audio]);
		const created = { ...newProject("AutoCut") };
		const calls: [string, unknown][] = [];
		runtime.api = (path, body) => {
			calls.push([path, body]);
			return Promise.resolve({
				beatSource: "none",
				captions: 0,
				duration: 30,
				project: created,
				slots: [{ end: 30, start: 0 }],
				transitions: 0,
			});
		};
		const view = await render(runtime);
		const create = buttonNamed(view.element, "Create AutoCut");
		expect(create?.disabled).toBe(true);
		const checkbox = view.element.querySelector<HTMLButtonElement>(
			'ul[aria-label="AutoCut sources"] [role="checkbox"]'
		);
		await act(async () => checkbox?.click());
		const music = view.element.querySelector<HTMLSelectElement>(
			'select[aria-label="AutoCut music"]'
		);
		await act(async () => {
			if (music) {
				music.value = audio.id;
				music.dispatchEvent(new Event("change", { bubbles: true }));
			}
		});
		expect(buttonNamed(view.element, "Create AutoCut")?.disabled).toBe(false);
		await act(async () => buttonNamed(view.element, "Create AutoCut")?.click());
		expect(calls).toHaveLength(1);
		expect(calls[0]?.[0]).toBe("/auto-edit");
		expect(calls[0]?.[1]).toMatchObject({
			assetIds: [asset.id],
			duration: 30,
			musicAssetId: audio.id,
			style: "energetic",
		});
		expect(view.element.textContent).toContain("Open AutoCut");
		expect(String(lastStatus(runtime))).toContain(
			"AutoCut: 1 clip over 30.0 s"
		);
		await view.unmount();
	});

	test("makes shorts from the saved project and lists them", async () => {
		const { asset, project } = testProject();
		const runtime = createTestRuntime(project, [asset]);
		const short = { ...newProject("Runtime test · short 1") };
		const calls: [string, unknown][] = [];
		runtime.api = (path, body) => {
			calls.push([path, body]);
			return Promise.resolve({
				revision: project.revision,
				shorts: [
					{
						end: 20,
						project: short,
						reasons: [],
						score: 0.5,
						start: 5,
						title: "Best",
					},
				],
			});
		};
		const view = await render(runtime);
		await act(async () => buttonNamed(view.element, "Make shorts")?.click());
		expect(calls[0]?.[0]).toBe(`/projects/${project.id}/shorts`);
		expect(calls[0]?.[1]).toMatchObject({
			aspect: "9:16",
			captions: true,
			count: 3,
			export: false,
			revision: project.revision,
		});
		const list = view.element.querySelector('ol[aria-label="Created shorts"]');
		expect(list?.textContent).toContain("Runtime test · short 1 · 15.0 s");
		expect(lastStatus(runtime)).toBe("Created 1 short from Runtime test.");
		await view.unmount();
	});

	test("reports route errors", async () => {
		const { asset, project } = testProject();
		const runtime = createTestRuntime(project, [asset]);
		runtime.api = () => Promise.reject(new Error("No highlights fit."));
		const view = await render(runtime);
		await act(async () => buttonNamed(view.element, "Make shorts")?.click());
		expect(lastStatus(runtime)).toBe("No highlights fit.");
		await view.unmount();
	});
});
