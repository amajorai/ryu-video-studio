import { describe, expect, test } from "bun:test";
import { newSegment, type Segment } from "../../../shared/project.ts";
import { testVideo } from "../editor/test-runtime.ts";
import {
	clipDrawSpan,
	clipsInWindow,
	laneIndex,
	laneIndexes,
	scrollBucket,
	VIRTUALIZE_MIN_CLIPS,
	viewportTimeWindow,
	visibleTimeWindow,
	widestClipPx,
} from "./virtualize.ts";

const asset = testVideo("lane.mp4", 4000);

function clip(start: number, length: number, track = 0): Segment {
	return { ...newSegment(asset, start, track), sourceIn: 0, sourceOut: length };
}

describe("laneIndex", () => {
	test("orders clips by start and tracks the furthest end", () => {
		const long = clip(0, 100);
		const lane = laneIndex([clip(50, 1), long, clip(10, 1)]);
		expect(lane.starts).toEqual([0, 10, 50]);
		expect(lane.reach).toEqual([100, 100, 100]);
		expect(lane.segments[0]).toBe(long);
	});

	test("groups clips per track", () => {
		const indexes = laneIndexes([clip(0, 1, 0), clip(0, 1, 2), clip(5, 1, 0)]);
		expect([...indexes.keys()]).toEqual([0, 2]);
		expect(indexes.get(0)?.segments).toHaveLength(2);
	});
});

describe("clipsInWindow", () => {
	const clips = Array.from({ length: 1000 }, (_, index) => clip(index, 1));
	const lane = laneIndex(clips);

	test("returns the clips overlapping the window, edges included", () => {
		const visible = clipsInWindow(lane, { end: 20, start: 10 });
		expect(visible.map((segment) => segment.start)).toEqual([
			9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20,
		]);
	});

	test("keeps a long clip that starts well before the window", () => {
		const long = clip(0, 900, 0);
		const mixed = laneIndex([long, ...clips.slice(800)]);
		const visible = clipsInWindow(mixed, { end: 805, start: 803 });
		expect(visible[0]).toBe(long);
		expect(visible.slice(1).map((segment) => segment.start)).toEqual([
			802, 803, 804, 805,
		]);
	});

	test("keeps selected clips outside the window, in start order", () => {
		const far = clips[900];
		const visible = clipsInWindow(
			lane,
			{ end: 3, start: 2 },
			new Set(far ? [far.id] : [])
		);
		expect(visible.map((segment) => segment.start)).toEqual([1, 2, 3, 900]);
	});

	test("returns every clip without a window", () => {
		expect(clipsInWindow(lane, null)).toBe(lane.segments);
	});
});

describe("visibleTimeWindow", () => {
	const base = {
		clipCount: 5000,
		lanesOffset: 176,
		scrollLeft: 0,
		viewportWidth: 1000,
		zoom: 100,
	};

	test("widens the viewport by one bucket and the overscan", () => {
		expect(visibleTimeWindow(base)).toEqual({ end: 20.24, start: 0 });
		expect(visibleTimeWindow({ ...base, scrollLeft: 4000 })).toEqual({
			end: 60.24,
			start: 30.24,
		});
	});

	test("mounts everything for short timelines or an unmeasured viewport", () => {
		expect(
			visibleTimeWindow({ ...base, clipCount: VIRTUALIZE_MIN_CLIPS - 1 })
		).toBeNull();
		expect(visibleTimeWindow({ ...base, viewportWidth: 0 })).toBeNull();
		expect(
			visibleTimeWindow({ ...base, viewportWidth: undefined })?.end
		).toBeCloseTo((2560 + 400 - 176 + 800) / 100);
		expect(visibleTimeWindow({ ...base, zoom: 0 })).toBeNull();
	});

	test("scroll offsets snap down to their bucket", () => {
		expect(scrollBucket(0)).toBe(0);
		expect(scrollBucket(399)).toBe(0);
		expect(scrollBucket(401)).toBe(400);
		expect(scrollBucket(-5)).toBe(0);
	});
});

describe("clip draw window", () => {
	test("the viewport window ignores the clip count", () => {
		const viewport = {
			lanesOffset: 100,
			scrollLeft: 4000,
			viewportWidth: 1000,
			zoom: 100,
		};
		expect(visibleTimeWindow({ ...viewport, clipCount: 3 })).toBe(null);
		expect(viewportTimeWindow(viewport)).toEqual({ end: 61, start: 31 });
		expect(viewportTimeWindow({ ...viewport, viewportWidth: 0 })).toBe(null);
	});

	test("wide clips draw only their overlap with the window", () => {
		const long = { ...clip(10, 600), speed: 2 };
		expect(widestClipPx([clip(0, 4), long], 100)).toBe(30_000);
		expect(clipDrawSpan(long, null, 100)).toEqual({ from: 0, to: 30_000 });
		expect(clipDrawSpan(long, { end: 60, start: 30 }, 100)).toEqual({
			from: 2000,
			to: 5000,
		});
		expect(clipDrawSpan(long, { end: 400, start: 305 }, 100)).toEqual({
			from: 29_500,
			to: 30_000,
		});
		const before = clipDrawSpan(long, { end: 5, start: 0 }, 100);
		expect(before.to - before.from).toBe(0);
	});
});
