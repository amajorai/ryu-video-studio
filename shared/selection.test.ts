import { describe, expect, test } from "bun:test";
import {
	type Asset,
	newProject,
	newSegment,
	type Project,
	updateTrackSetting,
} from "./project.ts";
import {
	clipsInRect,
	marqueeSelection,
	rectFromPoints,
	selectAll,
	selectForward,
	timelineLayout,
	withLinkedPartners,
} from "./selection.ts";

const video: Asset = {
	createdAt: new Date(0).toISOString(),
	duration: 20,
	hasAudio: true,
	height: 360,
	id: crypto.randomUUID(),
	kind: "video",
	name: "clip.mp4",
	width: 640,
};

function fixture() {
	const linkGroupId = crypto.randomUUID();
	const a = { ...newSegment(video, 0, 0), sourceOut: 2 };
	const b = { ...newSegment(video, 2, 0), linkGroupId, sourceOut: 2 };
	const c = { ...newSegment(video, 4, 1), linkGroupId, sourceOut: 2 };
	const d = { ...newSegment(video, 1, 1), sourceOut: 2 };
	const project: Project = {
		...newProject("Selection"),
		segments: [a, b, c, d],
	};
	return { a, b, c, d, project };
}

describe("selection queries", () => {
	test("selectForward picks clips starting at or after the time, in timeline order", () => {
		const { b, c, project } = fixture();
		expect(selectForward(project, 2)).toEqual([b.id, c.id]);
		expect(selectForward(project, 2, { track: 1 })).toEqual([c.id]);
		expect(selectForward(project, 99)).toEqual([]);
	});

	test("selectAll covers every track or one, skipping locked tracks", () => {
		const { a, b, c, d, project } = fixture();
		expect(selectAll(project)).toEqual([a.id, d.id, b.id, c.id]);
		expect(selectAll(project, { track: 0 })).toEqual([a.id, b.id]);
		const locked = updateTrackSetting(project, 1, { locked: true });
		expect(selectAll(locked)).toEqual([a.id, b.id]);
		expect(selectForward(locked, 0)).toEqual([a.id, b.id]);
	});

	test("withLinkedPartners adds group members and drops unknown ids", () => {
		const { b, c, project } = fixture();
		expect(withLinkedPartners(project, [b.id, "missing"])).toEqual([
			b.id,
			c.id,
		]);
	});
});

describe("marquee hit testing", () => {
	const rows = [
		{ bottom: 54, top: 0, track: 1 },
		{ bottom: 108, top: 54, track: 0 },
	];

	test("layout maps start and duration through zoom and tracks to rows", () => {
		const { a, c, project } = fixture();
		const layout = timelineLayout(project, rows, 10);
		expect(layout.find((rect) => rect.id === a.id)).toEqual({
			bottom: 108,
			id: a.id,
			left: 0,
			right: 20,
			top: 54,
		});
		expect(layout.find((rect) => rect.id === c.id)).toMatchObject({
			left: 40,
			right: 60,
			top: 0,
		});
		expect(timelineLayout(project, rows.slice(0, 1), 10)).toHaveLength(2);
	});

	test("clipsInRect returns clips the rectangle overlaps", () => {
		const { a, b, d, project } = fixture();
		const layout = timelineLayout(project, rows, 10);
		const rect = rectFromPoints({ x: 25, y: 100 }, { x: 5, y: 30 });
		expect(rect).toEqual({ bottom: 100, left: 5, right: 25, top: 30 });
		expect(clipsInRect(layout, rect).sort()).toEqual([a.id, b.id, d.id].sort());
		// Touching an edge only does not select.
		expect(
			clipsInRect(layout, { bottom: 108, left: 20, right: 20.5, top: 60 })
		).toEqual([b.id]);
		expect(
			clipsInRect(layout, { bottom: 54, left: 0, right: 100, top: 0 })
		).not.toContain(a.id);
	});

	test("a marquee skips clips on locked tracks", () => {
		const { a, b, d, project } = fixture();
		const locked = updateTrackSetting(project, 0, { locked: true });
		const everything = { bottom: 108, left: 0, right: 100, top: 0 };
		const hits = clipsInRect(timelineLayout(locked, rows, 10), everything);
		expect(hits).toHaveLength(2);
		expect(hits).not.toContain(a.id);
		expect(hits).not.toContain(b.id);
		expect(hits).toContain(d.id);
	});

	test("marqueeSelection replaces or extends the starting selection", () => {
		expect(marqueeSelection(["x"], ["y"], false)).toEqual(["y"]);
		expect(marqueeSelection(["x", "y"], ["y", "z"], true)).toEqual([
			"x",
			"y",
			"z",
		]);
	});
});
