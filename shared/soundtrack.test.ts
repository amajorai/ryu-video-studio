import { describe, expect, test } from "bun:test";
import {
	SOUNDTRACK_STYLES,
	soundtrackBarSeconds,
	soundtrackClockLead,
	soundtrackIntensitySteps,
	soundtrackLayersOf,
	soundtrackMoodSchema,
	soundtrackRequestSchema,
	soundtrackSectionIssues,
} from "./soundtrack.ts";

describe("soundtrack request", () => {
	test("legacy requests parse unchanged with their defaults", () => {
		expect(soundtrackRequestSchema.parse({ duration: 4 })).toEqual({
			bpm: 96,
			duration: 4,
			mood: "warm",
		});
	});

	test("every style has a definition and the planner styles are present", () => {
		expect(soundtrackMoodSchema.options).toEqual([
			"warm",
			"bright",
			"tense",
			"ambient",
			"cinematic",
			"lo-fi",
			"upbeat",
			"corporate",
			"suspense",
		]);
		for (const style of soundtrackMoodSchema.options) {
			const definition = SOUNDTRACK_STYLES[style];
			expect(definition.bpm).toBeGreaterThanOrEqual(60);
			expect(definition.bpm).toBeLessThanOrEqual(180);
			expect(definition.progression).toHaveLength(4);
			expect(definition.layers.length).toBeGreaterThan(0);
		}
	});

	test("original moods keep the published progression constants", () => {
		expect(SOUNDTRACK_STYLES.warm.progression).toEqual([
			1, 0.8409, 0.6674, 0.7492,
		]);
		expect(SOUNDTRACK_STYLES.cinematic.progression[1]).toBe(0.7937);
	});

	test("rejects unknown keys, layers and an empty layer list", () => {
		expect(() =>
			soundtrackRequestSchema.parse({ duration: 4, extra: true })
		).toThrow();
		expect(() =>
			soundtrackRequestSchema.parse({ duration: 4, layers: ["tuba"] })
		).toThrow();
		expect(() =>
			soundtrackRequestSchema.parse({ duration: 4, layers: [] })
		).toThrow();
	});

	test("sections must be ordered, inside the duration and long enough", () => {
		const valid = soundtrackRequestSchema.parse({
			duration: 30,
			mood: "cinematic",
			sections: [
				{ start: 0, end: 10, intensity: 0.2 },
				{ start: 10, end: 30, intensity: 1 },
			],
		});
		expect(valid.sections).toHaveLength(2);
		expect(
			soundtrackSectionIssues(
				[
					{ start: 0, end: 12, intensity: 0.2 },
					{ start: 10, end: 31, intensity: 1 },
					{ start: 31, end: 31.2, intensity: 1 },
				],
				30
			)
		).toEqual([
			"Section 2 overlaps the previous section.",
			"Section 2 ends after the soundtrack.",
			"Section 3 must last at least 0.5 seconds.",
			"Section 3 ends after the soundtrack.",
		]);
		expect(() =>
			soundtrackRequestSchema.parse({
				duration: 10,
				sections: [{ start: 2, end: 11, intensity: 0.5 }],
			})
		).toThrow("ends after the soundtrack");
	});
});

describe("layers and intensity", () => {
	test("layers default to the style band in a stable order", () => {
		expect(soundtrackLayersOf({ mood: "warm" })).toEqual(["pluck"]);
		expect(
			soundtrackLayersOf({ layers: ["snare", "pad", "snare"], mood: "warm" })
		).toEqual(["pad", "snare"]);
		expect(soundtrackLayersOf({ mood: "upbeat" })).toEqual([
			"pad",
			"bass",
			"arpeggio",
			"kick",
			"hat",
			"snare",
		]);
	});

	test("contiguous sections become one step per change, then the default after the last", () => {
		expect(
			soundtrackIntensitySteps([
				{ start: 0, end: 10, intensity: 0.2 },
				{ start: 10, end: 20, intensity: 1 },
				{ start: 20, end: 30, intensity: 0.4 },
			])
		).toEqual([
			[0, 0.2],
			[10, 1],
			[20, 0.4],
			[30, 0.5],
		]);
	});

	test("gaps and a late first section fall back to the default intensity", () => {
		expect(
			soundtrackIntensitySteps([
				{ start: 2, end: 5, intensity: 0.9 },
				{ start: 8, end: 10, intensity: 0.5 },
			])
		).toEqual([
			[0, 0.5],
			[2, 0.9],
			[5, 0.5],
		]);
	});
});

describe("bar phase", () => {
	test("the clock lead puts a bar start on the downbeat offset", () => {
		expect(soundtrackBarSeconds(120)).toBe(2);
		expect(soundtrackClockLead({ bpm: 120 })).toBe(0);
		expect(soundtrackClockLead({ bpm: 120, downbeatOffset: 0 })).toBe(0);
		expect(soundtrackClockLead({ bpm: 120, downbeatOffset: 6 })).toBe(0);
		expect(soundtrackClockLead({ bpm: 120, downbeatOffset: 0.5 })).toBe(1.5);
		expect(soundtrackClockLead({ bpm: 120, downbeatOffset: 4.5 })).toBe(1.5);
		const bar = soundtrackBarSeconds(97.4);
		const lead = soundtrackClockLead({ bpm: 97.4, downbeatOffset: 0.3 });
		// Shifted clock at the offset is a whole number of bars.
		expect(((0.3 + lead) / bar) % 1).toBeCloseTo(0, 9);
	});

	test("downbeatOffset and fractional tempo are optional request fields", () => {
		expect(
			soundtrackRequestSchema.parse({
				bpm: 97.4,
				downbeatOffset: 0.3,
				duration: 10,
				mood: "upbeat",
			})
		).toEqual({ bpm: 97.4, downbeatOffset: 0.3, duration: 10, mood: "upbeat" });
		expect(() =>
			soundtrackRequestSchema.parse({ downbeatOffset: -1, duration: 10 })
		).toThrow();
		expect(soundtrackRequestSchema.parse({ duration: 10 })).not.toHaveProperty(
			"downbeatOffset"
		);
	});
});
