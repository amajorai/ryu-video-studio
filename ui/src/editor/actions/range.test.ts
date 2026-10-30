import { afterEach, describe, expect, test } from "bun:test";
import { newSegment } from "../../../../shared/project.ts";
import {
	createTestRuntime,
	lastStatus,
	testProject,
	testVideo,
} from "../test-runtime.ts";
import { clearRange } from "./navigation.ts";
import { openRangeExport, scoreRange } from "./range.ts";

const originalRyu = globalThis.window?.ryu;
afterEach(() => {
	if (globalThis.window) {
		globalThis.window.ryu = originalRyu;
	}
});

function fixture() {
	const video = testVideo("range.mp4", 20);
	const project = {
		...testProject().project,
		segments: [{ ...newSegment(video, 0, 0), sourceOut: 12 }],
	};
	const runtime = createTestRuntime(project, [video]);
	runtime.duration = 12;
	return runtime;
}

describe("range actions", () => {
	test("export range opens the export panel with the range preset", () => {
		const runtime = fixture();
		openRangeExport(runtime);
		expect(runtime.store.getState().exportPreset ?? null).toBeNull();
		expect(lastStatus(runtime)).toContain("Mark a range");
		runtime.range = { end: 6, start: 2 };
		runtime.rangeMarked = true;
		openRangeExport(runtime, { saveAsAsset: true });
		expect(runtime.store.getState().exportPreset).toEqual({
			rangeOnly: true,
			saveAsAsset: true,
		});
		expect(runtime.panel).toBe("exports");
	});

	test("clear range hides the range and declines without one", () => {
		const runtime = fixture();
		expect(clearRange(runtime)).toBe(false);
		runtime.rangeMarked = true;
		expect(clearRange(runtime)).toBe(true);
		expect(runtime.rangeMarked).toBe(false);
	});

	test("score this range creates music for the range and places it there", async () => {
		const runtime = fixture();
		runtime.range = { end: 8, start: 3 };
		runtime.rangeMarked = true;
		const bodies: unknown[] = [];
		const music = {
			createdAt: new Date().toISOString(),
			duration: 5,
			hasAudio: true,
			height: 0,
			id: crypto.randomUUID(),
			kind: "audio",
			name: "Score.wav",
			width: 0,
		};
		globalThis.window ??= globalThis as unknown as Window & typeof globalThis;
		window.ryu = {
			app: {
				request: (input) => {
					bodies.push(input.body);
					return Promise.resolve(music);
				},
			},
		};
		await scoreRange(runtime);
		expect(bodies[0]).toMatchObject({ duration: 5, mood: "cinematic" });
		const placed = runtime.project?.segments.find(
			(segment) => segment.assetId === music.id
		);
		expect(placed?.start).toBe(3);
		expect(placed?.track).toBeGreaterThanOrEqual(1);
		expect(lastStatus(runtime)).toContain("Scored");
	});
});
