import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { defaultMask } from "../../../../shared/masks.ts";
import {
	type Asset,
	newProject,
	newSegment,
	type Project,
	type Segment,
} from "../../../../shared/project.ts";
import type { EditorRuntime } from "../../editor/runtime.ts";

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
const { clientToFrame, maskHandleSpecs, MaskHandles, mirrorPoint } =
	await import("./MaskHandles.tsx");
const { mediaLayerStyle } = await import("../preview-style.ts");
const { transformCss } = await import("../stages/transform.ts");
const { entryTransitionState } = await import("../stages/transitions.ts");
const { setActiveMask } = await import(
	"../../inspector/sections/mask-selection.ts"
);
const originalRect = HTMLElement.prototype.getBoundingClientRect;
afterAll(() => {
	HTMLElement.prototype.getBoundingClientRect = originalRect;
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

const ID = "00000000-0000-4000-8000-000000000001";

const video: Asset = {
	createdAt: "2026-01-01T00:00:00.000Z",
	duration: 4,
	hasAudio: false,
	height: 1080,
	id: "00000000-0000-4000-8000-0000000000a1",
	kind: "video",
	name: "Clip",
	width: 1920,
};

beforeEach(() => {
	setActiveMask(null);
});

describe("pointer mapping", () => {
	test("inverts the crop window's client-space corners", () => {
		const frame = {
			origin: { x: 10, y: 20 },
			xAxis: { x: 210, y: 20 },
			yAxis: { x: 10, y: 120 },
		};
		expect(clientToFrame(frame, { x: 110, y: 70 })).toEqual({ x: 0.5, y: 0.5 });
		// Rotated 90° clockwise: the frame's x axis points down the screen.
		const rotated = {
			origin: { x: 100, y: 0 },
			xAxis: { x: 100, y: 200 },
			yAxis: { x: 0, y: 0 },
		};
		const point = clientToFrame(rotated, { x: 75, y: 50 });
		expect(point?.x).toBeCloseTo(0.25);
		expect(point?.y).toBeCloseTo(0.25);
		expect(
			clientToFrame(
				{
					origin: { x: 0, y: 0 },
					xAxis: { x: 0, y: 0 },
					yAxis: { x: 0, y: 0 },
				},
				{ x: 1, y: 1 }
			)
		).toBeUndefined();
	});

	test("flipped clips mirror handle positions", () => {
		const flipped = { ...newSegment(video), flipH: true };
		expect(mirrorPoint(flipped, { x: 0.2, y: 0.3 })).toEqual({
			x: 0.8,
			y: 0.3,
		});
		expect(mirrorPoint(newSegment(video), { x: 0.2, y: 0.3 })).toEqual({
			x: 0.2,
			y: 0.3,
		});
	});

	test("freeform masks get one handle per point; the feather handle moves out", () => {
		const freeform = maskHandleSpecs(defaultMask("freeform", ID), 16 / 9);
		expect(
			freeform.filter((spec) => spec.handle.startsWith("point:"))
		).toHaveLength(3);
		const sharp = maskHandleSpecs(defaultMask("ellipse", ID), 1);
		const soft = maskHandleSpecs(
			{ ...defaultMask("ellipse", ID), feather: 0.5 },
			1
		);
		const featherX = (specs: typeof sharp) =>
			specs.find((spec) => spec.handle === "feather")?.point.x ?? 0;
		expect(featherX(sharp)).toBe(1);
		expect(featherX(soft)).toBeCloseTo(1.4);
	});
});

function fakeRuntime(project: Project, segment: Segment, assets: Asset[]) {
	const edits: Project[] = [];
	const statuses: string[] = [];
	const runtime = {
		assets,
		edit: (next: Project) => edits.push(next),
		project,
		selectedId: segment.id,
		selectedSegment: segment,
		selectedTrackLocked: false,
		setStatus: (status: string) => statuses.push(status),
	} as unknown as EditorRuntime;
	return { edits, runtime, statuses };
}

async function renderHandles(
	segment: Segment,
	time = 1,
	playing = false,
	assets: Asset[] = [video]
) {
	const project = { ...newProject("Masks"), segments: [segment] };
	const fake = fakeRuntime(project, segment, assets);
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	await act(async () => {
		root.render(
			<EditorProvider value={fake.runtime}>
				<MaskHandles playing={playing} project={project} time={time} />
			</EditorProvider>
		);
	});
	return { container, ...fake };
}

describe("MaskHandles", () => {
	test("draws nothing without a provider, masks, or while playing", async () => {
		const container = document.createElement("div");
		document.body.append(container);
		await act(async () => {
			createRoot(container).render(
				<MaskHandles playing={false} project={newProject()} time={0} />
			);
		});
		expect(container.innerHTML).toBe("");
		expect((await renderHandles(newSegment(video))).container.innerHTML).toBe(
			""
		);
		const masked = {
			...newSegment(video),
			masks: [defaultMask("ellipse", ID)],
		};
		expect((await renderHandles(masked, 1, true)).container.innerHTML).toBe("");
		expect((await renderHandles(masked, 99)).container.innerHTML).toBe("");
	});

	test("shows the active mask's handles", async () => {
		const masked = {
			...newSegment(video),
			masks: [defaultMask("ellipse", ID)],
		};
		const { container } = await renderHandles(masked);
		const handles = [...container.querySelectorAll("button[data-handle]")].map(
			(button) => button.getAttribute("data-handle")
		);
		expect(handles).toEqual([
			"move",
			"nw",
			"ne",
			"sw",
			"se",
			"rotate",
			"feather",
		]);
		const move = container.querySelector<HTMLElement>('[data-handle="move"]');
		expect(move?.style.left).toBe("50%");
		expect(move?.style.top).toBe("50%");
	});

	test("handles anchor to a letterboxed clip's picture at its aspect", async () => {
		const square = { ...video, height: 1080, width: 1440 };
		const masked = {
			...newSegment(square),
			masks: [{ ...defaultMask("ellipse", ID), x: 0.5 }],
		};
		const { container } = await renderHandles(masked, 1, false, [square]);
		const anchor = container.querySelector<HTMLElement>(
			'[data-testid="mask-handles"] > div'
		);
		// A 4:3 picture in a 16:9 project spans 75% of the width, centered.
		expect(anchor?.style.left).toBe("12.5%");
		expect(anchor?.style.width).toBe("75%");
		expect(anchor?.style.top).toBe("0%");
		expect(anchor?.style.height).toBe("100%");
		expect(container.querySelector("svg")?.getAttribute("viewBox")).toBe(
			`0 0 ${(1440 / 1080) * 1000} 1000`
		);
		const move = container.querySelector<HTMLElement>('[data-handle="move"]');
		expect(move?.style.left).toBe("75%");
	});

	test("handles move with a cropped fill clip exactly like its picture", async () => {
		const square = { ...video, height: 1080, width: 1440 };
		const masked: Segment = {
			...newSegment(square),
			crop: { bottom: 0, left: 0.1, right: 0.2, top: 0 },
			fit: "fill",
			masks: [defaultMask("ellipse", ID)],
		};
		const { container } = await renderHandles(masked, 1, false, [square]);
		const overlay = container.querySelector<HTMLElement>(
			'[data-testid="mask-handles"]'
		);
		const project = { ...newProject("Masks"), segments: [masked] };
		const picture = mediaLayerStyle(masked, 1, {
			active: true,
			media: {
				canvas: { height: project.height, width: project.width },
				media: { height: square.height, width: square.width },
			},
		})["--studio-media-transform"];
		expect(overlay?.style.transform).toBe(picture);
		// The size-less approximation the handles used before differs here.
		expect(picture).not.toBe(
			transformCss(masked, 1, entryTransitionState(masked, 1))
		);
	});

	test("dragging the center moves the mask as one edit on release", async () => {
		HTMLElement.prototype.getBoundingClientRect = function rect(
			this: HTMLElement
		) {
			const right = this.className.includes("right-0");
			const bottom = this.className.includes("bottom-0");
			const x = right ? 200 : 0;
			const y = bottom ? 100 : 0;
			return {
				bottom: y,
				height: 0,
				left: x,
				right: x,
				top: y,
				width: 0,
				x,
				y,
				toJSON: () => ({}),
			};
		};
		try {
			const masked = {
				...newSegment(video),
				masks: [defaultMask("ellipse", ID)],
			};
			const { container, edits } = await renderHandles(masked);
			const move = container.querySelector<HTMLElement>('[data-handle="move"]');
			const pointer = (type: string, clientX: number, clientY: number) =>
				new PointerEvent(type, {
					bubbles: true,
					clientX,
					clientY,
					pointerId: 1,
				});
			await act(async () => {
				move?.dispatchEvent(pointer("pointerdown", 100, 50));
			});
			await act(async () => {
				move?.dispatchEvent(pointer("pointermove", 120, 40));
			});
			expect(edits).toHaveLength(0);
			await act(async () => {
				move?.dispatchEvent(pointer("pointerup", 120, 40));
			});
			expect(edits).toHaveLength(1);
			expect(edits[0]?.segments[0]?.masks?.[0]).toMatchObject({
				x: 0.2,
				y: -0.2,
			});
		} finally {
			HTMLElement.prototype.getBoundingClientRect = originalRect;
		}
	});

	test("arrow keys nudge the mask", async () => {
		const masked = {
			...newSegment(video),
			masks: [defaultMask("ellipse", ID)],
		};
		const { container, edits } = await renderHandles(masked);
		const move = container.querySelector<HTMLElement>('[data-handle="move"]');
		await act(async () => {
			move?.dispatchEvent(
				new KeyboardEvent("keydown", { bubbles: true, key: "ArrowRight" })
			);
		});
		expect(edits[0]?.segments[0]?.masks?.[0]?.x).toBeCloseTo(0.02);
	});
});
