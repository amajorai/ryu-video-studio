import { describe, expect, test } from "bun:test";
import { matteName, matteRequestSchema, matteRgb } from "./matte.ts";

describe("color mattes", () => {
	test("request schema is strict and bounded", () => {
		const valid = { color: "#12abEF", height: 1080, width: 1920 };
		expect(matteRequestSchema.parse(valid)).toEqual(valid);
		expect(matteRequestSchema.safeParse({ ...valid, extra: 1 }).success).toBe(
			false
		);
		expect(
			matteRequestSchema.safeParse({ ...valid, color: "red" }).success
		).toBe(false);
		expect(matteRequestSchema.safeParse({ ...valid, width: 1 }).success).toBe(
			false
		);
		expect(
			matteRequestSchema.safeParse({ ...valid, width: 8193 }).success
		).toBe(false);
		expect(
			matteRequestSchema.safeParse({ ...valid, width: 10.5 }).success
		).toBe(false);
		// Mattes are stills placed at the standard still length, so a
		// requested duration is refused instead of silently ignored.
		expect(
			matteRequestSchema.safeParse({ ...valid, duration: 30 }).success
		).toBe(false);
	});

	test("colors parse to channels and names default to the hex", () => {
		expect(matteRgb("#12abEF")).toEqual([0x12, 0xab, 0xef]);
		expect(() => matteRgb("#12ab")).toThrow();
		expect(matteName({ color: "#12abef" })).toBe("Color matte #12ABEF");
		expect(matteName({ color: "#12abef", name: "Backdrop" })).toBe("Backdrop");
	});
});
