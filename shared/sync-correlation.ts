import type { MediaAnalysis } from "./analysis.ts";

function waveformValue(
	waveform: readonly number[],
	duration: number,
	second: number
): number {
	if (!waveform.length || second < 0 || second > duration) {
		return 0;
	}
	const position = (second / Math.max(duration, 0.001)) * (waveform.length - 1);
	const lower = Math.max(0, Math.floor(position));
	const upper = Math.min(waveform.length - 1, lower + 1);
	const fraction = position - lower;
	return (
		(waveform[lower] ?? 0) * (1 - fraction) + (waveform[upper] ?? 0) * fraction
	);
}

function correlationAt(
	reference: MediaAnalysis,
	target: MediaAnalysis,
	lag: number,
	step: number,
	ranges: {
		referenceIn: number;
		referenceOut: number;
		targetIn: number;
		targetOut: number;
	}
): number | null {
	const start = Math.max(ranges.referenceIn, ranges.targetIn - lag);
	const end = Math.min(ranges.referenceOut, ranges.targetOut - lag);
	const count = Math.floor((end - start) / step) + 1;
	if (count < 8) {
		return null;
	}
	let referenceMean = 0;
	let targetMean = 0;
	let numerator = 0;
	let referenceVariance = 0;
	let targetVariance = 0;
	for (let index = 0; index < count; index += 1) {
		const second = Math.min(end, start + index * step);
		const value = waveformValue(reference.waveform, reference.duration, second);
		const targetValue = waveformValue(
			target.waveform,
			target.duration,
			second + lag
		);
		const referenceDelta = value - referenceMean;
		const targetDelta = targetValue - targetMean;
		referenceMean += referenceDelta / (index + 1);
		targetMean += targetDelta / (index + 1);
		numerator += referenceDelta * (targetValue - targetMean);
		referenceVariance += referenceDelta * (value - referenceMean);
		targetVariance += targetDelta * (targetValue - targetMean);
	}
	if (referenceVariance < 0.0001 || targetVariance < 0.0001) {
		return null;
	}
	return numerator / Math.sqrt(referenceVariance * targetVariance);
}

/**
 * Find a source-time lag from two measured audio envelopes. A positive lag
 * means the target's matching sound occurs later in its source than the
 * reference sound.
 */
export interface AudioCorrelation {
	confidence: number;
	lagSeconds: number;
}

export function correlateAudio(
	reference: MediaAnalysis,
	target: MediaAnalysis,
	searchWindowSeconds: number,
	minConfidence: number,
	ranges = {
		referenceIn: 0,
		referenceOut: reference.duration,
		targetIn: 0,
		targetOut: target.duration,
	}
): AudioCorrelation {
	if (
		!Number.isFinite(searchWindowSeconds) ||
		searchWindowSeconds < 0 ||
		searchWindowSeconds > 600 ||
		!Number.isFinite(minConfidence) ||
		minConfidence < 0 ||
		minConfidence > 1 ||
		!Object.values(ranges).every(Number.isFinite) ||
		ranges.referenceIn < 0 ||
		ranges.targetIn < 0 ||
		ranges.referenceOut < ranges.referenceIn ||
		ranges.targetOut < ranges.targetIn ||
		ranges.referenceOut > reference.duration ||
		ranges.targetOut > target.duration
	) {
		throw new Error(
			"Audio sync requires finite search bounds inside the measured source ranges."
		);
	}
	if (
		reference.status !== "completed" ||
		target.status !== "completed" ||
		reference.waveform.length < 8 ||
		target.waveform.length < 8 ||
		reference.waveform.length > 600 ||
		target.waveform.length > 600 ||
		!Number.isFinite(reference.duration) ||
		!Number.isFinite(target.duration) ||
		reference.duration <= 0 ||
		target.duration <= 0 ||
		reference.duration > 7200 ||
		target.duration > 7200
	) {
		throw new Error(
			"Complete audio analysis is required before syncing clips."
		);
	}
	const step = Math.max(
		0.1,
		reference.duration / reference.waveform.length,
		target.duration / target.waveform.length
	);
	const window = Math.min(600, Math.max(step, searchWindowSeconds));
	let best: { confidence: number; lagSeconds: number } | null = null;
	const steps = Math.floor(window / step);
	for (let index = -steps; index <= steps; index++) {
		const lag = index * step;
		const score = correlationAt(reference, target, lag, step, ranges);
		if (score === null) {
			continue;
		}
		const confidence = Math.max(0, Math.min(1, score));
		if (
			!best ||
			confidence > best.confidence + 0.0001 ||
			(Math.abs(confidence - best.confidence) <= 0.0001 &&
				Math.abs(lag) < Math.abs(best.lagSeconds))
		) {
			best = { confidence, lagSeconds: lag };
		}
	}
	if (!best || best.confidence < minConfidence) {
		throw new Error(
			"The measured audio match is too weak. Use a longer shared sound or a manual offset."
		);
	}
	return {
		confidence: Number(best.confidence.toFixed(3)),
		lagSeconds: Number(best.lagSeconds.toFixed(3)),
	};
}
