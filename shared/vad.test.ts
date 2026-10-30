import { describe, expect, test } from "bun:test";
import type { Segment, TrackSetting } from "./project.ts";
import {
	audibleSegments,
	classifySpeech,
	DEFAULT_VAD_PARAMS,
	intersectRanges,
	noiseFloorDb,
	resolveVadParams,
	sourceSpansToTimeline,
	subtractRanges,
	unionRanges,
	VAD_FRAME_SAMPLES,
	VAD_MIN_DB,
	VAD_SAMPLE_RATE,
	VadFeatureAccumulator,
	vadFeatures,
	vadParamsSchema,
	vadSilence,
	vadSilenceQuery,
	vadSpeech,
} from "./vad.ts";

/** Deterministic uniform noise in -1..1 (LCG). */
function noise(seed: number) {
	let state = seed >>> 0;
	return () => {
		state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
		return (state / 4_294_967_296) * 2 - 1;
	};
}

/**
 * Speech-like bursts (a 140 Hz voiced harmonic stack with 4 Hz syllable
 * modulation) separated by the given pauses, over -50 dBFS noise.
 */
function speechFixture(
	layout: readonly { pause?: number; speech?: number }[],
	options: { noiseLevel?: number; seed?: number } = {}
) {
	const samples: number[] = [];
	const random = noise(options.seed ?? 7);
	const noiseLevel = options.noiseLevel ?? 0.003;
	const pauses: [number, number][] = [];
	for (const part of layout) {
		const seconds = part.speech ?? part.pause ?? 0;
		const count = Math.round(seconds * VAD_SAMPLE_RATE);
		const offset = samples.length / VAD_SAMPLE_RATE;
		if (part.pause !== undefined) {
			pauses.push([offset, offset + seconds]);
		}
		for (let index = 0; index < count; index += 1) {
			const time = index / VAD_SAMPLE_RATE;
			let value = 0;
			if (part.speech !== undefined) {
				const syllable = 0.55 + 0.45 * Math.sin(2 * Math.PI * 4 * time);
				for (let harmonic = 1; harmonic <= 6; harmonic += 1) {
					value +=
						Math.sin(2 * Math.PI * 140 * harmonic * time) / (harmonic * 2.5);
				}
				value *= 0.4 * syllable;
			}
			samples.push(value + random() * noiseLevel);
		}
	}
	return { duration: samples.length / VAD_SAMPLE_RATE, pauses, samples };
}

const threePauses = () =>
	speechFixture([
		{ speech: 1.2 },
		{ pause: 0.5 },
		{ speech: 0.9 },
		{ pause: 0.8 },
		{ speech: 1.5 },
		{ pause: 1.2 },
		{ speech: 0.7 },
	]);

describe("frame features", () => {
	test("frames are 20 ms with clamped energy and a zero-crossing rate", () => {
		const silent = vadFeatures(new Array(VAD_FRAME_SAMPLES * 3).fill(0));
		expect(silent.energyDb.length).toBe(3);
		expect([...silent.energyDb]).toEqual([VAD_MIN_DB, VAD_MIN_DB, VAD_MIN_DB]);
		const square = vadFeatures(
			Array.from({ length: VAD_FRAME_SAMPLES }, (_, index) =>
				index % 2 === 0 ? 0.5 : -0.5
			)
		);
		expect(square.energyDb[0]).toBeCloseTo(20 * Math.log10(0.5), 3);
		expect(square.zcr[0]).toBeCloseTo(
			(VAD_FRAME_SAMPLES - 1) / VAD_FRAME_SAMPLES
		);
		expect(square.duration).toBeCloseTo(0.02, 6);
	});

	test("byte input matches sample input, even when a sample spans chunks", () => {
		const { samples } = speechFixture([{ speech: 0.3 }, { pause: 0.2 }]);
		const pcm = new Uint8Array(samples.length * 2);
		const view = new DataView(pcm.buffer);
		for (const [index, sample] of samples.entries()) {
			view.setInt16(index * 2, Math.round(sample * 32_767), true);
		}
		const bytes = new VadFeatureAccumulator();
		bytes.pushBytes(pcm.subarray(0, 1001));
		bytes.pushBytes(pcm.subarray(1001, 1002));
		bytes.pushBytes(pcm.subarray(1002));
		const fromBytes = bytes.finish();
		const fromSamples = vadFeatures(samples);
		expect(fromBytes.energyDb.length).toBe(fromSamples.energyDb.length);
		for (const [index, energy] of fromSamples.energyDb.entries()) {
			expect(fromBytes.energyDb[index]).toBeCloseTo(energy, 1);
		}
	});

	test("the noise floor is the 10th percentile of frame energy", () => {
		const energy = Array.from({ length: 101 }, (_, index) => -index);
		expect(noiseFloorDb(energy)).toBe(-90);
		expect(noiseFloorDb([])).toBe(VAD_MIN_DB);
	});
});

describe("speech classification", () => {
	test("three known pauses yield three spans within 50 ms", () => {
		const fixture = threePauses();
		const result = vadSilence(vadFeatures(fixture.samples), { padding: 0 });
		expect(result.ranges).toHaveLength(3);
		for (const [index, [start, end]] of fixture.pauses.entries()) {
			const span = result.ranges[index];
			expect(Math.abs((span?.[0] ?? 0) - start)).toBeLessThanOrEqual(0.05);
			expect(Math.abs((span?.[1] ?? 0) - end)).toBeLessThanOrEqual(0.05);
		}
		expect(result.noiseFloorDb).toBeLessThan(-40);
	});

	test("padding keeps a margin next to speech on both sides", () => {
		const fixture = threePauses();
		const features = vadFeatures(fixture.samples);
		const bare = vadSilence(features, { padding: 0 }).ranges;
		const padded = vadSilence(features, { padding: 0.1 }).ranges;
		expect(padded).toHaveLength(3);
		for (const [index, [start, end]] of bare.entries()) {
			expect(padded[index]?.[0]).toBeCloseTo(start + 0.1, 3);
			expect(padded[index]?.[1]).toBeCloseTo(end - 0.1, 3);
		}
	});

	test("minPause drops shorter pauses and keeps speech continuous", () => {
		const features = vadFeatures(threePauses().samples);
		expect(
			vadSilence(features, { minPause: 0.6, padding: 0 }).ranges
		).toHaveLength(2);
		expect(
			vadSilence(features, { minPause: 1, padding: 0 }).ranges
		).toHaveLength(1);
		expect(vadSpeech(features, { minPause: 1 })).toHaveLength(2);
		expect(vadSpeech(features, { minPause: 0.3 })).toHaveLength(4);
	});

	test("leading and trailing silence is reported without padding at file edges", () => {
		const fixture = speechFixture([
			{ pause: 0.6 },
			{ speech: 1 },
			{ pause: 0.7 },
		]);
		const ranges = vadSilence(vadFeatures(fixture.samples), {
			padding: 0.1,
		}).ranges;
		expect(ranges).toHaveLength(2);
		expect(ranges[0]?.[0]).toBe(0);
		expect(ranges[1]?.[1]).toBeCloseTo(fixture.duration, 2);
	});

	test("short clicks inside a pause are not speech", () => {
		const fixture = speechFixture([
			{ speech: 1 },
			{ pause: 0.5 },
			{ speech: 0.04 },
			{ pause: 0.5 },
			{ speech: 1 },
		]);
		const features = vadFeatures(fixture.samples);
		const ranges = vadSilence(features, { padding: 0 }).ranges;
		expect(ranges).toHaveLength(1);
		expect((ranges[0]?.[1] ?? 0) - (ranges[0]?.[0] ?? 0)).toBeGreaterThan(0.95);
		expect(
			vadSilence(features, { minSpeech: 0, padding: 0 }).ranges
		).toHaveLength(2);
	});

	test("a higher threshold ignores quiet speech-like bursts", () => {
		const loud = speechFixture([{ speech: 1 }, { pause: 0.5 }]).samples;
		const quiet = speechFixture([{ speech: 1 }, { pause: 0.5 }], {
			seed: 3,
		}).samples.map((sample) => sample * 0.02);
		const features = vadFeatures([...loud, ...quiet.map((sample) => sample)]);
		const low = classifySpeech(features, { threshold: 6 }).speech;
		const high = classifySpeech(features, { threshold: 40 }).speech;
		const speechSeconds = (flags: Uint8Array) =>
			flags.reduce((total, flag) => total + flag, 0) * 0.02;
		expect(speechSeconds(low)).toBeGreaterThan(speechSeconds(high));
	});

	test("classification is deterministic", () => {
		const features = vadFeatures(threePauses().samples);
		expect(vadSilence(features)).toEqual(vadSilence(features));
	});
});

describe("params and ranges", () => {
	test("params are optional, bounded, and resolved by accessor", () => {
		expect(resolveVadParams()).toEqual({ ...DEFAULT_VAD_PARAMS });
		expect(resolveVadParams({ threshold: 20 }).threshold).toBe(20);
		expect(vadParamsSchema.safeParse({ threshold: 0 }).success).toBe(false);
		expect(vadParamsSchema.safeParse({ extra: 1 }).success).toBe(false);
		expect(vadSilenceQuery({ padding: 0 })).toBe(
			"method=vad&threshold=10&minPause=0.3&padding=0&minSpeech=0.1"
		);
	});

	test("source spans map through the clip's source range and speed", () => {
		const clip = { sourceIn: 2, sourceOut: 8, speed: 2, start: 10 };
		expect(
			sourceSpansToTimeline(clip, [
				[0, 1],
				[1, 3],
				[4, 5],
				[7, 9],
			])
		).toEqual([
			{ end: 10.5, start: 10 },
			{ end: 11.5, start: 11 },
			{ end: 13, start: 12.5 },
		]);
		expect(sourceSpansToTimeline({ ...clip, speed: 0 }, [[2, 3]])).toEqual([]);
	});

	test("union, subtraction, and intersection", () => {
		const a = [
			{ end: 3, start: 1 },
			{ end: 2.5, start: 2 },
			{ end: 8, start: 5 },
		];
		expect(unionRanges(a)).toEqual([
			{ end: 3, start: 1 },
			{ end: 8, start: 5 },
		]);
		expect(subtractRanges(a, [{ end: 6, start: 2 }])).toEqual([
			{ end: 2, start: 1 },
			{ end: 8, start: 6 },
		]);
		expect(
			intersectRanges(a, [
				{ end: 1.5, start: 0 },
				{ end: 7, start: 2.8 },
			])
		).toEqual([
			{ end: 1.5, start: 1 },
			{ end: 3, start: 2.8 },
			{ end: 7, start: 5 },
		]);
	});
});

describe("audible segments", () => {
	const clip = (id: string, track: number, extra: Partial<Segment> = {}) =>
		({
			id,
			keyframes: [],
			muted: false,
			speed: 1,
			track,
			volume: 1,
			...extra,
		}) as Segment;
	const setting = (track: number, extra: Partial<TrackSetting>) =>
		({
			locked: false,
			muted: false,
			name: "Track",
			solo: false,
			track,
			...extra,
		}) as TrackSetting;
	const ids = (segments: Segment[]) => segments.map((segment) => segment.id);

	test("drop muted clips, silent clips, muted tracks and solo-silenced tracks", () => {
		const segments = [
			clip("a", 0),
			clip("b", 1),
			clip("c", 0, { muted: true }),
			clip("d", 2, { volume: 0 }),
		];
		expect(ids(audibleSegments({ segments, trackSettings: [] }))).toEqual([
			"a",
			"b",
		]);
		expect(
			ids(
				audibleSegments({
					segments,
					trackSettings: [setting(1, { muted: true })],
				})
			)
		).toEqual(["a"]);
		expect(
			ids(
				audibleSegments({
					segments,
					trackSettings: [setting(1, { solo: true })],
				})
			)
		).toEqual(["b"]);
	});

	test("drop hidden clips, hidden tracks and high-speed-muted clips, as the export does", () => {
		const segments = [
			clip("a", 0),
			clip("hidden", 0, { hidden: true }),
			clip("on-hidden-track", 1),
			clip("fast", 0, { speed: 20 }),
			clip("fast-kept", 0, { muted: false, speed: 20 }),
		];
		expect(
			ids(
				audibleSegments({
					segments: segments.map((segment) =>
						segment.id === "fast" ? { ...segment, muted: undefined } : segment
					) as Segment[],
					trackSettings: [setting(1, { hidden: true })],
				})
			)
		).toEqual(["a", "fast-kept"]);
	});
});
