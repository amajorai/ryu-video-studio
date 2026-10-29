import { describe, expect, test } from "bun:test";
import { createTestRuntime, testProject } from "../test-runtime.ts";
import { fitTimelineZoom, stepTimelineZoom, zoomActions } from "./zoom.ts";

function setup() {
	const { project } = testProject();
	return createTestRuntime(project);
}

describe("zoom actions", () => {
	test("+ and - step the zoom by 1.25x within 5..600 px/s", () => {
		const runtime = setup();
		runtime.store.setState({ zoomPxPerSec: 80 });
		zoomActions["zoom.in"]?.(runtime);
		expect(runtime.store.getState().zoomPxPerSec).toBe(100);
		zoomActions["zoom.out"]?.(runtime);
		zoomActions["zoom.out"]?.(runtime);
		expect(runtime.store.getState().zoomPxPerSec).toBe(64);
		runtime.store.setState({ zoomPxPerSec: 600 });
		expect(stepTimelineZoom(runtime, 1)).toBe(600);
		runtime.store.setState({ zoomPxPerSec: 5 });
		expect(stepTimelineZoom(runtime, -1)).toBe(5);
	});

	test("Shift+Z fits the timeline (800 px lanes without a mounted viewport)", () => {
		const runtime = setup();
		// testProject is 15 s long.
		expect(runtime.duration).toBe(15);
		const zoom = fitTimelineZoom(runtime);
		expect(runtime.store.getState().zoomPxPerSec).toBe(zoom);
		expect(zoom * runtime.duration).toBeLessThanOrEqual(800);
		expect(zoom * runtime.duration).toBeGreaterThan(700);
	});
});
