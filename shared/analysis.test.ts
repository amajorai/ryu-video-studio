import { describe, expect, test } from "bun:test";
import {
	analysisSchema,
	assetBeatsResponseSchema,
	beatsResponseCovers,
	estimateBeatTimes,
	isDetectedBeats,
	loudnessPeakTimes,
	parseWaveform,
	silenceRanges,
	sourceBeats,
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

describe("waveform parsing", () => {
	test("puts every 0.1s frame in its own bin without float gaps", () => {
		const duration = 6;
		const output = Array.from(
			{ length: 60 },
			(_, frame) =>
				`frame:${frame} pts_time:${(frame * 0.1).toFixed(1)}\nlavfi.astats.Overall.RMS_level=-20`
		).join("\n");
		const bins = parseWaveform(output, duration);
		expect(bins).toHaveLength(60);
		expect(bins.every((level) => level > 0.09)).toBe(true);
	});
});

describe("source beats", () => {
	const base = {
		assetId: crypto.randomUUID(),
		createdAt: new Date().toISOString(),
		duration: 10,
		sceneCuts: [],
		status: "completed" as const,
		waveform: Array.from({ length: 20 }, (_, index) =>
			[1, 5, 9, 13, 17].includes(index) ? 0.9 : 0.08
		),
	};

	test("prefers cached detection over the envelope estimate", () => {
		const analysis = analysisSchema.parse({
			...base,
			beats: {
				analyzedDuration: 10,
				beats: [0.5, 1, 1.5, 2],
				bpm: 120,
				confidence: 0.8,
				downbeats: [0.5],
				method: "spectral-flux",
			},
		});
		expect(sourceBeats(analysis)).toEqual({
			bpm: 120,
			detected: true,
			downbeats: [0.5],
			times: [0.5, 1, 1.5, 2],
		});
	});

	test("uses a cached detection only for a window it analyzed", () => {
		const analysis = analysisSchema.parse({
			...base,
			duration: 900,
			beats: {
				analyzedDuration: 600,
				analyzedFrom: 300,
				beats: [700, 700.5],
				bpm: 120,
				confidence: 0.8,
				downbeats: [700],
				method: "spectral-flux",
			},
		});
		expect(sourceBeats(analysis, { from: 700, to: 760 }).detected).toBe(true);
		expect(sourceBeats(analysis, { from: 100, to: 160 }).detected).toBe(false);
		expect(sourceBeats(analysis, { from: 0, to: 900 }).detected).toBe(false);
		// Without a window the cached detection is used as before.
		expect(sourceBeats(analysis).detected).toBe(true);
	});

	test("falls back to the RMS estimate and keeps legacy records valid", () => {
		const analysis = analysisSchema.parse(base);
		expect(analysis).toEqual(base);
		expect(sourceBeats(analysis)).toEqual({
			detected: false,
			times: [0.75, 2.75, 4.75, 6.75, 8.75],
		});
	});
});

describe("beats response contract", () => {
	test("accepts detected and estimated bodies and rejects mixtures", () => {
		const assetId = crypto.randomUUID();
		expect(assetBeatsResponseSchema.parse({ assetId, times: [1, 2] })).toEqual({
			assetId,
			times: [1, 2],
		});
		const detected = {
			analyzedDuration: 4,
			assetId,
			beats: [1, 2],
			bpm: 120,
			confidence: 0.5,
			downbeats: [1],
			method: "spectral-flux",
			times: [1, 2],
		};
		expect(assetBeatsResponseSchema.parse(detected)).toEqual(detected);
		expect(() =>
			assetBeatsResponseSchema.parse({ assetId, bpm: 120, times: [1] })
		).toThrow();
	});

	test("reports whether a response covers a source span", () => {
		const assetId = crypto.randomUUID();
		const window = {
			analyzedDuration: 600,
			analyzedFrom: 600,
			assetId,
			beats: [601, 602],
			bpm: 60,
			confidence: 0.5,
			downbeats: [601],
			method: "spectral-flux" as const,
			times: [601, 602],
		};
		expect(beatsResponseCovers(window, 700, 760, 1500)).toBe(true);
		expect(beatsResponseCovers(window, 500, 760, 1500)).toBe(false);
		expect(beatsResponseCovers(window, 1100, 1300, 1500)).toBe(false);
		// The estimate spans the whole source.
		expect(
			beatsResponseCovers({ assetId, times: [1, 2] }, 1100, 1300, 1500)
		).toBe(true);
	});
});

test("isDetectedBeats distinguishes detection from the estimate", () => {
	const assetId = crypto.randomUUID();
	expect(isDetectedBeats({ assetId, times: [] })).toBe(false);
	expect(
		isDetectedBeats({
			analyzedDuration: 1,
			assetId,
			beats: [],
			bpm: 90,
			confidence: 0,
			downbeats: [],
			method: "spectral-flux",
			times: [],
		})
	).toBe(true);
});
