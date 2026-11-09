import { afterEach, expect, test } from "bun:test";
import { formatMessage, type MessageValuesInput } from "@ryu/i18n/core";
// The provider registers its runtime here; a test registers a stand-in.
import {
	registerActiveI18nRuntime,
	unregisterActiveI18nRuntime,
} from "../../../../../packages/i18n/src/active-locale.ts";
import { previewZoomLabel } from "./viewport-math.ts";

// The preview zoom readout prints its level in the reader's number format:
// "150 %" in German instead of a hand-built "150%".
const german = {
	direction: "ltr" as const,
	locale: "de",
	translate(id: string, values?: MessageValuesInput, fallback?: string) {
		return formatMessage(fallback ?? id, values, "de");
	},
};

afterEach(() => {
	unregisterActiveI18nRuntime(german);
});

test("preview zoom label uses the German percent format under de", () => {
	registerActiveI18nRuntime(german);
	expect(previewZoomLabel(1.5)).toBe("150 %");
	expect(previewZoomLabel("fit")).toBe("Fit");
});
