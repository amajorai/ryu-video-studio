import { afterAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { ReactNode } from "react";
import type { Asset, Project } from "../../../shared/project.ts";

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
const { titleSchema } = await import("../../../shared/project.ts");
const { EditorProvider } = await import("../editor/context.tsx");
const { createTestRuntime, testProject } = await import(
	"../editor/test-runtime.ts"
);
const {
	DEFAULT_TRACK_REGION,
	TrackingPanel,
	clampRegion,
	effectiveTargetOption,
	targetFromOption,
	targetOptionValue,
	trackingBlocker,
	trackingBody,
	trackingSummary,
} = await import("./TrackingPanel.tsx");

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

type Runtime = ReturnType<typeof createTestRuntime>;

function captureRouteEdits(runtime: Runtime) {
	const edits: [string, Record<string, unknown>][] = [];
	runtime.routeEdit = (action, body) => {
		edits.push([action, body]);
		return Promise.resolve({ extras: {}, status: "ok" });
	};
	return edits;
}

async function render(runtime: Runtime, node: ReactNode) {
	const element = document.createElement("div");
	document.body.append(element);
	const root = createRoot(element);
	await act(async () => {
		root.render(<EditorProvider value={runtime}>{node}</EditorProvider>);
	});
	return {
		element,
		unmount: async () => {
			await act(async () => root.unmount());
			element.remove();
		},
	};
}

const trackButton = (element: HTMLElement) =>
	[...element.querySelectorAll("button")].find(
		(button) => button.textContent?.trim() === "Track motion"
	);

function scene(): { asset: Asset; project: Project; titleId: string } {
	const { asset, project } = testProject();
	const label = titleSchema.parse({
		color: "#ffffff",
		end: 4,
		fadeIn: 0,
		fadeOut: 0,
		fontSize: 0.05,
		id: crypto.randomUUID(),
		start: 0,
		text: "Name tag",
		x: 0.5,
		y: 0.2,
	});
	return { asset, project: { ...project, titles: [label] }, titleId: label.id };
}

describe("tracking helpers", () => {
	test("target options round-trip", () => {
		const id = crypto.randomUUID();
		for (const target of [
			{ createRegion: "blur" as const },
			{ createRegion: "mosaic" as const },
			{ id, kind: "title" as const },
			{ id, kind: "clip" as const },
		]) {
			expect(targetFromOption(targetOptionValue(target))).toEqual(target);
		}
		expect(targetFromOption("avatar:x")).toBeNull();
		expect(targetFromOption("title:")).toBeNull();
	});

	test("regions stay inside the frame", () => {
		expect(clampRegion({ height: 0.3, width: 0.5, x: 0.8, y: -1 })).toEqual({
			height: 0.3,
			width: 0.5,
			x: 0.5,
			y: 0,
		});
		expect(clampRegion({ height: 0, width: 2, x: 0, y: 0 }).width).toBe(1);
	});

	test("the duration is only sent when it stops before the clip end", () => {
		const base = {
			clipId: "clip",
			region: DEFAULT_TRACK_REGION,
			remaining: 5,
			target: { createRegion: "blur" as const },
			time: 2,
		};
		expect(trackingBody({ ...base, duration: 120 })).not.toHaveProperty(
			"duration"
		);
		expect(trackingBody({ ...base, duration: 2 })).toMatchObject({
			duration: 2,
		});
	});

	test("summaries mention lost frames", () => {
		expect(
			trackingSummary({
				confidence: 0.934,
				keyframes: 42,
				lostFrames: 0,
				samples: 90,
			})
		).toBe("Tracked 90 frames (93% match) into 42 keyframes.");
		expect(
			trackingSummary({
				confidence: 0.5,
				keyframes: 4,
				lostFrames: 3,
				samples: 9,
			})
		).toContain("lost on 3 frames");
	});

	test("blockers explain missing selection, non-video clips and the playhead", () => {
		const { asset, project } = scene();
		const clip = project.segments[0];
		expect(trackingBlocker(undefined, [asset], 0)).toContain("Select");
		expect(trackingBlocker(clip, [{ ...asset, kind: "image" }], 0)).toContain(
			"video clips only"
		);
		expect(trackingBlocker(clip, [asset], 30)).toContain("playhead");
		expect(trackingBlocker(clip, [asset], 1)).toBeNull();
	});
});

describe("effectiveTargetOption", () => {
	const listed = [{ id: "a", kind: "title" as const }];
	test("keeps regions and listed followers", () => {
		expect(effectiveTargetOption("region:mosaic", [])).toBe("region:mosaic");
		expect(effectiveTargetOption("title:a", listed)).toBe("title:a");
	});
	test("falls back to the blur region for an unlisted follower", () => {
		expect(effectiveTargetOption("title:b", listed)).toBe("region:blur");
		expect(effectiveTargetOption("clip:a", listed)).toBe("region:blur");
	});
});

describe("TrackingPanel", () => {
	test("tracks the selected clip into a blur region by default", async () => {
		const { asset, project } = scene();
		const runtime = createTestRuntime(project, [asset]);
		const edits = captureRouteEdits(runtime);
		const clip = project.segments[0];
		runtime.setSelected(clip?.id ?? null);
		runtime.time = 1;
		const view = await render(runtime, <TrackingPanel />);
		await act(async () => {
			trackButton(view.element)?.click();
		});
		expect(edits).toEqual([
			[
				"track",
				{
					clipId: clip?.id,
					roi: DEFAULT_TRACK_REGION,
					target: { createRegion: "blur" },
					time: 1,
				},
			],
		]);
		await view.unmount();
	});

	test("lists on-screen titles as followers", async () => {
		const { asset, project, titleId } = scene();
		const runtime = createTestRuntime(project, [asset]);
		const edits = captureRouteEdits(runtime);
		runtime.setSelected(project.segments[0]?.id ?? null);
		runtime.time = 1;
		const view = await render(runtime, <TrackingPanel />);
		const select = view.element.querySelector<HTMLSelectElement>(
			'[aria-label="Follower"]'
		);
		const options = [...(select?.options ?? [])].map((item) => item.text);
		expect(options).toContain("Title: Name tag");
		await act(async () => {
			if (select) {
				select.value = `title:${titleId}`;
				select.dispatchEvent(new Event("change", { bubbles: true }));
			}
		});
		await act(async () => {
			trackButton(view.element)?.click();
		});
		expect(edits[0]?.[1].target).toEqual({ id: titleId, kind: "title" });
		await view.unmount();
	});

	test("a follower that leaves the screen falls back to the blur region", async () => {
		const { asset, project, titleId } = scene();
		const runtime = createTestRuntime(project, [asset]);
		const edits = captureRouteEdits(runtime);
		const clip = project.segments[0];
		runtime.setSelected(clip?.id ?? null);
		runtime.time = 1;
		const element = document.createElement("div");
		document.body.append(element);
		const root = createRoot(element);
		const draw = () =>
			act(async () => {
				root.render(
					<EditorProvider value={{ ...runtime }}>
						<TrackingPanel />
					</EditorProvider>
				);
			});
		await draw();
		const select = () =>
			element.querySelector<HTMLSelectElement>('[aria-label="Follower"]');
		await act(async () => {
			const menu = select();
			if (menu) {
				menu.value = `title:${titleId}`;
				menu.dispatchEvent(new Event("change", { bubbles: true }));
			}
		});
		expect(select()?.value).toBe(`title:${titleId}`);
		// The title ends at 4: past it, the menu and the request agree.
		runtime.time = 4.5;
		await draw();
		expect(select()?.value).toBe("region:blur");
		await act(async () => {
			trackButton(element)?.click();
		});
		expect(edits[0]?.[1].target).toEqual({ createRegion: "blur" });
		await act(async () => root.unmount());
		element.remove();
	});

	test("is disabled without a video clip selection", async () => {
		const { asset, project } = scene();
		const runtime = createTestRuntime(project, [asset]);
		const view = await render(runtime, <TrackingPanel />);
		expect(trackButton(view.element)?.disabled).toBe(true);
		expect(view.element.textContent).toContain("Select the video clip");
		await view.unmount();
	});
});
