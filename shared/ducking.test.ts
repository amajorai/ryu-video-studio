import { describe, expect, test } from "bun:test";
import {
	DUCK_DEFAULTS,
	DUCK_THRESHOLD,
	duckFilterChain,
	duckGain,
	duckKey,
	ffmpegEnvelopeMs,
	previewDuckTarget,
	resolveDuck,
} from "./ducking.ts";
import { newSegment, segmentSchema } from "./project.ts";

describe("ducking settings", () => {
	test("missing fields fall back to the defaults", () => {
		expect(resolveDuck(undefined)).toEqual(DUCK_DEFAULTS);
		expect(resolveDuck({ amountDb: 15 })).toEqual({
			...DUCK_DEFAULTS,
			amountDb: 15,
		});
	});

	test("out-of-range values are clamped to the limits", () => {
		expect(resolveDuck({ amountDb: 40, attackMs: 1, releaseMs: 9000 })).toEqual(
			{ amountDb: 24, attackMs: 5, releaseMs: 2000 }
		);
	});

	test("the segment schema accepts bounded settings and rejects others", () => {
		const base = newSegment({
			createdAt: "2026-01-01T00:00:00.000Z",
			duration: 4,
			hasAudio: true,
			height: 0,
			id: "00000000-0000-4000-8000-000000000001",
			kind: "audio",
			name: "Music",
			width: 0,
		});
		expect(
			segmentSchema.safeParse({
				...base,
				duckUnderVoice: true,
				ducking: { amountDb: 12, attackMs: 40, releaseMs: 500 },
			}).success
		).toBe(true);
		expect(
			segmentSchema.safeParse({ ...base, ducking: { amountDb: 30 } }).success
		).toBe(false);
		expect(
			segmentSchema.safeParse({ ...base, ducking: { depth: 3 } }).success
		).toBe(false);
	});

	test("the dip gain is the amount in dB", () => {
		expect(20 * Math.log10(duckGain(9))).toBeCloseTo(-9, 9);
		expect(20 * Math.log10(duckGain(24))).toBeCloseTo(-24, 9);
	});

	test("equal settings share a key", () => {
		expect(duckKey(resolveDuck({}))).toBe(duckKey(DUCK_DEFAULTS));
		expect(duckKey(resolveDuck({ releaseMs: 600 }))).not.toBe(
			duckKey(DUCK_DEFAULTS)
		);
	});
});

describe("duck filter chain", () => {
	test("gates a copy on the key and subtracts it at the set depth", () => {
		expect(
			duckFilterChain({
				duck: { amountDb: 6, attackMs: 30, releaseMs: 400 },
				key: "[k]",
				output: "[out]",
				prefix: "d",
				source: "[in]",
			})
		).toEqual([
			"[k]dcshift=shift=0.000001,asplit=2[dKeyA][dKeyB]",
			"[dKeyA]aeval=exprs=1:c=mono[dOne]",
			"[dOne][dKeyB]sidechaingate=threshold=0.02:ratio=9000:range=0.000001:knee=1:attack=5:release=60:detection=rms[dVoiced]",
			"[in]asplit=2[dDry][dWet]",
			"[dWet][dVoiced]sidechaingate=threshold=1:ratio=2:range=0:knee=1:attack=54.614354:release=728.191381:detection=peak,volume=-0.498813[dCut]",
			"[dDry][dCut]amix=inputs=2:normalize=0[out]",
		]);
	});

	test("FFmpeg envelope times have the set 10-90% time", () => {
		// FFmpeg's gate time constant is a quarter of its attack or release;
		// a one-pole rise from 10% to 90% takes ln 9 time constants.
		expect((ffmpegEnvelopeMs(250) / 4) * Math.log(9)).toBeCloseTo(250, 4);
	});
});

describe("preview envelope", () => {
	test("dips with the attack while the key is above the threshold", () => {
		const target = previewDuckTarget(DUCK_THRESHOLD * 2, {
			amountDb: 12,
			attackMs: 44,
			releaseMs: 660,
		});
		expect(target.gain).toBeCloseTo(duckGain(12), 9);
		expect(target.timeConstant).toBeCloseTo(0.044 / Math.log(9), 9);
	});

	test("recovers with the release when the key falls silent", () => {
		const target = previewDuckTarget(0, {
			amountDb: 12,
			attackMs: 44,
			releaseMs: 660,
		});
		expect(target.gain).toBe(1);
		expect(target.timeConstant).toBeCloseTo(0.66 / Math.log(9), 9);
	});
});
