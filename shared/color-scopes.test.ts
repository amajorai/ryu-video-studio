import { describe, expect, test } from "bun:test";
import {
	colorScopesDetailSchema,
	computeScopeWaveforms,
	lumaCode,
	SCOPE_PARADE_BINS,
	SCOPE_VECTOR_SIZE,
	scopeIntensity,
	scopePeak,
	scopeSampleSize,
	scopeWaveformsSchema,
	vectorscopeCell,
} from "./color-scopes.ts";

function solid(width: number, height: number, rgb: [number, number, number]) {
	const frame = new Uint8Array(width * height * 3);
	for (let index = 0; index < width * height; index++) {
		frame.set(rgb, index * 3);
	}
	return frame;
}

const sum = (values: readonly number[]) =>
	values.reduce((total, value) => total + value, 0);

describe("luma histogram", () => {
	test("a solid black frame fills bin 0 and reports crushed blacks", () => {
		const scopes = computeScopeWaveforms(solid(8, 4, [0, 0, 0]), 8, 4, 8);
		expect(scopes.histogram[0]).toBe(32);
		expect(sum(scopes.histogram)).toBe(32);
		expect(scopes.luma).toEqual({ average: 0, max: 0, min: 0 });
		expect(scopes.clipped).toEqual({ black: 1, white: 0 });
	});

	test("a solid white frame fills bin 255 and reports clipped whites", () => {
		const scopes = computeScopeWaveforms(solid(4, 4, [255, 255, 255]), 4, 4, 4);
		expect(scopes.histogram[255]).toBe(16);
		expect(scopes.clipped).toEqual({ black: 0, white: 1 });
		expect(scopes.luma.average).toBe(1);
	});

	test("a half-black, half-white split lands in two bins", () => {
		const frame = solid(4, 2, [0, 0, 0]);
		frame.set([255, 255, 255, 255, 255, 255], 6);
		frame.set([255, 255, 255, 255, 255, 255], 18);
		const scopes = computeScopeWaveforms(frame, 4, 2, 4);
		expect(scopes.histogram[0]).toBe(4);
		expect(scopes.histogram[255]).toBe(4);
		expect(scopes.luma.average).toBe(0.5);
	});

	test("pure primaries use BT.709 luma weights", () => {
		expect(lumaCode(255, 0, 0)).toBe(54);
		expect(lumaCode(0, 255, 0)).toBe(182);
		expect(lumaCode(0, 0, 255)).toBe(18);
		const red = computeScopeWaveforms(solid(2, 2, [255, 0, 0]), 2, 2, 2);
		expect(red.histogram[54]).toBe(4);
	});
});

describe("RGB parade", () => {
	test("columns follow horizontal position and bins follow value", () => {
		// Left half pure red, right half pure blue.
		const frame = new Uint8Array(4 * 1 * 3);
		frame.set([255, 0, 0, 255, 0, 0, 0, 0, 255, 0, 0, 255]);
		const scopes = computeScopeWaveforms(frame, 4, 1, 2);
		expect(scopes.parade.columns).toBe(2);
		expect(scopes.parade.r[0]?.[SCOPE_PARADE_BINS - 1]).toBe(2);
		expect(scopes.parade.r[1]?.[0]).toBe(2);
		expect(scopes.parade.b[0]?.[0]).toBe(2);
		expect(scopes.parade.b[1]?.[SCOPE_PARADE_BINS - 1]).toBe(2);
		expect(scopes.parade.g[0]?.[0]).toBe(2);
	});

	test("never asks for more columns than the frame is wide", () => {
		const scopes = computeScopeWaveforms(solid(3, 2, [10, 20, 30]), 3, 2, 64);
		expect(scopes.parade.columns).toBe(3);
		expect(scopes.parade.r).toHaveLength(3);
		for (const row of scopes.parade.g) {
			expect(sum(row)).toBe(2);
		}
	});
});

describe("vectorscope", () => {
	test("neutral grey sits in the centre cell", () => {
		expect(vectorscopeCell(128, 128, 128)).toEqual({
			column: SCOPE_VECTOR_SIZE / 2,
			row: SCOPE_VECTOR_SIZE / 2,
		});
		const scopes = computeScopeWaveforms(solid(4, 4, [128, 128, 128]), 4, 4, 4);
		expect(
			scopes.vectorscope.cells[SCOPE_VECTOR_SIZE / 2]?.[SCOPE_VECTOR_SIZE / 2]
		).toBe(16);
	});

	test("red points up-left, blue points right", () => {
		const red = vectorscopeCell(255, 0, 0);
		expect(red.row).toBe(0);
		expect(red.column).toBeLessThan(SCOPE_VECTOR_SIZE / 2);
		const blue = vectorscopeCell(0, 0, 255);
		expect(blue.column).toBe(SCOPE_VECTOR_SIZE - 1);
		expect(blue.row).toBeGreaterThan(SCOPE_VECTOR_SIZE / 2);
	});
});

describe("contracts and helpers", () => {
	test("results round-trip through the strict schemas", () => {
		const waveforms = computeScopeWaveforms(
			solid(16, 9, [40, 120, 200]),
			16,
			9,
			16
		);
		expect(scopeWaveformsSchema.parse(waveforms)).toEqual(waveforms);
		expect(
			colorScopesDetailSchema.safeParse({
				assetId: crypto.randomUUID(),
				chroma: { u: 0.5, v: 0.5 },
				clipping: { black: false, white: false },
				hueDegrees: 0,
				luma: { average: 0.5, max: 0.5, min: 0.5 },
				sampledAt: 0,
				saturation: { average: 0, max: 0, min: 0 },
				waveforms,
			}).success
		).toBe(true);
		const broken = {
			...waveforms,
			parade: { ...waveforms.parade, columns: 3 },
		};
		expect(scopeWaveformsSchema.safeParse(broken).success).toBe(false);
	});

	test("rejects frames whose byte length does not match", () => {
		expect(() => computeScopeWaveforms(new Uint8Array(5), 2, 1)).toThrow(
			"does not match"
		);
		expect(() => computeScopeWaveforms(new Uint8Array(0), 0, 0)).toThrow(
			"at least one pixel"
		);
	});

	test("sample size keeps aspect and never upscales", () => {
		expect(scopeSampleSize(1920, 1080)).toEqual({ height: 144, width: 256 });
		expect(scopeSampleSize(1080, 1920)).toEqual({ height: 256, width: 144 });
		expect(scopeSampleSize(64, 32)).toEqual({ height: 32, width: 64 });
		expect(scopeSampleSize(0, 0)).toEqual({ height: 144, width: 256 });
	});

	test("intensity is logarithmic and bounded", () => {
		expect(scopePeak([1, 9, 3])).toBe(9);
		expect(scopePeak([[1], [4, 2]])).toBe(4);
		expect(scopeIntensity(0, 10)).toBe(0);
		expect(scopeIntensity(10, 10)).toBe(1);
		expect(scopeIntensity(1, 1000)).toBeGreaterThan(0.09);
		expect(scopeIntensity(5, 0)).toBe(0);
	});
});
