import { describe, expect, test } from "bun:test";
import { applyLayout, layoutRange } from "./layouts.ts";
import { newProject, newSegment } from "./project.ts";

function asset(id: string) {
	return {
		id,
		name: id,
		kind: "video" as const,
		duration: 4,
		width: 640,
		height: 360,
		hasAudio: false,
		createdAt: new Date().toISOString(),
	};
}

describe("timeline layout presets", () => {
	test("places selected clips in order and clears conflicting framing keyframes", () => {
		const first = asset(crypto.randomUUID());
		const second = asset(crypto.randomUUID());
		const project = newProject("Layout");
		const firstSegment = newSegment(first);
		firstSegment.keyframes = [
			{ id: crypto.randomUUID(), property: "x", time: 1, value: 0.4 },
			{ id: crypto.randomUUID(), property: "rotation", time: 1, value: 20 },
		];
		project.segments = [firstSegment, newSegment(second, 0, 1)];
		const next = applyLayout(
			project,
			[project.segments[0]!.id, project.segments[1]!.id],
			"side-by-side"
		);
		expect(next.segments.map(({ scale, x, y }) => ({ scale, x, y }))).toEqual([
			{ scale: 0.5, x: -0.5, y: 0 },
			{ scale: 0.5, x: 0.5, y: 0 },
		]);
		expect(next.segments[0]?.keyframes.map((frame) => frame.property)).toEqual([
			"rotation",
		]);
	});
	test("bounds named layout selection", () => {
		expect(layoutRange("grid-2x2")).toEqual({ max: 4, min: 2 });
		expect(layoutRange("grid-3x3")).toEqual({ max: 9, min: 2 });
		expect(layoutRange("grid-4x4")).toEqual({ max: 16, min: 2 });
		expect(() =>
			applyLayout(newProject("Invalid"), [], "picture-in-picture")
		).toThrow("Picture in picture needs 2 visual clips");
	});
	test("fills larger grids in deterministic top-left order", () => {
		const project = newProject("Large grid");
		const assets = Array.from({ length: 9 }, (_, index) =>
			asset(crypto.randomUUID())
		);
		project.segments = assets.map((item, index) => newSegment(item, index));
		const next = applyLayout(
			project,
			project.segments.map((segment) => segment.id),
			"grid-3x3"
		);
		expect(next.segments[0]?.scale).toBeCloseTo(1 / 3, 12);
		expect(next.segments[0]?.x).toBeCloseTo(-2 / 3, 12);
		expect(next.segments[0]?.y).toBeCloseTo(-2 / 3, 12);
		expect(next.segments[8]?.scale).toBeCloseTo(1 / 3, 12);
		expect(next.segments[8]?.x).toBeCloseTo(2 / 3, 12);
		expect(next.segments[8]?.y).toBeCloseTo(2 / 3, 12);
	});
});
