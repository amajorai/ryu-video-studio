import { z } from "zod";

/**
 * Beat detection over decoded mono PCM. Pure and deterministic: the sidecar
 * decodes audio with FFmpeg, and everything from the onset envelope to the
 * downbeat phase is computed here so it can be unit tested on synthetic audio.
 *
 * Pipeline: spectral-flux onset envelope (1024-point FFT, hop 110 at
 * 11025 Hz, about 100 envelope frames per second) → tempo from the envelope
 * autocorrelation between 60 and 180 BPM, weighted by a log-Gaussian prior
 * around 120 BPM → beat positions by dynamic programming (Ellis 2007) →
 * downbeats as the phase of four with the strongest low-band accent.
 */

export const BEAT_SAMPLE_RATE = 11_025;
export const BEAT_FFT_SIZE = 1024;
export const BEAT_HOP = 110;
/** Longest source span decoded for detection; later audio is not analyzed. */
export const BEAT_MAX_SECONDS = 600;
export const BEAT_MIN_BPM = 60;
export const BEAT_MAX_BPM = 180;
const PRIOR_BPM = 120;
/** Prior width in octaves. */
const PRIOR_OCTAVES = 1;
/** Ellis tightness: how strongly beat spacing is held to the tempo period. */
const TIGHTNESS = 100;
/**
 * Half-lag autocorrelation, relative to the chosen lag, at or above which the
 * faster tempo of the pair wins.
 */
const TEMPO_PAIR_RATIO = 0.85;
/**
 * Minimum weak/strong ratio between alternate beats at the faster tempo of a
 * pair (see `parityBalance`; even pulses, bar-accented or not, measure about
 * 0.95, eighth-note grooves under 0.8).
 */
const TEMPO_PAIR_BALANCE = 0.88;
/** Low-band accent ceiling for downbeat phase (kick drum and bass). */
const LOW_BAND_HZ = 150;
const BEATS_PER_BAR = 4;
const MAX_BEATS = 2000;

const time = z.number().finite().min(0).max(7200);

export const beatAnalysisSchema = z
	.object({
		/** Tempo in beats per minute, rounded to 0.1. */
		bpm: z.number().finite().min(BEAT_MIN_BPM).max(BEAT_MAX_BPM),
		/** Beat times in source seconds, ascending. */
		beats: z.array(time).max(MAX_BEATS),
		/** The subset of `beats` that start a bar of four. */
		downbeats: z.array(time).max(MAX_BEATS),
		/** 0-1: periodicity strength of the onset envelope at the tempo. */
		confidence: z.number().finite().min(0).max(1),
		/** Source seconds analyzed from `analyzedFrom` (at most `BEAT_MAX_SECONDS`). */
		analyzedDuration: z.number().finite().min(0).max(7200),
		/** Source second the analyzed window starts at; absent means 0. */
		analyzedFrom: z.number().finite().min(0).max(7200).optional(),
		method: z.literal("spectral-flux"),
	})
	.strict();
export type BeatAnalysis = z.infer<typeof beatAnalysisSchema>;

export interface OnsetEnvelope {
	/** Normalized spectral-flux novelty per frame (rectified, unit RMS). */
	envelope: Float64Array;
	/** Envelope frames per second. */
	frameRate: number;
	/** Low-band flux per frame, for accent (downbeat) decisions. */
	lowBand: Float64Array;
	/** Source time, in seconds, of frame 0. */
	offset: number;
}

interface FftPlan {
	cos: Float64Array;
	reverse: Uint32Array;
	sin: Float64Array;
	size: number;
	window: Float64Array;
}

function fftPlan(size: number): FftPlan {
	if (size < 2 || (size & (size - 1)) !== 0) {
		throw new Error("FFT size must be a power of two.");
	}
	const bits = Math.log2(size);
	const reverse = new Uint32Array(size);
	for (let index = 0; index < size; index++) {
		let value = 0;
		for (let bit = 0; bit < bits; bit++) {
			value = (value << 1) | ((index >> bit) & 1);
		}
		reverse[index] = value;
	}
	const cos = new Float64Array(size / 2);
	const sin = new Float64Array(size / 2);
	for (let index = 0; index < size / 2; index++) {
		cos[index] = Math.cos((-2 * Math.PI * index) / size);
		sin[index] = Math.sin((-2 * Math.PI * index) / size);
	}
	const window = new Float64Array(size);
	for (let index = 0; index < size; index++) {
		window[index] = 0.5 - 0.5 * Math.cos((2 * Math.PI * index) / size);
	}
	return { cos, reverse, sin, size, window };
}

/** In-place radix-2 FFT using a precomputed plan. */
function transform(plan: FftPlan, real: Float64Array, imaginary: Float64Array) {
	const { size, reverse, cos, sin } = plan;
	for (let index = 0; index < size; index++) {
		const target = reverse[index] ?? 0;
		if (target > index) {
			const swapReal = real[index] ?? 0;
			real[index] = real[target] ?? 0;
			real[target] = swapReal;
			const swapImaginary = imaginary[index] ?? 0;
			imaginary[index] = imaginary[target] ?? 0;
			imaginary[target] = swapImaginary;
		}
	}
	for (let length = 2; length <= size; length *= 2) {
		const half = length / 2;
		const stride = size / length;
		for (let start = 0; start < size; start += length) {
			for (let offset = 0; offset < half; offset++) {
				const twiddleReal = cos[offset * stride] ?? 1;
				const twiddleImaginary = sin[offset * stride] ?? 0;
				const even = start + offset;
				const odd = even + half;
				const oddReal = real[odd] ?? 0;
				const oddImaginary = imaginary[odd] ?? 0;
				const productReal =
					oddReal * twiddleReal - oddImaginary * twiddleImaginary;
				const productImaginary =
					oddReal * twiddleImaginary + oddImaginary * twiddleReal;
				const evenReal = real[even] ?? 0;
				const evenImaginary = imaginary[even] ?? 0;
				real[even] = evenReal + productReal;
				imaginary[even] = evenImaginary + productImaginary;
				real[odd] = evenReal - productReal;
				imaginary[odd] = evenImaginary - productImaginary;
			}
		}
	}
}

/** Subtract a centred moving average, half-wave rectify, then scale to unit RMS. */
function normalizeNovelty(
	values: Float64Array,
	radius: number,
	minimumRms: number
): Float64Array {
	const length = values.length;
	const prefix = new Float64Array(length + 1);
	for (let index = 0; index < length; index++) {
		prefix[index + 1] = (prefix[index] ?? 0) + (values[index] ?? 0);
	}
	const result = new Float64Array(length);
	let energy = 0;
	for (let index = 0; index < length; index++) {
		const from = Math.max(0, index - radius);
		const to = Math.min(length, index + radius + 1);
		const mean = ((prefix[to] ?? 0) - (prefix[from] ?? 0)) / (to - from);
		const value = Math.max(0, (values[index] ?? 0) - mean);
		result[index] = value;
		energy += value * value;
	}
	const rms = Math.sqrt(energy / Math.max(1, length));
	// Leakage ripple from a steady signal must not be amplified into onsets.
	if (!(rms > minimumRms)) {
		return new Float64Array(length);
	}
	for (let index = 0; index < length; index++) {
		result[index] = (result[index] ?? 0) / rms;
	}
	return result;
}

/**
 * Spectral-flux onset envelope: the summed positive change of log-compressed
 * Hann-windowed magnitudes between consecutive frames.
 */
export function onsetEnvelope(
	samples: Float32Array,
	sampleRate = BEAT_SAMPLE_RATE
): OnsetEnvelope {
	const plan = fftPlan(BEAT_FFT_SIZE);
	const bins = BEAT_FFT_SIZE / 2 + 1;
	const lowBins = Math.max(
		2,
		Math.min(bins, Math.ceil((LOW_BAND_HZ * BEAT_FFT_SIZE) / sampleRate) + 1)
	);
	const frames =
		samples.length >= BEAT_FFT_SIZE
			? Math.floor((samples.length - BEAT_FFT_SIZE) / BEAT_HOP) + 1
			: 0;
	const frameRate = sampleRate / BEAT_HOP;
	const flux = new Float64Array(frames);
	const low = new Float64Array(frames);
	const real = new Float64Array(BEAT_FFT_SIZE);
	const imaginary = new Float64Array(BEAT_FFT_SIZE);
	let previous = new Float64Array(bins);
	let current = new Float64Array(bins);
	let mass = 0;
	for (let frame = 0; frame < frames; frame++) {
		const start = frame * BEAT_HOP;
		for (let index = 0; index < BEAT_FFT_SIZE; index++) {
			const sample = samples[start + index] ?? 0;
			real[index] =
				(Number.isFinite(sample) ? sample : 0) * (plan.window[index] ?? 0);
			imaginary[index] = 0;
		}
		transform(plan, real, imaginary);
		let total = 0;
		let lowTotal = 0;
		for (let bin = 0; bin < bins; bin++) {
			const magnitude = Math.hypot(real[bin] ?? 0, imaginary[bin] ?? 0);
			const compressed = Math.log1p(100 * magnitude);
			current[bin] = compressed;
			mass += compressed;
			if (frame > 0) {
				const rise = compressed - (previous[bin] ?? 0);
				if (rise > 0) {
					total += rise;
					if (bin < lowBins) {
						lowTotal += rise;
					}
				}
			}
		}
		flux[frame] = total;
		low[frame] = lowTotal;
		const swap = previous;
		previous = current;
		current = swap;
	}
	// Log-compressed flux peaks while a new sound is still near the leading
	// edge of the Hann window (measured on synthetic onsets: about 0.8 of the
	// window), so stamp each frame there rather than at its centre.
	const offset = (BEAT_FFT_SIZE * 0.8) / sampleRate;
	const radius = Math.round(frameRate * 0.25);
	// Novelty under 1% of the mean spectral mass per frame is a steady sound,
	// not a sequence of onsets.
	const minimumRms = Math.max(1e-6, (0.01 * mass) / Math.max(1, frames));
	return {
		envelope: normalizeNovelty(flux, radius, minimumRms),
		frameRate,
		lowBand: normalizeNovelty(low, radius, 1e-6),
		offset,
	};
}

function autocorrelation(envelope: Float64Array, lag: number): number {
	let total = 0;
	for (let index = lag; index < envelope.length; index++) {
		total += (envelope[index] ?? 0) * (envelope[index - lag] ?? 0);
	}
	return total / Math.max(1, envelope.length - lag);
}

/**
 * Evenness of beat strength between alternate beats tracked at `period`
 * (0-1). Beats are grouped by phase of four and each parity keeps its weaker
 * phase, so a bar accent on one beat in four does not count as alternation,
 * while a slow pulse with off-beat subdivisions (eighth-note hats between
 * kicks and snares), whose every other beat is weak, still does.
 */
function parityBalance(envelope: Float64Array, period: number): number {
	const totals = [0, 0, 0, 0];
	const counts = [0, 0, 0, 0];
	for (const [position, frame] of trackBeats(envelope, period).entries()) {
		const phase = position % BEATS_PER_BAR;
		totals[phase] = (totals[phase] ?? 0) + peakNear(envelope, frame, 2);
		counts[phase] = (counts[phase] ?? 0) + 1;
	}
	const mean = (phase: number) =>
		(totals[phase] ?? 0) / Math.max(1, counts[phase] ?? 0);
	const even = Math.min(mean(0), mean(2));
	const odd = Math.min(mean(1), mean(3));
	const stronger = Math.max(even, odd);
	return stronger > 0 ? Math.min(even, odd) / stronger : 0;
}

/**
 * Tempo-pair check. A beat train correlates as strongly at two periods as at
 * one, and the octave-symmetric prior weighs 170 BPM and 85 BPM alike, so a
 * slow pick is replaced by the autocorrelation peak at half its lag (double
 * the tempo) when that peak is in range, nearly as strong, and the beats it
 * implies are about equally strong. Strong-weak alternation at the faster
 * rate means off-beat subdivisions of the slower tempo, which is kept.
 */
function preferFasterPair(
	envelope: Float64Array,
	raw: Float64Array,
	lag: number,
	minLag: number
): number {
	let current = lag;
	while (current / 2 >= minLag) {
		const centre = Math.round(current / 2);
		let half = -1;
		for (
			let candidate = Math.max(minLag, centre - 1);
			candidate <= centre + 1;
			candidate++
		) {
			if (half < 0 || (raw[candidate] ?? 0) > (raw[half] ?? 0)) {
				half = candidate;
			}
		}
		if (
			half < 0 ||
			(raw[half] ?? 0) < TEMPO_PAIR_RATIO * (raw[current] ?? 0) ||
			parityBalance(envelope, current / 2) < TEMPO_PAIR_BALANCE
		) {
			break;
		}
		current = half;
	}
	return current;
}

export interface TempoEstimate {
	bpm: number;
	confidence: number;
	/** Beat period in envelope frames (fractional). */
	period: number;
}

/**
 * Tempo from the envelope autocorrelation over 60-180 BPM, weighted by a
 * log-Gaussian prior around 120 BPM and refined by parabolic interpolation.
 */
export function estimateTempo(
	envelope: Float64Array,
	frameRate: number
): TempoEstimate | null {
	const minLag = Math.max(1, Math.floor((60 * frameRate) / BEAT_MAX_BPM));
	const maxLag = Math.ceil((60 * frameRate) / BEAT_MIN_BPM);
	if (envelope.length < maxLag * 2 + 2) {
		return null;
	}
	const zero = autocorrelation(envelope, 0);
	if (!(zero > 1e-12)) {
		return null;
	}
	const raw = new Float64Array(maxLag + 2);
	for (let lag = Math.max(1, minLag - 1); lag <= maxLag + 1; lag++) {
		raw[lag] = autocorrelation(envelope, lag);
	}
	const weight = (lag: number) => {
		const octaves = Math.log2((60 * frameRate) / lag / PRIOR_BPM);
		return Math.exp(-0.5 * (octaves / PRIOR_OCTAVES) ** 2);
	};
	let best = -1;
	let bestScore = Number.NEGATIVE_INFINITY;
	for (let lag = minLag; lag <= maxLag; lag++) {
		const value = raw[lag] ?? 0;
		const isPeak = value >= (raw[lag - 1] ?? 0) && value >= (raw[lag + 1] ?? 0);
		const score = value * weight(lag);
		if (isPeak && score > bestScore) {
			bestScore = score;
			best = lag;
		}
	}
	if (best < 0 || !((raw[best] ?? 0) > 0)) {
		return null;
	}
	best = preferFasterPair(envelope, raw, best, minLag);
	const left = raw[best - 1] ?? 0;
	const centre = raw[best] ?? 0;
	const right = raw[best + 1] ?? 0;
	const curvature = left - 2 * centre + right;
	const shift =
		curvature < 0
			? Math.max(-0.5, Math.min(0.5, (0.5 * (left - right)) / curvature))
			: 0;
	const period = best + shift;
	const bpm = Math.max(
		BEAT_MIN_BPM,
		Math.min(BEAT_MAX_BPM, (60 * frameRate) / period)
	);
	return {
		bpm,
		confidence: Math.max(0, Math.min(1, centre / zero)),
		period: (60 * frameRate) / bpm,
	};
}

/** Gaussian-smoothed envelope used as the per-frame beat evidence. */
function localScore(envelope: Float64Array, period: number): Float64Array {
	const sigma = Math.max(1, period / 32);
	const radius = Math.ceil(sigma * 3);
	const kernel: number[] = [];
	for (let offset = -radius; offset <= radius; offset++) {
		kernel.push(Math.exp(-0.5 * (offset / sigma) ** 2));
	}
	const result = new Float64Array(envelope.length);
	for (let index = 0; index < envelope.length; index++) {
		let total = 0;
		for (let offset = -radius; offset <= radius; offset++) {
			total += (envelope[index + offset] ?? 0) * (kernel[offset + radius] ?? 0);
		}
		result[index] = total;
	}
	return result;
}

/**
 * Ellis dynamic-programming beat tracker: each frame's cumulative score is its
 * local evidence plus the best predecessor score, penalized by the squared log
 * deviation of the spacing from the tempo period. Returns beat frame indices.
 */
export function trackBeats(envelope: Float64Array, period: number): number[] {
	const length = envelope.length;
	if (!(period >= 1) || length < 2) {
		return [];
	}
	const score = localScore(envelope, period);
	const cumulative = new Float64Array(length);
	const backlink = new Int32Array(length).fill(-1);
	const nearest = Math.round(period / 2);
	const farthest = Math.round(period * 2);
	for (let index = 0; index < length; index++) {
		let best = Number.NEGATIVE_INFINITY;
		let link = -1;
		for (
			let previous = Math.max(0, index - farthest);
			previous <= index - nearest;
			previous++
		) {
			const spacing = Math.log((index - previous) / period);
			const candidate =
				(cumulative[previous] ?? 0) - TIGHTNESS * spacing * spacing;
			if (candidate > best) {
				best = candidate;
				link = previous;
			}
		}
		if (link >= 0 && best > 0) {
			cumulative[index] = (score[index] ?? 0) + best;
			backlink[index] = link;
		} else {
			cumulative[index] = score[index] ?? 0;
		}
	}
	// Edge beats weaker than half the evidence RMS are silence before the
	// music starts or after it stops.
	let energy = 0;
	for (const value of score) {
		energy += value * value;
	}
	const floor = 0.5 * Math.sqrt(energy / length);
	// Last beat: the latest local maximum of the cumulative score that carries
	// real evidence and reaches half the median of all such maxima, so neither
	// a fade-out nor the decaying tail of the final hit ends the chain early.
	const maxima: number[] = [];
	for (let index = 1; index < length - 1; index++) {
		const value = cumulative[index] ?? 0;
		if (
			value > (cumulative[index - 1] ?? 0) &&
			value >= (cumulative[index + 1] ?? 0)
		) {
			maxima.push(index);
		}
	}
	if (!maxima.length) {
		return [];
	}
	const values = maxima
		.map((index) => cumulative[index] ?? 0)
		.sort((a, b) => a - b);
	const median = values[Math.floor(values.length / 2)] ?? 0;
	let last = -1;
	for (let position = maxima.length - 1; position >= 0; position--) {
		const index = maxima[position] ?? 0;
		if (
			(cumulative[index] ?? 0) >= median / 2 &&
			(score[index] ?? 0) >= floor
		) {
			last = index;
			break;
		}
	}
	const beats: number[] = [];
	for (let index = last; index >= 0; index = backlink[index] ?? -1) {
		beats.push(index);
	}
	beats.reverse();
	let from = 0;
	let to = beats.length;
	while (from < to && (score[beats[from] ?? 0] ?? 0) < floor) {
		from++;
	}
	while (to > from && (score[beats[to - 1] ?? 0] ?? 0) < floor) {
		to--;
	}
	return beats.slice(from, to);
}

/** Peak of `values` within ±`radius` frames of `index`. */
function peakNear(values: Float64Array, index: number, radius: number) {
	let peak = 0;
	for (let offset = -radius; offset <= radius; offset++) {
		peak = Math.max(peak, values[index + offset] ?? 0);
	}
	return peak;
}

/**
 * Which of the four bar phases holds the downbeat: the phase whose beats carry
 * the highest mean low-band accent. Ties keep the earliest phase.
 */
export function downbeatPhase(accents: readonly number[]): number {
	let best = 0;
	let bestMean = Number.NEGATIVE_INFINITY;
	for (
		let phase = 0;
		phase < Math.min(BEATS_PER_BAR, accents.length);
		phase++
	) {
		let total = 0;
		let count = 0;
		for (let index = phase; index < accents.length; index += BEATS_PER_BAR) {
			total += accents[index] ?? 0;
			count++;
		}
		const mean = total / Math.max(1, count);
		if (mean > bestMean + 1e-9) {
			bestMean = mean;
			best = phase;
		}
	}
	return best;
}

const round3 = (value: number) => Math.round(value * 1000) / 1000;

/**
 * Detect tempo, beats and downbeats in mono PCM. Returns null when the audio
 * is too short or has no periodic onsets to track.
 */
export function detectBeats(
	samples: Float32Array,
	sampleRate = BEAT_SAMPLE_RATE,
	/** Source time, in seconds, of the first sample. */
	startSeconds = 0
): BeatAnalysis | null {
	const analyzedDuration = round3(samples.length / sampleRate);
	const from = round3(Math.max(0, Math.min(7200, startSeconds)));
	const onset = onsetEnvelope(samples, sampleRate);
	const tempo = estimateTempo(onset.envelope, onset.frameRate);
	if (!tempo) {
		return null;
	}
	const frames = trackBeats(onset.envelope, tempo.period);
	if (frames.length < 2) {
		return null;
	}
	const toTime = (frame: number) =>
		round3(
			Math.min(7200, from + Math.max(0, frame / onset.frameRate + onset.offset))
		);
	const accents = frames.map((frame) => peakNear(onset.lowBand, frame, 2));
	const phase = downbeatPhase(accents);
	const kept = frames.slice(0, MAX_BEATS);
	const beats = kept.map(toTime);
	return beatAnalysisSchema.parse({
		analyzedDuration: Math.min(7200, analyzedDuration),
		...(from > 0 ? { analyzedFrom: from } : {}),
		beats,
		bpm: Math.round(tempo.bpm * 10) / 10,
		confidence: round3(tempo.confidence),
		downbeats: beats.filter(
			(_, index) => index >= phase && (index - phase) % BEATS_PER_BAR === 0
		),
		method: "spectral-flux",
	});
}

export interface BeatWindow {
	/** Source seconds of audio to decode from `start`. */
	seconds: number;
	/** Source second decoding starts at. */
	start: number;
}

/**
 * The source window to decode so detection covers `[from, to]`: up to
 * `BEAT_MAX_SECONDS`, starting at `from` but pulled earlier (never before 0)
 * so a short request near the end of a long source still gets a full window
 * of context. A request longer than the limit is covered from `from` only.
 */
export function beatDetectionWindow(
	duration: number,
	from = 0,
	to = duration
): BeatWindow {
	const total = Number.isFinite(duration) ? Math.max(0, duration) : 0;
	const first = Math.max(0, Math.min(total, Number.isFinite(from) ? from : 0));
	const last = Math.max(
		first,
		Math.min(total, Number.isFinite(to) ? to : total)
	);
	const start =
		last - first > BEAT_MAX_SECONDS
			? first
			: Math.max(0, Math.min(first, total - BEAT_MAX_SECONDS));
	return {
		seconds: round3(Math.min(BEAT_MAX_SECONDS, total - start)),
		start: round3(start),
	};
}

/** Tolerance for window edges: rounding and the final partial frame. */
const COVERAGE_SLACK = 0.05;
/** An audio stream can end slightly before the container duration. */
const END_SLACK = 0.5;

/**
 * Whether a detection analyzed all of `[from, to]` in source seconds. `end`
 * is the source duration, so a window that reached the end of the source (or
 * of its audio) covers anything after it.
 */
export function beatsCover(
	beats: Pick<BeatAnalysis, "analyzedDuration" | "analyzedFrom">,
	from: number,
	to: number,
	end = Number.POSITIVE_INFINITY
): boolean {
	const start = beats.analyzedFrom ?? 0;
	const stop = start + beats.analyzedDuration;
	// A window that decoded less than it asked for ran out of audio, so it
	// covers everything after it too.
	const reachesEnd =
		stop >= end - END_SLACK ||
		(Number.isFinite(end) &&
			beats.analyzedDuration <
				Math.min(BEAT_MAX_SECONDS, end - start) - END_SLACK);
	return (
		start <= from + COVERAGE_SLACK &&
		(reachesEnd || stop >= to - COVERAGE_SLACK)
	);
}
