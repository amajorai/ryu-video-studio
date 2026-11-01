import { afterAll, afterEach, describe, expect, test } from "bun:test";
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
let cleanup: (() => Promise<void>) | null = null;

afterEach(async () => {
	await cleanup?.();
	cleanup = null;
});

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
	cleanup = async () => {
		await act(async () => root.unmount());
		host.remove();
	};
	return { draw, host };
}

/** Track 0 holds clips at 0..5 and 6..9 of a 20s video. */
function fixture() {
	const asset = testVideo("lanes.mp4", 20);
	const a = { ...newSegment(asset, 0, 0), sourceOut: 5 };
	const b = { ...newSegment(asset, 6, 0), sourceOut: 3 };
	const project: Project = { ...testProject().project, segments: [a, b] };
	const runtime = createTestRuntime(project, [asset]);
	runtime.zoom = ZOOM;
	return { a, asset, b, runtime };
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

function placeClip(button: HTMLElement, start: number, width: number) {
	button.getBoundingClientRect = () => ({
		bottom: 40,
		height: 40,
		left: start * ZOOM,
		right: (start + width) * ZOOM,
		toJSON: () => ({}),
		top: 0,
		width: width * ZOOM,
		x: start * ZOOM,
		y: 0,
	});
}

async function rightClick(
	view: Awaited<ReturnType<typeof render>>,
	button: HTMLElement,
	clientX: number
) {
	const event = new MouseEvent("contextmenu", {
		bubbles: true,
		button: 2,
		cancelable: true,
		clientX,
		clientY: 20,
	});
	await act(async () => {
		button.dispatchEvent(event);
	});
	// The test runtime's selection lives outside React; hand the menu a fresh copy.
	await view.draw();
	return event;
}

const menuItem = (id: string) =>
	document.querySelector<HTMLElement>(`[data-menu-item="${id}"]`);

const menuItems = () => [
	...document.querySelectorAll<HTMLElement>(
		"[data-slot='context-menu-content'] [data-menu-item]"
	),
];

describe("clip context menu", () => {
	test("right-click opens the menu, selects the clip, and keeps the browser menu closed", async () => {
		const { b, runtime } = fixture();
		const view = await render(runtime);
		expect(menuItem("split")).toBeNull();
		const event = await rightClick(view, clipButton(view.host, 6), 7 * ZOOM);
		expect(event.defaultPrevented).toBe(true);
		expect(runtime.selectedIds).toEqual([b.id]);
		expect(
			document
				.querySelector("[data-slot='context-menu-content']")
				?.getAttribute("aria-label")
		).toBe("Clip actions");
		const labels = [
			...document.querySelectorAll("[data-slot='context-menu-label']"),
		].map((label) => label.textContent);
		expect(labels).toEqual([
			"Edit",
			"Label",
			"Audio",
			"Media",
			"Placement and AI",
		]);
		expect(menuItem("copy")?.textContent).toBe("Copy");
		// The playhead did not move.
		expect(runtime.calls.some(([name]) => name === "setTime")).toBe(false);
	});

	test("right-click split cuts the clip at the pointer", async () => {
		const { b, runtime } = fixture();
		runtime.store.setState({ snapEnabled: false });
		const view = await render(runtime);
		const button = clipButton(view.host, 6);
		placeClip(button, 6, 3);
		await rightClick(view, button, 7.5 * ZOOM);
		const split = menuItem("split");
		expect(split?.textContent).toBe("Split here");
		await act(async () => {
			split?.click();
		});
		const track0 = (runtime.project?.segments ?? [])
			.filter((segment) => segment.track === 0)
			.map((segment) => segment.start)
			.sort((left, right) => left - right);
		expect(track0).toEqual([0, 6, 7.5]);
		expect(
			runtime.project?.segments.find((segment) => segment.id === b.id)?.start
		).toBe(6);
		expect(runtime.calls).toContainEqual(["edit", "Razor cut"]);
	});

	test("with the playhead inside the clip, split dispatches the split action", async () => {
		const { runtime } = fixture();
		runtime.time = 2;
		const view = await render(runtime);
		await rightClick(view, clipButton(view.host, 0), 4 * ZOOM);
		const split = menuItem("split");
		expect(split?.textContent).toBe("Split at playhead");
		await act(async () => {
			split?.click();
		});
		expect(
			(runtime.project?.segments ?? []).map((segment) => segment.start).sort()
		).toEqual([0, 2, 6]);
	});

	test("unimplemented and inapplicable items are disabled with a reason", async () => {
		const { runtime } = fixture();
		const view = await render(runtime);
		await rightClick(view, clipButton(view.host, 0), 1 * ZOOM);
		const editWithAi = menuItem("edit-with-ai");
		expect(editWithAi?.getAttribute("aria-disabled")).toBe("true");
		expect(editWithAi?.textContent).toContain("Not available");
		expect(editWithAi?.title).toBe("Not available");
		const askAgent = menuItem("ask-agent");
		expect(askAgent?.getAttribute("aria-disabled")).toBe("true");
		const paste = menuItem("paste");
		expect(paste?.getAttribute("aria-disabled")).toBe("true");
		expect(paste?.title).toBe("Copy or cut clips first.");
		expect(menuItem("copy")?.getAttribute("aria-disabled")).not.toBe("true");
		const before = runtime.project;
		await act(async () => {
			editWithAi?.click();
			paste?.click();
		});
		expect(runtime.project).toBe(before);
	});

	test("arrow keys move through the enabled items", async () => {
		const { runtime } = fixture();
		const view = await render(runtime);
		await rightClick(view, clipButton(view.host, 0), 1 * ZOOM);
		const popup = document.querySelector<HTMLElement>(
			"[data-slot='context-menu-content']"
		);
		expect(popup).not.toBeNull();
		const press = async (key: string) => {
			await act(async () => {
				(document.activeElement ?? popup)?.dispatchEvent(
					new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key })
				);
			});
		};
		const highlighted = () =>
			menuItems()
				.find((element) => element.hasAttribute("data-highlighted"))
				?.getAttribute("data-menu-item");
		await press("ArrowDown");
		const first = highlighted();
		await press("ArrowDown");
		const second = highlighted();
		expect(first).toBeDefined();
		expect(second).toBeDefined();
		expect(second).not.toBe(first);
		await press("ArrowUp");
		expect(highlighted()).toBe(first);
		await press("End");
		expect(highlighted()).toBe("edit-with-ai");
		await press("Home");
		expect(highlighted()).toBe("split");
	});

	test("Copy then Paste settings and Mute run through the action registry", async () => {
		const { a, runtime } = fixture();
		const view = await render(runtime);
		await rightClick(view, clipButton(view.host, 0), 1 * ZOOM);
		await act(async () => {
			menuItem("mute")?.click();
		});
		expect(
			runtime.project?.segments.find((segment) => segment.id === a.id)?.muted
		).toBe(true);
		await view.draw();
		await rightClick(view, clipButton(view.host, 0), 1 * ZOOM);
		await act(async () => {
			menuItem("copy")?.click();
		});
		expect(runtime.store.getState().clipboard?.items[0]?.segmentId).toBe(a.id);
		await rightClick(view, clipButton(view.host, 6), 7 * ZOOM);
		expect(menuItem("paste")?.getAttribute("aria-disabled")).not.toBe("true");
	});

	test("Rename opens a dialog that labels the clip", async () => {
		const { a, runtime } = fixture();
		const view = await render(runtime);
		await rightClick(view, clipButton(view.host, 0), 1 * ZOOM);
		await act(async () => {
			menuItem("rename")?.click();
		});
		const input = document.querySelector<HTMLInputElement>(
			"input[aria-label='Clip label']"
		);
		expect(input).not.toBeNull();
		if (input) {
			input.value = "Cold open";
		}
		const submit = [
			...document.querySelectorAll<HTMLButtonElement>("button[type='submit']"),
		].find((button) => button.textContent === "Rename");
		await act(async () => {
			submit?.click();
		});
		expect(
			runtime.project?.segments.find((segment) => segment.id === a.id)?.label
		).toBe("Cold open");
		expect(runtime.calls).toContainEqual(["edit", "Rename clip"]);
	});

	test("a touch long-press splits at the touch, not a stale right-click", async () => {
		const { runtime } = fixture();
		runtime.store.setState({ snapEnabled: false });
		const view = await render(runtime);
		const button = clipButton(view.host, 6);
		placeClip(button, 6, 3);
		await rightClick(view, button, 7.5 * ZOOM);
		await act(async () => {
			menuItem("copy")?.click();
		});
		const touch = new Event("touchstart", { bubbles: true, cancelable: true });
		Object.defineProperty(touch, "touches", {
			value: [{ clientX: 8.5 * ZOOM, clientY: 20, identifier: 1 }],
		});
		await act(async () => {
			button.dispatchEvent(touch);
			await new Promise((resolve) => setTimeout(resolve, 650));
		});
		await view.draw();
		const split = menuItem("split");
		expect(split?.textContent).toBe("Split here");
		expect(split?.getAttribute("aria-disabled")).not.toBe("true");
		await act(async () => {
			split?.click();
		});
		const track0 = (runtime.project?.segments ?? [])
			.filter((segment) => segment.track === 0)
			.map((segment) => segment.start)
			.sort((left, right) => left - right);
		expect(track0).toEqual([0, 6, 8.5]);
	});

	test("a keyboard-opened menu has no pointer, so Split here is disabled", async () => {
		const { runtime } = fixture();
		const view = await render(runtime);
		const button = clipButton(view.host, 6);
		placeClip(button, 6, 3);
		await rightClick(view, button, 7.5 * ZOOM);
		await act(async () => {
			menuItem("copy")?.click();
		});
		await rightClick(view, button, 0);
		expect(menuItem("split")?.getAttribute("aria-disabled")).toBe("true");
	});

	test("Recover audio on a detached camera clip calls reattach-audio", async () => {
		const camera = testVideo("camera.mp4", 20);
		const extracted = {
			...testVideo("camera audio.wav", 20),
			derivation: "audio" as const,
			derivedFromAssetId: camera.id,
			hasAudio: true,
			kind: "audio" as const,
		};
		const groupId = crypto.randomUUID();
		const video = { ...newSegment(camera, 0, 0), linkGroupId: groupId };
		const audio = { ...newSegment(extracted, 0, 1), linkGroupId: groupId };
		const project: Project = {
			...testProject().project,
			segments: [video, audio],
		};
		const runtime = createTestRuntime(project, [camera, extracted]);
		runtime.zoom = ZOOM;
		const routes: [string, Record<string, unknown>][] = [];
		runtime.routeEdit = (action, body) => {
			routes.push([action, body]);
			return Promise.resolve({ status: "error" });
		};
		const view = await render(runtime);
		const button = [
			...view.host.querySelectorAll<HTMLElement>(".studio-timeline-clip"),
		].find((candidate) =>
			candidate.getAttribute("aria-label")?.includes("camera.mp4")
		);
		expect(button).toBeDefined();
		if (!button) {
			return;
		}
		await rightClick(view, button, 1 * ZOOM);
		const recover = menuItem("recover-audio");
		expect(recover?.getAttribute("aria-disabled")).not.toBe("true");
		expect(menuItem("detach-audio")).toBeNull();
		await act(async () => {
			recover?.click();
		});
		expect(routes).toEqual([["reattach-audio", { clipIds: [video.id] }]]);
	});
});
