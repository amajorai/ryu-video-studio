import { afterEach, describe, expect, test } from "bun:test";
import { formatMessage } from "@ryu/i18n/core";
import type { LiteralMessage } from "@ryu/i18n/react";
// The provider registers its runtime here; a test registers a stand-in.
import {
	type ActiveI18nRuntime,
	registerActiveI18nRuntime,
	unregisterActiveI18nRuntime,
} from "../../../../../packages/i18n/src/active-locale.ts";
import { fadeLabel } from "../timeline/clip-drag-fade.ts";
import { formatDecimal } from "./decimal.ts";

const german: ActiveI18nRuntime = {
	direction: "ltr",
	locale: "de",
	translate: (_id, values, fallback) =>
		formatMessage(fallback ?? "", values ?? {}, "de"),
};

afterEach(() => unregisterActiveI18nRuntime(german));

describe("formatDecimal", () => {
	test("matches toFixed in English", () => {
		expect(formatDecimal(1.5, 2, "en")).toBe("1.50");
		expect(formatDecimal(0.125, 1, "en")).toBe("0.1");
		expect(formatDecimal(3, 1, "en")).toBe("3.0");
	});

	test("uses the reader's decimal mark", () => {
		expect(formatDecimal(1.5, 2, "de")).toBe("1,50");
		expect(formatDecimal(1.5, 1, "ru")).toBe("1,5");
		expect(formatDecimal(1.5, 1, "fr")).toBe("1,5");
		expect(formatDecimal(1.5, 2, "ja")).toBe("1.50");
	});

	test("a fade tooltip reads with a comma in German", () => {
		registerActiveI18nRuntime(german);
		const germanTl: LiteralMessage = (_source, values) =>
			formatMessage(
				"{direction, select, in {Einblenden} other {Ausblenden}} {seconds} s",
				values ?? {},
				"de"
			);
		expect(fadeLabel("in", 1.5, germanTl)).toBe("Einblenden 1,50 s");
		expect(fadeLabel("out", 0.25)).toBe("Fade out 0,25 s");
	});
});
