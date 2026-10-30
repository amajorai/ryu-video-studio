import { afterAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { newProject } from "../../../../shared/project.ts";
import { createTestRuntime } from "../../editor/test-runtime.ts";
import {
	type CanvasBox,
	canvasGuideStoreFor,
	canvasSnapLines,
	createCanvasGuideStore,
	EMPTY_CANVAS_GUIDES,
	snapCanvasBox,
} from "./preview-snap.ts";

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
	value: true,
	configurable: true,
	writable: true,
});
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { EditorProvider } = await import("../../editor/context.tsx");
const { PreviewSnapGuides } = await import("./PreviewSnapGuides.tsx");
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

const box = (
	left: number,
	top: number,
	width: number,
	height: number
): CanvasBox => ({
	bottom: top + height,
	left,
	right: left + width,
	top,
});
const SIZE = { heightPx: 1080, widthPx: 1920 };

describe("canvasSnapLines", () => {
	test("canvas edges and center plus other items' edges and centers, deduplicated", () => {
		expect(canvasSnapLines()).toEqual({ x: [0, 0.5, 1], y: [0, 0.5, 1] });
		expect(canvasSnapLines([box(0.25, 0, 0.5, 0.5)])).toEqual({
			x: [0, 0.25, 0.5, 0.75, 1],
			y: [0, 0.25, 0.5, 1],
		});
	});
});

describe("snapCanvasBox", () => {
	test("centers a box near the canvas center and reports both guides", () => {
		// Center at (0.502, 0.497): 3.8 px and 3.2 px from center.
		const result = snapCanvasBox(
			box(0.402, 0.397, 0.2, 0.2),
			canvasSnapLines(),
			SIZE
		);
		expect(result.dx).toBeCloseTo(-0.002, 9);
		expect(result.dy).toBeCloseTo(0.003, 9);
		expect(result.guides).toEqual({ x: [0.5], y: [0.5] });
		expect(result.box.left).toBeCloseTo(0.4, 9);
	});

	test("snaps an edge to another item's edge", () => {
		const lines = canvasSnapLines([box(0.6, 0.1, 0.2, 0.2)]);
		const result = snapCanvasBox(box(0.1, 0.7, 0.4975, 0.1), lines, SIZE);
		// Right edge 0.5975 is 4.8 px from the other item's left at 0.6.
		expect(result.box.right).toBeCloseTo(0.6, 9);
		expect(result.guides.x).toEqual([0.6]);
	});

	test("prefers the nearest line and ignores lines beyond the threshold", () => {
		const result = snapCanvasBox(
			box(0.006, 0.3, 0.2, 0.2),
			canvasSnapLines(),
			SIZE
		);
		// Left edge 11.5 px from 0: out of range at 8 px.
		expect(result.dx).toBe(0);
		expect(result.guides.x).toEqual([]);
		const wide = snapCanvasBox(box(0.006, 0.3, 0.2, 0.2), canvasSnapLines(), {
			...SIZE,
			thresholdPx: 12,
		});
		expect(wide.box.left).toBeCloseTo(0, 9);
		expect(wide.guides.x).toEqual([0]);
	});

	test("the pixel threshold scales with the rendered canvas size", () => {
		const nearCenter = box(0.395, 0.1, 0.2, 0.2);
		expect(snapCanvasBox(nearCenter, canvasSnapLines(), SIZE).dx).toBe(0);
		expect(
			snapCanvasBox(nearCenter, canvasSnapLines(), {
				heightPx: 1080,
				widthPx: 3840,
			}).dx
		).toBe(0);
		expect(
			snapCanvasBox(nearCenter, canvasSnapLines(), {
				heightPx: 270,
				widthPx: 480,
			}).dx
		).toBeCloseTo(0.005, 9);
	});

	test("an unrendered canvas never captures", () => {
		const result = snapCanvasBox(box(0.4, 0.4, 0.2, 0.2), canvasSnapLines(), {
			heightPx: 0,
			widthPx: 0,
		});
		expect(result.guides.x).toEqual([0.5]);
		expect(result.dx).toBe(0);
		const miss = snapCanvasBox(box(0.401, 0.4, 0.2, 0.2), canvasSnapLines(), {
			heightPx: 0,
			widthPx: 0,
		});
		expect(miss.guides.x).toEqual([]);
	});
});

describe("canvas guide store", () => {
	test("publishes changes, normalizes empty guides, and scopes per editor", () => {
		const guides = createCanvasGuideStore();
		let notified = 0;
		const unsubscribe = guides.subscribe(() => {
			notified += 1;
		});
		guides.set({ x: [0.5], y: [] });
		expect(guides.get()).toEqual({ x: [0.5], y: [] });
		guides.set({ x: [], y: [] });
		expect(guides.get()).toBe(EMPTY_CANVAS_GUIDES);
		guides.clear();
		expect(notified).toBe(2);
		unsubscribe();
		const first = createTestRuntime(newProject("A")).store;
		const second = createTestRuntime(newProject("B")).store;
		expect(canvasGuideStoreFor(first)).toBe(canvasGuideStoreFor(first));
		expect(canvasGuideStoreFor(first)).not.toBe(canvasGuideStoreFor(second));
		expect(canvasGuideStoreFor(null)).toBe(canvasGuideStoreFor(undefined));
	});
});

describe("PreviewSnapGuides", () => {
	test("draws the published guides inside an editor and hides while playing", async () => {
		const runtime = createTestRuntime(newProject("Guides"));
		const project = runtime.project;
		if (!project) {
			throw new Error("project missing");
		}
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		const render = (playing: boolean) =>
			act(async () => {
				root.render(
					<EditorProvider value={runtime}>
						<PreviewSnapGuides playing={playing} project={project} time={0} />
					</EditorProvider>
				);
			});
		await render(false);
		expect(container.querySelector("svg")).toBeNull();
		const guides = canvasGuideStoreFor(runtime.store);
		await act(async () => {
			guides.set(
				snapCanvasBox(box(0.402, 0.397, 0.2, 0.2), canvasSnapLines(), SIZE)
					.guides
			);
		});
		const svg = container.querySelector('[data-testid="preview-snap-guides"]');
		expect(svg?.getAttribute("aria-hidden")).toBe("true");
		const lines = [...container.querySelectorAll("line")].map((line) => [
			line.dataset.axis,
			line.getAttribute("x1"),
			line.getAttribute("y1"),
		]);
		expect(lines).toEqual([
			["x", "50", "0"],
			["y", "0", "50"],
		]);
		await render(true);
		expect(container.querySelector("svg")).toBeNull();
		await render(false);
		await act(async () => {
			guides.clear();
		});
		expect(container.querySelector("svg")).toBeNull();
		await act(async () => {
			root.unmount();
		});
		container.remove();
	});

	test("renders without an editor through the detached store", async () => {
		const project = newProject("Detached");
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => {
			root.render(
				<PreviewSnapGuides playing={false} project={project} time={0} />
			);
		});
		expect(container.querySelector("svg")).toBeNull();
		await act(async () => {
			canvasGuideStoreFor(null).set({ x: [], y: [0] });
		});
		expect(container.querySelectorAll("line")).toHaveLength(1);
		await act(async () => {
			canvasGuideStoreFor(null).clear();
			root.unmount();
		});
		container.remove();
	});
});
