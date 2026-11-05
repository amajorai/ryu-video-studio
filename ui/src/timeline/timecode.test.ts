import { describe, expect, test } from "bun:test";
import {
	dropFramesPerMinute,
	formatTimecode,
	nominalFps,
	parseTimecode,
} from "./timecode.ts";

describe("timecode formatting", () => {
	test("formats non-drop-frame timecode at integer rates", () => {
		expect(formatTimecode(0, 30)).toBe("00:00:00:00");
		expect(formatTimecode(1.5, 30)).toBe("00:00:01:15");
		expect(formatTimecode(3661 + 2 / 25, 25)).toBe("01:01:01:02");
	});

	test("counts fractional rates at the nominal rate", () => {
		expect(nominalFps(29.97)).toBe(30);
		expect(nominalFps(23.976)).toBe(24);
		// 30 frames at 29.97 fps is 1.001 s and reads as one second.
		expect(formatTimecode(30 / 29.97, 29.97)).toBe("00:00:01:00");
		expect(formatTimecode(24 / 23.976, 23.976)).toBe("00:00:01:00");
	});

	test("drop-frame skips frame numbers at non-tenth minutes", () => {
		expect(dropFramesPerMinute(29.97)).toBe(2);
		expect(dropFramesPerMinute(59.94)).toBe(4);
		expect(dropFramesPerMinute(30)).toBe(0);
		expect(dropFramesPerMinute(23.976)).toBe(0);
		expect(formatTimecode(1799 / 29.97, 29.97, { dropFrame: true })).toBe(
			"00:00:59;29"
		);
		expect(formatTimecode(1800 / 29.97, 29.97, { dropFrame: true })).toBe(
			"00:01:00;02"
		);
		// The tenth minute keeps frames 00 and 01.
		expect(formatTimecode(17_982 / 29.97, 29.97, { dropFrame: true })).toBe(
			"00:10:00;00"
		);
	});

	test("drop-frame is ignored at rates without it", () => {
		expect(formatTimecode(1, 30, { dropFrame: true })).toBe("00:00:01:00");
	});

	test("negative and invalid times format as zero", () => {
		expect(formatTimecode(-3, 30)).toBe("00:00:00:00");
		expect(formatTimecode(Number.NaN, 30)).toBe("00:00:00:00");
	});
});

describe("timecode parsing", () => {
	test("parses HH:MM:SS:FF and MM:SS:FF", () => {
		expect(parseTimecode("00:00:01:15", 30)).toBe(1.5);
		expect(parseTimecode("01:01:01:02", 25)).toBeCloseTo(3661.08, 9);
		expect(parseTimecode("1:02:10", 30)).toBeCloseTo(62 + 10 / 30, 9);
		expect(parseTimecode(" 00:00:02.12 ", 24)).toBe(2.5);
	});

	test("parses at fractional frame rates", () => {
		// One nominal second at 29.97 is 30 real frames, 1.001 s.
		expect(parseTimecode("00:00:01:00", 29.97)).toBeCloseTo(30 / 29.97, 9);
		expect(parseTimecode("00:00:01:00", 23.976)).toBeCloseTo(24 / 23.976, 9);
		expect(parseTimecode("00:00:00:29", 29.97)).toBeCloseTo(29 / 29.97, 9);
	});

	test("drop-frame round-trips at 29.97 and 59.94", () => {
		for (const fps of [29.97, 59.94]) {
			for (const frame of [0, 1, 1799, 1800, 1801, 17_982, 107_892]) {
				const text = formatTimecode(frame / fps, fps, { dropFrame: true });
				expect(parseTimecode(text, fps)).toBeCloseTo(frame / fps, 6);
			}
		}
	});

	test("non-drop-frame round-trips at fractional rates", () => {
		for (const fps of [23.976, 29.97, 59.94]) {
			for (const frame of [0, 1, 23, 1799, 86_400]) {
				const text = formatTimecode(frame / fps, fps);
				expect(parseTimecode(text, fps)).toBeCloseTo(frame / fps, 6);
			}
		}
	});

	test("rejects drop-frame numbers that do not exist", () => {
		expect(parseTimecode("00:01:00;00", 29.97)).toBeNull();
		expect(parseTimecode("00:01:00;01", 29.97)).toBeNull();
		expect(parseTimecode("00:10:00;00", 29.97)).toBe(0 + 17_982 / 29.97);
		expect(parseTimecode("00:00:01;00", 30)).toBeNull();
	});

	test("bare numbers are frames; an s suffix means seconds", () => {
		expect(parseTimecode("45", 30)).toBe(1.5);
		expect(parseTimecode("45f", 30)).toBe(1.5);
		expect(parseTimecode("30", 29.97)).toBeCloseTo(30 / 29.97, 9);
		expect(parseTimecode("2.5s", 30)).toBe(2.5);
		expect(parseTimecode(".5s", 30)).toBe(0.5);
	});

	test("+ and - offsets are relative to the current time", () => {
		expect(parseTimecode("+15", 30, 2)).toBe(2.5);
		expect(parseTimecode("-1s", 30, 2)).toBe(1);
		expect(parseTimecode("-10s", 30, 2)).toBe(0);
		expect(parseTimecode("+00:00:01:00", 25, 1)).toBe(2);
	});

	test("rejects malformed and out-of-range input", () => {
		for (const text of [
			"",
			"abc",
			"00:60:00:00",
			"00:00:60:00",
			"00:00:00:30",
			"1:2",
			"1.5",
			"+",
			"--1",
		]) {
			expect(parseTimecode(text, 30)).toBeNull();
		}
		expect(parseTimecode("10", 0)).toBeNull();
	});
});
