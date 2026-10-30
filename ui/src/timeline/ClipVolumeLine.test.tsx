import { afterAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
	type Asset,
	type Keyframe,
	newSegment,
	type Project,
	segmentDuration,
} from "../../../shared/project.ts";

// React DOM decides at import time which events exist, so it loads after
// the DOM is registered.
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
const { Timeline } = await import("./Timeline.tsx");
const { selectClips } = await import("../editor/actions/select.ts");
const { CLIP_ID_ATTRIBUTE } = await import("./clip-drag.ts");
const { VOLUME_POINTS_ATTRIBUTE } = await import("./ClipVolumeLine.tsx");
const { VOLUME_LINE_HEIGHT, lineDragDeltaDb, volumeLineY } = await import(
	"../keyframes/volume-line.ts"
);
const { gainToDb } = await import("../../../shared/decibels.ts");

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

type Runtime = ReturnType<typeof createTestRuntime>;
const ZOOM = 70;
const LEFT = 100;
const TOP = 50;

async function render(runtime: Runtime) {
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	const draw = async () => {
		await act(async () => {
			root.render(
				<EditorProvider value={{ ...runtime }}>
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

const audio: Asset = {
	createdAt: new Date(0).toISOString(),
	duration: 20,
	hasAudio: true,
	height: 0,
	id: crypto.randomUUID(),
	kind: "audio",
	name: "voice.wav",
	width: 0,
};

function fixture(keyframes: Keyframe[] = []) {
	const clip = { ...newSegment(audio, 0, 0), keyframes, sourceOut: 4 };
	const project: Project = { ...testProject().project, segments: [clip] };
	const runtime = createTestRuntime(project, [audio]);
	runtime.zoom = ZOOM;
	return { clip, runtime };
}

/** The clip element, with a 32px-tall box at its timeline position. */
function clipElement(host: HTMLElement, runtime: Runtime) {
	const segment = runtime.project?.segments[0];
	const element = host.querySelector<HTMLElement>(`[${CLIP_ID_ATTRIBUTE}]`);
	if (!(element && segment)) {
		throw new Error("The clip is not rendered.");
	}
	const width = segmentDuration(segment) * ZOOM;
	element.getBoundingClientRect = () =>
		({
			bottom: TOP + VOLUME_LINE_HEIGHT,
			height: VOLUME_LINE_HEIGHT,
			left: LEFT,
			right: LEFT + width,
			top: TOP,
			width,
			x: LEFT,
			y: TOP,
		}) as DOMRect;
	return element;
}

function pointer(
	type: string,
	target: EventTarget,
	x: number,
	y: number,
	extra: PointerEventInit = {}
) {
	target.dispatchEvent(
		new PointerEvent(type, {
			bubbles: true,
			button: 0,
			cancelable: true,
			clientX: x,
			clientY: y,
			pointerId: 9,
			...extra,
		})
	);
}

const volumeKeys = (runtime: Runtime) =>
	(runtime.project?.segments[0]?.keyframes ?? [])
		.filter((frame) => frame.property === "volume")
		.sort((a, b) => a.time - b.time);

function query(host: HTMLElement, selector: string): HTMLElement {
	const found = host.querySelector<HTMLElement>(selector);
	if (!found) {
		throw new Error(`Nothing matches ${selector}.`);
	}
	return found;
}

const editLabels = (runtime: Runtime) =>
	runtime.calls.filter(([name]) => name === "edit").map(([, label]) => label);

describe("ClipVolumeLine", () => {
	test("audible clips draw the line at their volume", async () => {
		const { runtime } = fixture();
		const view = await render(runtime);
		const line = view.host.querySelector("[data-volume-line] polyline");
		const y = volumeLineY(runtime.project?.segments[0] as never, 0);
		expect(
			line?.getAttribute("points")?.startsWith(`0.00,${y.toFixed(2)}`)
		).toBe(true);
		await view.unmount();
	});

	test("Cmd-click on the line adds a volume keyframe without changing the volume", async () => {
		const { clip, runtime } = fixture();
		selectClips(runtime, [clip.id]);
		const view = await render(runtime);
		const element = clipElement(view.host, runtime);
		const lineY = volumeLineY(clip, 2);
		const press = (y: number) =>
			act(async () => {
				// Well off the line but within its grab tolerance.
				pointer("pointerdown", element, LEFT + 2 * ZOOM, TOP + y, {
					metaKey: true,
				});
				pointer("pointerup", element, LEFT + 2 * ZOOM, TOP + y, {
					metaKey: true,
				});
				element.click();
			});
		await press(lineY + 4.9);
		const keys = volumeKeys(runtime);
		expect(keys).toHaveLength(1);
		expect(keys[0]?.time).toBe(2);
		// The un-animated clip stays at unity gain everywhere.
		expect(keys[0]?.value).toBe(1);
		expect(runtime.project?.segments[0]?.volume).toBe(1);
		expect(editLabels(runtime)).toEqual(["Add volume keyframe"]);
		// The press stayed with the line: no clip drag, selection kept.
		expect(runtime.store.getState().drag).toBeNull();
		expect(runtime.selectedIds).toEqual([clip.id]);
		// A second click on the same frame lands on that keyframe.
		await view.draw();
		await press(lineY - 4);
		expect(volumeKeys(runtime)).toHaveLength(1);
		expect(editLabels(runtime)).toEqual(["Add volume keyframe"]);
		await view.unmount();
	});

	test("the handle and points hide while the clip is dragged", async () => {
		const first: Keyframe = {
			id: crypto.randomUUID(),
			property: "volume",
			time: 1,
			value: 1,
		};
		const { clip, runtime } = fixture([first]);
		selectClips(runtime, [clip.id]);
		const view = await render(runtime);
		expect(view.host.querySelector("[data-volume-handle]")).not.toBeNull();
		expect(view.host.querySelector("[data-volume-point]")).not.toBeNull();
		const element = clipElement(view.host, runtime);
		const y = TOP + volumeLineY(clip, 1);
		await act(async () => {
			pointer("pointerdown", element, LEFT + 2 * ZOOM, y);
			pointer("pointermove", element, LEFT + 3 * ZOOM, y);
		});
		expect(runtime.store.getState().drag?.ids).toContain(clip.id);
		expect(view.host.querySelector("[data-volume-handle]")).toBeNull();
		expect(view.host.querySelector("[data-volume-point]")).toBeNull();
		await act(async () => {
			pointer("pointerup", element, LEFT + 3 * ZOOM, y);
		});
		expect(view.host.querySelector("[data-volume-handle]")).not.toBeNull();
		await view.unmount();
	});

	test("dragging the line handle sets the static volume as one edit", async () => {
		const { clip, runtime } = fixture();
		selectClips(runtime, [clip.id]);
		const view = await render(runtime);
		const handle = query(view.host, "[data-volume-handle]");
		expect(handle.closest(".studio-timeline-clip")).toBeNull();
		await act(async () => {
			pointer("pointerdown", handle, 300, 100);
			pointer("pointermove", handle, 300, 106);
		});
		// Live readout while dragging; nothing saved yet.
		expect(
			view.host.querySelector("[data-volume-line]")?.textContent
		).toContain("dB");
		expect(editLabels(runtime)).toEqual([]);
		await act(async () => {
			pointer("pointerup", handle, 300, 106);
		});
		const volume = runtime.project?.segments[0]?.volume ?? 1;
		expect(volume).toBeLessThan(1);
		expect(gainToDb(volume)).toBeCloseTo(lineDragDeltaDb(6), 0);
		expect(editLabels(runtime)).toEqual(["Clip volume"]);
		expect(runtime.project?.segments[0]?.start).toBe(0);
		await view.draw();
		await act(async () => {
			query(view.host, "[data-volume-handle]").dispatchEvent(
				new KeyboardEvent("keydown", { bubbles: true, key: "ArrowUp" })
			);
		});
		expect(gainToDb(runtime.project?.segments[0]?.volume ?? 0)).toBeCloseTo(
			Math.round((gainToDb(volume) + 1) * 10) / 10,
			3
		);
		await view.unmount();
	});

	test("a plain press on the line still moves the clip", async () => {
		const { clip, runtime } = fixture();
		selectClips(runtime, [clip.id]);
		const view = await render(runtime);
		const element = clipElement(view.host, runtime);
		const y = TOP + volumeLineY(clip, 1);
		await act(async () => {
			pointer("pointerdown", element, LEFT + 2 * ZOOM, y);
			pointer("pointermove", element, LEFT + 3 * ZOOM, y);
			pointer("pointerup", element, LEFT + 3 * ZOOM, y);
		});
		expect(runtime.project?.segments[0]?.start).toBe(1);
		expect(volumeKeys(runtime)).toEqual([]);
		expect(runtime.project?.segments[0]?.volume).toBe(1);
		await view.unmount();
	});

	test("presses away from the line, or on unselected clips, reach the clip", async () => {
		const { clip, runtime } = fixture();
		const view = await render(runtime);
		const element = clipElement(view.host, runtime);
		const y = TOP + volumeLineY(clip, 1);
		await act(async () => {
			pointer("pointerdown", element, LEFT + ZOOM, y, { metaKey: true });
			pointer("pointerup", element, LEFT + ZOOM, y, { metaKey: true });
		});
		expect(volumeKeys(runtime)).toEqual([]);
		selectClips(runtime, [clip.id]);
		await view.draw();
		const selectedElement = clipElement(view.host, runtime);
		await act(async () => {
			pointer("pointerdown", selectedElement, LEFT + ZOOM, y + 12, {
				metaKey: true,
			});
			pointer("pointerup", selectedElement, LEFT + ZOOM, y + 12, {
				metaKey: true,
			});
		});
		expect(volumeKeys(runtime)).toEqual([]);
		await view.unmount();
	});

	test("volume keyframe points move with the keyboard and delete", async () => {
		const first: Keyframe = {
			id: crypto.randomUUID(),
			property: "volume",
			time: 1,
			value: 1,
		};
		const { clip, runtime } = fixture([first]);
		selectClips(runtime, [clip.id]);
		const view = await render(runtime);
		const point = view.host.querySelector<HTMLButtonElement>(
			`[${VOLUME_POINTS_ATTRIBUTE}="${clip.id}"] [data-volume-point]`
		);
		if (!point) {
			throw new Error("No volume point.");
		}
		expect(point.closest(".studio-timeline-clip")).toBeNull();
		expect(point.getAttribute("aria-label")).toBe(
			"Volume keyframe at 0:01.0, 0.0 dB"
		);
		await act(async () => {
			point.dispatchEvent(
				new KeyboardEvent("keydown", { bubbles: true, key: "ArrowUp" })
			);
		});
		expect(volumeKeys(runtime)[0]?.value).toBeGreaterThan(1);
		await view.draw();
		const moved = view.host.querySelector<HTMLButtonElement>(
			"[data-volume-point]"
		);
		await act(async () => {
			moved?.dispatchEvent(
				new KeyboardEvent("keydown", { bubbles: true, key: "Delete" })
			);
		});
		expect(volumeKeys(runtime)).toEqual([]);
		expect(editLabels(runtime)).toEqual([
			"Move volume keyframe",
			"Delete volume keyframe",
		]);
		await view.unmount();
	});

	test("dragging an animated line offsets its keyframes", async () => {
		const keys: Keyframe[] = [
			{ id: crypto.randomUUID(), property: "volume", time: 0, value: 1 },
			{ id: crypto.randomUUID(), property: "volume", time: 3, value: 0.5 },
		];
		const { clip, runtime } = fixture(keys);
		selectClips(runtime, [clip.id]);
		const view = await render(runtime);
		const handle = query(view.host, "[data-volume-handle]");
		await act(async () => {
			pointer("pointerdown", handle, 0, 100);
			pointer("pointermove", handle, 0, 104);
			pointer("pointerup", handle, 0, 104);
		});
		const after = volumeKeys(runtime);
		const delta = lineDragDeltaDb(4);
		expect(gainToDb(after[0]?.value ?? 0)).toBeCloseTo(delta, 0);
		expect(gainToDb(after[1]?.value ?? 0) - gainToDb(0.5)).toBeCloseTo(
			delta,
			0
		);
		expect(editLabels(runtime)).toEqual(["Volume line"]);
		await view.unmount();
	});
});
