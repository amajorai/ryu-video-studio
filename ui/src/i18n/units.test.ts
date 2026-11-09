import { describe, expect, test } from "bun:test";
import {
	formatSeconds,
	formatSecondsRange,
	formatUsd,
	formatUsdPrecise,
} from "./units.ts";

describe("formatSeconds", () => {
	test("keeps the English look in English", () => {
		expect(formatSeconds(3.25, { locale: "en" })).toBe("3.3s");
		expect(formatSeconds(0.5, { fractionDigits: 2, locale: "en" })).toBe(
			"0.50s"
		);
		expect(
			formatSeconds(2.5, { fractionDigits: 3, locale: "en", trimZeros: true })
		).toBe("2.5s");
	});

	test("uses the reader's decimal mark and unit", () => {
		expect(formatSeconds(3.25, { locale: "de" })).toBe("3,3 Sek.");
		expect(formatSeconds(3.25, { locale: "ar" })).toContain("ث");
		expect(formatSeconds(3.25, { locale: "ar" })).not.toContain("s");
	});
});

describe("formatSecondsRange", () => {
	test("shows one unit for the span", () => {
		expect(
			formatSecondsRange(1, 2.5, { fractionDigits: 2, locale: "en" })
		).toBe("1.00–2.50s");
		expect(formatSecondsRange(1, 2.5, { locale: "de" })).toBe("1,0–2,5 Sek.");
	});

	test("a span that rounds to one value is not marked approximate", () => {
		expect(formatSecondsRange(1, 1.01, { locale: "en" })).toBe("1.0s");
	});
});

describe("formatUsd", () => {
	test("formats micro-USD as dollars for the locale", () => {
		expect(formatUsd(1_500_000, "en")).toBe("$1.50");
		expect(formatUsd(1_500_000, "de")).toMatch(/^1,50\s\$$/);
		expect(formatUsd(1_500_000, "ar")).toContain("US$");
	});
});

describe("formatUsdPrecise", () => {
	test("keeps a tenth of a cent below one cent", () => {
		expect(formatUsdPrecise(4000, "en")).toBe("$0.004");
		expect(formatUsdPrecise(4000, "de")).toMatch(/^0,004\s\$$/);
		const arabic = formatUsdPrecise(4000, "ar");
		expect(arabic).toContain("US$");
		expect(arabic).not.toContain("$0.004");
		expect(arabic).toBe(
			new Intl.NumberFormat("ar", {
				currency: "USD",
				minimumFractionDigits: 3,
				style: "currency",
			}).format(0.004)
		);
	});

	test("uses cents from one cent up, and for zero", () => {
		expect(formatUsdPrecise(120_000, "en")).toBe("$0.12");
		expect(formatUsdPrecise(25_000_000, "de")).toMatch(/^25,00\s\$$/);
		expect(formatUsdPrecise(0, "en")).toBe("$0.00");
	});
});
