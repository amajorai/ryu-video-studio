import { formatByteSize } from "@ryu/i18n/format-intl";

/**
 * A decimal megabyte count with one decimal ("48.2 MB"), in the studio
 * locale's own digits and unit name elsewhere ("48,2 Mo").
 */
export function formatMegabytes(bytes: number, locale: string): string {
	return formatByteSize(bytes, locale, {
		base: 1000,
		fractionDigits: 1,
		maxUnit: "megabyte",
		minUnit: "megabyte",
	});
}
