import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
	type Caption,
	newProject,
	type Project,
	type Title,
} from "../../../shared/project.ts";
import { createTestRuntime } from "../editor/test-runtime.ts";

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
const { EditorProvider } = await import("../editor/context.tsx");
const {
	OVERLAY_ROW_HEIGHT,
	OverlayLanes,
	overlayDragEdit,
	overlayDragModeAt,
	overlayItemLabel,
	withOverlayClickSelection,
} = await import("./OverlayLanes.tsx");
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

const ZOOM = 100;

function title(start: number, end: number, text = "Hello"): Title {
	return {
		animation: "fade",
		color: "#ffffff",
		end,
		fadeIn: 0,
		fadeOut: 0,
		fontSize: 0.06,
		id: crypto.randomUUID(),
		start,
		text,
		x: 0.5,
		y: 0.5,
	};
}

function caption(start: number, end: number): Caption {
	return { end, id: crypto.randomUUID(), start, text: "Spoken line" };
}

describe("overlay drag helpers", () => {
	test("edges grab trims and the body grabs a move", () => {
		const bounds = { left: 100, right: 300 };
		expect(overlayDragModeAt(bounds, 102)).toBe("start");
		expect(overlayDragModeAt(bounds, 298)).toBe("end");
		expect(overlayDragModeAt(bounds, 200)).toBe("move");
	});

	test("a vertical drag of a title assigns a lane; captions only move", () => {
		const item = title(1, 3);
		const base = {
			deltaX: 50,
			item,
			mode: "move" as const,
			row: 0,
			zoom: ZOOM,
		};
		expect(
			overlayDragEdit({
				...base,
				deltaY: OVERLAY_ROW_HEIGHT * 2,
				ref: { id: item.id, kind: "titles" },
			})
		).toEqual({ id: item.id, kind: "titles", lane: 2, op: "move", start: 1.5 });
		expect(
			overlayDragEdit({
				...base,
				deltaY: OVERLAY_ROW_HEIGHT * 2,
				ref: { id: item.id, kind: "captions" },
			})
		).toEqual({ id: item.id, kind: "captions", op: "move", start: 1.5 });
		expect(
			overlayDragEdit({
				...base,
				deltaX: -400,
				deltaY: 0,
				mode: "end",
				ref: { id: item.id, kind: "titles" },
			})
		).toEqual({
			edge: "end",
			id: item.id,
			kind: "titles",
			op: "trim",
			time: 0,
		});
	});

	test("plain clicks select one overlay; Shift toggles", () => {
		const a = { id: "a", kind: "titles" as const };
		const b = { id: "b", kind: "graphics" as const };
		const one = withOverlayClickSelection(
			{ overlayIds: [b], primaryId: "clip", segmentIds: ["clip"] },
			a,
			false
		);
		expect(one).toEqual({ overlayIds: [a], primaryId: null, segmentIds: [] });
		const both = withOverlayClickSelection(one, b, true);
		expect(both.overlayIds).toEqual([a, b]);
		expect(withOverlayClickSelection(both, a, true).overlayIds).toEqual([b]);
	});

	test("labels come from the item", () => {
		const item = title(0, 1, "Opening");
		const project: Project = { ...newProject("Labels"), titles: [item] };
		expect(overlayItemLabel(project, { id: item.id, kind: "titles" })).toBe(
			"Opening"
		);
	});
});

async function mount(project: Project) {
	const runtime = createTestRuntime(project, []);
	runtime.zoom = ZOOM;
	runtime.time = 50;
	runtime.range = { end: 0, start: 0 };
	runtime.store.setState({ snapEnabled: false });
	runtime.refresh();
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	const render = async () => {
		await act(async () => {
			root.render(
				<EditorProvider value={runtime}>
					<OverlayLanes zoom={ZOOM} />
				</EditorProvider>
			);
		});
	};
	await render();
	const cleanup = async () => {
		await act(async () => {
			root.unmount();
		});
		host.remove();
	};
	return { cleanup, host, render, runtime };
}

function itemElement(host: HTMLElement, id: string): HTMLElement {
	const element = host.querySelector<HTMLElement>(`[data-overlay-id="${id}"]`);
	if (!element) {
		throw new Error(`overlay ${id} not rendered`);
	}
	return element;
}

/** Pin an element's horizontal box (happy-dom does no layout). */
function placeBox(element: Element, left: number, width: number) {
	Object.defineProperty(element, "getBoundingClientRect", {
		value: () => ({
			bottom: 20,
			height: 20,
			left,
			right: left + width,
			top: 0,
			width,
			x: left,
			y: 0,
		}),
	});
}

async function pointer(
	element: Element,
	type: "pointerdown" | "pointermove" | "pointerup",
	clientX: number,
	clientY = 10
) {
	await act(async () => {
		element.dispatchEvent(
			new PointerEvent(type, {
				bubbles: true,
				button: 0,
				cancelable: true,
				clientX,
				clientY,
				pointerId: 1,
			})
		);
	});
}

describe("OverlayLanes", () => {
	test("renders title, graphic, caption, and adjustment lanes", async () => {
		const view = await mount({
			...newProject("Lanes"),
			captions: [caption(0, 1)],
			titles: [title(1, 3, "Intro")],
		});
		try {
			const lanes = [...view.host.querySelectorAll("[data-overlay-lane]")].map(
				(lane) => lane.getAttribute("data-overlay-lane")
			);
			expect(lanes).toEqual([
				"titles",
				"graphics",
				"captions",
				"adjustmentLayers",
			]);
			const item = view.host.querySelector<HTMLElement>(
				'[data-overlay-kind="titles"]'
			);
			expect(item?.style.left).toBe("100px");
			expect(item?.style.width).toBe("200px");
			expect(item?.textContent).toContain("Intro");
		} finally {
			await view.cleanup();
		}
	});

	test("dragging a title on its lane updates start and end", async () => {
		const item = title(1, 3);
		const view = await mount({ ...newProject("Drag"), titles: [item] });
		try {
			const element = itemElement(view.host, item.id);
			placeBox(element, 100, 200);
			await pointer(element, "pointerdown", 200);
			await pointer(element, "pointermove", 350);
			expect(itemElement(view.host, item.id).style.left).toBe("250px");
			await pointer(element, "pointerup", 350);
			expect(view.runtime.project?.titles[0]).toMatchObject({
				end: 4.5,
				start: 2.5,
			});
			expect(view.runtime.calls.filter(([name]) => name === "edit")).toEqual([
				["edit", "Move title"],
			]);
		} finally {
			await view.cleanup();
		}
	});

	test("dragging an edge trims and keeps start before end", async () => {
		const item = title(1, 3);
		const view = await mount({ ...newProject("Trim"), titles: [item] });
		try {
			const element = itemElement(view.host, item.id);
			placeBox(element, 100, 200);
			await pointer(element, "pointerdown", 298);
			await pointer(element, "pointermove", 0);
			await pointer(element, "pointerup", 0);
			const trimmed = view.runtime.project?.titles[0];
			expect(trimmed?.start).toBe(1);
			expect(trimmed && trimmed.end > trimmed.start).toBe(true);
			expect(trimmed?.end).toBeCloseTo(1 + 1 / 30, 9);
		} finally {
			await view.cleanup();
		}
	});

	test("clicking selects the overlay; Delete removes it", async () => {
		const item = title(1, 3);
		const view = await mount({ ...newProject("Select"), titles: [item] });
		try {
			const element = itemElement(view.host, item.id);
			await act(async () => {
				element.click();
			});
			expect(view.runtime.store.getState().selection.overlayIds).toEqual([
				{ id: item.id, kind: "titles" },
			]);
			expect(element.getAttribute("aria-pressed")).toBe("true");
			await act(async () => {
				element.dispatchEvent(
					new KeyboardEvent("keydown", { bubbles: true, key: "Delete" })
				);
			});
			expect(view.runtime.project?.titles).toEqual([]);
			expect(view.runtime.store.getState().selection.overlayIds).toEqual([]);
		} finally {
			await view.cleanup();
		}
	});

	test("Mod+D duplicates and selects the copy", async () => {
		const item = title(1, 3);
		const view = await mount({ ...newProject("Duplicate"), titles: [item] });
		try {
			await act(async () => {
				itemElement(view.host, item.id).dispatchEvent(
					new KeyboardEvent("keydown", {
						bubbles: true,
						ctrlKey: true,
						key: "d",
					})
				);
			});
			const titles = view.runtime.project?.titles ?? [];
			expect(
				titles.map((candidate) => [candidate.start, candidate.end])
			).toEqual([
				[1, 3],
				[3, 5],
			]);
			expect(view.runtime.store.getState().selection.overlayIds).toEqual([
				{ id: titles[1]?.id ?? "", kind: "titles" },
			]);
		} finally {
			await view.cleanup();
		}
	});

	test("a nudge that changes nothing records no undo step", async () => {
		const item = title(0, 2);
		const view = await mount({ ...newProject("Nudge"), titles: [item] });
		try {
			const before = view.runtime.store.getState().history.past.length;
			await act(async () => {
				itemElement(view.host, item.id).dispatchEvent(
					new KeyboardEvent("keydown", {
						altKey: true,
						bubbles: true,
						key: "ArrowLeft",
					})
				);
			});
			expect(view.runtime.store.getState().history.past.length).toBe(before);
			expect(view.runtime.calls.filter(([name]) => name === "edit")).toEqual(
				[]
			);
			expect(view.runtime.project?.titles[0]).toMatchObject({
				end: 2,
				start: 0,
			});
			await act(async () => {
				itemElement(view.host, item.id).dispatchEvent(
					new KeyboardEvent("keydown", {
						altKey: true,
						bubbles: true,
						key: "ArrowRight",
						shiftKey: true,
					})
				);
			});
			expect(view.runtime.store.getState().history.past.length).toBe(
				before + 1
			);
		} finally {
			await view.cleanup();
		}
	});

	test("a lane collapses and hides its items", async () => {
		const item = title(1, 3);
		const view = await mount({ ...newProject("Collapse"), titles: [item] });
		try {
			const toggle = view.host.querySelector<HTMLElement>(
				'[data-overlay-lane="titles"] [aria-expanded]'
			);
			expect(toggle?.getAttribute("aria-expanded")).toBe("true");
			await act(async () => {
				toggle?.click();
			});
			expect(
				view.host
					.querySelector('[data-overlay-lane="titles"]')
					?.getAttribute("data-collapsed")
			).toBe("true");
			expect(
				view.host.querySelector(`[data-overlay-id="${item.id}"]`)
			).toBeNull();
		} finally {
			await view.cleanup();
		}
	});
});

describe("overlay keyframe lanes", () => {
	// An earlier test collapses the titles lane in viewer storage.
	beforeEach(() => {
		localStorage.clear();
	});
	const blueId = crypto.randomUUID();
	const keyed = (): Title => ({
		...title(1, 3, "Keyed"),
		keyframes: [
			{
				color: "#ff0000",
				id: crypto.randomUUID(),
				property: "color",
				time: 0,
				value: 0,
			},
			{ color: "#0000ff", id: blueId, property: "color", time: 1, value: 0 },
			{ id: crypto.randomUUID(), property: "fontSize", time: 0.5, value: 0.1 },
		],
	});

	async function openLanes(
		view: Awaited<ReturnType<typeof mount>>,
		id: string
	) {
		await act(async () => {
			itemElement(view.host, id).click();
		});
		const toggle = view.host.querySelector<HTMLElement>(
			`[data-overlay-keyframe-toggle="${id}"]`
		);
		if (!toggle) {
			throw new Error(`no keyframe lane toggle for ${id}`);
		}
		await act(async () => {
			toggle.click();
		});
	}

	test("a selected title expands one lane per animated channel", async () => {
		const item = keyed();
		const view = await mount({ ...newProject("Lanes"), titles: [item] });
		try {
			expect(
				view.host.querySelector(`[data-overlay-keyframe-toggle="${item.id}"]`)
			).toBeNull();
			await openLanes(view, item.id);
			const lanes = [
				...view.host.querySelectorAll("[data-overlay-keyframe-lane]"),
			].map((lane) => lane.getAttribute("data-overlay-keyframe-lane"));
			expect(lanes).toEqual(["fontSize", "color"]);
			const panel = view.host.querySelector<HTMLElement>(
				`[data-overlay-keyframe-lanes="${item.id}"]`
			);
			expect(panel?.style.marginLeft).toBe("100px");
			const colorDiamond = view.host.querySelector<HTMLElement>(
				`[data-overlay-keyframe-diamond="${blueId}"]`
			);
			expect(colorDiamond?.getAttribute("aria-label")).toContain("#0000ff");
			expect(colorDiamond?.style.left).toBe("95px");
		} finally {
			await view.cleanup();
		}
	});

	test("arrow keys retime a title keyframe and Delete removes it", async () => {
		const item = keyed();
		const view = await mount({ ...newProject("Nudge keys"), titles: [item] });
		try {
			await openLanes(view, item.id);
			const diamond = () =>
				view.host.querySelector<HTMLElement>(
					'[data-overlay-keyframe-lane="fontSize"] [data-overlay-keyframe-diamond]'
				);
			await act(async () => {
				diamond()?.dispatchEvent(
					new KeyboardEvent("keydown", {
						bubbles: true,
						key: "ArrowRight",
						shiftKey: true,
					})
				);
			});
			const moved = view.runtime.project?.titles[0]?.keyframes?.find(
				(frame) => frame.property === "fontSize"
			);
			expect(moved?.time).toBeCloseTo(0.5 + 10 / 30, 6);
			expect(moved?.value).toBe(0.1);
			await act(async () => {
				diamond()?.dispatchEvent(
					new KeyboardEvent("keydown", { bubbles: true, key: "Delete" })
				);
			});
			const left = view.runtime.project?.titles[0]?.keyframes ?? [];
			expect(left.map((frame) => frame.property)).toEqual(["color", "color"]);
			expect(view.runtime.calls.filter(([name]) => name === "edit")).toEqual([
				["edit", "Move keyframe"],
				["edit", "Delete keyframe"],
			]);
		} finally {
			await view.cleanup();
		}
	});

	test("Add records a graphic channel at the playhead", async () => {
		const graphic = {
			animation: "none" as const,
			end: 4,
			entryDuration: 0,
			fill: "#336699",
			height: 0.2,
			id: crypto.randomUUID(),
			opacity: 1,
			shape: "star" as const,
			start: 2,
			stroke: "#ffffff",
			strokeWidth: 0.01,
			width: 0.2,
			x: 0.1,
			y: 0.1,
		};
		const view = await mount({ ...newProject("Add"), graphics: [graphic] });
		try {
			await openLanes(view, graphic.id);
			view.runtime.time = 3;
			await view.render();
			const select = view.host.querySelector<HTMLSelectElement>(
				'[aria-label="Graphic keyframe channel to add"]'
			);
			expect(select).not.toBeNull();
			await act(async () => {
				if (select) {
					select.value = "fill";
					select.dispatchEvent(new Event("change", { bubbles: true }));
				}
			});
			const add = [...view.host.querySelectorAll("button")].find(
				(button) => button.textContent === "Add"
			);
			await act(async () => {
				add?.click();
			});
			expect(view.runtime.project?.graphics[0]?.keyframes).toEqual([
				expect.objectContaining({
					color: "#336699",
					property: "fill",
					time: 1,
					value: 0,
				}),
			]);
			await view.render();
			expect(
				view.host.querySelector('[data-overlay-keyframe-lane="fill"]')
			).not.toBeNull();
		} finally {
			await view.cleanup();
		}
	});
});
