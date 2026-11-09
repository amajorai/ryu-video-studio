import { afterAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { useRef, useState } from "react";
import {
	newProject,
	newSegment,
	type Project,
} from "../../../shared/project.ts";
import {
	clearSnapGuide,
	createDragSnapper,
} from "../editor/actions/snapping.ts";
import type { EditorRuntime } from "../editor/runtime.ts";
import { createTestRuntime, testVideo } from "../editor/test-runtime.ts";

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
const { SnapIndicator } = await import("./SnapIndicator.tsx");
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

/**
 * A minimal draggable clip wired the way the pointer drag engine uses the
 * snapping contract: targets collected on pointerdown, each move snapped,
 * Shift suspends, pointerup clears the indicator.
 */
function DragHarness({
	clipId,
	runtime,
	start,
}: {
	clipId: string;
	runtime: EditorRuntime;
	start: number;
}) {
	const [position, setPosition] = useState(start);
	const drag = useRef<{
		originX: number;
		snapper: ReturnType<typeof createDragSnapper>;
	} | null>(null);
	return (
		<div
			data-clip-start={position}
			data-testid="clip"
			onPointerDown={(event) => {
				drag.current = {
					originX: event.clientX,
					snapper: createDragSnapper(runtime, { exclude: [clipId] }),
				};
			}}
			onPointerMove={(event) => {
				if (!drag.current) {
					return;
				}
				const candidate = start + (event.clientX - drag.current.originX) / ZOOM;
				setPosition(
					drag.current.snapper(candidate, { shiftKey: event.shiftKey }).time
				);
			}}
			onPointerUp={() => {
				drag.current = null;
				clearSnapGuide(runtime);
			}}
		>
			<SnapIndicator zoom={ZOOM} />
		</div>
	);
}

async function mountDrag() {
	const asset = testVideo("drag.mp4", 20);
	const neighbour = { ...newSegment(asset, 0, 0), sourceOut: 4 };
	const dragged = { ...newSegment(asset, 6, 0), sourceOut: 3 };
	const project: Project = {
		...newProject("Drag"),
		segments: [neighbour, dragged],
	};
	const runtime = createTestRuntime(project, [asset]);
	runtime.zoom = ZOOM;
	runtime.time = 15;
	runtime.range = { end: 0, start: 0 };
	runtime.refresh();
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	await act(async () => {
		root.render(
			<EditorProvider value={runtime}>
				<DragHarness clipId={dragged.id} runtime={runtime} start={6} />
			</EditorProvider>
		);
	});
	const clip = container.querySelector<HTMLElement>('[data-testid="clip"]');
	if (!clip) {
		throw new Error("clip not rendered");
	}
	const pointer = async (
		type: "pointerdown" | "pointermove" | "pointerup",
		clientX: number,
		shiftKey = false
	) => {
		await act(async () => {
			clip.dispatchEvent(
				new PointerEvent(type, { bubbles: true, clientX, shiftKey })
			);
		});
	};
	const guide = () => container.querySelector<HTMLElement>("[data-snap-guide]");
	const cleanup = async () => {
		await act(async () => {
			root.unmount();
		});
		container.remove();
	};
	return { clip, cleanup, guide, pointer, runtime };
}

describe("SnapIndicator", () => {
	test("a dragged clip snaps to the neighbour edge within 8 px and shows the guide", async () => {
		const { clip, cleanup, guide, pointer } = await mountDrag();
		expect(guide()).toBeNull();
		await pointer("pointerdown", 600);
		// 6 s → 4.07 s: 7 px right of the neighbour's end at 4 s.
		await pointer("pointermove", 407);
		expect(clip.dataset.clipStart).toBe("4");
		const line = guide();
		expect(line).not.toBeNull();
		expect(line?.style.left).toBe("400px");
		expect(line?.getAttribute("aria-hidden")).toBe("true");
		// 9 px away: frame-quantized and the guide hides.
		await pointer("pointermove", 409);
		expect(Number(clip.dataset.clipStart)).toBeCloseTo(4.1, 6);
		expect(guide()).toBeNull();
		await cleanup();
	});

	test("Shift suspends snapping and pointerup clears the guide", async () => {
		const { clip, cleanup, guide, pointer, runtime } = await mountDrag();
		await pointer("pointerdown", 600);
		await pointer("pointermove", 403, true);
		expect(Number(clip.dataset.clipStart)).toBeCloseTo(4.0333, 3);
		expect(guide()).toBeNull();
		await pointer("pointermove", 403);
		expect(guide()?.style.left).toBe("400px");
		await pointer("pointerup", 403);
		expect(runtime.store.getState().snapGuideTime).toBeNull();
		expect(guide()).toBeNull();
		await cleanup();
	});

	test("renders at the store's guide time scaled by zoom", async () => {
		const { cleanup, guide, runtime } = await mountDrag();
		await act(async () => {
			runtime.store.setState({ snapGuideTime: 2.5 });
		});
		expect(guide()?.style.left).toBe("250px");
		expect(guide()?.dataset.snapGuide).toBe("2.5");
		await cleanup();
	});
});
