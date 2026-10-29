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

import { z } from "zod";
import type { AvatarRigKeyframe } from "./avatar.ts";
import {
	type Asset,
	type Avatar,
	idSchema,
	type Project,
	type Segment,
} from "./project.ts";
import { studioError } from "./studio-error.ts";
import { clipHeard } from "./sync-lock.ts";

/** Rig keyframes an avatar may hold (`avatarSchema.rigKeyframes`). */
export const MAX_AVATAR_RIG_KEYFRAMES = 100;
/** Sampling rate of the generated mouth curve, in frames per second. */
export const LIP_SYNC_RATE = 50;
export const LIP_SYNC_FRAME_SECONDS = 1 / LIP_SYNC_RATE;
export const DEFAULT_LIP_SYNC_SENSITIVITY = 0.5;
export const DEFAULT_LIP_SYNC_SMOOTHING = 0.4;
/** Exponent applied to the normalized level so quiet syllables still read. */
export const LIP_SYNC_OPENNESS_EXPONENT = 0.6;
/** Decimation stops once the curve is within this openness of the samples. */
export const LIP_SYNC_TOLERANCE = 0.02;
/** Half-width of a bilabial closure around its estimated time. */
export const LIP_SYNC_CLOSURE_SECONDS = 0.035;
/** Openness kept during a bilabial closure. */
const CLOSURE_FACTOR = 0.08;
/** Openness gain for vowel-heavy words. */
const VOWEL_WIDEN_FACTOR = 1.25;
const VOWEL_WORD_RATIO = 0.5;
/** Reference level percentile among voiced samples. */
const REFERENCE_PERCENTILE = 0.95;
const VOWELS = new Set(["a", "e", "i", "o", "u", "y"]);
const BILABIALS = new Set(["b", "m", "p"]);

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

const segmentProjectEnd = (segment: Segment) =>
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

const hasAudio = (asset: Asset) => asset.kind === "audio" || asset.hasAudio;

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

export interface LipSyncWord {
	end: number;
	start: number;
	text: string;
}

export interface LipSyncCurveInput {
	avatarDuration: number;
	avatarStart: number;
	envelope: LipSyncEnvelope;
	map: LipSyncSourceMap;
	sensitivity: number;
	smoothing: number;
	/** Transcript words in source time. */
	words?: readonly LipSyncWord[];
}

export interface LipSyncPoint {
	time: number;
	value: number;
}

export interface LipSyncCurve {
	/** Avatar-local sample times (50 Hz, plus the exact end). */
	times: number[];
	/** Mouth openness per sample, 0 (closed) to 1. */
	values: number[];
	/** Share of samples with an open mouth. */
	voicedRatio: number;
}

/** Sample times across the avatar's lifetime, ending exactly at its duration. */
export function lipSyncSampleTimes(duration: number): number[] {
	const times: number[] = [];
	const span = Math.max(0, duration);
	for (let index = 0; ; index += 1) {
		const time = index * LIP_SYNC_FRAME_SECONDS;
		if (time >= span - 0.001) {
			break;
		}
		times.push(time);
	}
	times.push(span);
	return times;
}

/** Gate level for a sensitivity: -30 dBFS at 0 down to -60 dBFS at 1. */
export const lipSyncGate = (sensitivity: number) =>
	10 ** ((-30 - 30 * clamp01(sensitivity)) / 20);

function clamp01(value: number): number {
	return Math.max(0, Math.min(1, value));
}

function percentile(values: readonly number[], share: number): number {
	if (!values.length) {
		return 0;
	}
	const sorted = [...values].sort((a, b) => a - b);
	const index = Math.min(
		sorted.length - 1,
		Math.max(0, Math.round((sorted.length - 1) * share))
	);
	return sorted[index] ?? 0;
}

/** Zero-phase one-pole smoothing: forward then backward, so peaks never lag. */
export function smoothOpenness(
	values: readonly number[],
	smoothing: number
): number[] {
	const alpha = 1 - 0.9 * clamp01(smoothing);
	if (alpha >= 1 || values.length < 2) {
		return [...values];
	}
	const forward = [...values];
	for (let index = 1; index < forward.length; index += 1) {
		const previous = forward[index - 1] ?? 0;
		forward[index] = previous + alpha * ((forward[index] ?? 0) - previous);
	}
	for (let index = forward.length - 2; index >= 0; index -= 1) {
		const next = forward[index + 1] ?? 0;
		forward[index] = next + alpha * ((forward[index] ?? 0) - next);
	}
	return forward;
}

interface WordShape {
	closures: number[];
	end: number;
	start: number;
	widen: number;
}

/** Vowel widening and bilabial closure times (source time) for one word. */
export function wordShape(word: LipSyncWord): WordShape | undefined {
	const letters = word.text
		.toLowerCase()
		.normalize("NFD")
		.replace(/[^a-z]/g, "");
	const duration = word.end - word.start;
	if (!letters || duration <= 0) {
		return undefined;
	}
	let vowels = 0;
	const closures: number[] = [];
	for (let index = 0; index < letters.length; index += 1) {
		const letter = letters[index] ?? "";
		if (VOWELS.has(letter)) {
			vowels += 1;
		}
		// Doubled bilabials ("pp", "mb") are one closure.
		if (BILABIALS.has(letter) && !BILABIALS.has(letters[index - 1] ?? "")) {
			closures.push(word.start + ((index + 0.5) / letters.length) * duration);
		}
	}
	return {
		closures,
		end: word.end,
		start: word.start,
		widen: vowels / letters.length >= VOWEL_WORD_RATIO ? VOWEL_WIDEN_FACTOR : 1,
	};
}

/** Index of the last word starting at or before `time` (words sorted by start). */
function wordIndexAt(shapes: readonly WordShape[], time: number): number {
	let low = 0;
	let high = shapes.length - 1;
	let found = -1;
	while (low <= high) {
		const middle = (low + high) >> 1;
		if ((shapes[middle]?.start ?? 0) <= time) {
			found = middle;
			low = middle + 1;
		} else {
			high = middle - 1;
		}
	}
	return found;
}

function wordFactor(shapes: readonly WordShape[], time: number): number {
	const index = wordIndexAt(shapes, time);
	const shape = shapes[index];
	if (!shape || time >= shape.end) {
		return 1;
	}
	for (const closure of shape.closures) {
		if (Math.abs(time - closure) <= LIP_SYNC_CLOSURE_SECONDS) {
			return CLOSURE_FACTOR;
		}
	}
	return shape.widen;
}

/** The sampled mouth-openness curve for an avatar. */
export function lipSyncCurve(input: LipSyncCurveInput): LipSyncCurve {
	const times = lipSyncSampleTimes(input.avatarDuration);
	const sourceTimes = times.map((time) =>
		lipSyncSourceTime(input.map, input.avatarStart, time)
	);
	const gate = lipSyncGate(input.sensitivity);
	const levels = sourceTimes.map((sourceTime) => {
		if (sourceTime === undefined) {
			return 0;
		}
		const level = envelopeLevelAt(input.envelope, sourceTime);
		return level > gate ? level : 0;
	});
	const voiced = levels.filter((level) => level > 0);
	const reference = percentile(voiced, REFERENCE_PERCENTILE);
	// Higher sensitivity lets quieter syllables reach full openness.
	const gain = 0.7 + 0.6 * clamp01(input.sensitivity);
	const shaped = levels.map((level) => {
		if (!(level > 0 && reference > gate)) {
			return 0;
		}
		const normalized = clamp01(((level - gate) / (reference - gate)) * gain);
		return normalized ** LIP_SYNC_OPENNESS_EXPONENT;
	});
	const smoothed = smoothOpenness(shaped, input.smoothing);
	const shapes = (input.words ?? [])
		.map(wordShape)
		.filter((shape): shape is WordShape => shape !== undefined)
		.sort((a, b) => a.start - b.start);
	const values = smoothed.map((value, index) => {
		const sourceTime = sourceTimes[index];
		const factor =
			sourceTime === undefined || !shapes.length
				? 1
				: wordFactor(shapes, sourceTime);
		const result = clamp01(value * factor);
		return result < 0.005 ? 0 : Math.round(result * 1000) / 1000;
	});
	const open = values.filter((value) => value > 0).length;
	return {
		times,
		values,
		voicedRatio: values.length ? open / values.length : 0,
	};
}

interface Span {
	error: number;
	errorIndex: number;
	from: number;
	to: number;
}

function spanError(
	times: readonly number[],
	values: readonly number[],
	from: number,
	to: number
): Span {
	const t0 = times[from] ?? 0;
	const t1 = times[to] ?? 0;
	const v0 = values[from] ?? 0;
	const v1 = values[to] ?? 0;
	let error = 0;
	let errorIndex = -1;
	for (let index = from + 1; index < to; index += 1) {
		const progress = t1 > t0 ? ((times[index] ?? 0) - t0) / (t1 - t0) : 0;
		const deviation = Math.abs(
			(values[index] ?? 0) - (v0 + (v1 - v0) * progress)
		);
		if (deviation > error) {
			error = deviation;
			errorIndex = index;
		}
	}
	return { error, errorIndex, from, to };
}

/**
 * Keep at most `budget` points (endpoints always kept) by repeatedly adding
 * the sample farthest from the current piecewise-linear curve, which is how
 * the rig interpolates. Stops early once every sample is within `tolerance`.
 */
export function decimateLipSync(
	times: readonly number[],
	values: readonly number[],
	budget: number,
	tolerance = LIP_SYNC_TOLERANCE
): LipSyncPoint[] {
	const count = Math.min(times.length, values.length);
	if (count === 0 || budget < 1) {
		return [];
	}
	const point = (index: number): LipSyncPoint => ({
		time: times[index] ?? 0,
		value: values[index] ?? 0,
	});
	if (count === 1 || budget === 1) {
		return [point(0)];
	}
	const kept = new Set<number>([0, count - 1]);
	const spans: Span[] = [spanError(times, values, 0, count - 1)];
	while (kept.size < budget) {
		let worst = 0;
		for (let index = 1; index < spans.length; index += 1) {
			if ((spans[index]?.error ?? 0) > (spans[worst]?.error ?? 0)) {
				worst = index;
			}
		}
		const span = spans[worst];
		if (!span || span.errorIndex < 0 || span.error <= tolerance) {
			break;
		}
		kept.add(span.errorIndex);
		spans.splice(
			worst,
			1,
			spanError(times, values, span.from, span.errorIndex),
			spanError(times, values, span.errorIndex, span.to)
		);
	}
	return [...kept].sort((a, b) => a - b).map(point);
}

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

export interface LipSyncSourceOption {
	assetId: string;
	label: string;
	segmentId?: string;
}

/**
 * Audio sources offered for an avatar: audible timeline clips with audio that
 * overlap it (in timeline order), then library media with audio. Muted,
 * hidden, high-speed-muted, zero-volume, and hidden/muted/non-soloed-track
 * clips are left out because the viewer never hears them.
 */
export function lipSyncSourceOptions(
	project: Project,
	assets: readonly Asset[],
	avatar: Avatar
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
			label: `Clip: ${byId.get(segment.assetId)?.name ?? "media"} at ${segment.start.toFixed(2)}s (track ${segment.track + 1})`,
			segmentId: segment.id,
		}));
	const media = assets.filter(hasAudio).map((asset) => ({
		assetId: asset.id,
		label: `Media: ${asset.name} from the avatar's start`,
	}));
	return [...clips, ...media];
}

/** Stable option key for a source choice. */
export const lipSyncSourceKey = (option: {
	assetId: string;
	segmentId?: string;
}) =>
	option.segmentId ? `segment:${option.segmentId}` : `asset:${option.assetId}`;

/**
 * Photoreal (cloud) lip-sync and talking avatars (G80). The local vector
 * avatar above stays the default; this mode sends real footage to a cloud
 * model, so it needs the sender to confirm the people shown agreed.
 *
 * - `lipsync`: the picture clip (`input_video`) is re-timed to the audio
 *   clip (`input_audio`) over the range where both play, at most 10 s.
 * - `avatar`: one still or frame of the picture clip (`input_images[0]`) is
 *   animated to speak the audio clip, at most 60 s.
 *
 * The result goes back on the picture clip's track over the same range,
 * muted, so the narration or TTS clip stays the audio.
 */
export const photorealModeSchema = z.enum(["lipsync", "avatar"]);
export type PhotorealMode = z.infer<typeof photorealModeSchema>;

/** Longest photoreal range per mode, in seconds. */
export const PHOTOREAL_MAX_SECONDS: Record<PhotorealMode, number> = {
	avatar: 60,
	lipsync: 10,
};

export const photorealInputsRequestSchema = z
	.object({
		mode: photorealModeSchema,
		/** The clip whose picture is sent (a video for lip-sync). */
		pictureClipId: idSchema,
		/** The narration or TTS clip whose audio is sent. */
		audioClipId: idSchema,
		/** The sender confirmed the people shown agreed to this use. */
		consent: z.literal("subjects-agreed"),
		revision: z.number().int().nonnegative(),
	})
	.strict();
export type PhotorealInputsRequest = z.infer<
	typeof photorealInputsRequestSchema
>;

/** What a photoreal request sends and where its result goes. */
export interface PhotorealPlan {
	audio: { assetId: string; end: number; start: number };
	/** Timeline seconds the result covers. */
	duration: number;
	mode: PhotorealMode;
	picture: {
		assetId: string;
		end: number;
		/** Zero-based source frame for avatars (the frame at the range start). */
		frame: number;
		kind: Asset["kind"];
		start: number;
	};
	/** Timeline second the result starts at, on the picture clip's track. */
	start: number;
	track: number;
	/** True when the overlap was longer than the mode allows. */
	truncated: boolean;
}

/**
 * Plan a photoreal request from a picture clip and the audio clip that
 * plays over it. Throws with an editor-facing reason when they do not
 * overlap, play at another speed, or the picture cannot be sent.
 */
export function photorealPlan(
	project: Pick<Project, "segments">,
	assets: readonly Asset[],
	input: Pick<PhotorealInputsRequest, "audioClipId" | "mode" | "pictureClipId">
): PhotorealPlan {
	const clip = (id: string, label: string) => {
		const segment = project.segments.find((item) => item.id === id);
		const asset = segment
			? assets.find((item) => item.id === segment.assetId)
			: undefined;
		if (!(segment && asset)) {
			throw studioError((text) => new Error(text), "avatar.clip-missing", {
				label,
			});
		}
		if (segment.speed !== 1 || segment.speedCurve) {
			throw new Error(
				`Set the ${label} clip to 100% speed before sending it to a photoreal model.`
			);
		}
		return { asset, segment };
	};
	const picture = clip(input.pictureClipId, "picture");
	const audio = clip(input.audioClipId, "audio");
	if (picture.asset.kind === "audio") {
		throw new Error("Choose a video or still clip for the picture.");
	}
	if (input.mode === "lipsync" && picture.asset.kind !== "video") {
		throw new Error(
			"Lip-sync needs a video clip of the speaker; use a talking avatar for a still."
		);
	}
	if (!(audio.asset.kind === "audio" || audio.asset.hasAudio)) {
		throw new Error("The audio clip has no sound to speak.");
	}
	const pictureEnd = segmentProjectEnd(picture.segment);
	const audioEnd = segmentProjectEnd(audio.segment);
	const start = Math.max(picture.segment.start, audio.segment.start);
	const overlapEnd = Math.min(pictureEnd, audioEnd);
	if (!(overlapEnd - start >= 0.1)) {
		throw new Error("The audio clip does not play over the picture clip.");
	}
	const end = Math.min(overlapEnd, start + PHOTOREAL_MAX_SECONDS[input.mode]);
	const source = (segment: Segment) => ({
		end: segment.sourceIn + (end - segment.start),
		start: segment.sourceIn + (start - segment.start),
	});
	const pictureRange = source(picture.segment);
	const rate =
		picture.asset.frameRate && picture.asset.frameRate > 0
			? picture.asset.frameRate
			: 30;
	return {
		audio: { assetId: audio.asset.id, ...source(audio.segment) },
		duration: end - start,
		mode: input.mode,
		picture: {
			assetId: picture.asset.id,
			...pictureRange,
			frame:
				picture.asset.kind === "video"
					? Math.floor(pictureRange.start * rate + 1e-6)
					: 0,
			kind: picture.asset.kind,
		},
		start,
		track: picture.segment.track,
		truncated: end < overlapEnd - 1e-6,
	};
}
