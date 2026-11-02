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
const { handleToolClick } = await import("./clip-click.ts");

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
const LANE_LEFT = 100;

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

/** Track 0 holds clips at 0..5 and 6..9; track 1 a clip at 2..4. */
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
	runtime.zoom = ZOOM;
	return { a, b, c, runtime };
}

function clipButton(host: HTMLElement, start: number) {
	const button = [
		...host.querySelectorAll<HTMLButtonElement>(".studio-timeline-clip"),
	].find((candidate) =>
		candidate.getAttribute("aria-label")?.includes(`at ${start.toFixed(2)}`)
	);
	if (!button) {
		throw new Error(`No clip at ${start}.`);
	}
	return button;
}

function laneFor(host: HTMLElement, track: number) {
	const lane = host
		.querySelector(`[data-gap-menu="${track}"]`)
		?.closest<HTMLElement>(".studio-track");
	if (!lane) {
		throw new Error(`No lane for track ${track}.`);
	}
	lane.getBoundingClientRect = () => ({
		bottom: 54,
		height: 54,
		left: LANE_LEFT,
		right: LANE_LEFT + 1000,
		toJSON: () => ({}),
		top: 0,
		width: 1000,
		x: LANE_LEFT,
		y: 0,
	});
	return lane;
}

describe("razor clicks", () => {
	test("a razor click on a clip splits it at the pointer", async () => {
		const { b, runtime } = fixture();
		runtime.setTool("razor");
		const view = await render(runtime);
		const button = clipButton(view.host, 6);
		await act(async () => {
			button.dispatchEvent(
				new MouseEvent("click", { bubbles: true, clientX: 1.5 * ZOOM })
			);
		});
		const track0 = (runtime.project?.segments ?? [])
			.filter((segment) => segment.track === 0)
			.sort((left, right) => left.start - right.start);
		expect(track0.map((segment) => segment.start)).toEqual([0, 6, 7.5]);
		expect(track0[1]?.id).toBe(b.id);
		expect(runtime.calls).toContainEqual(["edit", "Razor cut"]);
		// The click cut instead of selecting.
		expect(runtime.selectedIds).toEqual([]);
		await view.unmount();
	});

	test("Shift-click cuts every unlocked track at the pointer", async () => {
		const { runtime } = fixture();
		runtime.setTool("razor");
		const view = await render(runtime);
		await act(async () => {
			clipButton(view.host, 0).dispatchEvent(
				new MouseEvent("click", {
					bubbles: true,
					clientX: 3 * ZOOM,
					shiftKey: true,
				})
			);
		});
		expect(runtime.project?.segments).toHaveLength(5);
		await view.unmount();
	});

	test("without a mounted timeline the razor falls through to selection", async () => {
		const { a } = fixture();
		expect(
			handleToolClick({ at: 1, segment: a, shiftKey: false, tool: "razor" })
		).toBe(false);
		const { runtime } = fixture();
		const view = await render(runtime);
		expect(
			handleToolClick({ at: 1, segment: a, shiftKey: false, tool: "pointer" })
		).toBe(false);
		await view.unmount();
	});
});

describe("gap menu", () => {
	test("right-click on a gap offers Ripple delete gap, which closes it", async () => {
		const { b, runtime } = fixture();
		const view = await render(runtime);
		const lane = laneFor(view.host, 0);
		const event = new MouseEvent("contextmenu", {
			bubbles: true,
			cancelable: true,
			clientX: LANE_LEFT + 5.5 * ZOOM,
		});
		await act(async () => {
			lane.dispatchEvent(event);
		});
		expect(event.defaultPrevented).toBe(true);
		const item = [
			...document.querySelectorAll<HTMLElement>("[role='menuitem']"),
		].find((candidate) => candidate.textContent?.includes("Ripple delete gap"));
		expect(item?.textContent).toContain("0:01.0");
		await act(async () => {
			item?.click();
		});
		expect(
			runtime.project?.segments.find((segment) => segment.id === b.id)?.start
		).toBe(5);
		expect(runtime.calls).toContainEqual(["edit", "Ripple delete gap"]);
		await view.unmount();
	});

	test("right-click on a clip or after the last clip opens no gap menu", async () => {
		const { runtime } = fixture();
		const view = await render(runtime);
		const lane = laneFor(view.host, 0);
		const afterEnd = new MouseEvent("contextmenu", {
			bubbles: true,
			cancelable: true,
			clientX: LANE_LEFT + 12 * ZOOM,
		});
		await act(async () => {
			lane.dispatchEvent(afterEnd);
		});
		expect(afterEnd.defaultPrevented).toBe(false);
		const onClip = new MouseEvent("contextmenu", {
			bubbles: true,
			cancelable: true,
			clientX: LANE_LEFT + 1 * ZOOM,
		});
		await act(async () => {
			clipButton(view.host, 0).dispatchEvent(onClip);
		});
		// The clip's own context menu (W1-T10) may claim the event; the gap
		// menu must not open for it.
		const gapItems = [...document.querySelectorAll("[role='menuitem']")].filter(
			(item) => item.textContent?.includes("Ripple delete gap")
		);
		expect(gapItems).toHaveLength(0);
		await view.unmount();
	});
});
