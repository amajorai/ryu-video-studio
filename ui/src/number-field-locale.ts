/**
 * Locale-aware reading and display for `NumberField`. A German or French
 * editor types "0,5" or "1,5*2"; the arithmetic parser only knows ".", so a
 * plain number goes through `parseLocaleNumber` first and an expression has
 * the locale's decimal mark mapped to "." before it is evaluated. The box is
 * filled the way the user would type it ("0,5" in German), without grouping.
 */
import { activeLocale } from "@ryu/i18n/core";
import {
	formatLocaleNumberInput,
	localeSeparators,
	parseLocaleNumber,
} from "@ryu/i18n/parse-number";
import {
	evaluateMathExpression,
	type MathExpressionResult,
	stepPrecision,
} from "./math-expression.ts";

// Zero code points of the native digit runs `parseLocaleNumber` also reads.
const DIGIT_ZEROS = [
	0x6_60, 0x6_f0, 0x9_66, 0x9_e6, 0xa_66, 0xa_e6, 0xb_66, 0xb_e6, 0xc_66,
	0xc_e6, 0xd_66, 0xe_50, 0xe_d0, 0xf_20, 0x10_40, 0x17_e0, 0x18_10, 0xff_10,
];
// Bidi marks Intl puts around signs in RTL locales ("\u200e-1920" in Arabic).
const BIDI_MARKS = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu;

/** Drop bidi marks and fold native digits and "−" to ASCII for the parser. */
function normalizeInput(input: string): string {
	const folded = Array.from(input.replace(BIDI_MARKS, ""), (char) => {
		if (char === "−") {
			return "-";
		}
		const code = char.codePointAt(0) ?? 0;
		const zero = DIGIT_ZEROS.find(
			(start) => code >= start && code <= start + 9
		);
		return zero === undefined ? char : String(code - zero);
	});
	return folded.join("");
}

/**
 * The decimal marks that differ from "." for expression input: the locale's
 * own, the Arabic "٫" (never anything but a decimal), and the full-width ","
 * in a comma-decimal locale.
 */
function decimalMarks(locale: string): string[] {
	const { decimal } = localeSeparators(locale);
	const marks = new Set<string>(["٫"]);
	if (decimal !== ".") {
		marks.add(decimal);
		if (decimal === ",") {
			marks.add("，");
		}
	}
	return [...marks];
}

/**
 * Read `input` as a number or an arithmetic expression written in `locale`
 * ("1,5" and "1,5*2" in German, "1.5" and "1.5*2" in English).
 */
export function evaluateLocaleNumber(
	input: string,
	locale: string = activeLocale()
): MathExpressionResult {
	const normalized = normalizeInput(input);
	const plain = parseLocaleNumber(normalized, locale);
	if (normalized.trim() !== "" && Number.isFinite(plain)) {
		return { ok: true, value: Object.is(plain, -0) ? 0 : plain };
	}
	let source = normalized;
	for (const mark of decimalMarks(locale)) {
		source = source.split(mark).join(".");
	}
	return evaluateMathExpression(source);
}

/**
 * `value` as the field shows it: at least three decimals of precision (more
 * when `step` needs them), trailing zeros dropped, in the locale's digits and
 * decimal mark, without grouping.
 */
export function formatLocaleFieldNumber(
	value: number,
	step: number,
	locale: string = activeLocale()
): string {
	return formatLocaleNumberInput(
		value,
		locale,
		Math.min(20, Math.max(3, stepPrecision(step)))
	);
}
