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
const { EditorProvider } = await import("../editor/context.tsx");
const { createTestRuntime, lastStatus, testProject, testVideo } = await import(
	"../editor/test-runtime.ts"
);
const { Timeline } = await import("./Timeline.tsx");
const { rulerWindow } = await import("./TimelineRuler.tsx");
const { playheadKeyTarget } = await import("./Playhead.tsx");
const { scrubTime } = await import("./useScrub.ts");
const { defaultZoomAnchor, timelineViewport, zoomTimeline, zoomTimelineToFit } =
	await import("./useTimelineZoom.ts");

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

/** Where time 0 sits inside the scrolled content (header gutter + padding). */
const LANES_OFFSET = 192;
const ZOOM = 70;

function box(left: number, top: number, width: number, height: number) {
	return {
		bottom: top + height,
		height,
		left,
		right: left + width,
		toJSON: () => ({}),
		top,
		width,
		x: left,
		y: top,
	};
}

/** Track 0 holds clips at 0..5 and 6..9 (fps 30, zoom 70). */
function fixture() {
	const asset = testVideo("ruler.mp4", 20);
	const project: Project = {
		...testProject().project,
		markers: [{ id: crypto.randomUUID(), label: "Cue", time: 4 }],
		segments: [
			{ ...newSegment(asset, 0, 0), sourceOut: 5 },
			{ ...newSegment(asset, 6, 0), sourceOut: 3 },
		],
	};
	return createTestRuntime(project, [asset]);
}

async function render(runtime: Runtime) {
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	await act(async () => {
		root.render(
			<EditorProvider value={{ ...runtime }}>
				<Timeline />
			</EditorProvider>
		);
	});
	const scroll = host.querySelector<HTMLElement>(".studio-timeline-scroll");
	const tracks = host.querySelector<HTMLElement>(".studio-tracks");
	const ruler = host.querySelector<HTMLElement>("[data-timeline-ruler]");
	if (!(scroll && tracks && ruler)) {
		throw new Error("Timeline did not render.");
	}
	// Lanes start LANES_OFFSET px into the scrolled content.
	scroll.getBoundingClientRect = () => box(0, 0, 900, 300);
	Object.defineProperty(scroll, "clientWidth", {
		configurable: true,
		value: 900,
	});
	const lanesBox = () => box(LANES_OFFSET - scroll.scrollLeft, 0, 2000, 300);
	tracks.getBoundingClientRect = lanesBox;
	ruler.getBoundingClientRect = lanesBox;
	return {
		host,
		ruler,
		scroll,
		tracks,
		unmount: async () => {
			await act(async () => root.unmount());
			host.remove();
		},
	};
}

/** happy-dom drops WheelEvent modifiers and coordinates; set them directly. */
function wheel(init: {
	clientX?: number;
	ctrlKey?: boolean;
	deltaY: number;
	shiftKey?: boolean;
}) {
	const event = new WheelEvent("wheel", {
		bubbles: true,
		cancelable: true,
		deltaY: init.deltaY,
	});
	for (const [key, value] of Object.entries({
		altKey: false,
		clientX: init.clientX ?? 0,
		ctrlKey: init.ctrlKey ?? false,
		deltaMode: 0,
		deltaX: 0,
		deltaY: init.deltaY,
		metaKey: false,
		shiftKey: init.shiftKey ?? false,
	})) {
		Object.defineProperty(event, key, { configurable: true, value });
	}
	return event;
}

function pointer(
	type: string,
	target: EventTarget,
	x: number,
	extra: PointerEventInit = {}
) {
	target.dispatchEvent(
		new PointerEvent(type, {
			bubbles: true,
			button: 0,
			clientX: x,
			clientY: 20,
			pointerId: 3,
			...extra,
		})
	);
}

const seeks = (runtime: Runtime) =>
	runtime.calls.filter(([name]) => name === "setTime").map(([, time]) => time);

describe("ruler scrubbing", () => {
	test("pressing and dragging on the ruler moves the playhead", async () => {
		const runtime = fixture();
		runtime.playing = true;
		const view = await render(runtime);
		await act(async () => {
			pointer("pointerdown", view.ruler, LANES_OFFSET + 2 * ZOOM);
		});
		expect(runtime.time).toBe(2);
		expect(runtime.playing).toBe(false);
		await act(async () => {
			pointer("pointermove", window, LANES_OFFSET + 3 * ZOOM);
			pointer("pointermove", window, LANES_OFFSET + 3.5 * ZOOM);
			pointer("pointerup", window, LANES_OFFSET + 3.5 * ZOOM);
		});
		expect(seeks(runtime)).toEqual([2, 3, 3.5]);
		await act(async () => {
			pointer("pointermove", window, LANES_OFFSET + 6 * ZOOM);
		});
		expect(runtime.time).toBe(3.5);
		await view.unmount();
	});

	test("scrubbing is frame-quantized and clamped to the timeline", async () => {
		const runtime = fixture();
		const view = await render(runtime);
		await act(async () => {
			pointer("pointerdown", view.ruler, LANES_OFFSET + 1.01 * ZOOM);
			pointer("pointermove", window, LANES_OFFSET + 50 * ZOOM);
			pointer("pointermove", window, 0);
			pointer("pointerup", window, 0);
		});
		expect(seeks(runtime)).toEqual([1, runtime.duration, 0]);
		await view.unmount();
	});

	test("marker flags and the corner controls do not scrub", async () => {
		const runtime = fixture();
		const view = await render(runtime);
		const marker = view.host.querySelector<HTMLElement>(".studio-marker");
		const field = view.host.querySelector<HTMLElement>(
			'[aria-label="Go to timecode"]'
		);
		if (!(marker && field)) {
			throw new Error("Missing marker or timecode field.");
		}
		await act(async () => {
			pointer("pointerdown", marker, LANES_OFFSET + 4 * ZOOM);
			pointer("pointerup", window, LANES_OFFSET + 4 * ZOOM);
			pointer("pointerdown", field, 20);
			pointer("pointerup", window, 20);
		});
		expect(seeks(runtime)).toEqual([]);
		await act(async () => {
			marker.click();
		});
		expect(seeks(runtime)).toEqual([4]);
		await view.unmount();
	});

	test("clicking empty lane space seeks; dragging there does not", async () => {
		const runtime = fixture();
		const view = await render(runtime);
		const lane = view.host.querySelector<HTMLElement>(".studio-track");
		if (!lane) {
			throw new Error("Missing lane.");
		}
		await act(async () => {
			pointer("pointerdown", lane, LANES_OFFSET + 5.5 * ZOOM);
			pointer("pointerup", window, LANES_OFFSET + 5.5 * ZOOM + 1);
		});
		expect(runtime.time).toBe(5.5);
		await act(async () => {
			pointer("pointerdown", lane, LANES_OFFSET + 5.5 * ZOOM);
			pointer("pointermove", window, LANES_OFFSET + 8 * ZOOM);
			pointer("pointerup", window, LANES_OFFSET + 8 * ZOOM);
		});
		expect(seeks(runtime)).toEqual([5.5]);
		await view.unmount();
	});
});

describe("playhead handle", () => {
	test("is an accessible slider that steps by frame, second, and to the ends", async () => {
		const runtime = fixture();
		runtime.time = 2;
		const view = await render(runtime);
		const handle = view.host.querySelector<HTMLElement>(
			'[role="slider"][aria-label="Playhead position"]'
		);
		if (!handle) {
			throw new Error("Missing playhead handle.");
		}
		expect(handle.getAttribute("aria-valuenow")).toBe("2");
		expect(handle.getAttribute("aria-valuemax")).toBe("9");
		expect(handle.getAttribute("aria-valuetext")).toBe("00:00:02:00 (0:02.0)");
		let reachedWindow = 0;
		const onWindowKey = () => {
			reachedWindow += 1;
		};
		window.addEventListener("keydown", onWindowKey);
		await act(async () => {
			handle.dispatchEvent(
				new KeyboardEvent("keydown", { bubbles: true, key: "ArrowRight" })
			);
		});
		window.removeEventListener("keydown", onWindowKey);
		expect(runtime.time).toBeCloseTo(2 + 1 / 30, 9);
		// The slider handled the arrow; the window shortcut did not also run.
		expect(reachedWindow).toBe(0);
		await view.unmount();
	});

	test("dragging the handle scrubs from the lanes origin", async () => {
		const runtime = fixture();
		const view = await render(runtime);
		const handle = view.host.querySelector<HTMLElement>(
			"[data-playhead-handle]"
		);
		if (!handle) {
			throw new Error("Missing playhead handle.");
		}
		await act(async () => {
			pointer("pointerdown", handle, LANES_OFFSET + 1 * ZOOM);
			pointer("pointermove", window, LANES_OFFSET + 7 * ZOOM);
			pointer("pointerup", window, LANES_OFFSET + 7 * ZOOM);
		});
		expect(seeks(runtime)).toEqual([1, 7]);
		await view.unmount();
	});

	test("key targets clamp and quantize", () => {
		const at = { duration: 10, fps: 30, time: 5 };
		expect(playheadKeyTarget("ArrowLeft", false, at)).toBeCloseTo(
			5 - 1 / 30,
			9
		);
		expect(playheadKeyTarget("ArrowRight", true, at)).toBe(6);
		expect(playheadKeyTarget("PageUp", false, at)).toBe(10);
		expect(playheadKeyTarget("PageDown", false, at)).toBe(0);
		expect(playheadKeyTarget("Home", false, at)).toBe(0);
		expect(playheadKeyTarget("End", false, at)).toBe(10);
		expect(playheadKeyTarget("ArrowLeft", true, { ...at, time: 0.5 })).toBe(0);
		expect(playheadKeyTarget("x", false, at)).toBeNull();
	});
});

describe("wheel zoom and pan", () => {
	test("Ctrl+wheel zooms with the time under the pointer fixed", async () => {
		const runtime = fixture();
		const view = await render(runtime);
		const viewportX = LANES_OFFSET + 2 * ZOOM;
		await act(async () => {
			view.scroll.dispatchEvent(
				wheel({ clientX: viewportX, ctrlKey: true, deltaY: -100 })
			);
		});
		const zoom = runtime.store.getState().zoomPxPerSec;
		expect(zoom).toBeGreaterThan(ZOOM);
		// Time under the pointer after the zoom.
		const timeUnderPointer =
			(viewportX + view.scroll.scrollLeft - LANES_OFFSET) / zoom;
		expect(timeUnderPointer).toBeCloseTo(2, 6);
		expect(view.scroll.scrollLeft).toBeGreaterThan(0);
		expect(runtime.store.getState().scrollLeft).toBe(view.scroll.scrollLeft);
		await view.unmount();
	});

	test("a plain wheel leaves the zoom alone; Shift+wheel pans", async () => {
		const runtime = fixture();
		const view = await render(runtime);
		const plain = wheel({ deltaY: 50 });
		await act(async () => {
			view.scroll.dispatchEvent(plain);
		});
		expect(plain.defaultPrevented).toBe(false);
		expect(runtime.store.getState().zoomPxPerSec).toBe(ZOOM);
		await act(async () => {
			view.scroll.dispatchEvent(wheel({ deltaY: 120, shiftKey: true }));
		});
		expect(view.scroll.scrollLeft).toBe(120);
		expect(runtime.store.getState().zoomPxPerSec).toBe(ZOOM);
		await view.unmount();
	});

	test("keyboard zoom keeps an on-screen playhead in place", async () => {
		const runtime = fixture();
		runtime.time = 3;
		const view = await render(runtime);
		expect(timelineViewport(runtime.store)?.scroll).toBe(view.scroll);
		const before = LANES_OFFSET + 3 * ZOOM - view.scroll.scrollLeft;
		await act(async () => {
			zoomTimeline(runtime.store, 140);
		});
		const after = LANES_OFFSET + 3 * 140 - view.scroll.scrollLeft;
		expect(after).toBeCloseTo(before, 6);
		await view.unmount();
	});

	test("Shift+Z at the fit zoom still scrolls back to the start", async () => {
		const runtime = fixture();
		const view = await render(runtime);
		const duration = runtime.duration;
		let fit = 0;
		await act(async () => {
			fit = zoomTimelineToFit(runtime.store, duration);
		});
		expect(runtime.store.getState().zoomPxPerSec).toBe(fit);
		expect(view.scroll.scrollLeft).toBe(0);
		view.scroll.scrollLeft = 250;
		await act(async () => {
			expect(zoomTimelineToFit(runtime.store, duration)).toBe(fit);
		});
		expect(runtime.store.getState().zoomPxPerSec).toBe(fit);
		expect(view.scroll.scrollLeft).toBe(0);
		expect(runtime.store.getState().scrollLeft).toBe(0);
		await view.unmount();
	});
});

describe("timecode field", () => {
	test("Enter seeks to a typed timecode, frames, or seconds", async () => {
		const runtime = fixture();
		const view = await render(runtime);
		const field = view.host.querySelector<HTMLInputElement>(
			'[aria-label="Go to timecode"]'
		);
		if (!field) {
			throw new Error("Missing timecode field.");
		}
		expect(field.value).toBe("00:00:00:00");
		const type = async (text: string) => {
			await act(async () => {
				field.focus();
				const setter = Object.getOwnPropertyDescriptor(
					Object.getPrototypeOf(field),
					"value"
				)?.set;
				if (setter) {
					setter.call(field, text);
				} else {
					field.value = text;
				}
				field.dispatchEvent(new Event("input", { bubbles: true }));
				// React also detects value changes on key events; flush it before Enter.
				field.dispatchEvent(
					new KeyboardEvent("keyup", { bubbles: true, key: "Shift" })
				);
			});
			await act(async () => {
				field.dispatchEvent(
					new KeyboardEvent("keydown", { bubbles: true, key: "Enter" })
				);
			});
		};
		await type("00:00:02:15");
		await type("90");
		await type("1.25s");
		expect(seeks(runtime)).toEqual([2.5, 3, 1.25]);
		await type("nonsense");
		expect(seeks(runtime)).toHaveLength(3);
		expect(String(lastStatus(runtime))).toContain(
			'"nonsense" is not a timecode'
		);
		await view.unmount();
	});
});

describe("ruler geometry", () => {
	test("the canvas window follows the scroll and never exceeds the viewport", () => {
		expect(
			rulerWindow({
				lanesOffset: 192,
				rulerWidth: 5000,
				scrollLeft: 0,
				viewportWidth: 900,
			})
		).toEqual({ left: 0, width: 900 });
		expect(
			rulerWindow({
				lanesOffset: 192,
				rulerWidth: 5000,
				scrollLeft: 1192,
				viewportWidth: 900,
			})
		).toEqual({ left: 1000, width: 900 });
		expect(
			rulerWindow({
				lanesOffset: 192,
				rulerWidth: 1200,
				scrollLeft: 1192,
				viewportWidth: 900,
			})
		).toEqual({ left: 1000, width: 200 });
	});

	test("scrubTime and the default zoom anchor", () => {
		expect(
			scrubTime({ clientX: 240, duration: 10, fps: 25, originX: 100, zoom: 70 })
		).toBe(2);
		expect(
			scrubTime({ clientX: 240, duration: 10, fps: 25, originX: 100, zoom: 0 })
		).toBe(0);
		// Playhead on screen: it is the anchor.
		expect(
			defaultZoomAnchor({
				lanesOffset: 192,
				scrollLeft: 0,
				time: 3,
				viewportWidth: 900,
				zoom: 70,
			})
		).toEqual({ time: 3, viewportX: 402 });
		// Playhead off screen: the viewport center is.
		expect(
			defaultZoomAnchor({
				lanesOffset: 192,
				scrollLeft: 0,
				time: 30,
				viewportWidth: 900,
				zoom: 70,
			})
		).toEqual({ time: (450 - 192) / 70, viewportX: 450 });
	});
});

describe("range selection", () => {
	test("Shift+drag on the ruler marks a range that snaps to clip edges", async () => {
		const runtime = fixture();
		const view = await render(runtime);
		await act(async () => {
			pointer("pointerdown", view.ruler, LANES_OFFSET + 1 * ZOOM, {
				shiftKey: true,
			});
			pointer("pointermove", window, LANES_OFFSET + 4.95 * ZOOM);
			pointer("pointerup", window, LANES_OFFSET + 4.95 * ZOOM);
		});
		expect(runtime.rangeMarked).toBe(true);
		expect(runtime.range.start).toBe(1);
		// 4.95 s is within the snap threshold of the clip edge at 5 s.
		expect(runtime.range.end).toBe(5);
		// The press did not scrub the playhead.
		expect(seeks(runtime)).toEqual([]);
		await view.unmount();
	});

	test("a marked range is drawn with keyboard-operable In and Out edges", async () => {
		const runtime = fixture();
		runtime.range = { end: 4, start: 2 };
		runtime.rangeMarked = true;
		const view = await render(runtime);
		const band = view.host.querySelector<HTMLElement>("[data-timeline-range]");
		expect(band).not.toBeNull();
		expect(band?.style.getPropertyValue("--studio-range-left")).toBe(
			`${2 * ZOOM}px`
		);
		const out = view.host.querySelector<HTMLElement>(
			'[role="slider"][aria-label="Range out"]'
		);
		await act(async () => {
			out?.dispatchEvent(
				new KeyboardEvent("keydown", {
					bubbles: true,
					key: "ArrowRight",
					shiftKey: true,
				})
			);
		});
		expect(runtime.range).toEqual({ end: 5, start: 2 });
		const clear = [...view.host.querySelectorAll("button")].find(
			(button) => button.textContent === "Clear range"
		);
		await act(async () => {
			clear?.click();
		});
		expect(runtime.rangeMarked).toBe(false);
		await view.unmount();
	});

	test("no range band is drawn until a range is marked", async () => {
		const runtime = fixture();
		const view = await render(runtime);
		expect(view.host.querySelector("[data-timeline-range]")).toBeNull();
		await view.unmount();
	});
});

describe("range edge math", () => {
	test("edges stay ordered, apart, and inside the timeline", async () => {
		const { moveRangeEdge, rangeBetween, MIN_RANGE_SECONDS } = await import(
			"./TimelineRange.tsx"
		);
		const range = { end: 4, start: 2 };
		expect(moveRangeEdge(range, "start", 5, 10)).toEqual({
			end: 4,
			start: 4 - MIN_RANGE_SECONDS,
		});
		expect(moveRangeEdge(range, "end", 20, 10)).toEqual({ end: 10, start: 2 });
		expect(moveRangeEdge(range, "start", -3, 10)).toEqual({ end: 4, start: 0 });
		expect(rangeBetween(6, 3, 10)).toEqual({ end: 6, start: 3 });
		expect(rangeBetween(3, 3, 10)).toEqual({
			end: 3 + MIN_RANGE_SECONDS,
			start: 3,
		});
	});
});
