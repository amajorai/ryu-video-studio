/**
 * Safe arithmetic for numeric fields: a recursive-descent parser for
 * `+ - * /`, parentheses, unary signs and decimals. It never calls `eval`
 * or `Function`; anything outside the grammar is rejected with a reason.
 *
 *   expression := term (("+" | "-") term)*
 *   term       := unary (("*" | "/") unary)*
 *   unary      := ("+" | "-") unary | primary
 *   primary    := number | "(" expression ")"
 *   number     := digits ["." digits?] | "." digits
 */

export const MAX_EXPRESSION_LENGTH = 256;
export const MAX_EXPRESSION_DEPTH = 32;

export type MathExpressionResult =
	| { ok: true; value: number }
	| { error: string; ok: false };

class ExpressionError extends Error {}

const DIGIT = /[0-9]/;
const WHITESPACE = /\s/;

class Parser {
	private index = 0;
	private depth = 0;
	private readonly source: string;

	constructor(source: string) {
		this.source = source;
	}

	parse(): number {
		const value = this.expression();
		this.skipWhitespace();
		if (this.index < this.source.length) {
			throw new ExpressionError(
				`Unexpected "${this.source[this.index]}" at position ${this.index + 1}`
			);
		}
		return value;
	}

	private expression(): number {
		let value = this.term();
		for (;;) {
			const operator = this.peek();
			if (operator !== "+" && operator !== "-") {
				return value;
			}
			this.index += 1;
			const right = this.term();
			value = operator === "+" ? value + right : value - right;
		}
	}

	private term(): number {
		let value = this.unary();
		for (;;) {
			const operator = this.peek();
			if (operator !== "*" && operator !== "/") {
				return value;
			}
			this.index += 1;
			const right = this.unary();
			if (operator === "/") {
				if (right === 0) {
					throw new ExpressionError("Division by zero");
				}
				value /= right;
			} else {
				value *= right;
			}
		}
	}

	private unary(): number {
		const operator = this.peek();
		if (operator === "-" || operator === "+") {
			this.index += 1;
			const value = this.nested(() => this.unary());
			return operator === "-" ? -value : value;
		}
		return this.primary();
	}

	private primary(): number {
		const next = this.peek();
		if (next === "(") {
			this.index += 1;
			const value = this.nested(() => this.expression());
			if (this.peek() !== ")") {
				throw new ExpressionError("Missing closing parenthesis");
			}
			this.index += 1;
			return value;
		}
		if (next === undefined) {
			throw new ExpressionError("Unexpected end of expression");
		}
		return this.number();
	}

	private number(): number {
		const start = this.index;
		let digits = 0;
		while (this.isDigit(this.source[this.index])) {
			this.index += 1;
			digits += 1;
		}
		if (this.source[this.index] === ".") {
			this.index += 1;
			while (this.isDigit(this.source[this.index])) {
				this.index += 1;
				digits += 1;
			}
		}
		if (digits === 0) {
			this.index = start;
			const found = this.source[start];
			throw new ExpressionError(
				found === undefined
					? "Unexpected end of expression"
					: `Unexpected "${found}" at position ${start + 1}`
			);
		}
		return Number(this.source.slice(start, this.index));
	}

	private nested(read: () => number): number {
		this.depth += 1;
		if (this.depth > MAX_EXPRESSION_DEPTH) {
			throw new ExpressionError("Expression is nested too deeply");
		}
		const value = read();
		this.depth -= 1;
		return value;
	}

	private peek(): string | undefined {
		this.skipWhitespace();
		return this.source[this.index];
	}

	private skipWhitespace() {
		while (
			this.index < this.source.length &&
			WHITESPACE.test(this.source[this.index] ?? "")
		) {
			this.index += 1;
		}
	}

	private isDigit(character: string | undefined): boolean {
		return character !== undefined && DIGIT.test(character);
	}
}

/** Evaluates an arithmetic expression such as `1920 / 2 - (10 * 1.5)`. */
export function evaluateMathExpression(input: string): MathExpressionResult {
	const source = input.trim();
	if (source.length === 0) {
		return { error: "Enter a number", ok: false };
	}
	if (source.length > MAX_EXPRESSION_LENGTH) {
		return { error: "Expression is too long", ok: false };
	}
	try {
		const value = new Parser(source).parse();
		if (!Number.isFinite(value)) {
			return { error: "Result is not a finite number", ok: false };
		}
		return { ok: true, value: Object.is(value, -0) ? 0 : value };
	} catch (error) {
		if (error instanceof ExpressionError) {
			return { error: error.message, ok: false };
		}
		throw error;
	}
}

/** Decimal places needed to represent `step` exactly (0.05 → 2, 1 → 0). */
export function stepPrecision(step: number): number {
	if (!Number.isFinite(step) || step <= 0) {
		return 0;
	}
	const text = String(step);
	const exponent = text.match(/e-(\d+)$/);
	if (exponent) {
		return Number(exponent[1]);
	}
	const dot = text.indexOf(".");
	return dot === -1 ? 0 : text.length - dot - 1;
}

export function clampNumber(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

/** Rounds to the nearest multiple of `step` from `min`, then clamps. */
export function quantizeToStep(
	value: number,
	{ max, min, step }: { max: number; min: number; step: number }
): number {
	const clamped = clampNumber(value, min, max);
	if (!(step > 0 && Number.isFinite(step))) {
		return clamped;
	}
	const base = Number.isFinite(min) ? min : 0;
	const snapped = base + Math.round((clamped - base) / step) * step;
	const precision = Math.max(stepPrecision(step), stepPrecision(base));
	return clampNumber(Number(snapped.toFixed(precision)), min, max);
}

export interface ScrubModifiers {
	/** Alt / Option: coarse, 10x per pixel. */
	alt: boolean;
	/** Shift: fine, 0.1x per pixel. */
	shift: boolean;
}

/** Value change per pixel of horizontal drag for the held modifiers. */
export function scrubFactor({ alt, shift }: ScrubModifiers): number {
	if (shift && !alt) {
		return 0.1;
	}
	if (alt && !shift) {
		return 10;
	}
	return 1;
}

/**
 * The value grid for the held modifiers: `step` scaled by `scrubFactor`, so a
 * Shift drag or nudge lands between the plain steps instead of rounding back.
 */
export function scrubIncrement(
	step: number,
	modifiers: ScrubModifiers
): number {
	return Number((step * scrubFactor(modifiers)).toPrecision(12));
}

/**
 * The grid a scrubbed or nudged value snaps to: the fine increment while Shift
 * is held, otherwise the plain `step` (Alt moves faster but keeps the grid).
 */
export function scrubGrid(step: number, modifiers: ScrubModifiers): number {
	return Math.min(step, scrubIncrement(step, modifiers));
}

/**
 * Advances an unquantized scrub accumulator by `deltaPx` pixels. Callers keep
 * the raw accumulator between moves so modifier changes mid-drag do not jump,
 * and display `quantizeToStep(raw, …)`.
 */
export function scrubAccumulate(
	raw: number,
	deltaPx: number,
	step: number,
	modifiers: ScrubModifiers
): number {
	if (!Number.isFinite(deltaPx)) {
		return raw;
	}
	return raw + deltaPx * scrubIncrement(step, modifiers);
}

/** Formats a value for the field, trimming float noise to the step precision. */
export function formatFieldNumber(value: number, step: number): string {
	const precision = Math.max(3, stepPrecision(step));
	return String(Number(value.toFixed(precision)));
}
