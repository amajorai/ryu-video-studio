/**
 * Durations and money with the host locale's own digits, decimal mark and unit
 * ("3.2s", "3,2 Sek.", "3.2 ث"; "$1.50", "1,50 $"), instead of a hand-built
 * `toFixed(1) + "s"` that keeps the English look in every language. The locale
 * is the host's formatting locale (`activeLocale()`), read at call time so the
 * text is never one render behind a language switch.
 */
import { activeLocale, numberFormatter } from "@ryu/i18n/core";

interface SecondsOptions {
	/** Digits after the decimal mark, always shown (the old `toFixed(n)`). */
	fractionDigits?: number;
	locale?: string;
	/** Drop trailing zeros instead (`2.5s`, `2s`), keeping up to `fractionDigits`. */
	trimZeros?: boolean;
}

function secondsFormatter({
	fractionDigits = 1,
	locale = activeLocale(),
	trimZeros = false,
}: SecondsOptions): Intl.NumberFormat {
	return numberFormatter(locale, {
		maximumFractionDigits: fractionDigits,
		minimumFractionDigits: trimZeros ? 0 : fractionDigits,
		style: "unit",
		unit: "second",
		unitDisplay: "narrow",
	});
}

/** A second count with its narrow unit in the host locale ("3.2s"). */
export function formatSeconds(
	seconds: number,
	options: SecondsOptions = {}
): string {
	return secondsFormatter(options).format(seconds);
}

/** A start–end span in seconds with one unit ("1.0–2.5s"). */
export function formatSecondsRange(
	start: number,
	end: number,
	options: SecondsOptions = {}
): string {
	const formatter = secondsFormatter(options);
	const from = formatter.format(start);
	const to = formatter.format(end);
	// `formatRange` marks a span that rounds to one value as approximate
	// ("~1.0s"); show that value plainly instead.
	if (from === to) {
		return from;
	}
	if (start > end || typeof formatter.formatRange !== "function") {
		return `${from}–${to}`;
	}
	return formatter.formatRange(start, end);
}

/** A micro-USD amount as US dollars in the host locale ("$1.50", "1,50 $"). */
export function formatUsd(microUsd: number, locale = activeLocale()): string {
	return numberFormatter(locale, {
		currency: "USD",
		style: "currency",
	}).format(microUsd / 1_000_000);
}
