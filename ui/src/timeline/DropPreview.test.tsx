import { afterAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { DragEvent as ReactDragEvent } from "react";
import {
	newProject,
	newSegment,
	type Project,
	segmentDuration,
} from "../../../shared/project.ts";
import { trackOrderFor } from "../../../shared/track-edits.ts";
import { createTestRuntime, testVideo } from "../editor/test-runtime.ts";
import {
	ASSET_DRAG_MIME,
	activeAssetDrag,
	assetDragProps,
} from "../library/drag-source.ts";

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
const { DropPreview } = await import("./DropPreview.tsx");
const { dropPointIn, resolveDropTarget } = await import("./useTimelineDrop.ts");
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
const RULER = 35;
const LANE = 54;

/** Pin an element's layout box (happy-dom does no layout). */
function placeBox(element: Element, top: number, height: number) {
	Object.defineProperty(element, "getBoundingClientRect", {
		value: () => ({
			bottom: top + height,
			height,
			left: 0,
			right: 2000,
			top,
			width: 2000,
			x: 0,
			y: top,
		}),
	});
}

function dragTransfer(data: Record<string, string>) {
	return {
		dropEffect: "none",
		effectAllowed: "copy",
		files: [],
		getData: (type: string) => data[type] ?? "",
		setData: (type: string, value: string) => {
			data[type] = value;
		},
		get types() {
			return Object.keys(data);
		},
	};
}

interface DragInit {
	clientX: number;
	clientY: number;
	ctrlKey?: boolean;
	relatedTarget?: EventTarget | null;
}

async function mount() {
	const existing = testVideo("existing.mp4", 10);
	const dropped = testVideo("dropped.mp4", 2);
	const project: Project = {
		...newProject("Drop preview"),
		segments: [newSegment(existing, 0, 1)],
	};
	const runtime = createTestRuntime(project, [existing, dropped]);
	runtime.zoom = ZOOM;
	runtime.time = 20;
	runtime.range = { end: 0, start: 0 };
	runtime.refresh();
	const order = trackOrderFor(project);
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	await act(async () => {
		root.render(
			<EditorProvider value={runtime}>
				<div className="studio-tracks">
					{order.map((track) => (
						<div className="studio-track" data-track={track} key={track} />
					))}
					<DropPreview zoom={ZOOM} />
				</div>
			</EditorProvider>
		);
	});
	const lanes = host.querySelector(".studio-tracks");
	if (!lanes) {
		throw new Error("lanes not rendered");
	}
	placeBox(lanes, 0, RULER + LANE * order.length);
	const rows = [...lanes.querySelectorAll(".studio-track")];
	rows.forEach((row, index) => placeBox(row, RULER + index * LANE, LANE));
	const rowFor = (track: number) => {
		const row = rows[order.indexOf(track)];
		if (!row) {
			throw new Error(`no lane ${track}`);
		}
		return row;
	};
	const laneY = (track: number) => RULER + order.indexOf(track) * LANE + 10;
	const data: Record<string, string> = {};
	const startDrag = () => {
		const tile = { closest: () => null };
		assetDragProps(dropped).onDragStart({
			currentTarget: tile,
			dataTransfer: dragTransfer(data),
			target: tile,
		} as unknown as ReactDragEvent<HTMLElement>);
	};
	const fire = async (type: string, target: Element, init: DragInit) => {
		const event = new Event(type, { bubbles: true, cancelable: true });
		Object.defineProperties(event, {
			clientX: { value: init.clientX },
			clientY: { value: init.clientY },
			ctrlKey: { value: init.ctrlKey ?? false },
			dataTransfer: { value: dragTransfer(data) },
			metaKey: { value: false },
			relatedTarget: { value: init.relatedTarget ?? null },
			shiftKey: { value: false },
		});
		await act(async () => {
			target.dispatchEvent(event);
		});
		return event;
	};
	const cleanup = async () => {
		await act(async () => {
			root.unmount();
		});
		host.remove();
	};
	return {
		cleanup,
		dropped,
		fire,
		host,
		laneY,
		order,
		rowFor,
		runtime,
		startDrag,
	};
}

const px = (element: Element | null, property: "left" | "width" | "top") =>
	Number.parseFloat((element as HTMLElement | null)?.style[property] ?? "NaN");

describe("timeline library drop", () => {
	test("dragging over a lane shows the ghost and overwrite shading", async () => {
		const view = await mount();
		try {
			view.startDrag();
			const over = await view.fire("dragover", view.rowFor(1), {
				clientX: 300,
				clientY: view.laneY(1),
			});
			expect(over.defaultPrevented).toBe(true);
			const ghost = view.host.querySelector("[data-drop-ghost]");
			expect(ghost?.getAttribute("data-drop-ghost")).toBe("overwrite");
			expect(px(ghost, "left")).toBe(300);
			expect(px(ghost, "width")).toBe(200);
			const impacts = view.host.querySelectorAll("[data-drop-impact]");
			expect(impacts).toHaveLength(1);
			expect(impacts[0]?.getAttribute("data-drop-impact")).toBe("split");
			expect(px(impacts[0] ?? null, "left")).toBe(300);
			expect(px(impacts[0] ?? null, "width")).toBe(200);

			await view.fire("dragover", view.rowFor(1), {
				clientX: 300,
				clientY: view.laneY(1),
				ctrlKey: true,
			});
			expect(
				view.host
					.querySelector("[data-drop-ghost]")
					?.getAttribute("data-drop-ghost")
			).toBe("insert");
			expect(view.host.querySelector("[data-drop-insert]")).not.toBeNull();
			expect(view.host.querySelectorAll("[data-drop-impact]")).toHaveLength(0);

			await view.fire("dragleave", view.rowFor(1), {
				clientX: 0,
				clientY: 0,
				relatedTarget: document.body,
			});
			expect(view.host.querySelector("[data-drop-ghost]")).toBeNull();
		} finally {
			await view.cleanup();
		}
	});

	test("dropping at 3.0 s on track 1 overwrites in one edit", async () => {
		const view = await mount();
		try {
			view.startDrag();
			await view.fire("dragover", view.rowFor(1), {
				clientX: 300,
				clientY: view.laneY(1),
			});
			const drop = await view.fire("drop", view.rowFor(1), {
				clientX: 300,
				clientY: view.laneY(1),
			});
			expect(drop.defaultPrevented).toBe(true);
			const lane = (view.runtime.project?.segments ?? [])
				.filter((segment) => segment.track === 1)
				.map((segment) => [
					segment.start,
					Number((segment.start + segmentDuration(segment)).toFixed(6)),
					segment.assetId === view.dropped.id,
				]);
			expect(lane).toEqual([
				[0, 3, false],
				[3, 5, true],
				[5, 10, false],
			]);
			expect(view.runtime.calls.filter(([name]) => name === "edit")).toEqual([
				["edit", "Place dropped.mp4"],
			]);
			expect(view.host.querySelector("[data-drop-ghost]")).toBeNull();
			expect(activeAssetDrag()).toBeNull();
			expect(view.runtime.store.getState().snapGuideTime).toBeNull();
		} finally {
			await view.cleanup();
		}
	});

	test("drags without library media are ignored by the lanes", async () => {
		const view = await mount();
		try {
			const event = new Event("dragover", { bubbles: true, cancelable: true });
			Object.defineProperty(event, "dataTransfer", {
				value: { types: ["text/plain"] },
			});
			await act(async () => {
				view.rowFor(1).dispatchEvent(event);
			});
			expect(event.defaultPrevented).toBe(false);
			expect(view.host.querySelector("[data-drop-ghost]")).toBeNull();
		} finally {
			await view.cleanup();
		}
	});
});

describe("drop target resolution", () => {
	test("points resolve to lanes and free tracks are chosen below the lanes", () => {
		const container = document.createElement("div");
		const order = [0, 1, 2];
		placeBox(container, 0, RULER + LANE * 3);
		for (const [index] of order.entries()) {
			const row = document.createElement("div");
			row.className = "studio-track";
			placeBox(row, RULER + index * LANE, LANE);
			container.append(row);
		}
		const point = dropPointIn(
			container,
			order,
			{ clientX: 250, clientY: 100 },
			ZOOM
		);
		expect(point.time).toBe(2.5);
		expect(point.track).toBe(1);
		expect(point.lanes[2]).toEqual({ height: LANE, top: RULER + 2 * LANE });
		const below = dropPointIn(
			container,
			order,
			{ clientX: -50, clientY: 900 },
			ZOOM
		);
		expect(below.time).toBe(0);
		expect(below.track).toBeUndefined();

		const video = testVideo("v.mp4", 4);
		const audio = { ...testVideo("a.wav", 4), kind: "audio" as const };
		const project: Project = {
			...newProject("Resolve"),
			segments: [newSegment(video, 0, 0), newSegment(video, 0, 1)],
		};
		const target = resolveDropTarget({
			asset: audio,
			assets: [video, audio],
			at: 1,
			lanes: below.lanes,
			mode: "overwrite",
			payload: { assetId: audio.id },
			project,
		});
		expect(target.autoTrack).toBe(true);
		expect(target.track).toBe(2);
		expect(target.impacts).toEqual([]);
		expect(target.lanes[2]).toEqual({ height: LANE, top: RULER + 2 * LANE });
		const fresh = resolveDropTarget({
			asset: video,
			assets: [video, audio],
			at: 0,
			lanes: {},
			mode: "overwrite",
			payload: { assetId: video.id },
			project: {
				...project,
				segments: [0, 1, 2].map((track) => newSegment(video, 0, track)),
			},
		});
		expect(fresh.track).toBe(3);
		expect(fresh.lanes[3]).toEqual({ height: LANE, top: 0 });
		expect(ASSET_DRAG_MIME).toBe("application/x-ryu-asset");
	});
});
