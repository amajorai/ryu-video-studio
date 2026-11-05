import { describe, expect, test } from "bun:test";
import {
	add,
	atan2,
	clip,
	div,
	easeOut,
	evaluate,
	formatNumber,
	hypot,
	ifElse,
	isConstant,
	lt,
	mul,
	smooth,
	sub,
	toFfmpeg,
	unit,
} from "./transition-expr.ts";

describe("transition expressions", () => {
	test("constant subtrees fold and identities drop", () => {
		expect(add(1, 2)).toBe(3);
		expect(mul(2, 3)).toBe(6);
		expect(mul("t", 1)).toBe("t");
		expect(mul("t", 0)).toBe(0);
		expect(add("t", 0)).toBe("t");
		expect(sub("t", 0)).toBe("t");
		expect(isConstant(mul(1, 1), 1)).toBe(true);
	});

	test("numbers print with at most six places and parenthesized negatives", () => {
		expect(formatNumber(0.1 + 0.2)).toBe("0.3");
		expect(formatNumber(-2)).toBe("(-2)");
		expect(formatNumber(-0)).toBe("0");
		expect(formatNumber(Math.PI)).toBe("3.141593");
	});

	test("FFmpeg printing uses the context's variable names", () => {
		const expr = unit(sub(mul("t", 2), div("x", 2)));
		expect(toFfmpeg(expr, { t: "T", x: "X" })).toBe("clip(((T*2)-(X/2)),0,1)");
		expect(() => toFfmpeg("y", { t: "T" })).toThrow();
	});

	test("JavaScript evaluation matches the operators FFmpeg uses", () => {
		const env = { h: 4, t: 0.25, w: 8, x: 6, y: 1 };
		expect(evaluate(smooth("t"), env)).toBeCloseTo(0.156_25);
		expect(evaluate(easeOut("t"), env)).toBeCloseTo(1 - 0.75 ** 3);
		expect(evaluate(hypot(sub("x", 3), sub("y", 5)), env)).toBe(5);
		expect(evaluate(atan2(1, 0), env)).toBeCloseTo(Math.PI / 2);
		expect(evaluate(lt("t", 0.5), env)).toBe(1);
		expect(evaluate(ifElse(lt("t", 0.1), 7, 9), env)).toBe(9);
		expect(evaluate(clip("x", 0, 5), env)).toBe(5);
		expect(evaluate("w", {})).toBe(0);
	});
});
