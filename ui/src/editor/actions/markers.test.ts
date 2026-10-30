import { describe, expect, test } from "bun:test";
import { newProject, type Project } from "../../../../shared/project.ts";
import { runAction } from "../../shortcuts/registry.ts";
import { createTestRuntime, lastStatus, testProject } from "../test-runtime.ts";
import {
	addBarMarkers,
	addBeatMarkers,
	draggedMarkerTime,
	markerFromRange,
	moveMarker,
	navigateMarker,
	setRippleMarkers,
	toggleMarker,
	updateMarker,
} from "./markers.ts";

function setup(markers: Project["markers"] = []) {
	const project: Project = { ...newProject("Markers"), markers };
	const runtime = createTestRuntime(project);
	runtime.time = 2;
	return runtime;
}

const markersOf = (runtime: ReturnType<typeof setup>) =>
	runtime.project?.markers ?? [];

describe("marker actions", () => {
	test("beat and bar analysis markers are labelled and coloured apart", () => {
		const { asset, project } = testProject();
		const runtime = createTestRuntime(project, [asset]);
		addBeatMarkers(runtime, [0.5, 1], "song.mp3");
		expect(lastStatus(runtime)).toBe("Added 2 beat markers from song.mp3.");
		addBarMarkers(runtime, [1, 2], "song.mp3");
		expect(lastStatus(runtime)).toBe("Added 1 bar start marker from song.mp3.");
		expect(markersOf(runtime)).toMatchObject([
			{ color: "#f97316", label: "Beat 1", time: 0.5 },
			{ color: "#f97316", label: "Beat 2", time: 1 },
			{ color: "#a855f7", label: "Bar 3", time: 2 },
		]);
	});

	test("M toggles a marker at the playhead as one undo step each way", () => {
		const runtime = setup();
		runtime.markerLabel = "Hook";
		expect(runAction("markers.toggle", runtime)).toBe(true);
		expect(markersOf(runtime)).toMatchObject([{ label: "Hook", time: 2 }]);
		expect(runtime.markerLabel).toBe("");
		expect(lastStatus(runtime)).toBe("Marker added at 0:02.0.");
		toggleMarker(runtime, 2.01);
		expect(markersOf(runtime)).toEqual([]);
		expect(lastStatus(runtime)).toBe("Removed marker Hook.");
		runtime.undo();
		expect(markersOf(runtime)).toHaveLength(1);
	});

	test("Alt+M marks the in/out range, and refuses an empty range", () => {
		const runtime = setup();
		runtime.range = { end: 1, start: 1 };
		markerFromRange(runtime);
		expect(markersOf(runtime)).toEqual([]);
		expect(lastStatus(runtime)).toBe(
			"Set an in and out range before marking it."
		);
		runtime.range = { end: 4.5, start: 1.5 };
		expect(runAction("markers.fromRange", runtime)).toBe(true);
		expect(markersOf(runtime)).toMatchObject([
			{ duration: 3, label: "Range 1", time: 1.5 },
		]);
	});

	test("move, update, and ripple go through the shared operation", () => {
		const id = crypto.randomUUID();
		const runtime = setup([{ id, label: "Cue", time: 1 }]);
		moveMarker(runtime, id, 3.25);
		expect(markersOf(runtime)[0]?.time).toBe(3.25);
		updateMarker(runtime, id, { comment: "Check sync", status: "review" });
		expect(markersOf(runtime)[0]).toMatchObject({
			comment: "Check sync",
			status: "review",
		});
		setRippleMarkers(runtime, false);
		expect(runtime.project?.rippleMarkers).toBe(false);
		setRippleMarkers(runtime, true);
		expect(runtime.project && "rippleMarkers" in runtime.project).toBe(false);
	});

	test("an invalid edit reports a status instead of throwing", () => {
		const a = { id: crypto.randomUUID(), label: "A", time: 1 };
		const b = { id: crypto.randomUUID(), label: "B", time: 2 };
		const runtime = setup([a, b]);
		moveMarker(runtime, a.id, 2);
		expect(markersOf(runtime)).toEqual([a, b]);
		expect(lastStatus(runtime)).toBe(
			"A timeline marker already exists at that time."
		);
	});

	test("navigation wraps through markers in time order", () => {
		const runtime = setup([
			{ id: crypto.randomUUID(), label: "Late", time: 5 },
			{ id: crypto.randomUUID(), label: "Early", time: 1 },
		]);
		navigateMarker(runtime, 1);
		expect(runtime.time).toBe(5);
		navigateMarker(runtime, 1);
		expect(runtime.time).toBe(1);
		navigateMarker(runtime, -1);
		expect(runtime.time).toBe(5);
	});

	test("a dragged marker stays on the timeline with its range", () => {
		const point = { id: crypto.randomUUID(), label: "P", time: 1 };
		expect(draggedMarkerTime(point, -2, 10)).toBe(0);
		expect(draggedMarkerTime(point, 12, 10)).toBe(10);
		const range = { ...point, duration: 4 };
		expect(draggedMarkerTime(range, 9, 10)).toBe(6);
		const beyond = { ...point, time: 15 };
		expect(draggedMarkerTime(beyond, 20, 10)).toBe(15);
	});
});
