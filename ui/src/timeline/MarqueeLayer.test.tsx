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
const { createTestRuntime, testProject, testVideo } = await import(
	"../editor/test-runtime.ts"
);
const { Timeline } = await import("./Timeline.tsx");
const { ClipInspector } = await import("../inspector/ClipInspector.tsx");
const { selectClips } = await import("../editor/actions/select.ts");
const { clearSettingsClipboard } = await import(
	"../editor/actions/clipboard.ts"
);
const { startsMarquee } = await import("./useMarquee.ts");

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

const ROW_HEIGHT = 54;
const RULER_HEIGHT = 35;

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

/** Give the lanes a real geometry: ruler on top, then 54 px rows. */
function stubLayout(host: HTMLElement) {
	const tracks = host.querySelector<HTMLElement>(".studio-tracks");
	if (!tracks) {
		throw new Error("No lanes rendered.");
	}
	tracks.getBoundingClientRect = () => box(100, 50, 1000, 400);
	const rows = [
		...tracks.querySelectorAll<HTMLElement>(":scope > .studio-track"),
	];
	rows.forEach((row, index) => {
		row.getBoundingClientRect = () =>
			box(100, 50 + RULER_HEIGHT + index * ROW_HEIGHT, 1000, ROW_HEIGHT);
	});
	return { rows, tracks };
}

async function render(runtime: Runtime, children = <Timeline />) {
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	const draw = async () => {
		await act(async () => {
			root.render(
				<EditorProvider value={{ ...runtime }}>{children}</EditorProvider>
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
			clientX: x,
			clientY: y,
			pointerId: 7,
			...extra,
		})
	);
}

/** Track 0 holds clips at 0..5 and 6..9, track 1 a clip at 2..4 (zoom 70). */
function fixture() {
	const asset = testVideo("lanes.mp4", 20);
	const a = { ...newSegment(asset, 0, 0), sourceOut: 5 };
	const b = { ...newSegment(asset, 6, 0), sourceOut: 3 };
	const c = { ...newSegment(asset, 2, 1), sourceOut: 2 };
	const project: Project = {
		...testProject().project,
		segments: [a, b, c],
	};
	const runtime = createTestRuntime(project, [asset]);
	return { a, b, c, runtime };
}

describe("marquee selection", () => {
	test("dragging on empty lane space selects the clips the rectangle touches", async () => {
		const { a, c, runtime } = fixture();
		const view = await render(runtime);
		const { rows } = stubLayout(view.host);
		const lane = rows[1];
		if (!lane) {
			throw new Error("Missing lane row.");
		}
		// Start at 5.5 s on the track 1 row and drag back to 1 s on track 0.
		await act(async () => {
			pointer("pointerdown", lane, 100 + 5.5 * 70, 50 + RULER_HEIGHT + 60);
			pointer("pointermove", window, 100 + 1 * 70, 50 + RULER_HEIGHT + 20);
		});
		expect(view.host.querySelector("[data-marquee]")).not.toBeNull();
		expect(runtime.store.getState().drag?.kind).toBe("marquee");
		await act(async () => {
			pointer("pointerup", window, 100 + 1 * 70, 50 + RULER_HEIGHT + 20);
		});
		expect([...runtime.selectedIds].sort()).toEqual([a.id, c.id].sort());
		expect(runtime.store.getState().drag).toBeNull();
		expect(view.host.querySelector("[data-marquee]")).toBeNull();
		await view.unmount();
	});

	test("Shift extends the selection and a plain click clears it", async () => {
		const { a, b, c, runtime } = fixture();
		const view = await render(runtime);
		const { rows } = stubLayout(view.host);
		selectClips(runtime, [c.id]);
		const lane = rows[0];
		if (!lane) {
			throw new Error("Missing lane row.");
		}
		await act(async () => {
			pointer("pointerdown", lane, 100 + 5.5 * 70, 50 + RULER_HEIGHT + 10, {
				shiftKey: true,
			});
			pointer("pointermove", window, 100 + 7 * 70, 50 + RULER_HEIGHT + 20);
			pointer("pointerup", window, 100 + 7 * 70, 50 + RULER_HEIGHT + 20);
		});
		expect([...runtime.selectedIds].sort()).toEqual([b.id, c.id].sort());
		expect(runtime.selectedIds).not.toContain(a.id);
		await act(async () => {
			pointer("pointerdown", lane, 100 + 5.5 * 70, 50 + RULER_HEIGHT + 10);
			pointer("pointerup", window, 100 + 5.5 * 70, 50 + RULER_HEIGHT + 10);
		});
		expect(runtime.selectedIds).toEqual([]);
		await view.unmount();
	});

	test("Escape during a marquee restores the starting selection", async () => {
		const { c, runtime } = fixture();
		const view = await render(runtime);
		const { rows } = stubLayout(view.host);
		selectClips(runtime, [c.id]);
		const lane = rows[0];
		if (!lane) {
			throw new Error("Missing lane row.");
		}
		await act(async () => {
			pointer("pointerdown", lane, 100 + 5.5 * 70, 50 + RULER_HEIGHT + 10);
			pointer("pointermove", window, 100 + 1 * 70, 50 + RULER_HEIGHT + 20);
		});
		expect(runtime.store.getState().selection.segmentIds).not.toEqual([c.id]);
		runtime.store.setState({ drag: null });
		await act(async () => {
			pointer("pointerup", window, 100 + 1 * 70, 50 + RULER_HEIGHT + 20);
		});
		expect(runtime.selectedIds).toEqual([c.id]);
		await view.unmount();
	});

	test("presses on clips and headers never start a marquee", async () => {
		const { runtime } = fixture();
		const view = await render(runtime);
		const clip = view.host.querySelector(".studio-timeline-clip");
		const header = view.host.querySelector(".studio-track-label");
		const lane = view.host.querySelector(".studio-track");
		expect(startsMarquee(clip)).toBe(false);
		expect(startsMarquee(header)).toBe(false);
		expect(startsMarquee(lane)).toBe(true);
		expect(startsMarquee(null)).toBe(false);
		await view.unmount();
	});
});

describe("clipboard inspector section", () => {
	test("copies settings and pastes the checked groups onto the selection", async () => {
		clearSettingsClipboard();
		const { a, b, runtime } = fixture();
		runtime.project = {
			...(runtime.project as Project),
			segments: (runtime.project?.segments ?? []).map((segment) =>
				segment.id === a.id
					? { ...segment, brightness: 0.3, opacity: 0.4 }
					: segment
			),
		};
		selectClips(runtime, [a.id]);
		const view = await render(runtime, <ClipInspector />);
		const button = (name: string) =>
			[...view.host.querySelectorAll("button")].find((candidate) =>
				candidate.textContent?.startsWith(name)
			);
		expect(button("Paste settings")?.disabled).toBe(true);
		await act(async () => {
			button("Copy settings")?.click();
		});
		const transform = view.host.querySelector<HTMLElement>(
			"#clipboard-group-transform"
		);
		await act(async () => {
			transform?.click();
		});
		selectClips(runtime, [b.id]);
		await view.draw();
		await act(async () => {
			button("Paste settings")?.click();
		});
		const pasted = runtime.project?.segments.find(
			(segment) => segment.id === b.id
		);
		expect(pasted).toMatchObject({ brightness: 0.3, opacity: 1 });
		await view.unmount();
	});
});
