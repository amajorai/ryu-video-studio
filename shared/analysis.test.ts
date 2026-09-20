import { describe, expect, test } from "bun:test";
import {
	estimateBeatTimes,
	loudnessPeakTimes,
	silenceRanges,
} from "./analysis.ts";

describe("measured loudness markers", () => {
	test("selects separated pronounced peaks in source time order", () => {
		const peaks = loudnessPeakTimes(
			[0.05, 0.2, 0.92, 0.2, 0.05, 0.1, 0.7, 0.1, 0.04],
			9
		);
		expect(peaks).toEqual([2.5, 6.5]);
	});

	test("does not invent markers for quiet or unusable waveforms", () => {
		expect(loudnessPeakTimes([0.01, 0.02, 0.01], 3)).toEqual([]);
		expect(loudnessPeakTimes([0.1, 0.9], 2)).toEqual([]);
		expect(loudnessPeakTimes([0.1, 0.9, 0.1], 0)).toEqual([]);
	});

	test("estimates recurring beat onsets from a measured envelope", () => {
		const waveform = Array.from({ length: 20 }, (_, index) =>
			[1, 5, 9, 13, 17].includes(index) ? 0.9 : 0.08
		);
		expect(estimateBeatTimes(waveform, 10)).toEqual([
			0.75, 2.75, 4.75, 6.75, 8.75,
		]);
	});

	test("does not infer beats from a steady envelope", () => {
		expect(
			estimateBeatTimes(
				Array.from({ length: 20 }, () => 0.2),
				10
			)
		).toEqual([]);
	});

	test("finds separated silent source ranges", () => {
		expect(
			silenceRanges([0, 0, 0.2, 0.5, 0.1, 0, 0, 0.3, 0, 0, 0], 11, 2)
		).toEqual([
			[0, 2],
			[5, 7],
			[8, 11],
		]);
	});

	test("does not remove a quiet source without a measured signal", () => {
		expect(silenceRanges([0.01, 0.02, 0.01], 3)).toEqual([]);
	});
});
