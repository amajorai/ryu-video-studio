/**
 * Voice activity detection (VAD) over band-limited mono PCM.
 *
 * The sidecar extracts 16 kHz mono audio through a speech band-pass, feeds the
 * samples to `VadFeatureAccumulator`, and caches the per-frame features. Every
 * parameter change then reruns only the cheap, deterministic classifier here,
 * so the Cleanup panel can show a live count while sliders move.
 */
import { z } from "zod";
import type { Project, Segment } from "./project.ts";
import { clipHeard } from "./sync-lock.ts";

export const VAD_SAMPLE_RATE = 16_000;
/** 20 ms analysis frames. */
export const VAD_FRAME_SAMPLES = 320;
export const VAD_FRAME_SECONDS = VAD_FRAME_SAMPLES / VAD_SAMPLE_RATE;
/** Energy reported for digital silence, so the floor never reaches -Infinity. */
export const VAD_MIN_DB = -100;
/** Upper bound on reported non-speech spans per asset. */
export const MAX_VAD_SPANS = 2000;

/** Percentile of frame energy taken as the adaptive noise floor. */
const NOISE_FLOOR_PERCENTILE = 0.1;
/** Speech continues while energy stays above this share of the threshold. */
const RELEASE_RATIO = 0.6;
/** Unvoiced consonants: quiet frames with a high zero-crossing rate. */
const UNVOICED_ZCR = 0.25;
const UNVOICED_MIN_DB_ABOVE_FLOOR = 3;
const UNVOICED_MAX_EXTENSION_SECONDS = 0.15;
/** Hiss-like frames need this much extra energy to start speech. */
const NOISY_ZCR = 0.5;
const NOISY_ONSET_EXTRA_DB = 6;
const EPSILON = 1e-9;

export const DEFAULT_VAD_PARAMS = {
	minPause: 0.3,
	minSpeech: 0.1,
	padding: 0.05,
	threshold: 10,
} as const;

/** Classifier settings; every field is optional and resolved by `resolveVadParams`. */
export const vadParamsSchema = z
	.object({
		/** Shortest non-speech run, in seconds, reported as a pause. */
		minPause: z.number().finite().min(0.05).max(10).optional(),
		/** Shortest speech run, in seconds; shorter blips (clicks, breaths) count as silence. */
		minSpeech: z.number().finite().min(0).max(2).optional(),
		/** Seconds of each pause kept next to speech so words are never clipped. */
		padding: z.number().finite().min(0).max(0.5).optional(),
		/** Decibels above the adaptive noise floor that start speech. */
		threshold: z.number().finite().min(1).max(40).optional(),
	})
	.strict();

export type VadParams = z.infer<typeof vadParamsSchema>;
export type ResolvedVadParams = Required<VadParams>;

export function resolveVadParams(params: VadParams = {}): ResolvedVadParams {
	return {
		minPause: params.minPause ?? DEFAULT_VAD_PARAMS.minPause,
		minSpeech: params.minSpeech ?? DEFAULT_VAD_PARAMS.minSpeech,
		padding: params.padding ?? DEFAULT_VAD_PARAMS.padding,
		threshold: params.threshold ?? DEFAULT_VAD_PARAMS.threshold,
	};
}

/** Per-frame features of one source's band-limited audio. */
export interface VadFeatures {
	/** Source seconds covered by the samples. */
	duration: number;
	/** Frame RMS in dBFS, clamped at `VAD_MIN_DB`. */
	energyDb: Float32Array;
	frameSeconds: number;
	/** Zero crossings per sample in each frame, 0..1. */
	zcr: Float32Array;
}

export interface VadResult {
	noiseFloorDb: number;
	/** Non-speech source intervals `[start, end]` in seconds, in time order. */
	ranges: [number, number][];
}

/** A clip's mapping from source seconds to timeline seconds. */
export interface SourceMapping {
	sourceIn: number;
	sourceOut: number;
	speed: number;
	start: number;
}

export interface TimeRange {
	end: number;
	start: number;
}

const round = (value: number) => Math.round(value * 1000) / 1000;

function frameDb(sumSquares: number, count: number) {
	if (count === 0 || sumSquares <= 0) {
		return VAD_MIN_DB;
	}
	return Math.max(VAD_MIN_DB, 10 * Math.log10(sumSquares / count));
}

/**
 * Streams little-endian signed 16-bit mono PCM into 20 ms frame features.
 * Chunks may split a sample across boundaries; the odd byte is carried over.
 */
export class VadFeatureAccumulator {
	private carry: number | null = null;
	private readonly energy: number[] = [];
	private readonly crossings: number[] = [];
	private frameCount = 0;
	private frameSum = 0;
	private frameCrossings = 0;
	private previousSign = 0;
	private samples = 0;

	/** Add PCM bytes (s16le). */
	pushBytes(bytes: Uint8Array) {
		let index = 0;
		if (this.carry !== null && bytes.length > 0) {
			this.pushSample(toInt16(this.carry | ((bytes[0] ?? 0) << 8)) / 32_768);
			this.carry = null;
			index = 1;
		}
		for (; index + 1 < bytes.length; index += 2) {
			const low = bytes[index] ?? 0;
			const high = bytes[index + 1] ?? 0;
			this.pushSample(toInt16(low | (high << 8)) / 32_768);
		}
		if (index < bytes.length) {
			this.carry = bytes[index] ?? 0;
		}
	}

	/** Add normalized samples in -1..1. */
	pushSamples(samples: ArrayLike<number>) {
		for (let index = 0; index < samples.length; index += 1) {
			this.pushSample(samples[index] ?? 0);
		}
	}

	finish(): VadFeatures {
		if (this.frameCount > 0) {
			this.closeFrame();
		}
		return {
			duration: this.samples / VAD_SAMPLE_RATE,
			energyDb: Float32Array.from(this.energy),
			frameSeconds: VAD_FRAME_SECONDS,
			zcr: Float32Array.from(this.crossings),
		};
	}

	private pushSample(sample: number) {
		const value = Number.isFinite(sample) ? sample : 0;
		this.frameSum += value * value;
		const sign = Math.sign(value);
		if (sign !== 0) {
			if (this.previousSign !== 0 && sign !== this.previousSign) {
				this.frameCrossings += 1;
			}
			this.previousSign = sign;
		}
		this.frameCount += 1;
		this.samples += 1;
		if (this.frameCount === VAD_FRAME_SAMPLES) {
			this.closeFrame();
		}
	}

	private closeFrame() {
		this.energy.push(frameDb(this.frameSum, this.frameCount));
		this.crossings.push(this.frameCrossings / this.frameCount);
		this.frameCount = 0;
		this.frameSum = 0;
		this.frameCrossings = 0;
	}
}

function toInt16(value: number) {
	return value >= 32_768 ? value - 65_536 : value;
}

/** Frame features of normalized mono samples at `VAD_SAMPLE_RATE`. */
export function vadFeatures(samples: ArrayLike<number>): VadFeatures {
	const accumulator = new VadFeatureAccumulator();
	accumulator.pushSamples(samples);
	return accumulator.finish();
}

/** Adaptive noise floor: the 10th percentile of frame energy. */
export function noiseFloorDb(energyDb: ArrayLike<number>): number {
	if (energyDb.length === 0) {
		return VAD_MIN_DB;
	}
	const sorted = Float32Array.from(energyDb).sort();
	const index = Math.min(
		sorted.length - 1,
		Math.floor((sorted.length - 1) * NOISE_FLOOR_PERCENTILE)
	);
	return sorted[index] ?? VAD_MIN_DB;
}

/** Frame runs of `value` as `[firstFrame, endFrame)` pairs. */
function runsOf(flags: Uint8Array, value: number): [number, number][] {
	const runs: [number, number][] = [];
	let start: number | null = null;
	for (let index = 0; index <= flags.length; index += 1) {
		const matches = index < flags.length && flags[index] === value;
		if (matches) {
			start ??= index;
		} else if (start !== null) {
			runs.push([start, index]);
			start = null;
		}
	}
	return runs;
}

/** Hysteresis speech decision before duration smoothing. */
function hysteresis(
	features: VadFeatures,
	floor: number,
	threshold: number
): Uint8Array {
	const { energyDb, zcr } = features;
	const onset = floor + threshold;
	const release = floor + threshold * RELEASE_RATIO;
	const speech = new Uint8Array(energyDb.length);
	let active = false;
	for (let index = 0; index < energyDb.length; index += 1) {
		const energy = energyDb[index] ?? VAD_MIN_DB;
		const crossing = zcr[index] ?? 0;
		if (active) {
			active = energy >= release;
		} else {
			const noisy = crossing > NOISY_ZCR;
			active = energy >= onset + (noisy ? NOISY_ONSET_EXTRA_DB : 0);
		}
		speech[index] = active ? 1 : 0;
	}
	extendUnvoiced(speech, features, floor);
	return speech;
}

/** Grow speech over adjacent quiet high-ZCR frames (fricative onsets and tails). */
function extendUnvoiced(
	speech: Uint8Array,
	features: VadFeatures,
	floor: number
) {
	const limit = Math.round(
		UNVOICED_MAX_EXTENSION_SECONDS / features.frameSeconds
	);
	const unvoiced = (index: number) =>
		speech[index] === 0 &&
		(features.zcr[index] ?? 0) >= UNVOICED_ZCR &&
		(features.energyDb[index] ?? VAD_MIN_DB) >=
			floor + UNVOICED_MIN_DB_ABOVE_FLOOR;
	for (const [start, end] of runsOf(speech, 1)) {
		for (let step = 1; step <= limit && unvoiced(start - step); step += 1) {
			speech[start - step] = 1;
		}
		for (let step = 0; step < limit && unvoiced(end + step); step += 1) {
			speech[end + step] = 1;
		}
	}
}

/**
 * Classify each frame as speech (1) or not (0): hysteresis on energy above the
 * adaptive floor, then speech blips shorter than `minSpeech` are dropped and
 * pauses shorter than `minPause` are filled.
 */
export function classifySpeech(
	features: VadFeatures,
	params: VadParams = {}
): { noiseFloorDb: number; speech: Uint8Array } {
	const resolved = resolveVadParams(params);
	const floor = noiseFloorDb(features.energyDb);
	const speech = hysteresis(features, floor, resolved.threshold);
	const frame = features.frameSeconds;
	for (const [start, end] of runsOf(speech, 1)) {
		if ((end - start) * frame < resolved.minSpeech - EPSILON) {
			speech.fill(0, start, end);
		}
	}
	for (const [start, end] of runsOf(speech, 0)) {
		const bounded = start > 0 && end < speech.length;
		if (bounded && (end - start) * frame < resolved.minPause - EPSILON) {
			speech.fill(1, start, end);
		}
	}
	return { noiseFloorDb: floor, speech };
}

/**
 * Non-speech source spans at least `minPause` long, shrunk by `padding` on
 * each side that touches speech. Spans are in time order and capped at
 * `MAX_VAD_SPANS`.
 */
export function vadSilence(
	features: VadFeatures,
	params: VadParams = {}
): VadResult {
	const resolved = resolveVadParams(params);
	const { noiseFloorDb: floor, speech } = classifySpeech(features, resolved);
	const frame = features.frameSeconds;
	const ranges: [number, number][] = [];
	for (const [first, last] of runsOf(speech, 0)) {
		const rawStart = first * frame;
		const rawEnd = Math.min(features.duration, last * frame);
		if (rawEnd - rawStart < resolved.minPause - EPSILON) {
			continue;
		}
		const start = rawStart + (first > 0 ? resolved.padding : 0);
		const end = rawEnd - (last < speech.length ? resolved.padding : 0);
		if (end - start > EPSILON) {
			ranges.push([round(start), round(end)]);
		}
		if (ranges.length >= MAX_VAD_SPANS) {
			break;
		}
	}
	return { noiseFloorDb: round(floor), ranges };
}

/** Speech source spans: the complement of `vadSilence` without padding. */
export function vadSpeech(
	features: VadFeatures,
	params: VadParams = {}
): [number, number][] {
	const { speech } = classifySpeech(features, params);
	const frame = features.frameSeconds;
	return runsOf(speech, 1)
		.slice(0, MAX_VAD_SPANS)
		.map(([first, last]) => [
			round(first * frame),
			round(Math.min(features.duration, last * frame)),
		]);
}

/**
 * Map source spans into a clip's timeline range. Spans are clipped to
 * `[sourceIn, sourceOut]` and scaled by the clip speed.
 */
export function sourceSpansToTimeline(
	clip: SourceMapping,
	spans: readonly (readonly [number, number])[]
): TimeRange[] {
	const ranges: TimeRange[] = [];
	if (!(clip.speed > 0)) {
		return ranges;
	}
	for (const [spanStart, spanEnd] of spans) {
		const start = Math.max(spanStart, clip.sourceIn);
		const end = Math.min(spanEnd, clip.sourceOut);
		if (end - start <= EPSILON) {
			continue;
		}
		ranges.push({
			end: round(clip.start + (end - clip.sourceIn) / clip.speed),
			start: round(clip.start + (start - clip.sourceIn) / clip.speed),
		});
	}
	return ranges;
}

/**
 * Clips the listener can hear (`clipHeard`): not muted or hidden, not past the
 * high-speed mute, with volume, on a visible track that is neither muted nor
 * silenced by another track's solo.
 */
export function audibleSegments(
	project: Pick<Project, "segments" | "trackSettings">
): Segment[] {
	return project.segments.filter((segment) => clipHeard(project, segment));
}

/** Union of intervals, sorted by start. */
export function unionRanges(ranges: readonly TimeRange[]): TimeRange[] {
	const merged: TimeRange[] = [];
	for (const range of [...ranges].sort((a, b) => a.start - b.start)) {
		if (range.end - range.start <= EPSILON) {
			continue;
		}
		const previous = merged.at(-1);
		if (previous && range.start <= previous.end + EPSILON) {
			previous.end = Math.max(previous.end, range.end);
		} else {
			merged.push({ end: range.end, start: range.start });
		}
	}
	return merged;
}

/** Parts of `ranges` not covered by `remove`, sorted by start. */
export function subtractRanges(
	ranges: readonly TimeRange[],
	remove: readonly TimeRange[]
): TimeRange[] {
	const cuts = unionRanges(remove);
	const result: TimeRange[] = [];
	for (const range of unionRanges(ranges)) {
		let cursor = range.start;
		for (const cut of cuts) {
			if (cut.end <= cursor || cut.start >= range.end) {
				continue;
			}
			if (cut.start > cursor) {
				result.push({ end: cut.start, start: cursor });
			}
			cursor = Math.max(cursor, cut.end);
		}
		if (range.end - cursor > EPSILON) {
			result.push({ end: range.end, start: cursor });
		}
	}
	return result;
}

/** Overlap of two interval sets, sorted by start. */
export function intersectRanges(
	left: readonly TimeRange[],
	right: readonly TimeRange[]
): TimeRange[] {
	const a = unionRanges(left);
	const b = unionRanges(right);
	const result: TimeRange[] = [];
	let i = 0;
	let j = 0;
	while (i < a.length && j < b.length) {
		const x = a[i];
		const y = b[j];
		if (!(x && y)) {
			break;
		}
		const start = Math.max(x.start, y.start);
		const end = Math.min(x.end, y.end);
		if (end - start > EPSILON) {
			result.push({ end, start });
		}
		if (x.end < y.end) {
			i += 1;
		} else {
			j += 1;
		}
	}
	return result;
}

/** Query string for `GET /assets/:id/silence` with VAD parameters. */
export function vadSilenceQuery(params: VadParams = {}): string {
	const resolved = resolveVadParams(params);
	const query = new URLSearchParams({ method: "vad" });
	for (const key of [
		"threshold",
		"minPause",
		"padding",
		"minSpeech",
	] as const) {
		query.set(key, String(resolved[key]));
	}
	return query.toString();
}
