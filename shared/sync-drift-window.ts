import type { MediaAnalysis } from "./analysis.ts";
import { MAX_CLIP_SPEED, MIN_CLIP_SPEED } from "./audio.ts";
import {
	bestEnvelopeLag,
	DRIFT_ENVELOPE_RATE,
	DRIFT_SEARCH_RATIO,
	DRIFT_WINDOW_SECONDS,
	type DriftWindow,
	type DriftWindowPlan,
	type EnvelopeLag,
	MAX_CORRECTABLE_DRIFT,
	MIN_DRIFT_CONFIDENCE,
	MIN_DRIFT_OVERLAP_SECONDS,
	type SourceRange,
	type SyncDrift,
	type SyncRefinement,
	targetWindow,
} from "./sync-drift.ts";

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
