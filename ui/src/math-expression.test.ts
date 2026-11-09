import { describe, expect, test } from "bun:test";
import {
	evaluateMathExpression,
	formatFieldNumber,
	MAX_EXPRESSION_DEPTH,
	MAX_EXPRESSION_LENGTH,
	quantizeToStep,
	scrubAccumulate,
	scrubFactor,
	scrubGrid,
	scrubIncrement,
	stepPrecision,
} from "./math-expression.ts";

function evaluated(input: string): number {
	const result = evaluateMathExpression(input);
	if (!result.ok) {
		throw new Error(`expected ${input} to parse: ${result.error}`);
	}
	return result.value;
}

function errorOf(input: string): string {
	const result = evaluateMathExpression(input);
	if (result.ok) {
		throw new Error(`expected ${input} to fail, got ${result.value}`);
	}
	return result.error;
}

describe("evaluateMathExpression", () => {
	test("parses plain numbers and decimals", () => {
		expect(evaluated("42")).toBe(42);
		expect(evaluated("  3.25 ")).toBe(3.25);
		expect(evaluated(".5")).toBe(0.5);
		expect(evaluated("5.")).toBe(5);
		expect(evaluated("007")).toBe(7);
	});

	test("respects precedence and associativity", () => {
		expect(evaluated("1 + 2 * 3")).toBe(7);
		expect(evaluated("(1 + 2) * 3")).toBe(9);
		expect(evaluated("10 - 4 - 3")).toBe(3);
		expect(evaluated("100 / 10 / 5")).toBe(2);
		expect(evaluated("2 * 3 / 4")).toBe(1.5);
		expect(evaluated("1920 / 2 - (10 * 1.5)")).toBe(945);
		expect(evaluated("((2))*((3+1))")).toBe(8);
	});

	test("handles unary signs", () => {
		expect(evaluated("-5")).toBe(-5);
		expect(evaluated("--5")).toBe(5);
		expect(evaluated("+5")).toBe(5);
		expect(evaluated("3 - -2")).toBe(5);
		expect(evaluated("-(2 + 3) * 2")).toBe(-10);
		expect(evaluated("2 * -3")).toBe(-6);
	});

	test("normalizes negative zero", () => {
		expect(Object.is(evaluated("-0"), 0)).toBe(true);
	});

	test("rejects invalid input with a reason", () => {
		expect(errorOf("")).toBe("Enter a number");
		expect(errorOf("   ")).toBe("Enter a number");
		expect(errorOf("1 +")).toBe("Unexpected end of expression");
		expect(errorOf("(1 + 2")).toBe("Missing closing parenthesis");
		expect(errorOf("1 + 2)")).toContain('Unexpected ")"');
		expect(errorOf("2 3")).toContain('Unexpected "3"');
		expect(errorOf("1 / 0")).toBe("Division by zero");
		expect(errorOf("1 / (2 - 2)")).toBe("Division by zero");
		expect(errorOf(".")).toContain('Unexpected "."');
		expect(errorOf("1..2")).toContain('Unexpected "."');
		expect(errorOf("abc")).toContain('Unexpected "a"');
		expect(errorOf("1e3")).toContain('Unexpected "e"');
		expect(errorOf("2 ** 3")).toContain('Unexpected "*"');
		expect(errorOf("Math.max(1)")).toContain('Unexpected "M"');
		expect(errorOf("alert(1)")).toContain('Unexpected "a"');
	});

	test("rejects oversize input and deep nesting", () => {
		expect(errorOf(`9${"9".repeat(400)}`)).toBe("Expression is too long");
		expect(evaluated(`${"9".repeat(200)} * ${"9".repeat(50)}`)).toBeCloseTo(
			1e250,
			-240
		);
		const deep = `${"(".repeat(MAX_EXPRESSION_DEPTH + 1)}1${")".repeat(
			MAX_EXPRESSION_DEPTH + 1
		)}`;
		expect(deep.length).toBeLessThanOrEqual(MAX_EXPRESSION_LENGTH);
		expect(errorOf(deep)).toBe("Expression is nested too deeply");
		expect(errorOf("-".repeat(MAX_EXPRESSION_DEPTH + 1).concat("1"))).toBe(
			"Expression is nested too deeply"
		);
		const ok = `${"(".repeat(MAX_EXPRESSION_DEPTH)}1${")".repeat(
			MAX_EXPRESSION_DEPTH
		)}`;
		expect(evaluated(ok)).toBe(1);
	});
});

describe("step helpers", () => {
	test("stepPrecision", () => {
		expect(stepPrecision(1)).toBe(0);
		expect(stepPrecision(0.1)).toBe(1);
		expect(stepPrecision(0.05)).toBe(2);
		expect(stepPrecision(1e-7)).toBe(7);
		expect(stepPrecision(0)).toBe(0);
		expect(stepPrecision(Number.NaN)).toBe(0);
	});

	test("quantizeToStep snaps from min and clamps", () => {
		expect(quantizeToStep(0.123, { max: 1, min: 0, step: 0.05 })).toBe(0.1);
		expect(quantizeToStep(0.300_000_000_4, { max: 1, min: 0, step: 0.1 })).toBe(
			0.3
		);
		expect(quantizeToStep(5, { max: 1, min: 0, step: 0.1 })).toBe(1);
		expect(quantizeToStep(-5, { max: 1, min: -1, step: 0.1 })).toBe(-1);
		expect(quantizeToStep(2.4, { max: 10, min: 0.5, step: 1 })).toBe(2.5);
		expect(quantizeToStep(0.37, { max: 1, min: 0, step: 0 })).toBe(0.37);
	});

	test("formatFieldNumber trims float noise", () => {
		expect(formatFieldNumber(0.1 + 0.2, 0.1)).toBe("0.3");
		expect(formatFieldNumber(1.234_56, 1)).toBe("1.235");
		expect(formatFieldNumber(1e-5, 1e-5)).toBe("0.00001");
	});
});

describe("scrub deltas", () => {
	test("modifier factors", () => {
		expect(scrubFactor({ alt: false, shift: false })).toBe(1);
		expect(scrubFactor({ alt: false, shift: true })).toBe(0.1);
		expect(scrubFactor({ alt: true, shift: false })).toBe(10);
		expect(scrubFactor({ alt: true, shift: true })).toBe(1);
	});

	test("increment follows the modifiers without float noise", () => {
		expect(scrubIncrement(0.1, { alt: false, shift: true })).toBe(0.01);
		expect(scrubIncrement(0.05, { alt: true, shift: false })).toBe(0.5);
		expect(scrubIncrement(1, { alt: false, shift: false })).toBe(1);
	});

	test("grid keeps the plain step for coarse moves", () => {
		expect(scrubGrid(0.5, { alt: true, shift: false })).toBe(0.5);
		expect(scrubGrid(0.5, { alt: false, shift: true })).toBe(0.05);
		expect(scrubGrid(0.5, { alt: false, shift: false })).toBe(0.5);
	});

	test("accumulates step per pixel with modifiers", () => {
		const none = { alt: false, shift: false };
		expect(scrubAccumulate(1, 10, 0.1, none)).toBeCloseTo(2);
		expect(scrubAccumulate(1, -10, 0.1, none)).toBeCloseTo(0);
		expect(
			scrubAccumulate(1, 10, 0.1, { alt: false, shift: true })
		).toBeCloseTo(1.1);
		expect(
			scrubAccumulate(1, 10, 0.1, { alt: true, shift: false })
		).toBeCloseTo(11);
		expect(scrubAccumulate(1, Number.NaN, 0.1, none)).toBe(1);
	});

	test("fine scrub accumulates sub-step motion before quantizing", () => {
		const fine = { alt: false, shift: true };
		let raw = 0;
		for (let index = 0; index < 5; index += 1) {
			raw = scrubAccumulate(raw, 1, 1, fine);
		}
		expect(quantizeToStep(raw, { max: 10, min: 0, step: 1 })).toBe(1);
		expect(raw).toBeCloseTo(0.5);
	});
});
