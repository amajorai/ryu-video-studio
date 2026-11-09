import { describe, expect, test } from "bun:test";
import { formatMessage, type MessageValuesInput } from "@ryu/i18n/lite";
import { speedRampStatus } from "./speed-ramp-status.ts";

const STEPS =
	"{preset} speed ramp applied in {steps, plural, one {# step} other {# steps}}.";

// A stub German catalog stands in for the shipped one, whose entries arrive
// with the catalog regeneration.
const GERMAN: Record<string, string> = {
	"Ease in": "Sanft ein",
	[STEPS]:
		"Geschwindigkeitsrampe {preset} in {steps, plural, one {# Schritt} other {# Schritten}} angewendet.",
};

const english = (source: string, values?: MessageValuesInput) =>
	formatMessage(source, values, "en");
const german = (source: string, values?: MessageValuesInput) =>
	formatMessage(GERMAN[source] ?? source, values, "de");

describe("speedRampStatus", () => {
	test("pluralizes the step count", () => {
		expect(speedRampStatus("steps", "Ease in", 1, english)).toBe(
			"Ease in speed ramp applied in 1 step."
		);
		expect(speedRampStatus("steps", "Ease in", 8, english)).toBe(
			"Ease in speed ramp applied in 8 steps."
		);
	});

	test("translates the sentence and the preset name inside it", () => {
		expect(speedRampStatus("steps", "Ease in", 8, german)).toBe(
			"Geschwindigkeitsrampe Sanft ein in 8 Schritten angewendet."
		);
	});

	test("describes a smooth curve as one clip", () => {
		expect(speedRampStatus("smooth", "Montage", 8, english)).toBe(
			"Montage speed curve applied as one smooth clip."
		);
	});
});
