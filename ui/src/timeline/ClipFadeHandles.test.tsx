import { afterAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";
import {
	type Asset,
	newSegment,
	type Project,
	segmentDuration,
} from "../../../shared/project.ts";

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
const { createTestRuntime, testProject, testVideo } = await import(
	"../editor/test-runtime.ts"
);
const { Timeline } = await import("./Timeline.tsx");
const { selectClips } = await import("../editor/actions/select.ts");
const { CLIP_ID_ATTRIBUTE, TRACK_ROW_PX } = await import("./clip-drag.ts");
const { FADE_KNEES_ATTRIBUTE } = await import("./ClipFadeHandles.tsx");

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

/** The clip element of `id`, with a real box at its timeline position. */
function clipElement(host: HTMLElement, project: Project, id: string) {
	const element = host.querySelector<HTMLElement>(
		`[${CLIP_ID_ATTRIBUTE}="${id}"]`
	);
	const segment = project.segments.find((candidate) => candidate.id === id);
	if (!(element && segment)) {
		throw new Error(`Clip ${id} is not rendered.`);
	}
	element.getBoundingClientRect = () =>
		box(
			LEFT + segment.start * ZOOM,
			50 + segment.track * TRACK_ROW_PX,
			segmentDuration(segment) * ZOOM,
			32
		);
	return element;
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
			clientY: 60,
			pointerId: 3,
			...extra,
		})
	);
}

/** Track 0: a at 0..4 and b at 6..9; track 1: a linked-free c at 1..3. */
function fixture() {
	const asset = testVideo("drag.mp4", 20);
	const a = { ...newSegment(asset, 0, 0), sourceOut: 4 };
	const b = { ...newSegment(asset, 6, 0), sourceIn: 1, sourceOut: 4 };
	const c = { ...newSegment(asset, 1, 1), sourceOut: 2 };
	const project: Project = {
		...testProject().project,
		segments: [a, b, c],
	};
	const assets: Asset[] = [asset];
	const runtime = createTestRuntime(project, assets);
	runtime.zoom = ZOOM;
	return { a, b, c, runtime };
}

const startOf = (runtime: Runtime, id: string) =>
	runtime.project?.segments.find((segment) => segment.id === id)?.start;

describe("pointer drag engine", () => {
	test("dragging one clip of a selected pair moves both", async () => {
		const { a, b, c, runtime } = fixture();
		selectClips(runtime, [a.id, b.id]);
		const view = await render(runtime);
		const project = runtime.project as Project;
		const body = clipElement(view.host, project, a.id);
		clipElement(view.host, project, b.id);
		const from = LEFT + 2 * ZOOM;
		await act(async () => {
			pointer("pointerdown", body, from, { shiftKey: true });
			pointer("pointermove", body, from + 0.5 * ZOOM, { shiftKey: true });
		});
		expect(runtime.store.getState().drag?.kind).toBe("move");
		expect(body.style.translate).toBe(`${0.5 * ZOOM}px 0px`);
		await act(async () => {
			pointer("pointerup", body, from + 0.5 * ZOOM, { shiftKey: true });
			body.click();
		});
		expect(startOf(runtime, a.id)).toBe(0.5);
		expect(startOf(runtime, b.id)).toBe(6.5);
		expect(startOf(runtime, c.id)).toBe(1);
		expect(body.style.translate || "").toBe("");
		expect(runtime.store.getState().drag).toBeNull();
		// The click after the drag did not collapse the selection.
		expect([...runtime.selectedIds].sort()).toEqual([a.id, b.id].sort());
		expect(runtime.calls.filter(([name]) => name === "edit")).toEqual([
			["edit", "Move clips"],
		]);
		await view.unmount();
	});

	test("a drag snaps a clip edge to its neighbour", async () => {
		const { a, b, runtime } = fixture();
		const view = await render(runtime);
		const body = clipElement(view.host, runtime.project as Project, b.id);
		const from = LEFT + 7 * ZOOM;
		// b starts at 6; moving it 1.93 s left lands 0.07 s from a's end (4).
		await act(async () => {
			pointer("pointerdown", body, from);
			pointer("pointermove", body, from - 1.93 * ZOOM);
		});
		expect(runtime.store.getState().snapGuideTime).toBe(4);
		await act(async () => {
			pointer("pointerup", body, from - 1.93 * ZOOM);
		});
		expect(startOf(runtime, b.id)).toBe(4);
		expect(startOf(runtime, a.id)).toBe(0);
		expect(runtime.store.getState().snapGuideTime).toBeNull();
		await view.unmount();
	});

	test("Escape cancels the in-flight drag", async () => {
		const { a, runtime } = fixture();
		const view = await render(runtime);
		const body = clipElement(view.host, runtime.project as Project, a.id);
		const from = LEFT + 2 * ZOOM;
		await act(async () => {
			pointer("pointerdown", body, from);
			pointer("pointermove", body, from + ZOOM);
		});
		expect(body.style.translate || "").not.toBe("");
		// The Escape action clears `store.drag`.
		await act(async () => {
			runtime.store.setState({ drag: null });
		});
		expect(body.style.translate || "").toBe("");
		// Moving on after Escape neither re-previews nor brings back a snap
		// guide (b's start at 6 is a snap target 4 s right of a's start).
		await act(async () => {
			pointer("pointermove", body, from + 2 * ZOOM);
		});
		expect(body.style.translate || "").toBe("");
		expect(runtime.store.getState().snapGuideTime).toBeNull();
		expect(runtime.store.getState().drag).toBeNull();
		await act(async () => {
			pointer("pointerup", body, from + 2 * ZOOM);
		});
		expect(startOf(runtime, a.id)).toBe(0);
		expect(runtime.calls.some(([name]) => name === "edit")).toBe(false);
		await view.unmount();
	});

	test("an edge drag trims and Alt-drag on the body duplicates", async () => {
		const { b, runtime } = fixture();
		const view = await render(runtime);
		const body = clipElement(view.host, runtime.project as Project, b.id);
		const edge = LEFT + 6 * ZOOM + 3;
		await act(async () => {
			pointer("pointerdown", body, edge, { shiftKey: true });
			pointer("pointermove", body, edge - ZOOM, { shiftKey: true });
			pointer("pointerup", body, edge - ZOOM, { shiftKey: true });
		});
		const trimmed = runtime.project?.segments.find(
			(segment) => segment.id === b.id
		);
		expect(trimmed).toMatchObject({ sourceIn: 0, start: 5 });
		await view.draw();
		const moved = clipElement(view.host, runtime.project as Project, b.id);
		const from = LEFT + 6 * ZOOM;
		await act(async () => {
			pointer("pointerdown", moved, from, { shiftKey: true });
			pointer("pointermove", moved, from + 10 * ZOOM, {
				altKey: true,
				shiftKey: true,
			});
			pointer("pointerup", moved, from + 10 * ZOOM, {
				altKey: true,
				shiftKey: true,
			});
		});
		expect(runtime.project?.segments).toHaveLength(4);
		expect(startOf(runtime, b.id)).toBe(5);
		expect(
			runtime.calls
				.filter(([name]) => name === "edit")
				.map(([, label]) => label)
		).toEqual(["Trim clip", "Duplicate clips"]);
		await view.unmount();
	});

	test("presses with another tool fall through to the clip", async () => {
		const { a, runtime } = fixture();
		runtime.setTool("slip");
		const view = await render(runtime);
		const body = clipElement(view.host, runtime.project as Project, a.id);
		await act(async () => {
			pointer("pointerdown", body, LEFT + 2 * ZOOM);
			pointer("pointermove", body, LEFT + 3 * ZOOM);
		});
		// The group engine stays out; the clip's own slip drag reports itself
		// (for the two-up viewer) and clears on cancel.
		expect(runtime.store.getState().drag?.kind).toBe("slip");
		await act(async () => {
			pointer("pointercancel", body, LEFT + 3 * ZOOM);
		});
		expect(runtime.store.getState().drag).toBeNull();
		await view.unmount();
	});
});

describe("fade knee handles", () => {
	test("a selected clip shows knees that set its fades", async () => {
		const { a, runtime } = fixture();
		selectClips(runtime, [a.id]);
		const view = await render(runtime);
		const knee = view.host.querySelector<HTMLElement>(
			`[${FADE_KNEES_ATTRIBUTE}="${a.id}"] [data-fade-knee="in"]`
		);
		if (!knee) {
			throw new Error("No fade-in knee rendered.");
		}
		expect(knee.getAttribute("role")).toBe("slider");
		// The slider is not inside the clip's <button> (whose content is
		// presentational): its overlay is the clip's next sibling.
		expect(knee.closest("button")).toBeNull();
		const clip = view.host.querySelector(`[${CLIP_ID_ATTRIBUTE}="${a.id}"]`);
		expect(clip?.nextElementSibling?.getAttribute(FADE_KNEES_ATTRIBUTE)).toBe(
			a.id
		);
		expect(knee.closest("[aria-hidden]")).toBeNull();
		expect(knee.getAttribute("aria-valuemax")).toBe("4");
		expect(knee.title).toBe("Fade in 0.00 s");
		await act(async () => {
			pointer("pointerdown", knee, 0);
			pointer("pointermove", knee, 35);
		});
		expect(knee.querySelector('[role="status"]')?.textContent).toBe(
			"Fade in 0.50 s"
		);
		// The engine left the press to the knee: no clip drag started.
		expect(runtime.store.getState().drag).toBeNull();
		await act(async () => {
			pointer("pointerup", knee, 35);
		});
		const faded = runtime.project?.segments.find(
			(segment) => segment.id === a.id
		);
		expect(faded?.fadeIn).toBe(0.5);
		expect(startOf(runtime, a.id)).toBe(0);
		await view.draw();
		const outKnee = view.host.querySelector<HTMLElement>(
			`[${FADE_KNEES_ATTRIBUTE}="${a.id}"] [data-fade-knee="out"]`
		);
		expect(outKnee?.getAttribute("aria-valuemax")).toBe("3.5");
		await act(async () => {
			outKnee?.dispatchEvent(
				new KeyboardEvent("keydown", { bubbles: true, key: "End" })
			);
		});
		expect(
			runtime.project?.segments.find((segment) => segment.id === a.id)?.fadeOut
		).toBe(3.5);
		await view.unmount();
	});

	test("unselected clips without fades show no knees", async () => {
		const { runtime } = fixture();
		const view = await render(runtime);
		expect(view.host.querySelector("[data-fade-knee]")).toBeNull();
		await view.unmount();
	});
});
