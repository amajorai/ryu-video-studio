import { describe, expect, test } from "bun:test";
import {
	canMarkSource,
	MIN_MARKED_DURATION,
	markedRange,
	markSourceIn,
	markSourceOut,
} from "./source-marks.ts";

const video = { duration: 10, kind: "video" } as const;

describe("source marks", () => {
	test("in and out marks make a range; nothing marked places the whole asset", () => {
		expect(markedRange({}, video)).toBeUndefined();
		const marks = markSourceOut(markSourceIn({}, 2.5, video), 6, video);
		expect(marks).toEqual({ in: 2.5, out: 6 });
		expect(markedRange(marks, video)).toEqual({ end: 6, start: 2.5 });
	});

	test("a lone mark runs to the edge of the source", () => {
		expect(markedRange({ in: 4 }, video)).toEqual({ end: 10, start: 4 });
		expect(markedRange({ out: 3 }, video)).toEqual({ end: 3, start: 0 });
	});

	test("marks clamp into the media and round to milliseconds", () => {
		expect(markSourceIn({}, -3, video)).toEqual({ in: 0 });
		expect(markSourceIn({}, 99, video)).toEqual({
			in: 10 - MIN_MARKED_DURATION,
		});
		expect(markSourceOut({}, 99, video)).toEqual({ out: 10 });
		expect(markSourceOut({}, 0, video)).toEqual({ out: MIN_MARKED_DURATION });
		expect(markSourceIn({}, 1.234_56, video)).toEqual({ in: 1.235 });
	});

	test("a new mark that crosses the other clears it", () => {
		expect(markSourceIn({ in: 1, out: 4 }, 5, video)).toEqual({ in: 5 });
		expect(markSourceOut({ in: 6, out: 8 }, 3, video)).toEqual({ out: 3 });
		expect(markSourceOut({ in: 6 }, 6.01, video)).toEqual({ out: 6.01 });
	});

	test("stills cannot be marked; audio can", () => {
		const still = { duration: 5, kind: "image" } as const;
		expect(canMarkSource(still)).toBe(false);
		expect(markedRange({ in: 1, out: 2 }, still)).toBeUndefined();
		expect(canMarkSource({ kind: "audio" })).toBe(true);
	});
});
