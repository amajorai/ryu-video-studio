import { afterEach, expect, test } from "bun:test";
import { formatMessage, type MessageValuesInput } from "@ryu/i18n/core";
// The provider registers its runtime here; a test registers a stand-in.
import {
	registerActiveI18nRuntime,
	unregisterActiveI18nRuntime,
} from "../../../../../../packages/i18n/src/active-locale.ts";
import { type GuideRect, previewGuideShapes } from "./guide-geometry.ts";

// A custom aspect that is not a small whole-number ratio prints its decimal
// in the reader's number format ("2,35:1" in German, not "2.35:1"). The stub
// catalog stands in for the shipped one, which has no translation yet.
const GERMAN: Record<string, string> = {
	"Custom {ratio}": "Eigenes {ratio}",
};
const german = {
	direction: "ltr" as const,
	locale: "de",
	translate(id: string, values?: MessageValuesInput, fallback?: string) {
		return formatMessage(
			GERMAN[fallback ?? id] ?? fallback ?? id,
			values,
			"de"
		);
	},
};

afterEach(() => {
	unregisterActiveI18nRuntime(german);
});

function customAspectLabel(aspect: number): string | undefined {
	const shapes = previewGuideShapes(["custom"], 1920, 1080, {
		aspect,
		margins: { bottom: 0, left: 0, right: 0, top: 0 },
	}) as GuideRect[];
	return shapes.find((shape) => shape.id === "custom:aspect")?.label;
}

test("a decimal custom aspect uses the German decimal mark under de", () => {
	registerActiveI18nRuntime(german);
	expect(customAspectLabel(2.3456)).toBe("Eigenes 2,35:1");
	expect(customAspectLabel(0.75)).toBe("Eigenes 3:4");
});

test("English keeps the English decimal mark", () => {
	expect(customAspectLabel(2.3456)).toBe("Custom 2.35:1");
});
