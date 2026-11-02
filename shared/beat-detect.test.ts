import { describe, expect, test } from "bun:test";
import {
	BEAT_MAX_SECONDS,
	BEAT_SAMPLE_RATE,
	beatAnalysisSchema,
	beatDetectionWindow,
	beatsCover,
	detectBeats,
	downbeatPhase,
	estimateTempo,
	onsetEnvelope,
	trackBeats,
} from "./beat-detect.ts";

/** Deterministic noise so tests never depend on Math.random. */
function noise(seed: number) {
	let state = seed >>> 0;
	return () => {
		state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
		return state / 2 ** 32 - 0.5;
	};
}

interface ClickTrack {
	/** Index of the first accented (downbeat) click. */
	accentPhase?: number;
	bpm: number;
	/** Silence before the first click, in seconds. */
	lead?: number;
	seconds: number;
}

/** Hi-hat-like clicks on every beat, plus a low kick on every fourth one. */
function clickTrack({ accentPhase = 0, bpm, lead = 0.5, seconds }: ClickTrack) {
	const rate = BEAT_SAMPLE_RATE;
	const samples = new Float32Array(Math.round(seconds * rate));
	const random = noise(bpm * 7919);
	const period = 60 / bpm;
	const onsets: number[] = [];
	for (let beat = 0; lead + beat * period < seconds - 0.2; beat++) {
		const at = lead + beat * period;
		onsets.push(at);
		const first = Math.round(at * rate);
		const accented = beat % 4 === accentPhase;
		for (let offset = 0; offset < rate * 0.4; offset++) {
			const index = first + offset;
			if (index >= samples.length) {
				break;
			}
			const elapsed = offset / rate;
			let value =
				0.4 *
				Math.exp(-elapsed / 0.012) *
				(random() + Math.sin(2 * Math.PI * 2500 * elapsed));
			if (accented) {
				value +=
					0.8 *
					Math.exp(-elapsed / 0.05) *
					Math.sin(2 * Math.PI * 60 * elapsed);
			}
			samples[index] = (samples[index] ?? 0) + value;
		}
	}
	return { onsets, samples };
}

describe("beat detection on synthetic click tracks", () => {
	for (const [bpm, lead] of [
		[90, 0.5],
		[120, 0.5],
		[150, 0.5],
		[165, 0.5],
		[170, 0.5],
		[170, 7.3],
		[180, 0.5],
	] as const) {
		test(`recovers ${bpm} BPM (lead ${lead} s) within 1 BPM and aligns beats`, () => {
			const { onsets, samples } = clickTrack({ bpm, lead, seconds: 24 });
			const result = detectBeats(samples);
			expect(result).not.toBeNull();
			if (!result) {
				return;
			}
			expect(Math.abs(result.bpm - bpm)).toBeLessThanOrEqual(1);
			expect(result.confidence).toBeGreaterThan(0.2);
			expect(result.beats.length).toBeGreaterThanOrEqual(onsets.length - 2);
			for (const beat of result.beats) {
				const nearest = Math.min(
					...onsets.map((onset) => Math.abs(onset - beat))
				);
				expect(nearest).toBeLessThan(0.035);
			}
			expect(beatAnalysisSchema.parse(result)).toEqual(result);
		});
	}

	for (const [accentPhase, bpm] of [
		[0, 120],
		[1, 120],
		[2, 120],
		[3, 120],
		[1, 175],
		[3, 180],
	] as const) {
		test(`downbeats follow the accented beat (phase ${accentPhase}, ${bpm} BPM)`, () => {
			const { onsets, samples } = clickTrack({
				accentPhase,
				bpm,
				seconds: 20,
			});
			const result = detectBeats(samples);
			expect(result).not.toBeNull();
			if (!result) {
				return;
			}
			const accented = onsets.filter((_, index) => index % 4 === accentPhase);
			expect(result.downbeats.length).toBeGreaterThanOrEqual(
				accented.length - 1
			);
			for (const downbeat of result.downbeats) {
				const nearest = Math.min(
					...accented.map((onset) => Math.abs(onset - downbeat))
				);
				expect(nearest).toBeLessThan(0.035);
			}
		});
	}

	test("keeps the slow tempo of an eighth-note groove (not double time)", () => {
		const rate = BEAT_SAMPLE_RATE;
		const samples = new Float32Array(rate * 24);
		const random = noise(85);
		const period = 60 / 85;
		const hit = (at: number, hat: number, kick: boolean, snare: boolean) => {
			const first = Math.round(at * rate);
			for (let offset = 0; offset < rate * 0.3; offset++) {
				const index = first + offset;
				if (index >= samples.length) {
					break;
				}
				const elapsed = offset / rate;
				let value =
					hat *
					Math.exp(-elapsed / 0.012) *
					(random() + Math.sin(2 * Math.PI * 2500 * elapsed));
				if (kick) {
					value +=
						0.8 *
						Math.exp(-elapsed / 0.05) *
						Math.sin(2 * Math.PI * 60 * elapsed);
				}
				if (snare) {
					value +=
						0.5 *
						Math.exp(-elapsed / 0.03) *
						(random() + Math.sin(2 * Math.PI * 200 * elapsed));
				}
				samples[index] = (samples[index] ?? 0) + value;
			}
		};
		for (let beat = 0; 0.5 + beat * period < 23.5; beat++) {
			const at = 0.5 + beat * period;
			hit(at, 0.4, beat % 2 === 0, beat % 2 === 1);
			hit(at + period / 2, 0.25, false, false);
		}
		const result = detectBeats(samples);
		expect(result && Math.abs(result.bpm - 85)).toBeLessThanOrEqual(1);
	});

	test("tracks clicks over a noise bed and a sustained chord", () => {
		const { samples } = clickTrack({ bpm: 128, seconds: 20 });
		const random = noise(42);
		for (let index = 0; index < samples.length; index++) {
			const seconds = index / BEAT_SAMPLE_RATE;
			samples[index] =
				(samples[index] ?? 0) +
				0.04 * random() +
				0.1 * Math.sin(2 * Math.PI * 220 * seconds) +
				0.08 * Math.sin(2 * Math.PI * 277.18 * seconds);
		}
		const result = detectBeats(samples);
		expect(result && Math.abs(result.bpm - 128)).toBeLessThanOrEqual(1);
	});

	test("is deterministic", () => {
		const { samples } = clickTrack({ bpm: 128, seconds: 12 });
		expect(detectBeats(samples)).toEqual(detectBeats(samples));
	});

	test("returns null for silence, steady tone and too-short audio", () => {
		expect(detectBeats(new Float32Array(BEAT_SAMPLE_RATE * 8))).toBeNull();
		const tone = new Float32Array(BEAT_SAMPLE_RATE * 8).map((_, index) =>
			Math.sin((2 * Math.PI * 440 * index) / BEAT_SAMPLE_RATE)
		);
		expect(detectBeats(tone)).toBeNull();
		expect(detectBeats(new Float32Array(500))).toBeNull();
	});

	test("ignores non-finite samples", () => {
		const { samples } = clickTrack({ bpm: 120, seconds: 12 });
		samples[1000] = Number.NaN;
		samples[2000] = Number.POSITIVE_INFINITY;
		const result = detectBeats(samples);
		expect(result && Math.abs(result.bpm - 120)).toBeLessThanOrEqual(1);
	});
});

describe("beat detection building blocks", () => {
	test("onset envelope runs at about 100 frames per second", () => {
		const envelope = onsetEnvelope(new Float32Array(BEAT_SAMPLE_RATE * 2));
		expect(envelope.frameRate).toBeCloseTo(100.227, 2);
		expect(envelope.envelope.length).toBe(
			Math.floor((BEAT_SAMPLE_RATE * 2 - 1024) / 110) + 1
		);
	});

	test("tempo prior prefers 120 over its 60 BPM sub-harmonic", () => {
		const frameRate = 100;
		const envelope = new Float64Array(3000);
		for (let index = 0; index < envelope.length; index += 50) {
			envelope[index] = 1;
		}
		const tempo = estimateTempo(envelope, frameRate);
		expect(tempo?.bpm).toBeCloseTo(120, 0);
	});

	test("beat tracker follows an impulse train and trims silent edges", () => {
		const envelope = new Float64Array(1200);
		for (let index = 200; index < 1000; index += 40) {
			envelope[index] = 1;
		}
		const beats = trackBeats(envelope, 40);
		expect(beats[0]).toBe(200);
		expect(beats.at(-1)).toBe(960);
		expect(beats.every((beat) => beat % 40 === 0)).toBe(true);
		expect(trackBeats(envelope, 0)).toEqual([]);
	});

	test("downbeat phase picks the strongest accent phase", () => {
		expect(downbeatPhase([0.1, 0.2, 1, 0.1, 0.1, 0.2, 0.9, 0.1])).toBe(2);
		expect(downbeatPhase([])).toBe(0);
		expect(downbeatPhase([1, 1, 1, 1])).toBe(0);
	});
});

/** The verify fixture's kick loop: one kick per beat, doubled on bar starts. */
function accentedKickLoop(bpm: number, seconds: number) {
	const rate = BEAT_SAMPLE_RATE;
	const samples = new Float32Array(Math.round(seconds * rate));
	const beat = 60 / bpm;
	for (let index = 0; index < samples.length; index++) {
		const t = index / rate;
		const phase = t % beat;
		const gain = t % (4 * beat) < beat ? 2 : 1;
		samples[index] =
			gain *
			(0.45 * Math.exp(-30 * phase) * Math.sin(2 * Math.PI * 60 * phase) +
				0.25 * Math.exp(-200 * phase) * Math.sin(2 * Math.PI * 2000 * t));
	}
	return samples;
}

describe("bar-accented kick loops", () => {
	for (const bpm of [120, 165, 175, 180]) {
		test(`a bar accent does not halve ${bpm} BPM`, () => {
			const result = detectBeats(accentedKickLoop(bpm, 24));
			expect(result).not.toBeNull();
			expect(Math.abs((result?.bpm ?? 0) - bpm)).toBeLessThanOrEqual(1);
			const bar = (4 * 60) / bpm;
			for (const downbeat of result?.downbeats ?? []) {
				const offset = Math.abs(downbeat / bar - Math.round(downbeat / bar));
				expect(offset * bar).toBeLessThan(0.035);
			}
		});
	}
});

describe("detection windows", () => {
	test("shifts detected times by the window start", () => {
		const { onsets, samples } = clickTrack({ bpm: 120, seconds: 20 });
		const result = detectBeats(samples, BEAT_SAMPLE_RATE, 700);
		expect(result?.analyzedFrom).toBe(700);
		const first = result?.beats[0] ?? 0;
		expect(Math.abs(first - (700 + (onsets[0] ?? 0)))).toBeLessThan(0.035);
		expect(detectBeats(samples)?.analyzedFrom).toBeUndefined();
	});

	test("chooses a window that covers the requested span", () => {
		expect(beatDetectionWindow(300)).toEqual({ seconds: 300, start: 0 });
		expect(beatDetectionWindow(1500)).toEqual({
			seconds: BEAT_MAX_SECONDS,
			start: 0,
		});
		// A late span pulls the window back for context, never past the end.
		expect(beatDetectionWindow(800, 700, 760)).toEqual({
			seconds: 600,
			start: 200,
		});
		expect(beatDetectionWindow(1500, 700, 760)).toEqual({
			seconds: 600,
			start: 700,
		});
		// A span longer than the limit is covered from its start only.
		expect(beatDetectionWindow(2000, 100, 1000)).toEqual({
			seconds: 600,
			start: 100,
		});
	});

	test("reports coverage of a span", () => {
		const window = { analyzedDuration: 600, analyzedFrom: 200 };
		expect(beatsCover(window, 700, 760, 800)).toBe(true);
		expect(beatsCover(window, 100, 160, 800)).toBe(false);
		expect(beatsCover(window, 700, 820, 1500)).toBe(false);
		// Reaching the source end covers spans to the end.
		expect(beatsCover({ analyzedDuration: 799.8 }, 700, 800, 800)).toBe(true);
		// Audio that ended inside the window covers the rest of the source.
		expect(beatsCover({ analyzedDuration: 12 }, 0, 20, 20)).toBe(true);
		expect(beatsCover({ analyzedDuration: 600 }, 0, 700, 1500)).toBe(false);
	});
});
