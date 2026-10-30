import { describe, expect, test } from "bun:test";
import {
	activeCurves,
	applyHueSaturation,
	applyLevels,
	applyWheelBalance,
	compileGrade,
	curveFunction,
	curveToTable,
	type HueSaturationFilter,
	hasAdvancedGrade,
	hueAdjustmentsOf,
	hueSaturationFilters,
	hueVsSatAt,
	isIdentityCurve,
	levelsOf,
	lookupTable,
	lutIntensityOf,
	type Rgb,
	toneCurveOf,
	wheelBalanceOf,
} from "./color-advanced.ts";
import { identityCubeLut, parseCubeLut } from "./cube-lut.ts";
import { type ColorGrade, colorGradeSchema } from "./schema/color.ts";

const grade = (value: Partial<ColorGrade> = {}): ColorGrade =>
	colorGradeSchema.parse(value);

/** Largest per-channel difference between two pixels. */
const rgbDistance = (actual: Rgb, expected: Rgb) =>
	Math.max(
		...actual.map((value, index) => Math.abs(value - (expected[index] ?? 0)))
	);

describe("curves", () => {
	test("curveToTable is monotonic for increasing points", () => {
		const table = curveToTable([
			{ x: 0, y: 0 },
			{ x: 0.2, y: 0.05 },
			{ x: 0.3, y: 0.6 },
			{ x: 0.7, y: 0.62 },
			{ x: 1, y: 1 },
		]);
		expect(table).toHaveLength(256);
		for (let index = 1; index < table.length; index++) {
			expect(table[index] ?? 0).toBeGreaterThanOrEqual(
				(table[index - 1] ?? 0) - 1e-12
			);
		}
		expect(table[0]).toBe(0);
		expect(table.at(-1)).toBe(1);
	});

	test("curves pass through their points and clamp outside them", () => {
		const evaluate = curveFunction([
			{ x: 0.1, y: 0.2 },
			{ x: 0.5, y: 0.7 },
			{ x: 0.9, y: 0.8 },
		]);
		expect(evaluate(0)).toBeCloseTo(0.2, 9);
		expect(evaluate(0.5)).toBeCloseTo(0.7, 9);
		expect(evaluate(1)).toBeCloseTo(0.8, 9);
		expect(curveFunction([{ x: 0.4, y: 0.3 }])(0.9)).toBe(0.3);
		expect(curveFunction([])(1.5)).toBe(1);
	});

	test("an invert curve flips gray 0.2 to 0.8", () => {
		const invert = [
			{ x: 0, y: 1 },
			{ x: 1, y: 0 },
		];
		expect(curveFunction(invert)(0.2)).toBeCloseTo(0.8, 9);
		expect(lookupTable(curveToTable(invert), 0.2)).toBeCloseTo(0.8, 6);
	});

	test("identity curves are detected and skipped", () => {
		expect(isIdentityCurve(undefined)).toBe(true);
		expect(
			isIdentityCurve([
				{ x: 0, y: 0 },
				{ x: 0.5, y: 0.5 },
				{ x: 1, y: 1 },
			])
		).toBe(true);
		// Identity points that stop early still clamp the top end.
		expect(
			isIdentityCurve([
				{ x: 0, y: 0 },
				{ x: 0.5, y: 0.5 },
			])
		).toBe(false);
		expect(
			Object.keys(
				activeCurves(
					grade({
						curves: {
							green: [
								{ x: 0, y: 0.1 },
								{ x: 1, y: 1 },
							],
							master: [
								{ x: 0, y: 0 },
								{ x: 1, y: 1 },
							],
						},
					})
				)
			)
		).toEqual(["green"]);
	});
});

describe("levels, tone and wheels", () => {
	test("levels map whites and blacks", () => {
		expect(levelsOf(grade())).toBeNull();
		const crush = levelsOf(grade({ blacks: 1, whites: 1 }));
		expect(crush).toEqual({ inMax: 0.75, inMin: 0.25, outMax: 1, outMin: 0 });
		if (crush) {
			expect(applyLevels(crush, 0.25)).toBe(0);
			expect(applyLevels(crush, 0.5)).toBeCloseTo(0.5, 9);
			expect(applyLevels(crush, 0.9)).toBe(1);
		}
		const fade = levelsOf(grade({ blacks: -1, whites: -1 }));
		expect(fade).toEqual({ inMax: 1, inMin: 0, outMax: 0.75, outMin: 0.25 });
		if (fade) {
			expect(applyLevels(fade, 0)).toBe(0.25);
		}
	});

	test("shadows and highlights shape the quarter tones", () => {
		expect(toneCurveOf(grade())).toBeNull();
		expect(toneCurveOf(grade({ highlights: 0.4, shadows: -0.8 }))).toEqual([
			{ x: 0, y: 0 },
			{ x: 0.25, y: 0.15 },
			{ x: 0.75, y: 0.8 },
			{ x: 1, y: 1 },
		]);
	});

	test("wheels add master to each channel and clamp", () => {
		expect(wheelBalanceOf(grade())).toBeNull();
		expect(
			wheelBalanceOf(grade({ lift: { b: 1, g: 0, master: 0.5, r: -0.5 } }))
		).toEqual({
			highlights: [0, 0, 0],
			midtones: [0, 0, 0],
			shadows: [0, 0.25, 0.5],
		});
	});

	test("lift moves shadows more than highlights", () => {
		const balance = wheelBalanceOf(
			grade({ lift: { b: 1, g: 0, master: 0, r: 0 } })
		);
		expect(balance).not.toBeNull();
		if (balance) {
			const dark = applyWheelBalance(balance, [0.05, 0.05, 0.05]);
			const bright = applyWheelBalance(balance, [0.9, 0.9, 0.9]);
			expect(dark[2] - 0.05).toBeGreaterThan(0.2);
			expect(bright[2]).toBeCloseTo(0.9, 6);
		}
	});
});

describe("hue and saturation", () => {
	test("bands split between ranges and hue-vs-sat samples range centers", () => {
		const adjustments = hueAdjustmentsOf(
			grade({
				hsl: [{ band: "purple", hue: 1, lightness: 0.4, saturation: -0.6 }],
				hueVsSat: [
					{ x: 0, y: 0.5 },
					{ x: 0.5, y: 1 },
					{ x: 1, y: 0.5 },
				],
			})
		);
		expect(adjustments.b.hue).toBe(15);
		expect(adjustments.m.intensity).toBe(0.1);
		expect(adjustments.c.saturation).toBe(1);
		expect(adjustments.r.saturation).toBe(0);
		expect(hueVsSatAt([], 120)).toBe(0);
	});

	test("a filter over every range is global", () => {
		expect(hueSaturationFilters(grade({ hueVsSat: [{ x: 0, y: 1 }] }))).toEqual(
			[
				{
					colors: ["r", "y", "g", "c", "b", "m"],
					hue: 0,
					intensity: 0,
					saturation: 1,
					strength: 100,
				},
			]
		);
	});

	test("hue/saturation response matches measured FFmpeg pixels", () => {
		const filter = (
			colors: HueSaturationFilter["colors"],
			values: Partial<HueSaturationFilter>
		): HueSaturationFilter => ({
			colors,
			hue: 0,
			intensity: 0,
			saturation: 0,
			strength: 1,
			...values,
		});
		const byte = (rgb: Rgb) => rgb.map((value) => value * 255);
		// ffmpeg huesaturation=saturation=-1:colors=r on 0xff8000 → 191,128,63.
		const half = byte(
			applyHueSaturation(filter(["r"], { saturation: -1 }), [1, 128 / 255, 0])
		);
		expect(half[0]).toBeCloseTo(191, -1);
		expect(half[2]).toBeCloseTo(64, -1);
		// … and colors=r on 0xc04040 → 149,85,85.
		const muted = byte(
			applyHueSaturation(filter(["r"], { saturation: -1 }), [
				192 / 255,
				64 / 255,
				64 / 255,
			])
		);
		expect(muted[0]).toBeCloseTo(149, -1);
		// Yellow is outside the red range; grays never change.
		expect(
			applyHueSaturation(filter(["r"], { saturation: -1 }), [1, 1, 0])
		).toEqual([1, 1, 0]);
		expect(
			applyHueSaturation(filter(["r"], { intensity: 1 }), [0.5, 0.5, 0.5])
		).toEqual([0.5, 0.5, 0.5]);
		// saturation=1:colors=r on 0xd2691e → 249,101,0.
		const boosted = byte(
			applyHueSaturation(filter(["r"], { saturation: 1 }), [
				210 / 255,
				105 / 255,
				30 / 255,
			])
		);
		expect(Math.abs((boosted[0] ?? 0) - 249)).toBeLessThan(6);
		expect(Math.abs((boosted[1] ?? 0) - 101)).toBeLessThan(6);
		expect(boosted[2]).toBe(0);
	});

	test("a shared adjustment splits into a global part and residuals", () => {
		expect(
			hueSaturationFilters(
				grade({
					hueVsSat: [
						{ x: 0, y: 0.25 },
						{ x: 1, y: 0.26 },
					],
				})
			)
		).toEqual([
			{
				colors: ["r", "y", "g", "c", "b", "m"],
				hue: 0,
				intensity: 0,
				saturation: -0.483_333,
				strength: 100,
			},
			// The magenta range sits nearest zero, so it has no residual.
			{
				colors: ["r"],
				hue: 0,
				intensity: 0,
				saturation: -0.016_667,
				strength: 1,
			},
			{
				colors: ["y"],
				hue: 0,
				intensity: 0,
				saturation: -0.013_334,
				strength: 1,
			},
			{ colors: ["g"], hue: 0, intensity: 0, saturation: -0.01, strength: 1 },
			{
				colors: ["c"],
				hue: 0,
				intensity: 0,
				saturation: -0.006_667,
				strength: 1,
			},
			{
				colors: ["b"],
				hue: 0,
				intensity: 0,
				saturation: -0.003_334,
				strength: 1,
			},
		]);
	});

	test("close grades give close pixels", () => {
		const flat = compileGrade(
			grade({
				hueVsSat: [
					{ x: 0, y: 0.25 },
					{ x: 1, y: 0.25 },
				],
			})
		);
		const tilted = compileGrade(
			grade({
				hueVsSat: [
					{ x: 0, y: 0.25 },
					{ x: 1, y: 0.26 },
				],
			})
		);
		const bands = (saturation: number) =>
			compileGrade(
				grade({
					hsl: (
						[
							"red",
							"orange",
							"yellow",
							"green",
							"aqua",
							"blue",
							"purple",
							"magenta",
						] as const
					).map((band, index) => ({
						band,
						hue: 0,
						lightness: 0,
						saturation: index === 0 ? saturation : -0.4,
					})),
				})
			);
		for (const pixel of [
			[0.6, 0.4, 0.4],
			[0.3, 0.7, 0.2],
			[0.2, 0.4, 0.9],
			[0.55, 0.5, 0.45],
		] as Rgb[]) {
			expect(rgbDistance(flat(pixel), tilted(pixel))).toBeLessThan(0.02);
			expect(rgbDistance(bands(-0.4)(pixel), bands(-0.39)(pixel))).toBeLessThan(
				0.02
			);
		}
	});

	test("identical adjustments share one filter", () => {
		expect(hueSaturationFilters(grade())).toEqual([]);
		expect(
			hueSaturationFilters(
				grade({
					hsl: [
						{ band: "red", hue: 0, lightness: 0, saturation: -1 },
						{ band: "green", hue: 0, lightness: 0, saturation: -1 },
					],
				})
			)
		).toEqual([
			{ colors: ["r", "g"], hue: 0, intensity: 0, saturation: -1, strength: 1 },
		]);
	});
});

describe("compiled grade", () => {
	test("a neutral grade is the identity", () => {
		expect(hasAdvancedGrade(grade())).toBe(false);
		const run = compileGrade(grade());
		expect(rgbDistance(run([0.2, 0.4, 0.6]), [0.2, 0.4, 0.6])).toBeLessThan(
			1e-9
		);
	});

	test("full desaturation produces gray", () => {
		const mono = grade({
			hsl: (
				[
					"red",
					"orange",
					"yellow",
					"green",
					"aqua",
					"blue",
					"purple",
					"magenta",
				] as const
			).map((band) => ({ band, hue: 0, lightness: 0, saturation: -1 })),
		});
		expect(hasAdvancedGrade(mono)).toBe(true);
		const [r, g, b] = compileGrade(mono)([0.8, 0.3, 0.1]);
		expect(r).toBeCloseTo(g, 6);
		expect(g).toBeCloseTo(b, 6);
	});

	test("an invert curve applies per channel then master", () => {
		const run = compileGrade(
			grade({
				curves: {
					master: [
						{ x: 0, y: 1 },
						{ x: 1, y: 0 },
					],
					red: [
						{ x: 0, y: 0.5 },
						{ x: 1, y: 1 },
					],
				},
			})
		);
		// red: 0.2 → 0.6 → 0.4; green 0.2 → 0.8.
		expect(rgbDistance(run([0.2, 0.2, 0.2]), [0.4, 0.8, 0.8])).toBeLessThan(
			0.01
		);
	});

	test("LUT intensity mixes the graded and original pixel", () => {
		const invert = parseCubeLut(
			"LUT_3D_SIZE 2\n1 1 1\n0 1 1\n1 0 1\n0 0 1\n1 1 0\n0 1 0\n1 0 0\n0 0 0\n"
		);
		const lutId = "00000000-0000-4000-8000-0000000000aa";
		const half = grade({ lut: { intensity: 0.5, lutId } });
		expect(lutIntensityOf(half)).toBe(0.5);
		expect(hasAdvancedGrade(half)).toBe(true);
		expect(
			rgbDistance(compileGrade(half, invert)([0.2, 0.2, 0.2]), [0.5, 0.5, 0.5])
		).toBeLessThan(1e-4);
		const full = grade({ lut: { intensity: 1, lutId } });
		expect(
			rgbDistance(compileGrade(full, invert)([0.2, 0.4, 0.6]), [0.8, 0.6, 0.4])
		).toBeLessThan(1e-4);
		// Without the parsed table the LUT step is skipped.
		expect(
			rgbDistance(compileGrade(full)([0.2, 0.4, 0.6]), [0.2, 0.4, 0.6])
		).toBeLessThan(1e-4);
		expect(
			rgbDistance(
				compileGrade(full, identityCubeLut(4))([0.3, 0.6, 0.9]),
				[0.3, 0.6, 0.9]
			)
		).toBeLessThan(1e-4);
	});

	test("compilation is deterministic", () => {
		const value = grade({
			blacks: 0.2,
			gamma: { b: -0.2, g: 0.1, master: 0, r: 0.3 },
			highlights: -0.3,
			hueVsSat: [{ x: 0.3, y: 0.7 }],
		});
		const first = compileGrade(value)([0.31, 0.52, 0.73]);
		const second = compileGrade(value)([0.31, 0.52, 0.73]);
		expect(first).toEqual(second);
	});
});
