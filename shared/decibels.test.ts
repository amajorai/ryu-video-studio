import { describe, expect, test } from "bun:test";
import {
	CLIP_THRESHOLD_DBFS,
	channelLevel,
	clampTrackGainDb,
	clipVolumeFromDb,
	dbToGain,
	displayDb,
	formatDb,
	gainToDb,
	isClipping,
	MAX_CLIP_GAIN,
	meterBallistics,
	meterFraction,
	SILENCE_DB,
} from "./decibels.ts";

describe("decibel conversions", () => {
	test("round-trips common gains", () => {
		expect(gainToDb(1)).toBe(0);
		expect(gainToDb(0.5)).toBeCloseTo(-6.0206, 4);
		expect(gainToDb(2)).toBeCloseTo(6.0206, 4);
		expect(dbToGain(-6)).toBeCloseTo(0.501_187, 6);
		expect(dbToGain(0)).toBe(1);
		for (const gain of [0.01, 0.25, 1, 3.5]) {
			expect(dbToGain(gainToDb(gain))).toBeCloseTo(gain, 10);
		}
	});

	test("silence is -Infinity and back to exactly zero", () => {
		expect(gainToDb(0)).toBe(Number.NEGATIVE_INFINITY);
		expect(gainToDb(-1)).toBe(Number.NEGATIVE_INFINITY);
		expect(gainToDb(Number.NaN)).toBe(Number.NEGATIVE_INFINITY);
		expect(dbToGain(Number.NEGATIVE_INFINITY)).toBe(0);
		expect(dbToGain(Number.NaN)).toBe(0);
	});

	test("clip volume from dB is clamped to the stored 0..4 range", () => {
		expect(clipVolumeFromDb(0)).toBe(1);
		expect(clipVolumeFromDb(12)).toBeCloseTo(3.981, 3);
		expect(clipVolumeFromDb(20)).toBe(MAX_CLIP_GAIN);
		expect(clipVolumeFromDb(SILENCE_DB)).toBe(0);
		expect(clipVolumeFromDb(Number.NEGATIVE_INFINITY)).toBe(0);
		expect(gainToDb(MAX_CLIP_GAIN)).toBeCloseTo(12.04, 2);
	});

	test("track gain clamps to the schema bounds", () => {
		expect(clampTrackGainDb(-6.04)).toBe(-6);
		expect(clampTrackGainDb(30)).toBe(12);
		expect(clampTrackGainDb(-100)).toBe(-60);
		expect(clampTrackGainDb(Number.NEGATIVE_INFINITY)).toBe(-60);
		expect(clampTrackGainDb(Number.POSITIVE_INFINITY)).toBe(12);
	});

	test("formats with a sign, one decimal, and -∞ for silence", () => {
		expect(formatDb(0)).toBe("0.0 dB");
		expect(formatDb(-0.04)).toBe("0.0 dB");
		expect(formatDb(6.02)).toBe("+6.0 dB");
		expect(formatDb(-12.345)).toBe("-12.3 dB");
		expect(formatDb(Number.NEGATIVE_INFINITY)).toBe("-∞ dB");
		expect(displayDb(Number.NEGATIVE_INFINITY)).toBe(SILENCE_DB);
	});
});

describe("metering", () => {
	test("peak and RMS of a known sine", () => {
		const samples = Float32Array.from({ length: 4800 }, (_, index) =>
			Math.sin((2 * Math.PI * 1000 * index) / 48_000)
		);
		const level = channelLevel(samples);
		expect(level.peak).toBeCloseTo(1, 3);
		expect(level.rms).toBeCloseTo(Math.SQRT1_2, 3);
		expect(gainToDb(level.rms)).toBeCloseTo(-3.01, 2);
	});

	test("peak and RMS of a constant block, empty block and non-finite samples", () => {
		expect(channelLevel([0.5, -0.5, 0.5, -0.5])).toEqual({
			peak: 0.5,
			rms: 0.5,
		});
		expect(channelLevel([])).toEqual({ peak: 0, rms: 0 });
		expect(channelLevel([Number.NaN, 0])).toEqual({ peak: 0, rms: 0 });
	});

	test("clip latch threshold is -0.1 dBFS", () => {
		expect(isClipping(1)).toBe(true);
		expect(isClipping(dbToGain(CLIP_THRESHOLD_DBFS) + 1e-6)).toBe(true);
		expect(isClipping(dbToGain(-0.2))).toBe(false);
		expect(isClipping(0)).toBe(false);
	});

	test("ballistics rise instantly and fall at the release rate", () => {
		expect(meterBallistics(-30, -6, 1 / 30)).toBe(-6);
		expect(meterBallistics(-6, -60, 0.5)).toBe(-18);
		expect(meterBallistics(-6, -10, 1)).toBe(-10);
		expect(meterBallistics(Number.NEGATIVE_INFINITY, -20, 0)).toBe(-20);
	});

	test("meter fraction spans the floor to full scale", () => {
		expect(meterFraction(0)).toBe(1);
		expect(meterFraction(3)).toBe(1);
		expect(meterFraction(-30)).toBe(0.5);
		expect(meterFraction(-60)).toBe(0);
		expect(meterFraction(Number.NEGATIVE_INFINITY)).toBe(0);
	});
});
