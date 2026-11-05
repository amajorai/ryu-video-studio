import { afterAll, describe, expect, test } from "bun:test";
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
const { createRoot } = await import("react-dom/client");
const { TIMELINE_TAB } = await import("../../../shared/preview-tabs.ts");
const { EditorProvider } = await import("../editor/context.tsx");
const { createTestRuntime, testProject, testVideo } = await import(
	"../editor/test-runtime.ts"
);
const { VIEWER_STORAGE_PREFIX } = await import("../editor/viewer-storage.ts");
const { AssetTile } = await import("../library/AssetTile.tsx");
const { runAction } = await import("../shortcuts/registry.ts");
const { PreviewTabsPanel } = await import("./PreviewTabs.tsx");
const { openAssetInViewer, previewTabsKey } = await import("./source-tabs.ts");

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

function memoryArea() {
	const values = new Map<string, string>();
	return {
		getItem: (key: string) => values.get(key) ?? null,
		removeItem: (key: string) => {
			values.delete(key);
		},
		setItem: (key: string, value: string) => {
			values.set(key, value);
		},
		values,
	};
}

const settle = () =>
	act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 0));
	});

function setup() {
	const { project } = testProject();
	const clip = testVideo("interview.mp4", 20);
	const music = {
		...testVideo("music.mp3", 30),
		id: "music",
		kind: "audio" as const,
	};
	const runtime = createTestRuntime(project, [clip, music]);
	runtime.refresh();
	const area = memoryArea();
	const loads: string[] = [];
	const load = (asset: { id: string }) => {
		loads.push(asset.id);
		return Promise.resolve(new Blob(["media"], { type: "video/mp4" }));
	};
	return { area, clip, load, loads, music, project, runtime };
}

type Setup = ReturnType<typeof setup>;

async function mount({ area, load, runtime }: Setup) {
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	await act(async () => {
		root.render(
			<EditorProvider value={{ ...runtime }}>
				<PreviewTabsPanel load={load} storage={area}>
					<div data-timeline-preview="">Timeline preview</div>
				</PreviewTabsPanel>
			</EditorProvider>
		);
	});
	await settle();
	return {
		host,
		unmount: async () => {
			await act(async () => root.unmount());
			host.remove();
		},
	};
}

const tabs = (host: HTMLElement) =>
	[...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')].map(
		(tab) => tab.dataset.previewTab
	);
const button = (host: HTMLElement, label: string) =>
	[...host.querySelectorAll<HTMLButtonElement>("button")].find(
		(candidate) =>
			candidate.getAttribute("aria-label") === label ||
			candidate.textContent === label
	);

describe("preview tabs", () => {
	test("a source tab plays the asset and closes back to the timeline", async () => {
		const context = setup();
		const view = await mount(context);
		const { host } = view;
		const { clip, loads, runtime } = context;
		expect(tabs(host)).toEqual([TIMELINE_TAB]);
		expect(host.querySelector("[data-timeline-preview]")).not.toBeNull();

		await act(async () => openAssetInViewer(runtime.store, clip.id));
		await settle();
		expect(tabs(host)).toEqual([TIMELINE_TAB, clip.id]);
		expect(host.querySelector("[data-timeline-preview]")).toBeNull();
		const monitor = host.querySelector(`[data-source-asset="${clip.id}"]`);
		expect(monitor).not.toBeNull();
		expect(loads).toEqual([clip.id]);
		expect(host.querySelector("video")?.getAttribute("src")).toStartWith(
			"blob:"
		);
		// Opening a source pauses the timeline.
		expect(runtime.calls).toContainEqual(["setPlaying", false]);

		await act(async () => button(host, "Previous preview tab")?.click());
		expect(runtime.store.getState().previewTabs.active).toBe(TIMELINE_TAB);
		expect(host.querySelector("[data-timeline-preview]")).not.toBeNull();
		await act(async () => button(host, "Next preview tab")?.click());
		expect(runtime.store.getState().previewTabs.active).toBe(clip.id);

		await act(async () => button(host, `Close ${clip.name}`)?.click());
		expect(tabs(host)).toEqual([TIMELINE_TAB]);
		expect(host.querySelector("[data-timeline-preview]")).not.toBeNull();
		await view.unmount();
	});

	test("open tabs are saved per viewer and project and restored", async () => {
		const context = setup();
		const first = await mount(context);
		await act(async () => {
			openAssetInViewer(context.runtime.store, context.clip.id);
			openAssetInViewer(context.runtime.store, context.music.id);
		});
		const saved = JSON.parse(
			context.area.values.get(
				VIEWER_STORAGE_PREFIX + previewTabsKey(context.project.id)
			) ?? "{}"
		);
		expect(saved.tabs).toEqual([context.clip.id, context.music.id]);
		expect(saved.active).toBe(context.music.id);
		await first.unmount();

		const fresh = createTestRuntime(context.project, context.runtime.assets);
		const second = await mount({ ...context, runtime: fresh });
		expect(tabs(second.host)).toEqual([
			TIMELINE_TAB,
			context.clip.id,
			context.music.id,
		]);
		expect(
			second.host.querySelector(`[data-source-asset="${context.music.id}"]`)
		).not.toBeNull();
		await second.unmount();

		// Tabs for media that left the library close on restore.
		const pruned = createTestRuntime(context.project, [context.clip]);
		const third = await mount({ ...context, runtime: pruned });
		expect(tabs(third.host)).toEqual([TIMELINE_TAB, context.clip.id]);
		await third.unmount();
	});

	test("I/O and transport shortcuts drive the active source tab", async () => {
		const context = setup();
		const view = await mount(context);
		const { clip, runtime } = context;
		await act(async () => openAssetInViewer(runtime.store, clip.id));
		await settle();
		const video = view.host.querySelector("video");
		if (!video) {
			throw new Error("source video missing");
		}
		video.currentTime = 4;
		await act(async () => {
			runAction("navigation.markIn", runtime);
		});
		video.currentTime = 9;
		await act(async () => {
			runAction("navigation.markOut", runtime);
		});
		expect(runtime.store.getState().sourceMarks[clip.id]).toEqual({
			in: 4,
			out: 9,
		});
		// The timeline's own range is untouched.
		expect(runtime.calls.some(([name]) => name === "setRangeStart")).toBe(
			false
		);
		expect(view.host.querySelector("[data-source-range]")?.textContent).toBe(
			"Marked 0:04.0–0:09.0"
		);

		await act(async () => {
			runAction("playback.toggle", runtime);
		});
		await settle();
		expect(view.host.querySelector("[data-source-playing]")).not.toBeNull();
		expect(runtime.calls).not.toContainEqual(["setPlaying", true]);
		await act(async () => {
			runAction("playback.pause", runtime);
		});
		expect(view.host.querySelector("[data-source-playing]")).toBeNull();
		await view.unmount();
	});

	test("double-clicking a library tile opens it and shares its marks", async () => {
		const context = setup();
		const { clip, runtime } = context;
		runtime.store.setState({ sourceMarks: { [clip.id]: { in: 2, out: 6 } } });
		const host = document.createElement("div");
		document.body.append(host);
		const root = createRoot(host);
		await act(async () => {
			root.render(
				<EditorProvider value={{ ...runtime }}>
					<AssetTile asset={clip} onDeleted={() => undefined} />
				</EditorProvider>
			);
		});
		expect(host.textContent).toContain("Marked 0:02.0–0:06.0");
		const tile = host.querySelector<HTMLElement>(
			`[data-asset-id="${clip.id}"]`
		);
		await act(async () => {
			tile?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
		});
		expect(runtime.store.getState().previewTabs).toMatchObject({
			active: clip.id,
			tabs: [clip.id],
		});
		await act(async () => root.unmount());
		host.remove();
	});
});
