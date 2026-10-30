import { z } from "zod";
import type { MediaAnalysis } from "./analysis.ts";
import { retimeKeyframes } from "./animation.ts";
import {
	type Asset,
	assetTimecodeSchema,
	type Project,
	trackSettingFor,
	validateProject,
} from "./project.ts";
import { correlateAudio } from "./sync-correlation.ts";
import type { SyncDrift, SyncRefinement } from "./sync-drift.ts";

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

export type { AudioCorrelation } from "./sync-correlation.ts";
// biome-ignore lint/performance/noBarrelFile: keeps the public sync module path stable.
export { correlateAudio } from "./sync-correlation.ts";
export type {
	DriftWindow,
	DriftWindowPlan,
	EnvelopeLag,
	SyncDrift,
	SyncDriftStatus,
	SyncRefinement,
} from "./sync-drift.ts";
export {
	bestEnvelopeLag,
	DRIFT_DECODE_RATE,
	DRIFT_ENVELOPE_RATE,
	DRIFT_WINDOW_SECONDS,
	MAX_CORRECTABLE_DRIFT,
	MIN_DRIFT_CONFIDENCE,
	MIN_DRIFT_OVERLAP_SECONDS,
	pcmEnvelope,
} from "./sync-drift.ts";
export type { DriftEnvelopeReader } from "./sync-drift-window.ts";
export {
	coarseStepSeconds,
	driftDecision,
	driftWindowPlan,
	measureDrift,
	refineSyncMatch,
	syncDriftNotice,
	windowLag,
} from "./sync-drift-window.ts";
