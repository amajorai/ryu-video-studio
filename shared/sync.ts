import { z } from "zod";
import type { MediaAnalysis } from "./analysis.ts";
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
	})
	.strict();
export type SyncRequest = z.infer<typeof syncRequestSchema>;

export interface SyncMatch {
	alignmentOffsetSeconds: number;
	clipId: string;
	confidence: number;
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
	step: number
): number | null {
	const start = Math.max(0, -lag);
	const end = Math.min(reference.duration, target.duration - lag);
	const count = Math.floor((end - start) / step) + 1;
	if (count < 8) {
		return null;
	}
	const referenceValues: number[] = [];
	const targetValues: number[] = [];
	for (let index = 0; index < count; index += 1) {
		const second = Math.min(end, start + index * step);
		referenceValues.push(
			waveformValue(reference.waveform, reference.duration, second)
		);
		targetValues.push(
			waveformValue(target.waveform, target.duration, second + lag)
		);
	}
	const referenceMean =
		referenceValues.reduce((total, value) => total + value, 0) /
		referenceValues.length;
	const targetMean =
		targetValues.reduce((total, value) => total + value, 0) /
		targetValues.length;
	let numerator = 0;
	let referenceVariance = 0;
	let targetVariance = 0;
	for (const [index, value] of referenceValues.entries()) {
		const referenceDelta = value - referenceMean;
		const targetDelta = (targetValues[index] ?? 0) - targetMean;
		numerator += referenceDelta * targetDelta;
		referenceVariance += referenceDelta * referenceDelta;
		targetVariance += targetDelta * targetDelta;
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
export function correlateAudio(
	reference: MediaAnalysis,
	target: MediaAnalysis,
	searchWindowSeconds: number,
	minConfidence: number
): { confidence: number; lagSeconds: number } {
	if (
		reference.status !== "completed" ||
		target.status !== "completed" ||
		reference.waveform.length < 8 ||
		target.waveform.length < 8
	) {
		throw new Error(
			"Complete audio analysis is required before syncing clips."
		);
	}
	const step = Math.max(
		0.1,
		Math.min(
			0.25,
			Math.max(
				reference.duration / reference.waveform.length,
				target.duration / target.waveform.length
			)
		)
	);
	const window = Math.min(120, Math.max(step, searchWindowSeconds));
	let best: { confidence: number; lagSeconds: number } | null = null;
	for (let lag = -window; lag <= window + step * 0.25; lag += step) {
		const score = correlationAt(reference, target, lag, step);
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

/** Align existing timeline clips to a reference using measured audio or an explicit offset. */
export function syncClips(
	project: Project,
	assets: readonly Asset[],
	analyses: ReadonlyMap<string, MediaAnalysis | null>,
	input: unknown
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
	for (const target of targets) {
		const targetAsset = media.get(target.assetId)!;
		let alignmentOffsetSeconds = request.offsetSeconds ?? 0;
		let confidence = 1;
		let method: SyncMatch["method"] = "manual";
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
				request.minConfidence
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
		const nextStart = roundedFrameTime(desired + groupShift, project.fps);
		return { ...segment, start: nextStart };
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
	return { matches, project: nextProject, shiftedFrames };
}
