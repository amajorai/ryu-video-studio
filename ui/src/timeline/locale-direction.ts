import { useOptionalI18n } from "@ryu/i18n/react";

/**
 * The host language's writing direction. The timeline's time axis is a
 * `dir="ltr"` island (00:00 on the left, LTR `scrollLeft` math), so its
 * sticky label and ruler gutters put this back on their own content.
 */
export function useLocaleDirection(): "ltr" | "rtl" {
	return useOptionalI18n()?.direction === "rtl" ? "rtl" : "ltr";
}
