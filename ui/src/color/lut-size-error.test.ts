import { describe, expect, test } from "bun:test";
import { formatMessage, type MessageValuesInput } from "@ryu/i18n/lite";
import { lutTooLargeMessage } from "./lut-size-error.ts";

const english = (source: string, values?: MessageValuesInput) =>
	formatMessage(source, values, "en");
const MIB = 1024 * 1024;

describe("lutTooLargeMessage", () => {
	test("names the point size when the file declares one", () => {
		expect(lutTooLargeMessage("65", 12.3 * MIB, 2 * MIB, english, "en")).toBe(
			"This LUT (65-point) is 12.3 MB once validated; imports are limited to 2.0 MB. Export it at 33 points (or smaller) and import it again."
		);
	});

	test("leaves the point size out when it is unknown", () => {
		expect(lutTooLargeMessage(undefined, 3 * MIB, 2 * MIB, english, "en")).toBe(
			"This LUT is 3.0 MB once validated; imports are limited to 2.0 MB. Export it at 33 points (or smaller) and import it again."
		);
	});

	test("formats the sizes in the host locale", () => {
		const french = lutTooLargeMessage("65", 12.3 * MIB, 2 * MIB, english, "fr");
		expect(french).toMatch(/is 12,3\s?Mo once/u);
		expect(french).toMatch(/limited to 2,0\s?Mo\./u);
	});
});
