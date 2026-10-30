import { describe, expect, test } from "bun:test";
import {
	editPoints,
	frameQuantize,
	markerPoints,
	nextEditPoint,
	nextMarkerPoint,
	nextPoint,
	previousEditPoint,
	previousMarkerPoint,
	previousPoint,
} from "./edit-points.ts";
import { type Asset, newProject, newSegment, type Project } from "./project.ts";

const video = (duration = 10): Asset => ({
	createdAt: new Date(0).toISOString(),
	duration,
	hasAudio: true,
	height: 360,
	id: crypto.randomUUID(),
	kind: "video",
	name: "clip.mp4",
	width: 640,
});

/** Two tracks: track 0 has [0,4] and [6,10]; track 1 has [2,5]. */
function fixture(): Project {
	const asset = video();
	return {
		...newProject("Edit points"),
		segments: [
			{ ...newSegment(asset, 0, 0), sourceOut: 4 },
			{ ...newSegment(asset, 6, 0), sourceIn: 1, sourceOut: 5 },
			{ ...newSegment(asset, 2, 1), sourceOut: 3 },
		],
	};
}

describe("editPoints", () => {
	test("is the sorted union of clip edges plus the timeline start", () => {
		expect(editPoints(fixture())).toEqual([0, 2, 4, 5, 6, 10]);
	});

	test("skips clips on hidden tracks", () => {
		const project: Project = {
			...fixture(),
			trackSettings: [
				{
					hidden: true,
					locked: false,
					muted: false,
					name: "V2",
					solo: false,
					track: 1,
				},
			],
		};
		expect(editPoints(project)).toEqual([0, 4, 6, 10]);
	});

	test("keeps clips on tracks whose setting is not hidden", () => {
		const project: Project = {
			...fixture(),
			trackSettings: [
				{
					hidden: false,
					locked: true,
					muted: true,
					name: "V2",
					solo: false,
					track: 1,
				},
			],
		};
		expect(editPoints(project)).toEqual([0, 2, 4, 5, 6, 10]);
	});

	test("accounts for speed and merges float-noise duplicates", () => {
		const asset = video(30);
		const project: Project = {
			...newProject("Speed"),
			segments: [
				// 3s of source at 3x lasts 1s: ends at 1.
				{ ...newSegment(asset, 0), sourceOut: 3, speed: 3 },
				// Starts at 1 + float noise.
				{ ...newSegment(asset, 0.1 + 0.2 + 0.7), sourceOut: 2 },
			],
		};
		expect(editPoints(project)).toEqual([0, 1, 3]);
	});

	test("an empty timeline has only the start", () => {
		expect(editPoints(newProject("Empty"))).toEqual([0]);
	});
});

describe("edit-point navigation", () => {
	const project = fixture();

	test("next steps to the first edge after the playhead", () => {
		expect(nextEditPoint(project, 0)).toBe(2);
		expect(nextEditPoint(project, 3)).toBe(4);
		expect(nextEditPoint(project, 5.5)).toBe(6);
	});

	test("a playhead parked on an edge moves past it", () => {
		expect(nextEditPoint(project, 4)).toBe(5);
		expect(previousEditPoint(project, 4)).toBe(2);
	});

	test("an edge within half a frame counts as the current position", () => {
		expect(nextEditPoint(project, 4 - 0.01)).toBe(5);
		expect(previousEditPoint(project, 4 + 0.01)).toBe(2);
	});

	test("previous steps back and stops at the start", () => {
		expect(previousEditPoint(project, 10)).toBe(6);
		expect(previousEditPoint(project, 1)).toBe(0);
		expect(previousEditPoint(project, 0)).toBeNull();
	});

	test("next returns null after the last edge", () => {
		expect(nextEditPoint(project, 10)).toBeNull();
		expect(nextEditPoint(project, 25)).toBeNull();
	});

	test("an explicit epsilon overrides the half-frame default", () => {
		expect(nextEditPoint(project, 3.9, { epsilon: 0.2 })).toBe(5);
		expect(nextEditPoint(project, 3.9, { epsilon: 0 })).toBe(4);
	});

	test("the default epsilon follows the project frame rate", () => {
		const fast: Project = { ...project, fps: 120 };
		// Half a frame at 120 fps is ~0.0042 s, so 0.01 s early still moves to 4.
		expect(nextEditPoint(fast, 4 - 0.01)).toBe(4);
		expect(nextEditPoint(project, 4 - 0.01)).toBe(5);
	});
});

describe("marker navigation", () => {
	const project: Project = {
		...newProject("Markers"),
		markers: [
			{ id: crypto.randomUUID(), label: "B", time: 5 },
			{ duration: 2, id: crypto.randomUUID(), label: "A", time: 1 },
			{ id: crypto.randomUUID(), label: "C", time: 5 },
		],
	};

	test("marker points include range ends and drop duplicates", () => {
		expect(markerPoints(project)).toEqual([1, 3, 5]);
	});

	test("steps between markers without wrapping", () => {
		expect(nextMarkerPoint(project, 0)).toBe(1);
		expect(nextMarkerPoint(project, 1)).toBe(3);
		expect(nextMarkerPoint(project, 5)).toBeNull();
		expect(previousMarkerPoint(project, 5)).toBe(3);
		expect(previousMarkerPoint(project, 1)).toBeNull();
	});

	test("no markers means no target", () => {
		expect(nextMarkerPoint(newProject("None"), 0)).toBeNull();
		expect(previousMarkerPoint(newProject("None"), 10)).toBeNull();
	});
});

describe("point helpers", () => {
	test("nextPoint and previousPoint work on any sorted list", () => {
		const points = [0, 1, 2];
		expect(nextPoint(points, 0.5, { epsilon: 0 })).toBe(1);
		expect(previousPoint(points, 0.5, { epsilon: 0 })).toBe(0);
		expect(nextPoint([], 0)).toBeNull();
		expect(previousPoint([], 0)).toBeNull();
	});

	test("frameQuantize rounds to the frame grid, including 29.97", () => {
		expect(frameQuantize(1.01, 30)).toBeCloseTo(1, 10);
		expect(frameQuantize(1.02, 30)).toBeCloseTo(31 / 30, 10);
		const ntsc = 30_000 / 1001;
		expect(frameQuantize(1, ntsc) * ntsc).toBeCloseTo(30, 10);
		expect(frameQuantize(Number.NaN, 30)).toBe(0);
		expect(frameQuantize(1, 0)).toBe(0);
	});
});
