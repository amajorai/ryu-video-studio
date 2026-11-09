/**
 * A plain number with a fixed count of decimals in the host locale ("1.50",
 * "1,50", "١٫٥٠"), for values that go into a translated message. `toFixed(n)`
 * always writes an English ".", which reads wrong inside a German or French
 * sentence. The locale is the host's formatting locale (`activeLocale()`),
 * read at call time, as in `units.ts`.
 */
import { activeLocale, numberFormatter } from "@ryu/i18n/core";

/** `value` with exactly `fractionDigits` decimals, the old `toFixed(n)`. */
export function formatDecimal(
	value: number,
	fractionDigits: number,
	locale: string = activeLocale()
): string {
	return numberFormatter(locale, {
		maximumFractionDigits: fractionDigits,
		minimumFractionDigits: fractionDigits,
	}).format(value);
}
