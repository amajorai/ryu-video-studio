/** Lip-sync request schemas, loudness envelopes, and audio source resolution (see `avatar-lipsync.ts`). */

import { z } from "zod";
import { type Asset, idSchema, type Project, type Segment } from "./project.ts";
import { clipHeard } from "./sync-lock.ts";

export const lipSyncEnvelopeKindSchema = z.enum(["audio", "analysis"]);
export type LipSyncEnvelopeKind = z.infer<typeof lipSyncEnvelopeKindSchema>;

export const avatarLipSyncRequestSchema = z
	.object({
		avatarId: idSchema,
		/** Source media aligned to the avatar's start. */
		assetId: idSchema.optional(),
		/** A timeline clip whose audio drives the mouth while it plays. */
		segmentId: idSchema.optional(),
		sensitivity: z.number().finite().min(0).max(1).optional(),
		smoothing: z.number().finite().min(0).max(1).optional(),
		/**
		 * `audio` (default) measures 20 ms speech-band energy with FFmpeg;
		 * `analysis` reuses the cached media analysis waveform (coarser, no
		 * FFmpeg run).
		 */
		envelope: lipSyncEnvelopeKindSchema.optional(),
		revision: z.number().int().nonnegative(),
	})
	.strict();
export type AvatarLipSyncRequest = z.infer<typeof avatarLipSyncRequestSchema>;

/** Linear amplitude (0..1) per frame; frame `i` is centered at `(i+0.5)*frameSeconds`. */
export interface LipSyncEnvelope {
	frameSeconds: number;
	values: ArrayLike<number>;
}

/** Envelope from per-frame energy in dBFS (the VAD features). */
export function envelopeFromDb(
	energyDb: ArrayLike<number>,
	frameSeconds: number
): LipSyncEnvelope {
	const values = new Float32Array(energyDb.length);
	for (let index = 0; index < energyDb.length; index += 1) {
		const db = energyDb[index] ?? Number.NEGATIVE_INFINITY;
		values[index] = Number.isFinite(db) ? Math.min(1, 10 ** (db / 20)) : 0;
	}
	return { frameSeconds, values };
}

/** Envelope from the analysis waveform, whose bins span the whole source. */
export function envelopeFromWaveform(
	waveform: readonly number[],
	duration: number
): LipSyncEnvelope {
	return {
		frameSeconds: waveform.length
			? Math.max(duration, 0.1) / waveform.length
			: 1,
		values: waveform,
	};
}

/** Linear interpolation between frame centers; outside the envelope is silent. */
export function envelopeLevelAt(
	envelope: LipSyncEnvelope,
	sourceTime: number
): number {
	const { frameSeconds, values } = envelope;
	const count = values.length;
	if (!(count && frameSeconds > 0) || sourceTime < 0) {
		return 0;
	}
	if (sourceTime > count * frameSeconds) {
		return 0;
	}
	const position = sourceTime / frameSeconds - 0.5;
	const left = Math.max(0, Math.min(count - 1, Math.floor(position)));
	const right = Math.min(count - 1, left + 1);
	const progress = Math.max(0, Math.min(1, position - left));
	const a = values[left] ?? 0;
	const b = values[right] ?? 0;
	return a + (b - a) * progress;
}

/** How avatar-local time maps to source time. */
export type LipSyncSourceMap =
	| { kind: "asset"; duration: number }
	| {
			kind: "segment";
			sourceIn: number;
			sourceOut: number;
			speed: number;
			start: number;
	  };

export const segmentProjectEnd = (segment: Segment) =>
	segment.start + (segment.sourceOut - segment.sourceIn) / segment.speed;

/** Source time heard at avatar-local `localTime`, or undefined when nothing plays. */
export function lipSyncSourceTime(
	map: LipSyncSourceMap,
	avatarStart: number,
	localTime: number
): number | undefined {
	if (map.kind === "asset") {
		return localTime <= map.duration ? localTime : undefined;
	}
	const projectTime = avatarStart + localTime;
	const end = map.start + (map.sourceOut - map.sourceIn) / map.speed;
	if (projectTime < map.start || projectTime >= end) {
		return undefined;
	}
	return map.sourceIn + (projectTime - map.start) * map.speed;
}

export interface ResolvedLipSyncSource {
	asset: Asset;
	map: LipSyncSourceMap;
	segmentId?: string;
}

export const hasAudio = (asset: Asset) =>
	asset.kind === "audio" || asset.hasAudio;

/**
 * Whether the viewer hears a clip (`clipHeard`): not muted or hidden, on an
 * audible visible track, not past the high-speed mute, and with a non-zero
 * volume or a volume keyframe that raises it above zero. It matches the
 * export's `segmentAudible`.
 */
export function isLipSyncClipAudible(
	project: Pick<Project, "trackSettings">,
	segment: Segment
): boolean {
	return clipHeard(project, segment);
}

/**
 * Resolve the audio that drives an avatar. A segment id wins (its asset must
 * match `assetId` when both are given, and the clip must be audible).
 */
export function resolveLipSyncSource(
	project: Project,
	assets: readonly Asset[],
	request: { assetId?: string; segmentId?: string }
): ResolvedLipSyncSource {
	const { assetId, segmentId } = request;
	if (segmentId) {
		const segment = project.segments.find((item) => item.id === segmentId);
		if (!segment) {
			throw new Error("The lip-sync clip is not on the timeline.");
		}
		if (assetId && assetId !== segment.assetId) {
			throw new Error("The lip-sync clip does not use the chosen media.");
		}
		const asset = assets.find((item) => item.id === segment.assetId);
		if (!(asset && hasAudio(asset))) {
			throw new Error("The lip-sync clip has no audio.");
		}
		if (!isLipSyncClipAudible(project, segment)) {
			throw new Error(
				"The lip-sync clip is muted or silent. Unmute it or choose another source."
			);
		}
		return {
			asset,
			map: {
				kind: "segment",
				sourceIn: segment.sourceIn,
				sourceOut: segment.sourceOut,
				speed: segment.speed,
				start: segment.start,
			},
			segmentId,
		};
	}
	if (!assetId) {
		throw new Error("Choose an audio clip or media to drive the lip-sync.");
	}
	const asset = assets.find((item) => item.id === assetId);
	if (!(asset && hasAudio(asset))) {
		throw new Error("The lip-sync media has no audio.");
	}
	return { asset, map: { kind: "asset", duration: asset.duration } };
}
