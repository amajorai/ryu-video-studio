/** Lip-sync mouth curve shaping and decimation (see `avatar-lipsync.ts`). */

import {
	envelopeLevelAt,
	type LipSyncEnvelope,
	type LipSyncSourceMap,
	lipSyncSourceTime,
} from "./avatar-lipsync-source.ts";

/** Rig keyframes an avatar may hold (`avatarSchema.rigKeyframes`). */
export const MAX_AVATAR_RIG_KEYFRAMES = 100;
/** Sampling rate of the generated mouth curve, in frames per second. */
export const LIP_SYNC_RATE = 50;
export const LIP_SYNC_FRAME_SECONDS = 1 / LIP_SYNC_RATE;
export const DEFAULT_LIP_SYNC_SENSITIVITY = 0.5;
export const DEFAULT_LIP_SYNC_SMOOTHING = 0.4;
/** Exponent applied to the normalized level so quiet syllables still read. */
export const LIP_SYNC_OPENNESS_EXPONENT = 0.6;
/** Decimation stops once the curve is within this openness of the samples. */
export const LIP_SYNC_TOLERANCE = 0.02;
/** Half-width of a bilabial closure around its estimated time. */
export const LIP_SYNC_CLOSURE_SECONDS = 0.035;
/** Openness kept during a bilabial closure. */
const CLOSURE_FACTOR = 0.08;
/** Openness gain for vowel-heavy words. */
const VOWEL_WIDEN_FACTOR = 1.25;
const VOWEL_WORD_RATIO = 0.5;
/** Reference level percentile among voiced samples. */
const REFERENCE_PERCENTILE = 0.95;
const VOWELS = new Set(["a", "e", "i", "o", "u", "y"]);
const BILABIALS = new Set(["b", "m", "p"]);

export interface LipSyncWord {
	end: number;
	start: number;
	text: string;
}

export interface LipSyncCurveInput {
	avatarDuration: number;
	avatarStart: number;
	envelope: LipSyncEnvelope;
	map: LipSyncSourceMap;
	sensitivity: number;
	smoothing: number;
	/** Transcript words in source time. */
	words?: readonly LipSyncWord[];
}

export interface LipSyncPoint {
	time: number;
	value: number;
}

export interface LipSyncCurve {
	/** Avatar-local sample times (50 Hz, plus the exact end). */
	times: number[];
	/** Mouth openness per sample, 0 (closed) to 1. */
	values: number[];
	/** Share of samples with an open mouth. */
	voicedRatio: number;
}

/** Sample times across the avatar's lifetime, ending exactly at its duration. */
export function lipSyncSampleTimes(duration: number): number[] {
	const times: number[] = [];
	const span = Math.max(0, duration);
	for (let index = 0; ; index += 1) {
		const time = index * LIP_SYNC_FRAME_SECONDS;
		if (time >= span - 0.001) {
			break;
		}
		times.push(time);
	}
	times.push(span);
	return times;
}

/** Gate level for a sensitivity: -30 dBFS at 0 down to -60 dBFS at 1. */
export const lipSyncGate = (sensitivity: number) =>
	10 ** ((-30 - 30 * clamp01(sensitivity)) / 20);

export function clamp01(value: number): number {
	return Math.max(0, Math.min(1, value));
}

function percentile(values: readonly number[], share: number): number {
	if (!values.length) {
		return 0;
	}
	const sorted = [...values].sort((a, b) => a - b);
	const index = Math.min(
		sorted.length - 1,
		Math.max(0, Math.round((sorted.length - 1) * share))
	);
	return sorted[index] ?? 0;
}

/** Zero-phase one-pole smoothing: forward then backward, so peaks never lag. */
export function smoothOpenness(
	values: readonly number[],
	smoothing: number
): number[] {
	const alpha = 1 - 0.9 * clamp01(smoothing);
	if (alpha >= 1 || values.length < 2) {
		return [...values];
	}
	const forward = [...values];
	for (let index = 1; index < forward.length; index += 1) {
		const previous = forward[index - 1] ?? 0;
		forward[index] = previous + alpha * ((forward[index] ?? 0) - previous);
	}
	for (let index = forward.length - 2; index >= 0; index -= 1) {
		const next = forward[index + 1] ?? 0;
		forward[index] = next + alpha * ((forward[index] ?? 0) - next);
	}
	return forward;
}

interface WordShape {
	closures: number[];
	end: number;
	start: number;
	widen: number;
}

/** Vowel widening and bilabial closure times (source time) for one word. */
export function wordShape(word: LipSyncWord): WordShape | undefined {
	const letters = word.text
		.toLowerCase()
		.normalize("NFD")
		.replace(/[^a-z]/g, "");
	const duration = word.end - word.start;
	if (!letters || duration <= 0) {
		return undefined;
	}
	let vowels = 0;
	const closures: number[] = [];
	for (let index = 0; index < letters.length; index += 1) {
		const letter = letters[index] ?? "";
		if (VOWELS.has(letter)) {
			vowels += 1;
		}
		// Doubled bilabials ("pp", "mb") are one closure.
		if (BILABIALS.has(letter) && !BILABIALS.has(letters[index - 1] ?? "")) {
			closures.push(word.start + ((index + 0.5) / letters.length) * duration);
		}
	}
	return {
		closures,
		end: word.end,
		start: word.start,
		widen: vowels / letters.length >= VOWEL_WORD_RATIO ? VOWEL_WIDEN_FACTOR : 1,
	};
}

/** Index of the last word starting at or before `time` (words sorted by start). */
function wordIndexAt(shapes: readonly WordShape[], time: number): number {
	let low = 0;
	let high = shapes.length - 1;
	let found = -1;
	while (low <= high) {
		const middle = (low + high) >> 1;
		if ((shapes[middle]?.start ?? 0) <= time) {
			found = middle;
			low = middle + 1;
		} else {
			high = middle - 1;
		}
	}
	return found;
}

function wordFactor(shapes: readonly WordShape[], time: number): number {
	const index = wordIndexAt(shapes, time);
	const shape = shapes[index];
	if (!shape || time >= shape.end) {
		return 1;
	}
	for (const closure of shape.closures) {
		if (Math.abs(time - closure) <= LIP_SYNC_CLOSURE_SECONDS) {
			return CLOSURE_FACTOR;
		}
	}
	return shape.widen;
}

/** The sampled mouth-openness curve for an avatar. */
export function lipSyncCurve(input: LipSyncCurveInput): LipSyncCurve {
	const times = lipSyncSampleTimes(input.avatarDuration);
	const sourceTimes = times.map((time) =>
		lipSyncSourceTime(input.map, input.avatarStart, time)
	);
	const gate = lipSyncGate(input.sensitivity);
	const levels = sourceTimes.map((sourceTime) => {
		if (sourceTime === undefined) {
			return 0;
		}
		const level = envelopeLevelAt(input.envelope, sourceTime);
		return level > gate ? level : 0;
	});
	const voiced = levels.filter((level) => level > 0);
	const reference = percentile(voiced, REFERENCE_PERCENTILE);
	// Higher sensitivity lets quieter syllables reach full openness.
	const gain = 0.7 + 0.6 * clamp01(input.sensitivity);
	const shaped = levels.map((level) => {
		if (!(level > 0 && reference > gate)) {
			return 0;
		}
		const normalized = clamp01(((level - gate) / (reference - gate)) * gain);
		return normalized ** LIP_SYNC_OPENNESS_EXPONENT;
	});
	const smoothed = smoothOpenness(shaped, input.smoothing);
	const shapes = (input.words ?? [])
		.map(wordShape)
		.filter((shape): shape is WordShape => shape !== undefined)
		.sort((a, b) => a.start - b.start);
	const values = smoothed.map((value, index) => {
		const sourceTime = sourceTimes[index];
		const factor =
			sourceTime === undefined || !shapes.length
				? 1
				: wordFactor(shapes, sourceTime);
		const result = clamp01(value * factor);
		return result < 0.005 ? 0 : Math.round(result * 1000) / 1000;
	});
	const open = values.filter((value) => value > 0).length;
	return {
		times,
		values,
		voicedRatio: values.length ? open / values.length : 0,
	};
}

interface Span {
	error: number;
	errorIndex: number;
	from: number;
	to: number;
}

function spanError(
	times: readonly number[],
	values: readonly number[],
	from: number,
	to: number
): Span {
	const t0 = times[from] ?? 0;
	const t1 = times[to] ?? 0;
	const v0 = values[from] ?? 0;
	const v1 = values[to] ?? 0;
	let error = 0;
	let errorIndex = -1;
	for (let index = from + 1; index < to; index += 1) {
		const progress = t1 > t0 ? ((times[index] ?? 0) - t0) / (t1 - t0) : 0;
		const deviation = Math.abs(
			(values[index] ?? 0) - (v0 + (v1 - v0) * progress)
		);
		if (deviation > error) {
			error = deviation;
			errorIndex = index;
		}
	}
	return { error, errorIndex, from, to };
}

/**
 * Keep at most `budget` points (endpoints always kept) by repeatedly adding
 * the sample farthest from the current piecewise-linear curve, which is how
 * the rig interpolates. Stops early once every sample is within `tolerance`.
 */
export function decimateLipSync(
	times: readonly number[],
	values: readonly number[],
	budget: number,
	tolerance = LIP_SYNC_TOLERANCE
): LipSyncPoint[] {
	const count = Math.min(times.length, values.length);
	if (count === 0 || budget < 1) {
		return [];
	}
	const point = (index: number): LipSyncPoint => ({
		time: times[index] ?? 0,
		value: values[index] ?? 0,
	});
	if (count === 1 || budget === 1) {
		return [point(0)];
	}
	const kept = new Set<number>([0, count - 1]);
	const spans: Span[] = [spanError(times, values, 0, count - 1)];
	while (kept.size < budget) {
		let worst = 0;
		for (let index = 1; index < spans.length; index += 1) {
			if ((spans[index]?.error ?? 0) > (spans[worst]?.error ?? 0)) {
				worst = index;
			}
		}
		const span = spans[worst];
		if (!span || span.errorIndex < 0 || span.error <= tolerance) {
			break;
		}
		kept.add(span.errorIndex);
		spans.splice(
			worst,
			1,
			spanError(times, values, span.from, span.errorIndex),
			spanError(times, values, span.errorIndex, span.to)
		);
	}
	return [...kept].sort((a, b) => a - b).map(point);
}
