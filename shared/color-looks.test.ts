import { expect, test } from "bun:test";
import { hasAdvancedGrade } from "./color-advanced.ts";
import {
	colorLook,
	colorLooks,
	gradeWithLook,
	lookGrade,
	lookIds,
} from "./color-looks.ts";
import { colorGradeSchema } from "./schema/color.ts";

test("there are twelve looks with unique ids, in id order", () => {
	expect(colorLooks).toHaveLength(12);
	expect(colorLooks.map((look) => look.id)).toEqual([...lookIds]);
	expect(new Set(colorLooks.map((look) => look.name)).size).toBe(12);
});

test("every look is schema-valid at every intensity and changes pixels", () => {
	for (const look of colorLooks) {
		for (const intensity of [0, 0.35, 1]) {
			const parsed = colorGradeSchema.safeParse(lookGrade(look.id, intensity));
			expect(parsed.success).toBe(true);
		}
		const full = colorGradeSchema.parse(lookGrade(look.id));
		const basic =
			full.exposure || full.temperature || full.tint || full.vibrance;
		expect(Boolean(basic) || hasAdvancedGrade(full)).toBe(true);
	}
});

test("zero intensity is neutral", () => {
	for (const look of colorLooks) {
		const neutral = colorGradeSchema.parse(lookGrade(look.id, 0));
		expect(hasAdvancedGrade(neutral)).toBe(false);
		expect(neutral.exposure).toBe(0);
		expect(neutral.vibrance).toBe(0);
	}
});

test("intensity scales values and curves toward neutral", () => {
	const half = lookGrade("faded", 0.5);
	expect(half.vibrance).toBe(-0.1);
	expect(half.curves?.master?.[0]).toEqual({ x: 0, y: 0.06 });
	const vivid = lookGrade("vivid", 0.5);
	expect(vivid.hueVsSat).toEqual([{ x: 0, y: 0.55 }]);
	expect(lookGrade("teal-orange", 2)).toEqual(lookGrade("teal-orange", 1));
});

test("applying a look keeps the LUT and records the id", () => {
	const lut = { intensity: 0.4, lutId: "00000000-0000-4000-8000-0000000000aa" };
	const current = colorGradeSchema.parse({
		exposure: 2,
		lut,
		look: "old",
		whites: 0.5,
	});
	const next = gradeWithLook(current, "noir");
	expect(next.lut).toEqual(lut);
	expect(next.look).toBe("noir");
	expect(next.whites).toBeUndefined();
	expect(next.exposure).toBe(colorLook("noir").grade.exposure);
	expect(
		gradeWithLook(colorGradeSchema.parse({}), "clean").lut
	).toBeUndefined();
});

test("unknown looks throw", () => {
	expect(() => colorLook("nope" as never)).toThrow("Color look not found.");
});
