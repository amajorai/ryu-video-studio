import { z } from "zod";
import type { MediaAnalysis } from "./analysis.ts";
import { retimeKeyframes } from "./animation.ts";
import { MAX_CLIP_SPEED, MIN_CLIP_SPEED } from "./audio.ts";
import {
	type Asset,
	assetTimecodeSchema,
	type Project,
	trackSettingFor,
	validateProject,
} from "./project.ts";

const syncSeconds = z.number().finite().min(-600).max(600);

export const syncRequestSchema = z
	.object({
		offsetSeconds: syncSeconds.optional(),
		mode: z.enum(["auto", "audio", "manual", "timecode"]).default("auto"),
		minConfidence: z.number().finite().min(0.05).max(0.99).default(0.5),
		referenceClipId: z.uuid(),
		revision: z.number().int().nonnegative(),
		searchWindowSeconds: z.number().finite().min(0.5).max(600).default(30),
		targetClipIds: z.array(z.uuid()).min(1).max(8),
		/**
		 * Audio modes measure clock drift from a second correlation window near
		 * the end of the overlap and correct up to ±0.5% through clip speed.
		 * `false` still measures and reports drift but leaves speeds alone.
		 */
		driftCorrection: z.boolean().default(true),
		/** Measure and report without saving the aligned project. */
		dryRun: z.boolean().default(false),
	})
	.strict();
export type SyncRequest = z.infer<typeof syncRequestSchema>;

export interface SyncMatch {
	alignmentOffsetSeconds: number;
	clipId: string;
	confidence: number;
	/** Clock drift measured between two correlation windows (audio modes). */
	drift?: SyncDrift;
	method: "audio" | "manual" | "timecode";
	offsetFrames: number;
	offsetSeconds: number;
}

/** Convert an embedded SMPTE timecode into source seconds. */
export function timecodeSeconds(value: string, frameRate = 30): number {
	const timecode = assetTimecodeSchema.parse(value);
	const match = timecode.match(/^(\d{2}):(\d{2}):(\d{2})([:;])(\d{2})$/);
	if (!match) {
		throw new Error("Embedded timecode is malformed.");
	}
	const hours = Number(match[1]);
	const minutes = Number(match[2]);
	const seconds = Number(match[3]);
	const frames = Number(match[5]);
	if (minutes > 59 || seconds > 59 || frames >= Math.ceil(frameRate)) {
		throw new Error("Embedded timecode is outside its frame-rate bounds.");
	}
	const nominalRate = Math.max(1, Math.round(frameRate));
	const dropFrames =
		match[4] === ";" && nominalRate === 30
			? 2
			: match[4] === ";" && nominalRate === 60
				? 4
				: 0;
	const totalMinutes = hours * 60 + minutes;
	const nominalFrame =
		(hours * 3600 + minutes * 60 + seconds) * nominalRate + frames;
	const dropped = dropFrames * (totalMinutes - Math.floor(totalMinutes / 10));
	return (nominalFrame - dropped) / frameRate;
}

export interface SyncResult {
	matches: SyncMatch[];
	project: Project;
	shiftedFrames: number;
	/** Drift that could not be corrected, or measurements that failed. */
	warnings?: string[];
}

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

function roundedFrameTime(value: number, fps: number): number {
	return Number((Math.round(value * fps) / fps).toFixed(6));
}

export type SyncClipsInput = z.input<typeof syncRequestSchema>;

/** Align existing timeline clips to a reference using measured audio or an explicit offset. */
export function syncClips(
	project: Project,
	assets: readonly Asset[],
	analyses: ReadonlyMap<string, MediaAnalysis | null>,
	input: SyncClipsInput,
	refinements: ReadonlyMap<string, SyncRefinement> = new Map()
): SyncResult {
	const request = syncRequestSchema.parse(input);
	if (
		request.referenceClipId &&
		request.targetClipIds.includes(request.referenceClipId)
	) {
		throw new Error("The reference clip cannot also be a sync target.");
	}
	if (new Set(request.targetClipIds).size !== request.targetClipIds.length) {
		throw new Error("Choose each sync target once.");
	}
	const reference = project.segments.find(
		(segment) => segment.id === request.referenceClipId
	);
	const targets = request.targetClipIds.map((id) => {
		const segment = project.segments.find((candidate) => candidate.id === id);
		if (!segment) {
			throw new Error("A selected sync clip is no longer on this timeline.");
		}
		return segment;
	});
	if (!reference) {
		throw new Error("The reference clip is no longer on this timeline.");
	}
	const media = new Map(assets.map((asset) => [asset.id, asset]));
	const referenceAsset = media.get(reference.assetId);
	if (!referenceAsset?.hasAudio || referenceAsset.kind === "image") {
		throw new Error("The reference clip must contain audio.");
	}
	if (trackSettingFor(project, reference.track).locked) {
		throw new Error("Unlock the reference track before syncing clips.");
	}
	for (const target of targets) {
		const targetAsset = media.get(target.assetId);
		if (!targetAsset?.hasAudio || targetAsset.kind === "image") {
			throw new Error("Every sync target must contain audio.");
		}
		if (trackSettingFor(project, target.track).locked) {
			throw new Error("Unlock every target track before syncing clips.");
		}
	}
	if (request.mode === "manual" && request.offsetSeconds === undefined) {
		throw new Error("Enter a manual offset in seconds.");
	}
	const referenceAnalysis = analyses.get(referenceAsset.id) ?? null;
	const matches: SyncMatch[] = [];
	const desiredStarts = new Map<string, number>([
		[reference.id, reference.start],
	]);
	const refined = new Map<string, { speed: number; subFrame: boolean }>();
	const warnings: string[] = [];
	for (const target of targets) {
		const targetAsset = media.get(target.assetId)!;
		let alignmentOffsetSeconds = request.offsetSeconds ?? 0;
		let confidence = 1;
		let method: SyncMatch["method"] = "manual";
		const refinement =
			request.mode === "auto" || request.mode === "audio"
				? refinements.get(target.id)
				: undefined;
		if (refinement) {
			const speed =
				refinement.drift.status === "corrected" && refinement.drift.speed
					? refinement.drift.speed
					: target.speed;
			// Align the two clips exactly at the measured anchor; a corrected
			// speed keeps them aligned through the end of the overlap.
			const anchorTime =
				reference.start +
				(refinement.anchorSeconds - reference.sourceIn) / reference.speed;
			desiredStarts.set(
				target.id,
				anchorTime -
					(refinement.anchorSeconds + refinement.lagSeconds - target.sourceIn) /
						speed
			);
			refined.set(target.id, { speed, subFrame: refinement.subFrame });
			if (refinement.drift.reason && refinement.drift.status !== "too-short") {
				warnings.push(refinement.drift.reason);
			}
			matches.push({
				alignmentOffsetSeconds: Number(refinement.lagSeconds.toFixed(4)),
				clipId: target.id,
				confidence: Number(refinement.confidence.toFixed(3)),
				drift: refinement.drift,
				method: "audio",
				offsetFrames: 0,
				offsetSeconds: 0,
			});
			continue;
		}
		if (request.mode === "timecode") {
			if (!(referenceAsset.timecodeStart && targetAsset.timecodeStart)) {
				throw new Error(
					"Embedded timecode is required on the reference and every target clip."
				);
			}
			const referenceTimecode = timecodeSeconds(
				referenceAsset.timecodeStart,
				referenceAsset.timecodeFrameRate ?? project.fps
			);
			const targetTimecode = timecodeSeconds(
				targetAsset.timecodeStart,
				targetAsset.timecodeFrameRate ?? project.fps
			);
			alignmentOffsetSeconds = referenceTimecode - targetTimecode;
			method = "timecode";
		} else if (request.mode !== "manual") {
			const targetAnalysis = analyses.get(targetAsset.id) ?? null;
			if (!(referenceAnalysis && targetAnalysis)) {
				throw new Error(
					"Analyze the reference and target audio before syncing clips."
				);
			}
			const match = correlateAudio(
				referenceAnalysis,
				targetAnalysis,
				request.searchWindowSeconds,
				request.minConfidence,
				{
					referenceIn: reference.sourceIn,
					referenceOut: reference.sourceOut,
					targetIn: target.sourceIn,
					targetOut: target.sourceOut,
				}
			);
			alignmentOffsetSeconds = match.lagSeconds;
			confidence = match.confidence;
			method = "audio";
		}
		const desiredStart =
			request.mode === "manual"
				? target.start + alignmentOffsetSeconds
				: reference.start -
					(reference.sourceIn + alignmentOffsetSeconds - target.sourceIn) /
						target.speed;
		desiredStarts.set(target.id, desiredStart);
		matches.push({
			alignmentOffsetSeconds: Number(alignmentOffsetSeconds.toFixed(3)),
			clipId: target.id,
			confidence: Number(confidence.toFixed(3)),
			method,
			offsetFrames: 0,
			offsetSeconds: 0,
		});
	}
	const minimumStart = Math.min(...desiredStarts.values());
	const shiftedFrames = Math.max(
		0,
		Math.ceil(-minimumStart * project.fps - 0.000_001)
	);
	const groupShift = shiftedFrames / project.fps;
	const nextSegments = project.segments.map((segment) => {
		const desired = desiredStarts.get(segment.id);
		if (desired === undefined) {
			return segment;
		}
		const refinement = refined.get(segment.id);
		if (!refinement) {
			const nextStart = roundedFrameTime(desired + groupShift, project.fps);
			return { ...segment, start: nextStart };
		}
		return refinedSegment(
			segment,
			desired + groupShift,
			refinement.speed,
			refinement.subFrame,
			project.fps
		);
	});
	const nextProject = validateProject({ ...project, segments: nextSegments }, [
		...assets,
	]);
	for (const match of matches) {
		const before = targets.find((segment) => segment.id === match.clipId)!;
		const after = nextProject.segments.find(
			(segment) => segment.id === match.clipId
		)!;
		match.offsetSeconds = Number((after.start - before.start).toFixed(3));
		match.offsetFrames = Math.round((after.start - before.start) * project.fps);
	}
	return warnings.length
		? { matches, project: nextProject, shiftedFrames, warnings }
		: { matches, project: nextProject, shiftedFrames };
}

/**
 * Place a refined target. Sub-frame measurements start on the next frame
 * boundary and skip the remainder in the source, so the anchor stays exact
 * instead of inheriting up to half a frame of rounding.
 */
function refinedSegment(
	segment: Project["segments"][number],
	desiredStart: number,
	speed: number,
	subFrame: boolean,
	fps: number
): Project["segments"][number] {
	const retimed =
		speed === segment.speed
			? segment
			: {
					...segment,
					keyframes: segment.keyframes.length
						? retimeKeyframes(
								segment,
								0,
								(segment.sourceOut - segment.sourceIn) / speed
							)
						: segment.keyframes,
					speed,
				};
	if (!subFrame) {
		return { ...retimed, start: roundedFrameTime(desiredStart, fps) };
	}
	const start = Number((Math.ceil(desiredStart * fps - 1e-6) / fps).toFixed(6));
	const skip = Math.max(0, (start - desiredStart) * speed);
	const sourceIn = Number((segment.sourceIn + skip).toFixed(6));
	if (sourceIn >= segment.sourceOut - 1 / fps) {
		return { ...retimed, start: roundedFrameTime(desiredStart, fps) };
	}
	return { ...retimed, sourceIn, start };
}

// ---------------------------------------------------------------------------
// Clock drift: a fine correlation near each end of the overlap.
// ---------------------------------------------------------------------------

/** Largest drift corrected through clip speed (0.5%). */
export const MAX_CORRECTABLE_DRIFT = 0.005;
/** Drift search covers ±1% of the span so larger drift is reported, not missed. */
const DRIFT_SEARCH_RATIO = 0.01;
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

interface SourceRange {
	sourceIn: number;
	sourceOut: number;
}

function targetWindow(
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

/**
 * Choose the two correlation windows for a coarse match: one at the start and
 * one at the end of the clips' overlap, in reference source time. Both
 * search widely enough to see drift beyond the correctable limit.
 */
export function driftWindowPlan(input: {
	coarseStepSeconds: number;
	lagSeconds: number;
	reference: SourceRange;
	target: SourceRange;
	targetDuration: number;
}): DriftWindowPlan | { reason: string } {
	const { lagSeconds, reference, target } = input;
	const overlapStart = Math.max(
		reference.sourceIn,
		target.sourceIn - lagSeconds
	);
	const overlapEnd = Math.min(
		reference.sourceOut,
		target.sourceOut - lagSeconds
	);
	const overlap = overlapEnd - overlapStart;
	if (!(overlap >= MIN_DRIFT_OVERLAP_SECONDS)) {
		return {
			reason: `Drift needs at least ${MIN_DRIFT_OVERLAP_SECONDS} s of shared audio; the clips overlap for ${Math.max(0, overlap).toFixed(1)} s.`,
		};
	}
	const duration = Math.min(DRIFT_WINDOW_SECONDS, overlap / 4);
	const spanSeconds = overlap - duration;
	// A whole-overlap coarse match settles near the mid-overlap lag, so under
	// drift each end can sit up to half the searched drift away from it.
	const search =
		Math.max(0.25, 2 * input.coarseStepSeconds + 0.1) +
		(DRIFT_SEARCH_RATIO * spanSeconds) / 2;
	const first: DriftWindow = {
		anchorSeconds: overlapStart + duration / 2,
		referenceDuration: duration,
		referenceStart: overlapStart,
		...targetWindow(
			overlapStart,
			duration,
			lagSeconds,
			search,
			input.targetDuration
		),
	};
	const secondStart = overlapEnd - duration;
	const second: DriftWindow = {
		anchorSeconds: secondStart + duration / 2,
		referenceDuration: duration,
		referenceStart: secondStart,
		...targetWindow(
			secondStart,
			duration,
			lagSeconds,
			search,
			input.targetDuration
		),
	};
	return { spanSeconds, windows: [first, second] };
}

/** Lag in source seconds for one window from its decoded envelopes. */
export function windowLag(
	window: DriftWindow,
	reference: Float32Array,
	target: Float32Array,
	rate = DRIFT_ENVELOPE_RATE
): EnvelopeLag | null {
	const match = bestEnvelopeLag(reference, target, rate);
	if (!match) {
		return null;
	}
	return {
		confidence: match.confidence,
		lagSeconds: window.targetStart + match.lagSeconds - window.referenceStart,
	};
}

/** `(offset2 - offset1) / span` for two anchored lag measurements. */
export function measureDrift(
	first: { anchorSeconds: number; lagSeconds: number },
	second: { anchorSeconds: number; lagSeconds: number }
): number {
	const span = second.anchorSeconds - first.anchorSeconds;
	if (!(span > 0)) {
		throw new Error("Drift windows must be in source order.");
	}
	return (second.lagSeconds - first.lagSeconds) / span;
}

/**
 * Decide what to do with a measured drift. Within ±0.5% the target speed
 * becomes `referenceSpeed * (1 + drift)`; beyond it the drift is reported
 * as a warning. Drift below half a frame over the overlap is negligible.
 */
export function driftDecision(input: {
	correct: boolean;
	drift: number;
	fps: number;
	overlapSeconds: number;
	referenceSpeed: number;
	spanSeconds: number;
}): SyncDrift {
	const { drift, fps } = input;
	const endErrorFrames = Number(
		(
			(Math.abs(drift) * input.overlapSeconds * fps) /
			input.referenceSpeed
		).toFixed(2)
	);
	const base = {
		driftPercent: Number((drift * 100).toFixed(4)),
		endErrorFrames,
		spanSeconds: Number(input.spanSeconds.toFixed(3)),
	};
	if (endErrorFrames < 0.5) {
		return { ...base, status: "negligible" };
	}
	if (Math.abs(drift) > MAX_CORRECTABLE_DRIFT) {
		return {
			...base,
			reason: `Measured clock drift of ${base.driftPercent.toFixed(3)}% exceeds the ±${MAX_CORRECTABLE_DRIFT * 100}% correction limit; the clips separate by ${endErrorFrames} frames by the end. Check the source frame rates or sync shorter sections.`,
			status: "too-large",
		};
	}
	if (!input.correct) {
		return {
			...base,
			reason: `Clock drift of ${base.driftPercent.toFixed(3)}% left uncorrected; the clips separate by ${endErrorFrames} frames by the end.`,
			status: "disabled",
		};
	}
	const speed = Number((input.referenceSpeed * (1 + drift)).toFixed(6));
	if (speed < MIN_CLIP_SPEED || speed > MAX_CLIP_SPEED) {
		return {
			...base,
			reason: "The drift-corrected speed is outside the clip speed range.",
			status: "too-large",
		};
	}
	return { ...base, speed, status: "corrected" };
}

/** Read one source window as a drift envelope at `DRIFT_ENVELOPE_RATE`. */
export type DriftEnvelopeReader = (
	role: "reference" | "target",
	start: number,
	duration: number
) => Promise<Float32Array>;

/**
 * Measure a fine anchor lag and clock drift for one coarse audio match.
 * Measurement failures fall back to the coarse lag with an `unmeasured`
 * drift and a reason, so syncing still succeeds.
 */
export async function refineSyncMatch(
	input: {
		coarse: { confidence: number; lagSeconds: number };
		coarseStepSeconds: number;
		correct: boolean;
		fps: number;
		reference: SourceRange & { speed: number };
		target: SourceRange;
		targetDuration: number;
	},
	read: DriftEnvelopeReader
): Promise<SyncRefinement> {
	const fallback = (reason: string): SyncRefinement => ({
		anchorSeconds: input.reference.sourceIn,
		confidence: input.coarse.confidence,
		drift: { reason, status: "unmeasured" },
		lagSeconds: input.coarse.lagSeconds,
		subFrame: false,
	});
	const plan = driftWindowPlan({
		coarseStepSeconds: input.coarseStepSeconds,
		lagSeconds: input.coarse.lagSeconds,
		reference: input.reference,
		target: input.target,
		targetDuration: input.targetDuration,
	});
	if ("reason" in plan) {
		return {
			...fallback(plan.reason),
			drift: { reason: plan.reason, status: "too-short" },
		};
	}
	const lags: EnvelopeLag[] = [];
	for (const window of plan.windows) {
		let reference: Float32Array;
		let target: Float32Array;
		try {
			reference = await read(
				"reference",
				window.referenceStart,
				window.referenceDuration
			);
			target = await read("target", window.targetStart, window.targetDuration);
		} catch (error) {
			return fallback(
				`Could not decode audio to measure drift: ${error instanceof Error ? error.message : "unknown error"}`
			);
		}
		const match = windowLag(window, reference, target);
		if (!match || match.confidence < MIN_DRIFT_CONFIDENCE) {
			return lags[0]
				? {
						anchorSeconds: plan.windows[0].anchorSeconds,
						confidence: lags[0].confidence,
						drift: {
							reason:
								"The end-of-overlap audio did not match clearly enough to measure drift.",
							status: "unmeasured",
						},
						lagSeconds: lags[0].lagSeconds,
						subFrame: true,
					}
				: fallback(
						"The start-of-overlap audio did not match clearly enough for a fine sync."
					);
		}
		lags.push(match);
	}
	const [first, second] = lags as [EnvelopeLag, EnvelopeLag];
	const [firstWindow, secondWindow] = plan.windows;
	const drift = measureDrift(
		{ anchorSeconds: firstWindow.anchorSeconds, lagSeconds: first.lagSeconds },
		{ anchorSeconds: secondWindow.anchorSeconds, lagSeconds: second.lagSeconds }
	);
	return {
		anchorSeconds: firstWindow.anchorSeconds,
		confidence: Math.min(first.confidence, second.confidence),
		drift: driftDecision({
			correct: input.correct,
			drift,
			fps: input.fps,
			overlapSeconds: plan.spanSeconds + firstWindow.referenceDuration,
			referenceSpeed: input.reference.speed,
			spanSeconds: plan.spanSeconds,
		}),
		lagSeconds: first.lagSeconds,
		subFrame: true,
	};
}

/** Seconds between coarse waveform samples of two completed analyses. */
export function coarseStepSeconds(
	reference: MediaAnalysis,
	target: MediaAnalysis
): number {
	return Math.max(
		0.1,
		reference.duration / Math.max(1, reference.waveform.length),
		target.duration / Math.max(1, target.waveform.length)
	);
}

/**
 * The drift part of a sync status line: how many clips had clock drift
 * corrected, then every warning the sync returned. Empty when neither applies.
 */
export function syncDriftNotice(
	matches: readonly { drift?: Pick<SyncDrift, "status"> }[],
	warnings: readonly string[]
): string {
	const corrected = matches.filter(
		(match) => match.drift?.status === "corrected"
	).length;
	const parts = [
		...(corrected
			? [
					`Clock drift corrected on ${corrected} clip${corrected === 1 ? "" : "s"}.`,
				]
			: []),
		...warnings,
	];
	return parts.join(" ");
}
