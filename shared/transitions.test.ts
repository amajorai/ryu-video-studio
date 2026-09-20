import { expect, test } from "bun:test";
import { buildRender } from "../sidecar/src/render.ts";
import { type Asset, newProject, newSegment, splitSegment } from "./project.ts";
import { entryOpacity, entryScale, entryShift } from "./transitions.ts";

const asset: Asset = {
	id: crypto.randomUUID(),
	kind: "video",
	name: "Clip",
	duration: 4,
	width: 320,
	height: 180,
	hasAudio: false,
	createdAt: new Date().toISOString(),
};
test("entry transitions use timeline seconds in all four directions", () => {
	for (const [kind, axis, sign] of [
		["slide-left", "x", 1],
		["slide-right", "x", -1],
		["slide-up", "y", 1],
		["slide-down", "y", -1],
	] as const) {
		const clip = {
			...newSegment(asset),
			speed: 2,
			entryTransition: kind,
			entryDuration: 1,
		};
		expect(entryShift(clip, 0, axis)).toBe(sign);
		expect(entryShift(clip, 0.25, axis)).toBe(sign * 0.75);
		expect(entryShift(clip, 1, axis)).toBeCloseTo(0);
		expect(entryShift(clip, 3, axis)).toBeCloseTo(0);
	}
});
test("splitting during a slide preserves position on both sides of the cut", () => {
	const clip = {
		...newSegment(asset, 2),
		entryTransition: "slide-left" as const,
		entryDuration: 2,
	};
	const [left, right] = splitSegment(clip, 2.5);
	expect(entryShift(left, 0.49, "x")).toBe(entryShift(clip, 0.49, "x"));
	expect(entryShift(right, 0, "x")).toBe(entryShift(clip, 0.5, "x"));
	expect(entryShift(right, 0.75, "x")).toBe(entryShift(clip, 1.25, "x"));
	expect(entryShift({ ...clip, entryDuration: 0 }, 0, "x")).toBe(0);
});

test("crossfade and zoom transitions use the same bounded entry clock", () => {
	const crossfade = {
		...newSegment(asset),
		entryDuration: 1,
		entryTransition: "crossfade" as const,
	};
	expect(entryOpacity(crossfade, 0)).toBe(0);
	expect(entryOpacity(crossfade, 0.5)).toBe(0.5);
	expect(entryOpacity(crossfade, 1)).toBe(1);
	const zoomIn = { ...crossfade, entryTransition: "zoom-in" as const };
	const zoomOut = { ...crossfade, entryTransition: "zoom-out" as const };
	expect(entryScale(zoomIn, 0)).toBeCloseTo(0.85);
	expect(entryScale(zoomIn, 1)).toBeCloseTo(1);
	expect(entryScale(zoomOut, 0)).toBeCloseTo(1.15);
	expect(entryScale(zoomOut, 1)).toBeCloseTo(1);
});

test("FFmpeg graph emits crossfade and zoom entry effects", () => {
	const crossfade = {
		...newSegment(asset),
		entryDuration: 1,
		entryTransition: "crossfade" as const,
	};
	const zoom = {
		...newSegment(asset, 1),
		entryDuration: 1,
		entryTransition: "zoom-in" as const,
	};
	const args = buildRender(
		{ ...newProject("Transition graph"), segments: [crossfade, zoom] },
		[asset],
		(id) => `/tmp/${id}`
	);
	const filter = args[args.indexOf("-filter_complex") + 1] ?? "";
	expect(filter).toContain("fade=t=in:st=0:d=1:alpha=1");
	expect(filter).toContain("0.85+0.15*clip");
});
