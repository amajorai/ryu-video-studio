/**
 * The error shown when a `.cube` LUT is too large for the sidecar's import
 * limit: one translated sentence, with a select on whether the file names its
 * point size, and both sizes formatted as megabytes in the host locale
 * ("12,3 Mo" in French).
 */
import { activeLocale, translate } from "@ryu/i18n/core";
import { formatByteSize } from "@ryu/i18n/format-intl";
import type { LiteralMessage } from "@ryu/i18n/react";

function megabytes(bytes: number, locale: string): string {
	return formatByteSize(bytes, locale, {
		fractionDigits: 1,
		maxUnit: "megabyte",
		minUnit: "megabyte",
	});
}

export function lutTooLargeMessage(
	pointSize: string | undefined,
	bytes: number,
	limitBytes: number,
	tl: LiteralMessage = translate,
	locale: string = activeLocale()
): string {
	return tl(
		"{known, select, yes {This LUT ({size}-point) is {bytes} once validated; imports are limited to {limit}. Export it at 33 points (or smaller) and import it again.} other {This LUT is {bytes} once validated; imports are limited to {limit}. Export it at 33 points (or smaller) and import it again.}}",
		{
			bytes: megabytes(bytes, locale),
			known: pointSize ? "yes" : "no",
			limit: megabytes(limitBytes, locale),
			size: pointSize ?? "",
		}
	);
}
