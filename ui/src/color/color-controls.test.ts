import { describe, expect, test } from "bun:test";
import {
	colorGradeSchema,
	toneCurveSchema,
} from "../../../shared/schema/color.ts";
import {
	identityCurve,
	insertCurvePoint,
	isNeutralWheel,
	MAX_CURVE_POINTS,
	moveCurvePoint,
	offsetFromWheel,
	removeCurvePoint,
	resetAdvancedGrade,
	setHslBand,
	wheelFromOffset,
	withGradeField,
} from "./color-controls.ts";

describe("curve editing", () => {
	test("moved points stay between neighbours and inside the box", () => {
		const points = [
			{ x: 0, y: 0 },
			{ x: 0.5, y: 0.5 },
			{ x: 1, y: 1 },
		];
		expect(moveCurvePoint(points, 1, { x: 2, y: -1 })[1]).toEqual({
			x: 0.99,
			y: 0,
		});
		expect(moveCurvePoint(points, 0, { x: 0.8, y: 0.3 })[0]).toEqual({
			x: 0.49,
			y: 0.3,
		});
		expect(
			toneCurveSchema.safeParse(moveCurvePoint(points, 2, { x: 0, y: 1 }))
				.success
		).toBe(true);
	});

	test("inserting keeps x order and refuses duplicates or a full curve", () => {
		const inserted = insertCurvePoint(identityCurve(), { x: 0.3, y: 0.6 });
		expect(inserted).toEqual({
			index: 1,
			points: [
				{ x: 0, y: 0 },
				{ x: 0.3, y: 0.6 },
				{ x: 1, y: 1 },
			],
		});
		expect(insertCurvePoint(identityCurve(), { x: 0.005, y: 0.4 })).toBeNull();
		const full = Array.from({ length: MAX_CURVE_POINTS }, (_, index) => ({
			x: index / (MAX_CURVE_POINTS - 1),
			y: 0.5,
		}));
		expect(insertCurvePoint(full, { x: 0.51, y: 0.2 })).toBeNull();
		expect(insertCurvePoint([], { x: 0.4, y: 0.7 })?.points).toEqual([
			{ x: 0.4, y: 0.7 },
		]);
	});

	test("removal keeps the minimum number of points", () => {
		expect(removeCurvePoint(identityCurve(), 0)).toEqual(identityCurve());
		expect(removeCurvePoint([{ x: 0.2, y: 0.4 }], 0, 0)).toEqual([]);
		expect(
			removeCurvePoint(
				[
					{ x: 0, y: 0 },
					{ x: 0.5, y: 0.2 },
					{ x: 1, y: 1 },
				],
				1
			)
		).toEqual(identityCurve());
	});
});

describe("wheels", () => {
	test("offsets toward a channel raise it and round-trip", () => {
		const red = wheelFromOffset(0.5, 0, 0.1);
		expect(red.r).toBe(0.5);
		expect(red.g).toBe(-0.25);
		expect(red.b).toBe(-0.25);
		expect(red.master).toBe(0.1);
		expect(offsetFromWheel(red)).toEqual({ x: 0.5, y: 0 });
		const anywhere = wheelFromOffset(-0.2, 0.35, 0);
		const back = offsetFromWheel(anywhere);
		expect(back.x).toBeCloseTo(-0.2, 3);
		expect(back.y).toBeCloseTo(0.35, 3);
	});

	test("offsets outside the disc are clamped to its edge", () => {
		const wheel = wheelFromOffset(3, 4, 0);
		const back = offsetFromWheel(wheel);
		expect(Math.hypot(back.x, back.y)).toBeCloseTo(1, 3);
		expect(offsetFromWheel(undefined)).toEqual({ x: 0, y: 0 });
		expect(isNeutralWheel(wheelFromOffset(0, 0, 0))).toBe(true);
		expect(isNeutralWheel(wheelFromOffset(0, 0, 0.2))).toBe(false);
	});
});

describe("grade fields", () => {
	test("HSL bands are set, merged and cleared when neutral", () => {
		const one = setHslBand(undefined, "red", { saturation: 0.4 });
		expect(one).toEqual([
			{ band: "red", hue: 0, lightness: 0, saturation: 0.4 },
		]);
		const two = setHslBand(one, "blue", { hue: 2 });
		expect(two?.[1]).toEqual({
			band: "blue",
			hue: 1,
			lightness: 0,
			saturation: 0,
		});
		expect(setHslBand(two, "red", { saturation: 0 })).toEqual([
			{ band: "blue", hue: 1, lightness: 0, saturation: 0 },
		]);
		expect(setHslBand(one, "red", { saturation: 0 })).toBeUndefined();
	});

	test("hand edits clear the look, LUT edits keep it", () => {
		const grade = colorGradeSchema.parse({ look: "noir", whites: 0.2 });
		const edited = withGradeField(grade, "blacks", 0.1);
		expect(edited.look).toBeUndefined();
		expect(edited.blacks).toBe(0.1);
		expect(withGradeField(edited, "blacks", undefined)).not.toHaveProperty(
			"blacks"
		);
		const lut = { intensity: 1, lutId: "00000000-0000-4000-8000-0000000000aa" };
		expect(withGradeField(grade, "lut", lut).look).toBe("noir");
	});

	test("reset keeps the basic grade and the LUT", () => {
		const lut = { intensity: 1, lutId: "00000000-0000-4000-8000-0000000000aa" };
		const grade = colorGradeSchema.parse({
			curves: { master: identityCurve() },
			exposure: 1,
			look: "noir",
			lut,
			shadows: 0.3,
		});
		expect(resetAdvancedGrade(grade)).toEqual({
			exposure: 1,
			lut,
			temperature: 0,
			tint: 0,
			vibrance: 0,
		});
	});
});
