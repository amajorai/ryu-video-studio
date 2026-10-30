/**
 * Audio-driven avatar lip-sync.
 *
 * A loudness envelope (the 50 Hz speech-band energy, or the coarser analysis
 * waveform) is sampled along the avatar's lifetime through its audio source,
 * gated and normalized, shaped as `openness = level^0.6`, smoothed without
 * lag, and refined with transcript words: vowel-heavy words open wider and
 * bilabial consonants (`m`, `b`, `p`) close the mouth near where they fall in
 * the word. The curve is decimated to the avatar's free rig keyframe budget
 * and written as `mouth` rig keyframes. Every function here is pure and
 * deterministic apart from the injected keyframe id factory.
 *
 * The generated keyframes are self-contained: no reference back to the source
 * clip or media is persisted in `avatar.lipSync`, because `validateProject`
 * treats that field as a hard reference and would reject every later save once
 * the clip or media is removed. A legacy `lipSync` is cleared on the next run,
 * and `pruneDanglingLipSync` repairs projects that still carry a stale one.
 */

import type { AvatarRigKeyframe } from "./avatar.ts";
import {
	clamp01,
	DEFAULT_LIP_SYNC_SENSITIVITY,
	DEFAULT_LIP_SYNC_SMOOTHING,
	decimateLipSync,
	type LipSyncWord,
	lipSyncCurve,
	MAX_AVATAR_RIG_KEYFRAMES,
} from "./avatar-lipsync-curve.ts";
import {
	hasAudio,
	isLipSyncClipAudible,
	type LipSyncEnvelope,
	type ResolvedLipSyncSource,
	segmentProjectEnd,
} from "./avatar-lipsync-source.ts";
import type { Asset, Avatar, Project } from "./project.ts";

export {
	DEFAULT_LIP_SYNC_SENSITIVITY,
	DEFAULT_LIP_SYNC_SMOOTHING,
	decimateLipSync,
	LIP_SYNC_CLOSURE_SECONDS,
	LIP_SYNC_FRAME_SECONDS,
	LIP_SYNC_OPENNESS_EXPONENT,
	LIP_SYNC_RATE,
	LIP_SYNC_TOLERANCE,
	type LipSyncCurve,
	type LipSyncCurveInput,
	type LipSyncPoint,
	type LipSyncWord,
	lipSyncCurve,
	lipSyncGate,
	lipSyncSampleTimes,
	MAX_AVATAR_RIG_KEYFRAMES,
	smoothOpenness,
	wordShape,
} from "./avatar-lipsync-curve.ts";
export {
	PHOTOREAL_MAX_SECONDS,
	type PhotorealInputsRequest,
	type PhotorealMode,
	type PhotorealPlan,
	photorealInputsRequestSchema,
	photorealModeSchema,
	photorealPlan,
} from "./avatar-lipsync-photoreal.ts";
export {
	type AvatarLipSyncRequest,
	avatarLipSyncRequestSchema,
	envelopeFromDb,
	envelopeFromWaveform,
	envelopeLevelAt,
	isLipSyncClipAudible,
	type LipSyncEnvelope,
	type LipSyncEnvelopeKind,
	type LipSyncSourceMap,
	lipSyncEnvelopeKindSchema,
	lipSyncSourceTime,
	type ResolvedLipSyncSource,
	resolveLipSyncSource,
} from "./avatar-lipsync-source.ts";

/** Rig keyframe slots left for `mouth` after the avatar's other keyframes. */
export function lipSyncKeyframeBudget(avatar: Avatar): number {
	const others = (avatar.rigKeyframes ?? []).filter(
		(keyframe) => keyframe.property !== "mouth"
	).length;
	return MAX_AVATAR_RIG_KEYFRAMES - others;
}

export interface AvatarLipSyncResult {
	avatar: Avatar;
	keyframes: number;
	project: Project;
	voicedRatio: number;
}

export interface ApplyAvatarLipSyncInput {
	avatarId: string;
	envelope: LipSyncEnvelope;
	/** Keyframe id factory; tests inject a deterministic one. */
	newId?: () => string;
	sensitivity?: number;
	smoothing?: number;
	source: ResolvedLipSyncSource;
	words?: readonly LipSyncWord[];
}

/**
 * Replace an avatar's `mouth` rig keyframes with the lip-sync curve. Other rig
 * keyframes stay; a legacy `avatar.lipSync` reference is cleared (see the
 * module comment).
 */
export function applyAvatarLipSync(
	project: Project,
	input: ApplyAvatarLipSyncInput
): AvatarLipSyncResult {
	const avatar = project.avatars.find((item) => item.id === input.avatarId);
	if (!avatar) {
		throw new Error("The avatar is not in this project.");
	}
	const budget = lipSyncKeyframeBudget(avatar);
	if (budget < 2) {
		throw new Error(
			"Lip-sync needs at least two free rig keyframes. Remove some arm, leg, or head keyframes first."
		);
	}
	const sensitivity = clamp01(
		input.sensitivity ?? DEFAULT_LIP_SYNC_SENSITIVITY
	);
	const smoothing = clamp01(input.smoothing ?? DEFAULT_LIP_SYNC_SMOOTHING);
	const duration = avatar.end - avatar.start;
	const curve = lipSyncCurve({
		avatarDuration: duration,
		avatarStart: avatar.start,
		envelope: input.envelope,
		map: input.source.map,
		sensitivity,
		smoothing,
		words: input.words,
	});
	const newId = input.newId ?? (() => crypto.randomUUID());
	const mouth: AvatarRigKeyframe[] = decimateLipSync(
		curve.times,
		curve.values,
		budget
	).map((point) => ({
		id: newId(),
		property: "mouth",
		time: Math.min(duration, Math.round(point.time * 1000) / 1000),
		value: point.value,
	}));
	const { lipSync: _legacy, ...rest } = avatar;
	const updated: Avatar = {
		...rest,
		rigKeyframes: [
			...(avatar.rigKeyframes ?? []).filter(
				(keyframe) => keyframe.property !== "mouth"
			),
			...mouth,
		].sort((a, b) => a.time - b.time),
	};
	return {
		avatar: updated,
		keyframes: mouth.length,
		project: {
			...project,
			avatars: project.avatars.map((item) =>
				item.id === avatar.id ? updated : item
			),
		},
		voicedRatio: curve.voicedRatio,
	};
}

/**
 * Drop `avatar.lipSync` entries whose media or clip no longer exists, keeping
 * the mouth keyframes. Returns the same project object when nothing changes,
 * so callers can apply it before `validateProject` after removing clips or
 * deleting media.
 */
export function pruneDanglingLipSync(
	project: Project,
	assets: readonly Asset[]
): Project {
	const segmentIds = new Set(project.segments.map((segment) => segment.id));
	const dangling = (avatar: Avatar) => {
		const link = avatar.lipSync;
		if (!link) {
			return false;
		}
		const asset = assets.find((item) => item.id === link.assetId);
		return (
			!(asset && hasAudio(asset)) ||
			(link.segmentId !== undefined && !segmentIds.has(link.segmentId))
		);
	};
	if (!project.avatars.some(dangling)) {
		return project;
	}
	return {
		...project,
		avatars: project.avatars.map((avatar) => {
			if (!dangling(avatar)) {
				return avatar;
			}
			const { lipSync: _stale, ...rest } = avatar;
			return rest;
		}),
	};
}

/**
 * Whole-sentence message formatter for source labels; structurally matches
 * `LiteralMessage` from `@ryu/i18n/react`, which this shared module does not
 * import.
 */
export type LipSyncLabelMessage = (
	source: string,
	values?: Readonly<Record<string, string | number>>
) => string;

/** English fallback: fills `{name}` placeholders verbatim. */
const englishLabel: LipSyncLabelMessage = (source, values = {}) =>
	source.replace(/\{(\w+)\}/g, (match, key: string) =>
		key in values ? String(values[key]) : match
	);

export interface LipSyncSourceOption {
	assetId: string;
	label: string;
	segmentId?: string;
}

/**
 * Audio sources offered for an avatar: audible timeline clips with audio that
 * overlap it (in timeline order), then library media with audio. Muted,
 * hidden, high-speed-muted, zero-volume, and hidden/muted/non-soloed-track
 * clips are left out because the viewer never hears them. Pass the editor's
 * `tl` (from `useLiteralMessages`) to localize the labels; without it they
 * stay English.
 */
export function lipSyncSourceOptions(
	project: Project,
	assets: readonly Asset[],
	avatar: Avatar,
	tl: LipSyncLabelMessage = englishLabel
): LipSyncSourceOption[] {
	const byId = new Map(assets.map((asset) => [asset.id, asset]));
	const clips = project.segments
		.filter((segment) => {
			const asset = byId.get(segment.assetId);
			return (
				asset !== undefined &&
				hasAudio(asset) &&
				isLipSyncClipAudible(project, segment) &&
				segment.start < avatar.end &&
				segmentProjectEnd(segment) > avatar.start
			);
		})
		.sort((a, b) => a.start - b.start || a.track - b.track)
		.map((segment) => ({
			assetId: segment.assetId,
			label: tl("Clip: {name} at {start}s (track {track})", {
				name: byId.get(segment.assetId)?.name ?? "media",
				start: segment.start.toFixed(2),
				track: segment.track + 1,
			}),
			segmentId: segment.id,
		}));
	const media = assets.filter(hasAudio).map((asset) => ({
		assetId: asset.id,
		label: tl("Media: {name} from the avatar's start", { name: asset.name }),
	}));
	return [...clips, ...media];
}

/** Stable option key for a source choice. */
export const lipSyncSourceKey = (option: {
	assetId: string;
	segmentId?: string;
}) =>
	option.segmentId ? `segment:${option.segmentId}` : `asset:${option.assetId}`;
