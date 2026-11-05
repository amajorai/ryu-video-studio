import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { ReactNode } from "react";

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
const { newSegment } = await import("../../../../shared/project.ts");
const { EditorProvider } = await import("../../editor/context.tsx");
const { createTestRuntime, lastStatus, testProject } = await import(
	"../../editor/test-runtime.ts"
);
const {
	applyTargetPatch,
	CROP_NEEDS_CLIP,
	clientToFramePx,
	contentSizeOf,
	createGestureCommit,
	directManipulationActions,
	directManipulationStore,
	LOCKED_TRACK_MESSAGE,
	otherBoxes,
	selectedTarget,
	toggleCropMode,
} = await import("./direct-manipulation.ts");
const { PreviewTransformHandles } = await import(
	"./PreviewTransformHandles.tsx"
);
const { CROP_UNAVAILABLE_MESSAGE, PreviewCropMode, sourceDelta } = await import(
	"./PreviewCropMode.tsx"
);
const {
	EMPTY_TITLE_MESSAGE,
	normalizeTitleText,
	TextEditOverlay,
	titleTextEdit,
} = await import("./TextEditOverlay.tsx");
const { PreviewStage } = await import("../PreviewStage.tsx");

type Project = ReturnType<typeof testProject>["project"];
type TestRuntime = ReturnType<typeof createTestRuntime>;
type Title = Project["titles"][number];
type Graphic = Project["graphics"][number];

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

/** On-screen size of the preview frame in these tests (a 1920×1080 project). */
const RECT = {
	bottom: 225,
	height: 225,
	left: 0,
	right: 400,
	top: 0,
	width: 400,
};

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) {
		await cleanup();
	}
});

const title = (patch: Partial<Title> = {}): Title => ({
	animation: "fade",
	color: "#ffffff",
	end: 5,
	fadeIn: 0,
	fadeOut: 0,
	fontSize: 0.08,
	id: crypto.randomUUID(),
	start: 0,
	text: "Opening",
	x: 0.5,
	y: 0.3,
	...patch,
});

const graphic = (patch: Partial<Graphic> = {}): Graphic => ({
	animation: "none",
	end: 5,
	entryDuration: 0.35,
	fill: "#ff0000",
	height: 0.2,
	id: crypto.randomUUID(),
	opacity: 1,
	shape: "rectangle",
	start: 0,
	stroke: "#ffffff",
	strokeWidth: 0,
	width: 0.2,
	x: 0.1,
	y: 0.1,
	...patch,
});

/** A test runtime whose `setProject` really replaces the project. */
function setup(patch: (project: Project) => Project = (project) => project) {
	const base = testProject();
	const project = patch(base.project);
	const runtime = createTestRuntime(project, [base.asset]);
	runtime.setProject = (update) => {
		runtime.calls.push(["setProject"]);
		const current = runtime.project;
		runtime.project =
			typeof update === "function" ? update(current) : (update ?? null);
		runtime.latestProject.current = runtime.project;
		runtime.refresh();
	};
	return { ...base, project, runtime };
}

const currentProject = (runtime: TestRuntime): Project => {
	if (!runtime.project) {
		throw new Error("The runtime lost its project.");
	}
	return runtime.project;
};

async function mount(
	runtime: TestRuntime,
	overlay: (project: Project) => ReactNode
) {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	const render = async () => {
		await act(async () => {
			root.render(
				<EditorProvider value={runtime}>
					<div className="studio-preview-frame">
						{overlay(currentProject(runtime))}
					</div>
				</EditorProvider>
			);
		});
		for (const element of container.querySelectorAll(
			"[data-preview-transform], [data-preview-crop], [data-preview-text-edit]"
		)) {
			Object.defineProperty(element, "getBoundingClientRect", {
				configurable: true,
				value: () => RECT,
			});
		}
	};
	await render();
	cleanups.push(async () => {
		await act(async () => {
			root.unmount();
		});
		container.remove();
	});
	const query = (selector: string) => {
		const element = container.querySelector(selector);
		if (!element) {
			throw new Error(`Missing ${selector}`);
		}
		return element;
	};
	return { container, query, render };
}

const pointer = (
	type: string,
	x: number,
	y: number,
	init: PointerEventInit = {}
) =>
	new PointerEvent(type, {
		bubbles: true,
		button: 0,
		cancelable: true,
		clientX: x,
		clientY: y,
		...init,
	});

async function drag(
	start: Element,
	from: { x: number; y: number },
	steps: { x: number; y: number }[],
	init: PointerEventInit = {}
) {
	await act(async () => {
		start.dispatchEvent(pointer("pointerdown", from.x, from.y, init));
	});
	for (const step of steps) {
		await act(async () => {
			window.dispatchEvent(pointer("pointermove", step.x, step.y, init));
		});
	}
	await act(async () => {
		window.dispatchEvent(pointer("pointerup", steps.at(-1)?.x ?? 0, 0));
	});
}

const segmentOf = (runtime: TestRuntime, id: string) => {
	const found = currentProject(runtime).segments.find(
		(segment) => segment.id === id
	);
	if (!found) {
		throw new Error("segment missing");
	}
	return found;
};

const handles = (project: Project, time = 1) => (
	<PreviewTransformHandles playing={false} project={project} time={time} />
);

describe("transform handles", () => {
	test("dragging a clip by 10% of the width adds 0.2 to x in one undo step", async () => {
		const { first, runtime } = setup();
		runtime.setSelected(first.id);
		const view = await mount(runtime, (project) => handles(project));
		await drag(
			view.query('[data-transform-handle="move"]'),
			{ x: 200, y: 100 },
			[
				{ x: 220, y: 100 },
				{ x: 240, y: 100 },
			]
		);
		expect(segmentOf(runtime, first.id).x).toBeCloseTo(0.2, 6);
		expect(segmentOf(runtime, first.id).y).toBe(0);
		const { history } = runtime.store.getState();
		expect(history.past).toHaveLength(1);
		expect(history.past[0]?.label).toBe("Move clip");
		expect(history.past[0]?.project.segments[0]?.x).toBe(0);
		runtime.undo();
		expect(segmentOf(runtime, first.id).x).toBe(0);
	});

	test("the box follows the clip's placement in percent of the frame", async () => {
		const { first, runtime } = setup((project) => ({
			...project,
			segments: project.segments.map((segment, index) =>
				index === 0 ? { ...segment, rotation: 30, scale: 0.5, x: 0.5 } : segment
			),
		}));
		runtime.setSelected(first.id);
		const view = await mount(runtime, (project) => handles(project));
		const box = view.query("[data-transform-box]") as HTMLElement;
		expect(box.style.left).toBe("50%");
		expect(box.style.width).toBe("50%");
		expect(box.style.transform).toBe("rotate(30deg)");
		// Move, four corners, four edges (scale X / Y) and the rotation knob.
		expect(
			view.container.querySelectorAll("[data-transform-handle]")
		).toHaveLength(10);
	});

	test("moving near the canvas center snaps and shows a guide", async () => {
		const { first, runtime } = setup((project) => ({
			...project,
			segments: project.segments.map((segment, index) =>
				index === 0 ? { ...segment, scale: 0.4 } : segment
			),
		}));
		runtime.setSelected(first.id);
		const view = await mount(runtime, (project) => handles(project));
		await act(async () => {
			view
				.query('[data-transform-handle="move"]')
				.dispatchEvent(pointer("pointerdown", 200, 100));
		});
		await act(async () => {
			window.dispatchEvent(pointer("pointermove", 203, 180));
		});
		expect(segmentOf(runtime, first.id).x).toBe(0);
		expect(segmentOf(runtime, first.id).y).toBeCloseTo((80 / 225) * 2, 3);
		expect(
			view.container.querySelector('[data-preview-snap-guide="x"]')
		).not.toBeNull();
		await act(async () => {
			window.dispatchEvent(pointer("pointerup", 203, 180));
		});
		expect(
			view.container.querySelector("[data-preview-snap-guide]")
		).toBeNull();
	});

	test("Shift snaps rotation to 15 degrees", async () => {
		const { first, runtime } = setup();
		runtime.setSelected(first.id);
		const view = await mount(runtime, (project) => handles(project));
		// Center (200, 112.5); start straight above, end slightly below the right.
		await drag(
			view.query('[data-transform-handle="rotate"]'),
			{ x: 200, y: 0 },
			[{ x: 300, y: 118 }],
			{ shiftKey: true }
		);
		expect(segmentOf(runtime, first.id).rotation).toBe(90);
		expect(runtime.store.getState().history.past[0]?.label).toBe("Rotate clip");
	});

	test("a corner drag scales uniformly; an edge drag stretches one axis", async () => {
		const { first, runtime } = setup((project) => ({
			...project,
			segments: project.segments.map((segment, index) =>
				index === 0 ? { ...segment, scale: 0.5 } : segment
			),
		}));
		runtime.setSelected(first.id);
		const view = await mount(runtime, (project) => handles(project));
		// The box spans (100, 56.25)–(300, 168.75); Alt scales about the center.
		await drag(
			view.query('[data-transform-handle="se"]'),
			{ x: 300, y: 168.75 },
			[{ x: 350, y: 196.875 }],
			{ altKey: true }
		);
		expect(segmentOf(runtime, first.id).scale).toBeCloseTo(0.75, 4);
		expect(segmentOf(runtime, first.id).x).toBeCloseTo(0, 6);
		expect(segmentOf(runtime, first.id).scaleX).toBeUndefined();
		await view.render();
		// The box now spans (50, 28.125)-(350, 196.875); drag the right edge
		// 30 px further: only the width grows, written as scaleX.
		await drag(
			view.query('[data-transform-handle="e"]'),
			{ x: 350, y: 112.5 },
			[{ x: 380, y: 112.5 }]
		);
		const stretched = segmentOf(runtime, first.id);
		expect(stretched.scale).toBeCloseTo(0.75, 4);
		expect(stretched.scaleX).toBeCloseTo(1.1, 4);
		expect(stretched.scaleY).toBeUndefined();
		expect(runtime.store.getState().history.past.at(-1)?.label).toBe(
			"Scale clip"
		);
	});

	test("a keyframed property gets a keyframe at the playhead", async () => {
		const { first, runtime } = setup((project) => ({
			...project,
			segments: project.segments.map((segment, index) =>
				index === 0
					? {
							...segment,
							keyframes: [
								{ id: crypto.randomUUID(), property: "x", time: 0, value: 0 },
								{ id: crypto.randomUUID(), property: "x", time: 4, value: 0 },
							],
						}
					: segment
			),
		}));
		runtime.setSelected(first.id);
		const view = await mount(runtime, (project) => handles(project, 2));
		await drag(
			view.query('[data-transform-handle="move"]'),
			{ x: 200, y: 100 },
			[{ x: 240, y: 100 }]
		);
		const moved = segmentOf(runtime, first.id);
		expect(moved.x).toBe(0);
		const atPlayhead = moved.keyframes.find(
			(frame) => frame.property === "x" && frame.time === 2
		);
		expect(atPlayhead?.value).toBeCloseTo(0.2, 6);
	});

	test("locked tracks refuse the gesture with a status", async () => {
		const { first, runtime } = setup((project) => ({
			...project,
			trackSettings: [
				{ locked: true, muted: false, solo: false, track: 0 },
			] as Project["trackSettings"],
		}));
		runtime.setSelected(first.id);
		const view = await mount(runtime, (project) => handles(project));
		await drag(
			view.query('[data-transform-handle="move"]'),
			{ x: 200, y: 100 },
			[{ x: 240, y: 100 }]
		);
		expect(segmentOf(runtime, first.id).x).toBe(0);
		expect(lastStatus(runtime)).toBe(LOCKED_TRACK_MESSAGE);
	});

	test("arrow keys nudge the selected item", async () => {
		const { first, runtime } = setup();
		runtime.setSelected(first.id);
		const view = await mount(runtime, (project) => handles(project));
		await act(async () => {
			view.query('[data-transform-handle="move"]').dispatchEvent(
				new KeyboardEvent("keydown", {
					bubbles: true,
					key: "ArrowRight",
					shiftKey: true,
				})
			);
		});
		expect(segmentOf(runtime, first.id).x).toBeCloseTo(20 / 1920, 4);
		expect(runtime.store.getState().history.past[0]?.label).toBe("Nudge clip");
	});

	test("titles scale their font size and graphics their size", async () => {
		const opening = title();
		const box = graphic();
		const { runtime } = setup((project) => ({
			...project,
			graphics: [box],
			titles: [opening],
		}));
		runtime.store.setState({
			selection: {
				overlayIds: [{ id: opening.id, kind: "titles" }],
				primaryId: null,
				segmentIds: [],
			},
		});
		const view = await mount(runtime, (project) => handles(project));
		// Move, four corners and the rotation knob (titles scale uniformly).
		expect(
			view.container.querySelectorAll("[data-transform-handle]")
		).toHaveLength(6);
		expect(
			view.container.querySelector('[data-transform-handle="rotate"]')
		).not.toBeNull();
		await drag(
			view.query('[data-transform-handle="move"]'),
			{ x: 200, y: 67 },
			[{ x: 200, y: 89.5 }]
		);
		expect(currentProject(runtime).titles[0]?.y).toBeCloseTo(0.4, 6);
		await act(async () => {
			runtime.store.setState({
				selection: {
					overlayIds: [{ id: box.id, kind: "graphics" }],
					primaryId: null,
					segmentIds: [],
				},
			});
		});
		await view.render();
		// The graphic spans x 40–120 px; drag its right edge 40 px further.
		await drag(view.query('[data-transform-handle="e"]'), { x: 120, y: 45 }, [
			{ x: 160, y: 45 },
		]);
		const resized = currentProject(runtime).graphics[0];
		expect(resized?.width).toBeCloseTo(0.3, 6);
		expect(resized?.x).toBeCloseTo(0.1, 6);
		expect(
			view.container.querySelector('[data-transform-handle="rotate"]')
		).not.toBeNull();
	});

	test("titles and graphics rotate on the canvas, Shift snapping to 15 degrees", async () => {
		const opening = title();
		const box = graphic();
		const { runtime } = setup((project) => ({
			...project,
			graphics: [box],
			titles: [opening],
		}));
		const select = async (id: string, kind: "graphics" | "titles") => {
			await act(async () => {
				runtime.store.setState({
					selection: {
						overlayIds: [{ id, kind }],
						primaryId: null,
						segmentIds: [],
					},
				});
			});
		};
		await select(opening.id, "titles");
		const view = await mount(runtime, (project) => handles(project));
		const knob = () =>
			view.query('[data-transform-handle="rotate"]') as HTMLElement;
		const titleCenter = { x: opening.x * 400, y: opening.y * 225 };
		await drag(
			knob(),
			{ x: titleCenter.x, y: titleCenter.y - 40 },
			[{ x: titleCenter.x + 40, y: titleCenter.y + 2 }],
			{ shiftKey: true }
		);
		expect(currentProject(runtime).titles[0]?.rotation).toBe(90);
		expect(runtime.store.getState().history.past.at(-1)?.label).toBe(
			"Rotate title"
		);
		await select(box.id, "graphics");
		await view.render();
		const graphicCenter = {
			x: (box.x + box.width / 2) * 400,
			y: (box.y + box.height / 2) * 225,
		};
		await drag(
			knob(),
			{ x: graphicCenter.x, y: graphicCenter.y - 30 },
			[{ x: graphicCenter.x - 30, y: graphicCenter.y - 30 }],
			{ shiftKey: true }
		);
		expect(currentProject(runtime).graphics[0]?.rotation).toBe(-45);
		const drawn = view.query("[data-transform-box]") as HTMLElement;
		await view.render();
		expect(
			(view.query("[data-transform-box]") as HTMLElement).style.transform
		).toBe("rotate(-45deg)");
		expect(drawn).toBeDefined();
	});

	test("nothing is drawn while playing or without a selection", async () => {
		const { first, runtime } = setup();
		const view = await mount(runtime, (project) => handles(project));
		expect(view.container.querySelector("[data-transform-box]")).toBeNull();
		await act(async () => {
			runtime.setSelected(first.id);
		});
		await view.render();
		expect(view.container.querySelector("[data-transform-box]")).not.toBeNull();
		const playing = await mount(runtime, (project) => (
			<PreviewTransformHandles playing project={project} time={1} />
		));
		expect(playing.container.querySelector("[data-transform-box]")).toBeNull();
	});

	test("PreviewStage mounts the handles inside the editor", async () => {
		const { first, runtime } = setup();
		runtime.setSelected(first.id);
		const view = await mount(runtime, (project) => (
			<PreviewStage
				assets={runtime.assets}
				playing={false}
				project={project}
				sources={{}}
				time={1}
			/>
		));
		expect(view.container.querySelector("[data-transform-box]")).not.toBeNull();
	});
});

describe("crop mode", () => {
	test("C needs a selected picture clip", () => {
		const { first, runtime } = setup();
		toggleCropMode(runtime);
		expect(lastStatus(runtime)).toBe(CROP_NEEDS_CLIP);
		runtime.setSelected(first.id);
		runtime.time = 1;
		directManipulationActions["preview.cropMode"]?.(runtime);
		expect(directManipulationStore(runtime.store).getState().cropMode).toBe(
			true
		);
		toggleCropMode(runtime);
		expect(directManipulationStore(runtime.store).getState().cropMode).toBe(
			false
		);
	});

	test("C on the focused clip box opens crop mode, which replaces the handles", async () => {
		const { first, runtime } = setup();
		runtime.setSelected(first.id);
		runtime.time = 1;
		const view = await mount(runtime, (project) => (
			<>
				{handles(project)}
				<PreviewCropMode playing={false} project={project} time={1} />
			</>
		));
		await act(async () => {
			view
				.query('[data-transform-handle="move"]')
				.dispatchEvent(
					new KeyboardEvent("keydown", { bubbles: true, key: "c" })
				);
		});
		expect(view.container.querySelector("[data-transform-box]")).toBeNull();
		expect(view.container.querySelector("[data-crop-toolbar]")).not.toBeNull();
	});

	test("aspect presets, handle drags and reset write the crop", async () => {
		const { first, runtime } = setup();
		runtime.setSelected(first.id);
		directManipulationStore(runtime.store).setState({
			cropMode: true,
			cropTargetId: first.id,
		});
		const view = await mount(runtime, (project) => (
			<PreviewCropMode playing={false} project={project} time={1} />
		));
		await act(async () => {
			(view.query('[data-crop-aspect="1:1"]') as HTMLElement).click();
		});
		const square = segmentOf(runtime, first.id).crop;
		expect(square.top).toBe(0);
		expect(square.left).toBeCloseTo((1 - 9 / 16) / 2, 4);
		expect(directManipulationStore(runtime.store).getState().cropAspect).toBe(
			"1:1"
		);
		await view.render();
		// Locked aspect: only corners.
		expect(view.container.querySelector('[data-crop-handle="e"]')).toBeNull();
		await act(async () => {
			(view.query('[data-crop-aspect="free"]') as HTMLElement).click();
		});
		await view.render();
		await drag(view.query('[data-crop-handle="w"]'), { x: 0, y: 100 }, [
			{ x: 0, y: 100 },
			{ x: 40, y: 100 },
		]);
		expect(segmentOf(runtime, first.id).crop.left).toBeCloseTo(
			square.left + 0.1,
			4
		);
		expect(runtime.store.getState().history.past.at(-1)?.label).toBe(
			"Crop clip"
		);
		await view.render();
		await act(async () => {
			(view.query('[data-crop-action="reset"]') as HTMLElement).click();
		});
		expect(segmentOf(runtime, first.id).crop).toEqual({
			bottom: 0,
			left: 0,
			right: 0,
			top: 0,
		});
		await act(async () => {
			(view.query('[data-crop-action="done"]') as HTMLElement).click();
		});
		expect(view.container.querySelector("[data-crop-toolbar]")).toBeNull();
	});

	test("pointer deltas map into source fractions through the rotation", () => {
		const { first, project, asset } = setup();
		const target = selectedTarget(
			{
				...project,
				segments: project.segments.map((segment) =>
					segment.id === first.id ? { ...segment, rotation: 90 } : segment
				),
			},
			[asset],
			{ overlayIds: [], primaryId: first.id, segmentIds: [first.id] },
			1,
			() => ({ height: 0, width: 0 })
		);
		if (target?.kind !== "segment") {
			throw new Error("expected a clip target");
		}
		// Rotated 90°, dragging down moves along the source's +x axis.
		const delta = sourceDelta(target.placement.full, { x: 0, y: 192 }, project);
		expect(delta.x).toBeCloseTo(0.1, 6);
		expect(delta.y).toBeCloseTo(0, 6);
	});
});

describe("crop mode lifetime", () => {
	const cropView = (runtime: TestRuntime, time = 1) =>
		mount(runtime, (project) => (
			<>
				{handles(project, time)}
				<PreviewCropMode playing={false} project={project} time={time} />
			</>
		));

	test("selecting another clip ends crop mode and brings the handles back", async () => {
		const { first, runtime, second } = setup((project) => ({
			...project,
			segments: project.segments.map((segment, index) =>
				index === 1 ? { ...segment, start: 0, track: 1 } : segment
			),
		}));
		runtime.setSelected(first.id);
		runtime.time = 1;
		toggleCropMode(runtime);
		const view = await cropView(runtime);
		expect(view.container.querySelector("[data-crop-toolbar]")).not.toBeNull();
		expect(view.container.querySelector("[data-transform-box]")).toBeNull();
		await act(async () => {
			runtime.setSelected(second.id);
		});
		await view.render();
		await view.render();
		const state = directManipulationStore(runtime.store).getState();
		expect(state.cropMode).toBe(false);
		expect(state.cropTargetId).toBeNull();
		expect(state.cropAspect).toBe("free");
		expect(lastStatus(runtime)).toBe(CROP_UNAVAILABLE_MESSAGE);
		expect(view.container.querySelector("[data-crop-toolbar]")).toBeNull();
		expect(view.container.querySelector("[data-transform-box]")).not.toBeNull();
	});

	test("moving the playhead off the clip or locking its track ends crop mode", async () => {
		const { first, runtime } = setup();
		runtime.setSelected(first.id);
		runtime.time = 1;
		toggleCropMode(runtime);
		await cropView(runtime, 11);
		expect(directManipulationStore(runtime.store).getState().cropMode).toBe(
			false
		);
		const locked = setup((project) => ({
			...project,
			trackSettings: [
				{ locked: false, muted: false, solo: false, track: 0 },
			] as Project["trackSettings"],
		}));
		locked.runtime.setSelected(locked.first.id);
		locked.runtime.time = 1;
		toggleCropMode(locked.runtime);
		const view = await cropView(locked.runtime);
		expect(view.container.querySelector("[data-crop-toolbar]")).not.toBeNull();
		locked.runtime.project = {
			...currentProject(locked.runtime),
			trackSettings: [
				{ locked: true, muted: false, solo: false, track: 0 },
			] as Project["trackSettings"],
		};
		await view.render();
		await view.render();
		expect(
			directManipulationStore(locked.runtime.store).getState().cropMode
		).toBe(false);
		expect(lastStatus(locked.runtime)).toBe(CROP_UNAVAILABLE_MESSAGE);
	});

	test("Done and Escape leave crop mode and reset the aspect", async () => {
		const { first, runtime } = setup();
		runtime.setSelected(first.id);
		runtime.time = 1;
		toggleCropMode(runtime);
		const store = directManipulationStore(runtime.store);
		store.setState({ cropAspect: "1:1" });
		const view = await cropView(runtime);
		await act(async () => {
			view
				.query('[data-crop-handle="window"]')
				.dispatchEvent(
					new KeyboardEvent("keydown", { bubbles: true, key: "Escape" })
				);
		});
		expect(store.getState()).toMatchObject({
			cropAspect: "free",
			cropMode: false,
			cropTargetId: null,
		});
	});

	test("the source box holds still during a crop drag, then re-fits", async () => {
		const { first, runtime } = setup();
		runtime.setSelected(first.id);
		runtime.time = 1;
		toggleCropMode(runtime);
		const view = await cropView(runtime);
		const bounds = () =>
			(view.query("[data-crop-bounds]") as HTMLElement).style.cssText;
		const before = bounds();
		await act(async () => {
			view
				.query('[data-crop-handle="w"]')
				.dispatchEvent(pointer("pointerdown", 0, 100));
		});
		await act(async () => {
			window.dispatchEvent(pointer("pointermove", 40, 100));
		});
		await view.render();
		expect(segmentOf(runtime, first.id).crop.left).toBeCloseTo(0.1, 4);
		expect(bounds()).toBe(before);
		// The window's left edge sits under the pointer (40 of 400 px).
		const windowBox = view.query('[data-crop-handle="window"]')
			.parentElement as HTMLElement;
		expect(Number.parseFloat(windowBox.style.left)).toBeCloseTo(10, 4);
		await act(async () => {
			window.dispatchEvent(pointer("pointerup", 40, 100));
		});
		await view.render();
		// Released: the kept 90% re-fits the canvas, so the source box grows.
		expect(bounds()).not.toBe(before);
	});
});

describe("in-place title editing", () => {
	test("double-click opens an editor that commits on Enter", async () => {
		const opening = title();
		const { runtime } = setup((project) => ({ ...project, titles: [opening] }));
		const view = await mount(runtime, (project) => (
			<>
				{handles(project)}
				<TextEditOverlay playing={false} project={project} time={1} />
			</>
		));
		const hit = view.query(`[data-title-hit="${opening.id}"]`);
		await act(async () => {
			hit.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
		});
		expect(runtime.store.getState().selection.overlayIds).toEqual([
			{ id: opening.id, kind: "titles" },
		]);
		const editor = view.query("[data-title-editor]") as HTMLElement;
		expect(editor.textContent).toBe("Opening");
		expect(editor.className).toContain("studio-title");
		// The selected title's handles step aside while its text is edited.
		expect(view.container.querySelector("[data-transform-box]")).toBeNull();
		editor.textContent = "  New opening  ";
		await act(async () => {
			editor.dispatchEvent(
				new KeyboardEvent("keydown", { bubbles: true, key: "Enter" })
			);
		});
		expect(currentProject(runtime).titles[0]?.text).toBe("New opening");
		expect(runtime.store.getState().history.past.at(-1)?.label).toBe(
			"Edit title text"
		);
		await view.render();
		expect(view.container.querySelector("[data-title-editor]")).toBeNull();
	});

	test("Escape cancels and empty text is refused", async () => {
		const opening = title();
		const { runtime } = setup((project) => ({ ...project, titles: [opening] }));
		const store = directManipulationStore(runtime.store);
		store.setState({ editingTitleId: opening.id });
		const view = await mount(runtime, (project) => (
			<TextEditOverlay playing={false} project={project} time={1} />
		));
		let editor = view.query("[data-title-editor]") as HTMLElement;
		editor.textContent = "Discarded";
		await act(async () => {
			editor.dispatchEvent(
				new KeyboardEvent("keydown", { bubbles: true, key: "Escape" })
			);
		});
		expect(currentProject(runtime).titles[0]?.text).toBe("Opening");
		expect(store.getState().editingTitleId).toBeNull();
		await act(async () => {
			store.setState({ editingTitleId: opening.id });
		});
		await view.render();
		editor = view.query("[data-title-editor]") as HTMLElement;
		editor.textContent = "   ";
		await act(async () => {
			editor.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
		});
		expect(currentProject(runtime).titles[0]?.text).toBe("Opening");
		expect(lastStatus(runtime)).toBe(EMPTY_TITLE_MESSAGE);
	});

	test("text normalization keeps line breaks and the schema limit", () => {
		expect(normalizeTitleText(" a\r\nb c ")).toBe("a\nb c");
		expect(normalizeTitleText("x".repeat(600))).toHaveLength(500);
		const { project } = setup((base) => ({ ...base, titles: [title()] }));
		const id = project.titles[0]?.id ?? "";
		expect(titleTextEdit(project, id, "Opening").kind).toBe("unchanged");
		expect(titleTextEdit(project, id, "").kind).toBe("empty");
		const changed = titleTextEdit(project, id, "Two\nlines");
		expect(changed.kind === "changed" && changed.project.titles[0]?.text).toBe(
			"Two\nlines"
		);
	});
});

describe("helpers", () => {
	test("client points map through the on-screen rect", () => {
		expect(
			clientToFramePx(
				{ x: 110, y: 60 },
				{ ...RECT, left: 10, top: 5 },
				{
					height: 1080,
					width: 1920,
				}
			)
		).toEqual({ x: 480, y: 264 });
		expect(
			clientToFramePx(
				{ x: 5, y: 5 },
				{ height: 0, left: 0, top: 0, width: 0 },
				{
					height: 1080,
					width: 1920,
				}
			)
		).toEqual({ x: 0, y: 0 });
	});

	test("unknown media sizes fill the canvas", () => {
		const canvas = { height: 1080, width: 1920 };
		expect(contentSizeOf(undefined, canvas)).toBe(canvas);
		expect(contentSizeOf({ height: 0, width: 0 }, canvas)).toBe(canvas);
		expect(contentSizeOf({ height: 10, width: 20 }, canvas)).toEqual({
			height: 10,
			width: 20,
		});
	});

	test("targets skip audio clips and items outside the playhead", () => {
		const { asset, first, project } = setup();
		const audio = { ...asset, id: crypto.randomUUID(), kind: "audio" as const };
		const audioClip = { ...newSegment(audio, 0, 1) };
		const withAudio = {
			...project,
			segments: [...project.segments, audioClip],
		};
		const select = (id: string) => ({
			overlayIds: [],
			primaryId: id,
			segmentIds: [id],
		});
		const sizer = () => ({ height: 0.1, width: 0.1 });
		expect(
			selectedTarget(withAudio, [asset, audio], select(audioClip.id), 1, sizer)
		).toBeNull();
		expect(
			selectedTarget(withAudio, [asset, audio], select(first.id), 11, sizer)
		).toBeNull();
		expect(
			selectedTarget(withAudio, [asset, audio], select(first.id), 1, sizer)
				?.kind
		).toBe("segment");
		const boxes = otherBoxes(
			{ ...withAudio, graphics: [graphic()], titles: [title()] },
			[asset, audio],
			1,
			first.id,
			sizer
		);
		expect(boxes).toHaveLength(2);
	});

	test("patches merge into the matching item only", () => {
		const opening = title();
		const { first, project, second } = setup((base) => ({
			...base,
			titles: [opening],
		}));
		const moved = applyTargetPatch(
			project,
			{ id: first.id, kind: "segment" },
			{
				x: 0.5,
			}
		);
		expect(moved.segments.map((segment) => segment.x)).toEqual([0.5, 0]);
		expect(moved.segments[1]).toBe(second);
		const retitled = applyTargetPatch(
			project,
			{ id: opening.id, kind: "title" },
			{
				y: 0.9,
			}
		);
		expect(retitled.titles[0]?.y).toBe(0.9);
	});

	test("a gesture commit records history once", () => {
		const { project, runtime } = setup();
		const commit = createGestureCommit(() => runtime, "Move clip");
		commit.update({ ...project, title: "one" });
		commit.update({ ...project, title: "two" });
		expect(runtime.store.getState().history.past).toHaveLength(1);
		expect(runtime.project?.title).toBe("two");
		expect(runtime.dirty).toBe(true);
	});
});
