import { describe, expect, test } from "bun:test";
import {
	newProject,
	newSegment,
	type Project,
} from "../../../../shared/project.ts";
import { createTestRuntime, lastStatus, testVideo } from "../test-runtime.ts";
import {
	goToEditPoint,
	goToMarkerPoint,
	navigationActions,
} from "./navigation.ts";

/** Track 0: 0..4 and 6..10; track 1 (hidden): 2..3. Markers at 1 and 5..7. */
function setup(hideTrackOne = true) {
	const asset = testVideo("clip.mp4", 10);
	const project: Project = {
		...newProject("Navigation"),
		markers: [
			{ id: crypto.randomUUID(), label: "One", time: 1 },
			{ duration: 2, id: crypto.randomUUID(), label: "Range", time: 5 },
		],
		segments: [
			{ ...newSegment(asset, 0, 0), sourceOut: 4 },
			{ ...newSegment(asset, 6, 0), sourceOut: 4 },
			{ ...newSegment(asset, 2, 1), sourceOut: 1 },
		],
		trackSettings: hideTrackOne
			? [
					{
						hidden: true,
						locked: false,
						muted: false,
						name: "V2",
						solo: false,
						track: 1,
					},
				]
			: [],
	};
	return createTestRuntime(project, [asset]);
}

describe("edit-point navigation", () => {
	test("Down steps through edges on visible tracks", () => {
		const runtime = setup();
		const visited: (number | null)[] = [];
		for (let step = 0; step < 4; step += 1) {
			visited.push(goToEditPoint(runtime, 1));
		}
		expect(visited).toEqual([4, 6, 10, null]);
		expect(runtime.time).toBe(10);
		expect(lastStatus(runtime)).toBe("No later edit point.");
	});

	test("hidden tracks are skipped; visible ones count", () => {
		const hidden = setup(true);
		hidden.time = 1;
		expect(goToEditPoint(hidden, 1)).toBe(4);
		const visible = setup(false);
		visible.time = 1;
		expect(goToEditPoint(visible, 1)).toBe(2);
	});

	test("Up steps back to the start and stops", () => {
		const runtime = setup();
		runtime.time = 7;
		expect(goToEditPoint(runtime, -1)).toBe(6);
		expect(goToEditPoint(runtime, -1)).toBe(4);
		expect(goToEditPoint(runtime, -1)).toBe(0);
		expect(goToEditPoint(runtime, -1)).toBeNull();
		expect(lastStatus(runtime)).toBe("No earlier edit point.");
	});

	test("navigation stops playback", () => {
		const runtime = setup();
		runtime.playing = true;
		navigationActions["navigation.nextEdit"]?.(runtime);
		expect(runtime.playing).toBe(false);
		expect(runtime.time).toBe(4);
	});

	test("does nothing without a project", () => {
		expect(goToEditPoint(createTestRuntime(null), 1)).toBeNull();
	});
});

describe("marker navigation", () => {
	test("Shift+Down visits marker starts and range ends without wrapping", () => {
		const runtime = setup();
		const visited: (number | null)[] = [];
		for (let step = 0; step < 4; step += 1) {
			visited.push(goToMarkerPoint(runtime, 1));
		}
		expect(visited).toEqual([1, 5, 7, null]);
		expect(lastStatus(runtime)).toBe("No later marker.");
	});

	test("Shift+Up steps back", () => {
		const runtime = setup();
		runtime.time = 6;
		navigationActions["navigation.previousMarker"]?.(runtime);
		expect(runtime.time).toBe(5);
		expect(lastStatus(runtime)).toBe("Marker at 0:05.0.");
		navigationActions["navigation.previousMarker"]?.(runtime);
		expect(runtime.time).toBe(1);
		navigationActions["navigation.nextMarker"]?.(runtime);
		expect(runtime.time).toBe(5);
	});

	test("asks for a marker when there are none", () => {
		const runtime = setup();
		if (runtime.project) {
			runtime.project = { ...runtime.project, markers: [] };
		}
		expect(goToMarkerPoint(runtime, 1)).toBeNull();
		expect(lastStatus(runtime)).toBe(
			"Add a timeline marker before navigating markers."
		);
	});
});
