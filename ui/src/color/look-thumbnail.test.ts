import { expect, test } from "bun:test";
import { identityCubeLut } from "../../../shared/cube-lut.ts";
import { gradePixels } from "./look-thumbnail.ts";

const pixels = Uint8ClampedArray.from([
	210, 105, 30, 255, 40, 120, 200, 128, 128, 128, 128, 255,
]);

test("mono looks turn colour pixels gray and keep alpha", () => {
	const out = gradePixels(pixels, "mono-contrast");
	for (let offset = 0; offset < out.length; offset += 4) {
		const [r = 0, g = 0, b = 0] = out.slice(offset, offset + 3);
		expect(Math.max(r, g, b) - Math.min(r, g, b)).toBeLessThanOrEqual(1);
	}
	expect(out[7]).toBe(128);
});

test("zero intensity leaves pixels unchanged", () => {
	expect(Array.from(gradePixels(pixels, "teal-orange", 0))).toEqual(
		Array.from(pixels)
	);
});

test("warm looks warm the frame", () => {
	const out = gradePixels(pixels, "golden-hour");
	// The neutral gray pixel gains red over blue.
	expect((out[8] ?? 0) - (out[10] ?? 0)).toBeGreaterThan(10);
});

test("a look replaces the clip's grade instead of stacking on it", () => {
	const noir = { exposure: -0.5, temperature: 0, tint: 0, vibrance: -1 };
	expect(
		Array.from(gradePixels(pixels, "vivid", 1, { grade: noir, lut: null }))
	).toEqual(Array.from(gradePixels(pixels, "vivid")));
});

test("the clip's LUT carries over into the preview", () => {
	const lut = identityCubeLut(2);
	// An inverting LUT at full intensity flips the gray pixel.
	for (let index = 0; index < lut.data.length; index++) {
		lut.data[index] = 1 - (lut.data[index] ?? 0);
	}
	const grade = {
		exposure: 0,
		lut: { intensity: 1, lutId: "00000000-0000-4000-8000-0000000000aa" },
		temperature: 0,
		tint: 0,
		vibrance: 0,
	};
	const out = gradePixels(pixels, "clean", 0, { grade, lut });
	expect(out[8]).toBe(127);
	expect(out[0]).toBe(45);
});
