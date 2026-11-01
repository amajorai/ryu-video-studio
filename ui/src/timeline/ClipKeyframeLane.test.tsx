import { afterAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
	type Asset,
	type Keyframe,
	newSegment,
	type Project,
	updateTrackSetting,
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
const { createTestRuntime, testProject, testVideo } = await import(
	"../editor/test-runtime.ts"
);
const { Timeline } = await import("./Timeline.tsx");
const { selectClips } = await import("../editor/actions/select.ts");
const { KEYFRAME_LANES_ATTRIBUTE } = await import("./ClipKeyframeLane.tsx");
const { GRAPH_ROW_PX, LANE_INSET_PX } = await import(
	"../keyframes/lane-math.ts"
);

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

const frame = (
	property: Keyframe["property"],
	time: number,
	value: number,
	extra: Partial<Keyframe> = {}
): Keyframe => ({ id: crypto.randomUUID(), property, time, value, ...extra });

/** One 4-second clip with opacity (1 → 0 at 1 s → 3 s) and a volume key. */
function fixture() {
	const asset: Asset = testVideo("lanes.mp4", 20);
	const clip = {
		...newSegment(asset, 0, 0),
		keyframes: [
			frame("opacity", 1, 1),
			frame("opacity", 3, 0),
			frame("volume", 2, 0.5),
		],
		sourceOut: 4,
	};
	const project: Project = { ...testProject().project, segments: [clip] };
	const runtime = createTestRuntime(project, [asset]);
	runtime.zoom = ZOOM;
	runtime.time = 10;
	return { clip, runtime };
}

const keyframesOf = (runtime: Runtime, property: Keyframe["property"]) =>
	(runtime.project?.segments[0]?.keyframes ?? [])
		.filter((item) => item.property === property)
		.sort((a, b) => a.time - b.time);

const editLabels = (runtime: Runtime) =>
	runtime.calls.filter(([name]) => name === "edit").map(([, label]) => label);

function pointer(
	type: string,
	target: EventTarget,
	x: number,
	y = 0,
	extra: PointerEventInit = {}
) {
	target.dispatchEvent(
		new PointerEvent(type, {
			bubbles: true,
			button: 0,
			clientX: x,
			clientY: y,
			pointerId: 7,
			...extra,
		})
	);
}

function query<T extends Element>(host: HTMLElement, selector: string): T {
	const found = host.querySelector<T>(selector);
	if (!found) {
		throw new Error(`Nothing matches ${selector}.`);
	}
	return found;
}

async function expand(view: Awaited<ReturnType<typeof render>>, id: string) {
	const toggle = query<HTMLButtonElement>(
		view.host,
		`[${KEYFRAME_LANES_ATTRIBUTE}="${id}"] [data-keyframe-toggle]`
	);
	await act(async () => toggle.click());
	return toggle;
}

const diamonds = (host: HTMLElement, lane: string) => [
	...host.querySelectorAll<HTMLButtonElement>(
		`[data-keyframe-lane="${lane}"] [data-keyframe-diamond]`
	),
];

describe("ClipKeyframeLane", () => {
	test("the clip shows decorative diamonds; the toggle opens one lane per channel", async () => {
		const { clip, runtime } = fixture();
		const view = await render(runtime);
		// Unselected: diamonds only, no toggle.
		const strip = query<HTMLElement>(view.host, "[data-keyframe-strip]");
		expect(strip.getAttribute("aria-hidden")).toBe("true");
		expect(strip.children).toHaveLength(3);
		expect(view.host.querySelector("[data-keyframe-toggle]")).toBeNull();
		selectClips(runtime, [clip.id]);
		await view.draw();
		const toggle = await expand(view, clip.id);
		// The toggle is a real control outside the clip's button.
		expect(toggle.closest(".studio-timeline-clip")).toBeNull();
		expect(toggle.getAttribute("aria-expanded")).toBe("true");
		const lanes = [
			...view.host.querySelectorAll<HTMLElement>("[data-keyframe-lane]"),
		].map((lane) => lane.dataset.keyframeLane);
		expect(lanes).toEqual(["opacity", "volume"]);
		const opacity = diamonds(view.host, "opacity");
		expect(opacity).toHaveLength(2);
		expect(opacity[0]?.style.left).toBe(`${1 * ZOOM - 5}px`);
		expect(opacity[0]?.getAttribute("aria-label")).toContain(
			"Opacity keyframe"
		);
		await view.unmount();
	});

	test("dragging a diamond moves the keyframe in time and saves the channel", async () => {
		const { clip, runtime } = fixture();
		selectClips(runtime, [clip.id]);
		const view = await render(runtime);
		await expand(view, clip.id);
		const diamond = diamonds(view.host, "opacity")[0] as HTMLButtonElement;
		await act(async () => {
			pointer("pointerdown", diamond, 200);
			pointer("pointermove", diamond, 200 + 0.5 * ZOOM);
		});
		// Live preview before the release; nothing saved yet.
		expect(diamonds(view.host, "opacity")[0]?.style.left).toBe(
			`${1.5 * ZOOM - 5}px`
		);
		expect(editLabels(runtime)).toEqual([]);
		await act(async () => {
			pointer("pointerup", diamond, 200 + 0.5 * ZOOM);
		});
		expect(keyframesOf(runtime, "opacity").map((item) => item.time)).toEqual([
			1.5, 3,
		]);
		// Other channels are untouched.
		expect(keyframesOf(runtime, "volume").map((item) => item.time)).toEqual([
			2,
		]);
		expect(editLabels(runtime)).toEqual(["Move keyframe"]);
		// No clip drag or selection change came from the press.
		expect(runtime.store.getState().drag).toBeNull();
		expect(runtime.selectedIds).toEqual([clip.id]);
		await view.unmount();
	});

	test("a diamond drag snaps to the playhead and never passes its neighbour", async () => {
		const { clip, runtime } = fixture();
		runtime.time = 2.02;
		selectClips(runtime, [clip.id]);
		const view = await render(runtime);
		await expand(view, clip.id);
		const diamond = diamonds(view.host, "opacity")[0] as HTMLButtonElement;
		await act(async () => {
			pointer("pointerdown", diamond, 100);
			pointer("pointermove", diamond, 100 + 1.05 * ZOOM);
			pointer("pointerup", diamond, 100 + 1.05 * ZOOM);
		});
		expect(keyframesOf(runtime, "opacity")[0]?.time).toBe(2.02);
		await view.draw();
		const moved = diamonds(view.host, "opacity")[0] as HTMLButtonElement;
		await act(async () => {
			pointer("pointerdown", moved, 100);
			pointer("pointermove", moved, 100 + 5 * ZOOM);
			pointer("pointerup", moved, 100 + 5 * ZOOM);
		});
		const times = keyframesOf(runtime, "opacity").map((item) => item.time);
		expect(times[0]).toBeCloseTo(3 - 1 / 30, 6);
		expect(times[1]).toBe(3);
		await view.unmount();
	});

	test("the graph view drags value vertically", async () => {
		const { clip, runtime } = fixture();
		selectClips(runtime, [clip.id]);
		const view = await render(runtime);
		await expand(view, clip.id);
		const graph = [...view.host.querySelectorAll("button")].find(
			(button) => button.textContent === "Graph"
		);
		await act(async () => graph?.click());
		expect(
			view.host.querySelector('[data-keyframe-lane="opacity"] polyline')
		).not.toBeNull();
		const diamond = diamonds(view.host, "opacity")[1] as HTMLButtonElement;
		const usable = GRAPH_ROW_PX - 2 * LANE_INSET_PX;
		await act(async () => {
			pointer("pointerdown", diamond, 300, 400);
			pointer("pointermove", diamond, 300, 400 - usable / 2);
			pointer("pointerup", diamond, 300, 400 - usable / 2);
		});
		const last = keyframesOf(runtime, "opacity")[1];
		expect(last?.time).toBe(3);
		expect(last?.value).toBeCloseTo(0.5, 3);
		await view.unmount();
	});

	test("Delete removes the focused keyframe and arrows nudge by a frame", async () => {
		const { clip, runtime } = fixture();
		selectClips(runtime, [clip.id]);
		const view = await render(runtime);
		await expand(view, clip.id);
		const key = (target: HTMLElement, name: string) =>
			act(async () => {
				target.dispatchEvent(
					new KeyboardEvent("keydown", { bubbles: true, key: name })
				);
			});
		await key(
			diamonds(view.host, "opacity")[1] as HTMLButtonElement,
			"ArrowLeft"
		);
		expect(keyframesOf(runtime, "opacity")[1]?.time).toBeCloseTo(3 - 1 / 30, 6);
		await view.draw();
		await key(diamonds(view.host, "volume")[0] as HTMLButtonElement, "Delete");
		expect(keyframesOf(runtime, "volume")).toEqual([]);
		expect(editLabels(runtime)).toEqual(["Move keyframe", "Delete keyframe"]);
		await view.draw();
		expect(
			[...view.host.querySelectorAll("[data-keyframe-lane]")].map(
				(lane) => (lane as HTMLElement).dataset.keyframeLane
			)
		).toEqual(["opacity"]);
		await view.unmount();
	});

	test("global shortcuts still reach the window from inside the lanes", async () => {
		const { clip, runtime } = fixture();
		selectClips(runtime, [clip.id]);
		const view = await render(runtime);
		await expand(view, clip.id);
		const seen: string[] = [];
		const listener = (event: KeyboardEvent) => {
			seen.push(`${event.metaKey ? "Meta+" : ""}${event.key}`);
		};
		window.addEventListener("keydown", listener);
		const press = (target: HTMLElement, init: KeyboardEventInit) =>
			act(async () => {
				target.dispatchEvent(
					new KeyboardEvent("keydown", { bubbles: true, ...init })
				);
			});
		try {
			const lanesButton = [...view.host.querySelectorAll("button")].find(
				(button) => button.textContent === "Lanes"
			) as HTMLButtonElement;
			const diamond = diamonds(view.host, "opacity")[0] as HTMLButtonElement;
			diamond.focus();
			await press(diamond, { key: "z", metaKey: true });
			await press(lanesButton, { key: "z", metaKey: true });
			await press(diamond, { key: "j" });
			// Alt+Arrow (the clip's nudge) stays inside the lanes.
			await press(diamond, { altKey: true, key: "ArrowLeft" });
		} finally {
			window.removeEventListener("keydown", listener);
		}
		expect(seen).toEqual(["Meta+z", "Meta+z", "j"]);
		expect(runtime.project?.segments[0]?.start).toBe(clip.start);
		await view.unmount();
	});

	test("a curve preset from the graph editor sets the interpolation", async () => {
		const { clip, runtime } = fixture();
		selectClips(runtime, [clip.id]);
		const view = await render(runtime);
		await expand(view, clip.id);
		const first = diamonds(view.host, "opacity")[0] as HTMLButtonElement;
		await act(async () => {
			pointer("pointerdown", first, 70);
			pointer("pointerup", first, 70);
		});
		expect(
			diamonds(view.host, "opacity")[0]?.getAttribute("aria-pressed")
		).toBe("true");
		const curve = [...view.host.querySelectorAll("button")].find(
			(button) => button.textContent === "Curve"
		);
		expect(curve?.disabled).toBe(false);
		await act(async () => curve?.click());
		const pop = document.querySelector<HTMLButtonElement>(
			'[data-easing-preset="pop"]'
		);
		if (!pop) {
			throw new Error("The graph editor did not open.");
		}
		await act(async () => pop.click());
		expect(keyframesOf(runtime, "opacity")[0]).toMatchObject({
			bezier: [0.34, 1.56, 0.64, 1],
			interpolation: "bezier",
			time: 1,
		});
		expect(editLabels(runtime)).toEqual(["Keyframe curve"]);
		await view.unmount();
	});

	test("locked clips show lanes read-only", async () => {
		const { clip, runtime } = fixture();
		runtime.project = updateTrackSetting(runtime.project as Project, 0, {
			locked: true,
		});
		runtime.refresh();
		selectClips(runtime, [clip.id]);
		const view = await render(runtime);
		await expand(view, clip.id);
		const diamond = diamonds(view.host, "opacity")[0] as HTMLButtonElement;
		await act(async () => {
			diamond.dispatchEvent(
				new KeyboardEvent("keydown", { bubbles: true, key: "Delete" })
			);
			pointer("pointerdown", diamond, 0);
			pointer("pointermove", diamond, 100);
			pointer("pointerup", diamond, 100);
		});
		expect(keyframesOf(runtime, "opacity")).toHaveLength(2);
		expect(editLabels(runtime)).toEqual([]);
		await view.unmount();
	});
});
