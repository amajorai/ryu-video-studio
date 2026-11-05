import { describe, expect, test } from "bun:test";
import {
	evaluateLocaleNumber,
	formatLocaleFieldNumber,
} from "./number-field-locale.ts";

function readValue(input: string, locale: string): number | string {
	const result = evaluateLocaleNumber(input, locale);
	return result.ok ? result.value : result.error;
}

describe("evaluateLocaleNumber", () => {
	test("reads a comma decimal in a comma-decimal locale", () => {
		expect(readValue("0,5", "de")).toBe(0.5);
		expect(readValue("1,25", "fr")).toBe(1.25);
	});

	test("still reads a dot decimal in a comma-decimal locale", () => {
		expect(readValue("1.5", "de")).toBe(1.5);
	});

	test("evaluates expressions written with the locale's decimal mark", () => {
		expect(readValue("1,5*2", "de")).toBe(3);
		expect(readValue("(4+2)*1,5", "fr")).toBe(9);
	});

	test("keeps English input and expressions unchanged", () => {
		expect(readValue("0.5", "en")).toBe(0.5);
		expect(readValue("1920/2", "en")).toBe(960);
	});

	test("reads Arabic-Indic digits and the Arabic decimal mark", () => {
		expect(readValue("٠٫٥", "ar")).toBe(0.5);
	});

	test("reads back negative values and expressions in RTL locales", () => {
		for (const locale of ["ar", "fa"]) {
			const shown = formatLocaleFieldNumber(-1921, 1, locale);
			expect(readValue(shown, locale)).toBe(-1921);
			expect(readValue(`${shown}*2`, locale)).toBe(-3842);
		}
		expect(readValue("٢*٣", "ar")).toBe(6);
		expect(readValue("١٫٥*٢", "ar")).toBe(3);
	});

	test("refuses empty and malformed input with a reason", () => {
		expect(evaluateLocaleNumber("", "de").ok).toBe(false);
		expect(evaluateLocaleNumber("1,,5", "de").ok).toBe(false);
	});
});

describe("formatLocaleFieldNumber", () => {
	test("fills the box with the locale's decimal mark and no grouping", () => {
		expect(formatLocaleFieldNumber(0.5, 0.1, "de")).toBe("0,5");
		expect(formatLocaleFieldNumber(1920, 1, "de")).toBe("1920");
		expect(formatLocaleFieldNumber(1.234_56, 0.1, "en")).toBe("1.235");
	});

	test("round-trips through evaluateLocaleNumber", () => {
		for (const locale of ["de", "fr", "en", "ar"]) {
			const shown = formatLocaleFieldNumber(12.75, 0.01, locale);
			expect(readValue(shown, locale)).toBe(12.75);
		}
	});
});
