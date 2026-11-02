// ---------------------------------------------------------------------------
// Clock drift: a fine correlation near each end of the overlap.
// ---------------------------------------------------------------------------

/** Largest drift corrected through clip speed (0.5%). */
export const MAX_CORRECTABLE_DRIFT = 0.005;
/** Drift search covers ±1% of the span so larger drift is reported, not missed. */
export const DRIFT_SEARCH_RATIO = 0.01;
/** Decode rate for drift windows (mono PCM). */
export const DRIFT_DECODE_RATE = 8000;
/** Envelope rate correlated for drift: one value per millisecond. */
export const DRIFT_ENVELOPE_RATE = 1000;
/** Longest correlation window at each end of the overlap. */
export const DRIFT_WINDOW_SECONDS = 10;
/** Shortest overlap that can measure drift. */
export const MIN_DRIFT_OVERLAP_SECONDS = 20;
/** Fine matches below this normalized correlation are not trusted. */
export const MIN_DRIFT_CONFIDENCE = 0.3;
const MAX_TARGET_WINDOW_SECONDS = 180;

export type SyncDriftStatus =
	| "corrected"
	| "negligible"
	| "too-large"
	| "disabled"
	| "too-short"
	| "unmeasured";

export interface SyncDrift {
	/** `(offset2 - offset1) / span`, as a percentage. */
	driftPercent?: number;
	/** Uncorrected misalignment at the end of the overlap, in frames. */
	endErrorFrames?: number;
	/** Why drift was not corrected, when it was not. */
	reason?: string;
	/** Seconds between the two measured window centers (reference source time). */
	spanSeconds?: number;
	/** The target clip speed after correction. */
	speed?: number;
	status: SyncDriftStatus;
}

/** A fine sync measurement that replaces the coarse envelope correlation. */
export interface SyncRefinement {
	/** Reference source second where `lagSeconds` was measured. */
	anchorSeconds: number;
	confidence: number;
	drift: SyncDrift;
	lagSeconds: number;
	/** True when the lag is precise enough to place the clip below one frame. */
	subFrame: boolean;
}

export interface EnvelopeLag {
	confidence: number;
	lagSeconds: number;
}

/** Mean absolute amplitude per block: PCM at `sampleRate` to `envelopeRate`. */
export function pcmEnvelope(
	samples: Float32Array,
	sampleRate = DRIFT_DECODE_RATE,
	envelopeRate = DRIFT_ENVELOPE_RATE
): Float32Array {
	const block = Math.max(1, Math.round(sampleRate / envelopeRate));
	const length = Math.floor(samples.length / block);
	const envelope = new Float32Array(length);
	for (let index = 0; index < length; index += 1) {
		let sum = 0;
		for (let offset = 0; offset < block; offset += 1) {
			sum += Math.abs(samples[index * block + offset] ?? 0);
		}
		envelope[index] = sum / block;
	}
	return envelope;
}

function decimate(values: Float32Array, factor: number): Float32Array {
	const length = Math.floor(values.length / factor);
	const result = new Float32Array(length);
	for (let index = 0; index < length; index += 1) {
		let sum = 0;
		for (let offset = 0; offset < factor; offset += 1) {
			sum += values[index * factor + offset] ?? 0;
		}
		result[index] = sum / factor;
	}
	return result;
}

/** Normalized cross-correlation of `reference` against `target` at lags `from..to`. */
function scanLags(
	reference: Float32Array,
	target: Float32Array,
	from: number,
	to: number
): Float64Array | null {
	const size = reference.length;
	let mean = 0;
	for (const value of reference) {
		mean += value;
	}
	mean /= size;
	const centered = new Float64Array(size);
	let referenceEnergy = 0;
	for (let index = 0; index < size; index += 1) {
		const value = (reference[index] ?? 0) - mean;
		centered[index] = value;
		referenceEnergy += value * value;
	}
	if (referenceEnergy <= 1e-12) {
		return null;
	}
	const prefix = new Float64Array(target.length + 1);
	const prefixSquares = new Float64Array(target.length + 1);
	for (let index = 0; index < target.length; index += 1) {
		const value = target[index] ?? 0;
		prefix[index + 1] = (prefix[index] ?? 0) + value;
		prefixSquares[index + 1] = (prefixSquares[index] ?? 0) + value * value;
	}
	const scores = new Float64Array(to - from + 1);
	for (let lag = from; lag <= to; lag += 1) {
		const sum = (prefix[lag + size] ?? 0) - (prefix[lag] ?? 0);
		const squares =
			(prefixSquares[lag + size] ?? 0) - (prefixSquares[lag] ?? 0);
		const targetEnergy = squares - (sum * sum) / size;
		if (targetEnergy <= 1e-12) {
			scores[lag - from] = 0;
			continue;
		}
		let numerator = 0;
		for (let index = 0; index < size; index += 1) {
			numerator += (centered[index] ?? 0) * (target[lag + index] ?? 0);
		}
		scores[lag - from] = numerator / Math.sqrt(referenceEnergy * targetEnergy);
	}
	return scores;
}

function peakIndex(scores: Float64Array): number {
	let best = 0;
	for (let index = 1; index < scores.length; index += 1) {
		if ((scores[index] ?? 0) > (scores[best] ?? 0)) {
			best = index;
		}
	}
	return best;
}

/**
 * Find where `reference` best matches inside the longer `target` (both
 * envelopes at `rate`). Returns the lag in seconds from the target's first
 * value: `reference[i]` matches `target[i + lag * rate]`. A coarse pass at a
 * tenth of the rate finds the peak, a full-rate pass refines it, and a
 * parabola through the peak gives sub-sample precision.
 */
export function bestEnvelopeLag(
	reference: Float32Array,
	target: Float32Array,
	rate = DRIFT_ENVELOPE_RATE
): EnvelopeLag | null {
	const span = target.length - reference.length;
	if (span < 0 || reference.length < Math.max(16, rate / 2)) {
		return null;
	}
	const factor = Math.max(1, Math.min(10, Math.floor(reference.length / 64)));
	const coarseReference = decimate(reference, factor);
	const coarseTarget = decimate(target, factor);
	const coarseSpan = coarseTarget.length - coarseReference.length;
	const coarse =
		coarseSpan >= 0
			? scanLags(coarseReference, coarseTarget, 0, coarseSpan)
			: null;
	if (!coarse) {
		return null;
	}
	const center = peakIndex(coarse) * factor;
	const from = Math.max(0, center - 2 * factor);
	const to = Math.min(span, center + 2 * factor);
	const fine = scanLags(reference, target, from, to);
	if (!fine) {
		return null;
	}
	const index = peakIndex(fine);
	const peak = fine[index] ?? 0;
	let fraction = 0;
	if (index > 0 && index < fine.length - 1) {
		const before = fine[index - 1] ?? 0;
		const after = fine[index + 1] ?? 0;
		const curvature = before - 2 * peak + after;
		if (curvature < 0) {
			fraction = Math.max(
				-0.5,
				Math.min(0.5, (0.5 * (before - after)) / curvature)
			);
		}
	}
	return {
		confidence: Math.max(0, Math.min(1, peak)),
		lagSeconds: (from + index + fraction) / rate,
	};
}

export interface DriftWindow {
	/** Window center in reference source seconds. */
	anchorSeconds: number;
	/** Reference source window. */
	referenceDuration: number;
	referenceStart: number;
	/** Target source window searched for the reference window. */
	targetDuration: number;
	targetStart: number;
}

export interface DriftWindowPlan {
	spanSeconds: number;
	windows: [DriftWindow, DriftWindow];
}

export interface SourceRange {
	sourceIn: number;
	sourceOut: number;
}

export function targetWindow(
	referenceStart: number,
	duration: number,
	lagSeconds: number,
	searchSeconds: number,
	targetDuration: number
): { targetDuration: number; targetStart: number } {
	const targetStart = Math.max(0, referenceStart + lagSeconds - searchSeconds);
	const targetEnd = Math.min(
		targetDuration,
		referenceStart + duration + lagSeconds + searchSeconds,
		targetStart + MAX_TARGET_WINDOW_SECONDS
	);
	return {
		targetDuration: Math.max(0, targetEnd - targetStart),
		targetStart,
	};
}
