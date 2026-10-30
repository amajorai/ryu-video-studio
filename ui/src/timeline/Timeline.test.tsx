import { afterAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { newSegment, type Project } from "../../../shared/project.ts";

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
// happy-dom has no layout: give the timeline viewport a real width.
const VIEWPORT_WIDTH = 1000;
const clientWidth = Object.getOwnPropertyDescriptor(
	HTMLElement.prototype,
	"clientWidth"
);
Object.defineProperty(HTMLElement.prototype, "clientWidth", {
	configurable: true,
	get(this: HTMLElement) {
		return this.classList.contains("studio-timeline-scroll")
			? VIEWPORT_WIDTH
			: 0;
	},
});
const { EditorProvider } = await import("../editor/context.tsx");
const { createTestRuntime, testProject, testVideo } = await import(
	"../editor/test-runtime.ts"
);
const { Timeline } = await import("./Timeline.tsx");
const { timelineColorStore } = await import("./timeline-colors.ts");

afterAll(() => {
	if (clientWidth) {
		Object.defineProperty(HTMLElement.prototype, "clientWidth", clientWidth);
	}
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

type Runtime = ReturnType<typeof createTestRuntime>;

/** Viewport plus one scroll bucket plus overscan on both sides, in pixels. */
const MOUNTED_PX = VIEWPORT_WIDTH + 400 + 800 * 2;

async function render(runtime: Runtime) {
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	const draw = async (value: Runtime = runtime) => {
		await act(async () => {
			root.render(
				<EditorProvider value={{ ...value }}>
					<Timeline />
				</EditorProvider>
			);
		});
	};
	await draw();
	return {
		draw,
		host,
		unmount: async () => {
			await act(async () => root.unmount());
			host.remove();
		},
	};
}

/** `count` half-second clips on track 0 and a full-length clip on track 1. */
function longTimeline(count: number) {
	const asset = testVideo("long.mp4", 4000);
	const clips = Array.from({ length: count }, (_, index) => ({
		...newSegment(asset, index * 0.5, 0),
		sourceIn: 0,
		sourceOut: 0.5,
	}));
	const bed = { ...newSegment(asset, 0, 1), sourceOut: count * 0.5 };
	const project: Project = {
		...testProject().project,
		segments: [...clips, bed],
	};
	const runtime = createTestRuntime(project, [asset]);
	runtime.zoom = 70;
	runtime.refresh();
	return { bed, clips, runtime };
}

function clipNodes(host: HTMLElement) {
	return [...host.querySelectorAll<HTMLButtonElement>(".studio-timeline-clip")];
}

/** Whether a clip starting at `start` is mounted (track 0 unless given). */
function mountedAt(host: HTMLElement, start: number, track = 0) {
	const lane = host.querySelectorAll<HTMLElement>(".studio-track")[track];
	return [
		...(lane?.querySelectorAll<HTMLButtonElement>(".studio-timeline-clip") ??
			[]),
	].some((button) =>
		button.getAttribute("aria-label")?.includes(`at ${start.toFixed(2)} `)
	);
}

function clipAt(host: HTMLElement, start: number) {
	return clipNodes(host).find((button) =>
		button.getAttribute("aria-label")?.includes(`at ${start.toFixed(2)} `)
	);
}

describe("timeline virtualization", () => {
	test("a 5000-clip timeline mounts only the clips near the viewport", async () => {
		const { runtime } = longTimeline(5000);
		const view = await render(runtime);
		const nodes = clipNodes(view.host);
		// Track 0 mounts the window (two clips per second); track 1 its bed.
		const limit = Math.ceil((MOUNTED_PX / runtime.zoom) * 2) + 2 + 1;
		expect(nodes.length).toBeLessThanOrEqual(limit);
		expect(nodes.length).toBeGreaterThan(20);
		expect(mountedAt(view.host, 0)).toBe(true);
		expect(mountedAt(view.host, 1000)).toBe(false);
		// The full-length clip on track 1 crosses the window and stays.
		expect(mountedAt(view.host, 0, 1)).toBe(true);
		const lane = view.host.querySelector<HTMLElement>(
			'.studio-track[data-clip-count="5000"]'
		);
		expect(Number(lane?.dataset.mountedClips)).toBeLessThan(100);
		await view.unmount();
	});

	test("scrolling mounts the clips of the new window", async () => {
		const { runtime } = longTimeline(5000);
		const view = await render(runtime);
		await act(async () => {
			runtime.store.setState({ scrollLeft: 1000 * runtime.zoom });
		});
		expect(mountedAt(view.host, 0)).toBe(false);
		expect(mountedAt(view.host, 1000)).toBe(true);
		expect(mountedAt(view.host, 0, 1)).toBe(true);
		expect(clipNodes(view.host).length).toBeLessThan(100);
		await view.unmount();
	});

	test("selected clips stay mounted outside the window", async () => {
		const { clips, runtime } = longTimeline(5000);
		const far = clips[4000];
		expect(far).toBeDefined();
		runtime.setSelected(far?.id ?? null);
		const view = await render(runtime);
		expect(mountedAt(view.host, 2000)).toBe(true);
		expect(mountedAt(view.host, 1999.5)).toBe(false);
		await view.unmount();
	});

	test("short timelines mount every clip", async () => {
		const { runtime } = longTimeline(60);
		const view = await render(runtime);
		expect(clipNodes(view.host)).toHaveLength(61);
		await view.unmount();
	});
});

describe("memoized lanes", () => {
	test("clip handlers use the latest runtime after a lane skips a render", async () => {
		const { runtime } = longTimeline(200);
		const view = await render(runtime);
		const seen: number[] = [];
		await view.draw({
			...runtime,
			setTime: (time: number) => {
				seen.push(time);
			},
			time: 3,
		});
		const target = clipAt(view.host, 2);
		expect(target === undefined).toBe(false);
		await act(async () => {
			target?.click();
		});
		expect(seen).toEqual([2]);
		expect(runtime.store.getState().selection.segmentIds).toHaveLength(1);
		await view.unmount();
	});
});

describe("timeline colors", () => {
	test("kind colors reach the tracks and untagged clips carry their kind", async () => {
		const { runtime } = longTimeline(3);
		const tagged = runtime.project?.segments[0];
		if (!(runtime.project && tagged)) {
			throw new Error("project missing");
		}
		runtime.project = {
			...runtime.project,
			segments: runtime.project.segments.map((segment) =>
				segment.id === tagged.id ? { ...segment, color: "teal" } : segment
			),
		};
		runtime.refresh();
		const view = await render(runtime);
		const tracks = view.host.querySelector<HTMLElement>(".studio-tracks");
		expect(tracks?.style.getPropertyValue("--studio-clip-kind-video")).toBe(
			"#3e63dd"
		);
		await act(async () => {
			timelineColorStore.setColor("video", "#101010");
		});
		expect(tracks?.style.getPropertyValue("--studio-clip-kind-video")).toBe(
			"#101010"
		);
		const clips = clipNodes(view.host);
		expect(clips.every((clip) => clip.dataset.clipKind === "video")).toBe(true);
		expect(
			clips.filter((clip) => clip.dataset.colorTag === "teal")
		).toHaveLength(1);
		await act(async () => {
			timelineColorStore.reset();
		});
		await view.unmount();
	});
});
