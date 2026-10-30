import { describe, expect, test } from "bun:test";
import {
	SFX_DEFAULT_DURATIONS,
	sfxKindSchema,
	sfxParameters,
	sfxRequestSchema,
} from "./sfx.ts";

describe("sfx request", () => {
	test("accepts the eight kinds with optional duration and seed", () => {
		expect(sfxKindSchema.options).toEqual([
			"whoosh",
			"riser",
			"hit",
			"impact",
			"click",
			"pop",
			"swoosh",
			"ding",
		]);
		expect(sfxRequestSchema.parse({ kind: "pop" })).toEqual({ kind: "pop" });
	});

	test("rejects unknown keys, kinds, fractional seeds and out-of-range durations", () => {
		for (const input of [
			{ kind: "pop", volume: 1 },
			{ kind: "boing" },
			{ kind: "pop", seed: 1.5 },
			{ kind: "pop", seed: -1 },
			{ kind: "pop", duration: 0.01 },
			{ kind: "pop", duration: 11 },
		]) {
			expect(sfxRequestSchema.safeParse(input).success).toBe(false);
		}
	});
});

describe("sfx parameters", () => {
	test("deterministic parameter snapshot", () => {
		expect(sfxParameters({ kind: "whoosh", seed: 7 })).toEqual({
			decay: 0,
			duration: 0.8,
			endHz: 564.2,
			gain: 3.2,
			kind: "whoosh",
			noise: 1,
			peak: 0.522,
			resonance: 0.985,
			seed: 7,
			startHz: 347.2,
			toneHz: 0,
			toneEndHz: 0,
		});
		expect(sfxParameters({ kind: "ding" })).toEqual({
			decay: 3.665,
			duration: 1.5,
			endHz: 2000,
			gain: 1.2,
			kind: "ding",
			noise: 0,
			peak: 0,
			resonance: 0.8,
			seed: 1,
			startHz: 2000,
			toneHz: 1253.2,
			toneEndHz: 1253.2,
		});
		expect(sfxParameters({ duration: 2, kind: "impact", seed: 42 })).toEqual({
			decay: 3.846,
			duration: 2,
			endHz: 300,
			gain: 1.8,
			kind: "impact",
			noise: 0.3,
			peak: 0,
			resonance: 0.93,
			seed: 42,
			startHz: 1491,
			toneHz: 112,
			toneEndHz: 44.7,
		});
	});

	test("same input gives the same parameters; seeds vary them", () => {
		for (const kind of sfxKindSchema.options) {
			const first = sfxParameters({ kind, seed: 3 });
			expect(sfxParameters({ kind, seed: 3 })).toEqual(first);
			expect(first.duration).toBe(SFX_DEFAULT_DURATIONS[kind]);
			const other = sfxParameters({ kind, seed: 4 });
			expect(other).not.toEqual(first);
		}
	});

	test("every kind has an audible, bounded shape", () => {
		for (const kind of sfxKindSchema.options) {
			const parameters = sfxParameters({ kind });
			expect(parameters.gain).toBeGreaterThan(0);
			expect(parameters.noise).toBeGreaterThanOrEqual(0);
			expect(parameters.noise).toBeLessThanOrEqual(1);
			expect(parameters.resonance).toBeLessThan(1);
			expect(parameters.startHz).toBeLessThan(24_000);
			expect(parameters.endHz).toBeLessThan(24_000);
			// A pure-noise kind needs a sweep; a tonal kind needs a tone.
			expect(parameters.noise === 1 || parameters.toneHz > 0).toBe(true);
			// Swell kinds have no decay and a peak inside the effect.
			if (parameters.decay === 0) {
				expect(parameters.peak).toBeGreaterThan(0);
				expect(parameters.peak).toBeLessThan(1);
			}
		}
	});
});
