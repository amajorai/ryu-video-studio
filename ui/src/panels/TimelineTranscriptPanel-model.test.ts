import { describe, expect, test } from "bun:test";
import {
	rangesSeconds,
	rangesSecondsLabel,
} from "./TimelineTranscriptPanel-model.ts";

const ranges = [
	{ end: 1, start: 0.5 },
	{ end: 2.234, start: 1.5 },
];

describe("rangesSecondsLabel", () => {
	test("sums the ranges to milliseconds", () => {
		expect(rangesSeconds(ranges)).toBe(1.234);
	});

	test("uses the reader's decimal mark", () => {
		expect(rangesSecondsLabel(ranges, "en")).toBe("1.234");
		expect(rangesSecondsLabel(ranges, "de")).toBe("1,234");
	});

	test("drops trailing zeros", () => {
		expect(rangesSecondsLabel([{ end: 2.5, start: 0 }], "en")).toBe("2.5");
		expect(rangesSecondsLabel([{ end: 2.5, start: 0 }], "de")).toBe("2,5");
	});
});
