/**
 * Clip audio effects: resolved parameters, FFmpeg filter strings, defaults,
 * labels, and stack presets. The render stage and the preview insert both read
 * `audioEffectParams`, so a render and its preview use the same numbers.
 */
import { filterNumber } from "./audio.ts";
import {
	type AudioEffect,
	type AudioEffectType,
	audioEffectTypeSchema,
	MAX_AUDIO_EFFECTS,
} from "./schema/audio-ext.ts";

export const AUDIO_EFFECT_TYPES = audioEffectTypeSchema.options;

export const AUDIO_EFFECT_LABELS: Record<AudioEffectType, string> = {
	"bass-boost": "Bass boost",
	chipmunk: "Chipmunk",
	chorus: "Chorus",
	"deep-voice": "Deep voice",
	echo: "Echo",
	eq: "EQ band",
	flanger: "Flanger",
	megaphone: "Megaphone",
	pitch: "Pitch shift",
	radio: "Radio",
	reverb: "Reverb",
	robot: "Robot",
	telephone: "Telephone",
	"treble-boost": "Treble boost",
	tremolo: "Tremolo",
	vibrato: "Vibrato",
};

/** Effects the preview cannot reproduce with WebAudio nodes; they apply on render. */
export const RENDER_ONLY_AUDIO_EFFECTS: ReadonlySet<AudioEffectType> = new Set([
	"chipmunk",
	"deep-voice",
	"pitch",
	"robot",
]);

/** Effects whose sound depends on a pitch shift (`rubberband` when available). */
export const PITCH_AUDIO_EFFECTS: ReadonlySet<AudioEffectType> = new Set([
	"chipmunk",
	"deep-voice",
	"pitch",
]);

/**
 * Which controls an effect type reads, for editors and agents. `amount` is
 * listed only where `audioEffectParams` reads it: the pitch family uses
 * semitones alone, and the shelf/EQ types take `gainDb` (amount is only the
 * fallback when no gain is set, and editors always set one).
 */
export const AUDIO_EFFECT_CONTROLS: Record<
	AudioEffectType,
	readonly ("amount" | "frequency" | "gainDb" | "semitones")[]
> = {
	"bass-boost": ["gainDb"],
	chipmunk: ["semitones"],
	chorus: ["amount"],
	"deep-voice": ["semitones"],
	echo: ["amount"],
	eq: ["frequency", "gainDb"],
	flanger: ["amount"],
	megaphone: ["amount"],
	pitch: ["semitones"],
	radio: ["amount"],
	reverb: ["amount"],
	robot: ["amount"],
	telephone: ["amount"],
	"treble-boost": ["gainDb"],
	tremolo: ["amount"],
	vibrato: ["amount"],
};

/**
 * The signed semitone range an editor offers per pitch-family type, matching
 * what `effectSemitones` renders: chipmunk only shifts up, deep voice only down.
 */
export function semitoneRange(type: AudioEffectType): {
	max: number;
	min: number;
} {
	switch (type) {
		case "chipmunk":
			return { max: 12, min: 0 };
		case "deep-voice":
			return { max: 0, min: -12 };
		default:
			return { max: 12, min: -12 };
	}
}

const clamp = (value: number, min: number, max: number) =>
	Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : min;

/** A band filter cascade shared by telephone, radio, and megaphone. */
export interface BandParams {
	highpass: number;
	lowpass: number;
	/** Second-order sections per side (2 = 24 dB/octave). */
	stages: number;
}

/** Resolved parameters per effect type; render and preview share them. */
export type AudioEffectParams =
	| { type: "pitch"; ratio: number; semitones: number }
	| { type: "echo"; decay: number; delayMs: number }
	| { type: "reverb"; decays: number[]; delaysMs: number[]; wet: number }
	| { type: "eq"; frequency: number; gainDb: number }
	| { type: "bass-boost"; frequency: number; gainDb: number }
	| { type: "treble-boost"; frequency: number; gainDb: number }
	| { type: "telephone"; band: BandParams }
	| { type: "radio"; band: BandParams; bits: number; crushMix: number }
	| { type: "robot"; windowSize: number }
	| {
			type: "chorus";
			decays: number[];
			delaysMs: number[];
			depthsMs: number[];
			speedsHz: number[];
	  }
	| { type: "flanger"; depthMs: number; regen: number; speedHz: number }
	| {
			type: "megaphone";
			band: BandParams;
			bits: number;
			crushMix: number;
			gain: number;
	  }
	| { type: "vibrato"; depth: number; frequency: number }
	| { type: "tremolo"; depth: number; frequency: number };

const REVERB_DELAYS_MS = [37, 53, 79, 113, 167];
const REVERB_DECAYS = [0.5, 0.42, 0.34, 0.27, 0.2];

/** Semitone shift for the pitch-family effects. */
export function effectSemitones(effect: AudioEffect): number {
	switch (effect.type) {
		case "chipmunk":
			return Math.abs(effect.semitones ?? 7);
		case "deep-voice":
			return -Math.abs(effect.semitones ?? 7);
		case "pitch":
			return effect.semitones ?? 0;
		default:
			return 0;
	}
}

/** The semitone shift an effect renders with, clamped to the supported range. */
export function displayedSemitones(effect: AudioEffect): number {
	return clamp(effectSemitones(effect), -12, 12);
}

function pitchParams(effect: AudioEffect): AudioEffectParams {
	const semitones = displayedSemitones(effect);
	return { type: "pitch", ratio: 2 ** (semitones / 12), semitones };
}

/** Resolve an effect's amount and optional controls into concrete parameters. */
export function audioEffectParams(effect: AudioEffect): AudioEffectParams {
	const amount = clamp(effect.amount, 0, 1);
	switch (effect.type) {
		case "pitch":
		case "chipmunk":
		case "deep-voice":
			return pitchParams(effect);
		case "echo":
			return {
				type: "echo",
				decay: 0.3 + amount * 0.4,
				delayMs: 60 + amount * 400,
			};
		case "reverb":
			return {
				type: "reverb",
				decays: REVERB_DECAYS.map((decay) => decay * (0.4 + amount * 0.6)),
				delaysMs: REVERB_DELAYS_MS,
				wet: 0.2 + amount * 0.6,
			};
		case "eq":
			return {
				type: "eq",
				frequency: clamp(effect.frequency ?? 1000, 20, 20_000),
				gainDb: clamp(effect.gainDb ?? amount * 12, -24, 24),
			};
		case "bass-boost":
			return {
				type: "bass-boost",
				frequency: clamp(effect.frequency ?? 100, 20, 20_000),
				gainDb: clamp(effect.gainDb ?? amount * 12, -24, 24),
			};
		case "treble-boost":
			return {
				type: "treble-boost",
				frequency: clamp(effect.frequency ?? 3000, 20, 20_000),
				gainDb: clamp(effect.gainDb ?? amount * 12, -24, 24),
			};
		case "telephone":
			return {
				type: "telephone",
				band: {
					highpass: 250 + amount * 150,
					lowpass: 3800 - amount * 800,
					stages: 2,
				},
			};
		case "radio":
			return {
				type: "radio",
				band: { highpass: 500, lowpass: 4500, stages: 2 },
				bits: 16 - amount * 8,
				crushMix: 0.2 + amount * 0.5,
			};
		case "robot":
			return {
				type: "robot",
				windowSize: amount < 1 / 3 ? 256 : amount < 2 / 3 ? 512 : 1024,
			};
		case "chorus":
			return {
				type: "chorus",
				decays: [0.25 + amount * 0.25, 0.2 + amount * 0.2],
				delaysMs: [50, 60],
				depthsMs: [1 + amount * 2, 1.3 + amount * 2],
				speedsHz: [0.25, 0.4],
			};
		case "flanger":
			return {
				type: "flanger",
				depthMs: 1 + amount * 9,
				regen: amount * 50,
				speedHz: 0.5,
			};
		case "megaphone":
			return {
				type: "megaphone",
				band: { highpass: 600, lowpass: 3000, stages: 1 },
				bits: 10 - amount * 4,
				crushMix: 0.3 + amount * 0.4,
				gain: 1 + amount,
			};
		case "vibrato":
			return {
				type: "vibrato",
				depth: 0.2 + amount * 0.6,
				frequency: 4 + amount * 4,
			};
		default:
			return {
				type: "tremolo",
				depth: 0.3 + amount * 0.6,
				frequency: 3 + amount * 7,
			};
	}
}

function bandFilters(band: BandParams): string[] {
	const stages = Array.from({ length: band.stages });
	return [
		...stages.map(() => `highpass=f=${filterNumber(band.highpass)}`),
		...stages.map(() => `lowpass=f=${filterNumber(band.lowpass)}`),
	];
}

const crusher = (bits: number, mix: number) =>
	`acrusher=bits=${filterNumber(bits)}:mode=log:aa=1:mix=${filterNumber(mix)}`;
const joinNumbers = (values: number[]) => values.map(filterNumber).join("|");

/** Normalized rate the fallback pitch shift resamples through. */
export const PITCH_FALLBACK_RATE = 48_000;

export interface AudioEffectFilterOptions {
	/** Whether FFmpeg has `rubberband`; otherwise pitch resamples and re-times. */
	rubberband: boolean;
}

function pitchFilters(
	params: Extract<AudioEffectParams, { type: "pitch" }>,
	options: AudioEffectFilterOptions
): string[] {
	if (params.semitones === 0) {
		return [];
	}
	if (options.rubberband) {
		return [`rubberband=pitch=${filterNumber(params.ratio)}`];
	}
	// Tape-style shift at a fixed rate, then `atempo` restores the duration.
	const shiftedRate = Math.round(PITCH_FALLBACK_RATE * params.ratio);
	return [
		`aresample=${PITCH_FALLBACK_RATE}`,
		`asetrate=${shiftedRate}`,
		`aresample=${PITCH_FALLBACK_RATE}`,
		// The ratio stays within 0.5..2 (±12 semitones), one `atempo` stage.
		`atempo=${filterNumber(PITCH_FALLBACK_RATE / shiftedRate)}`,
	];
}

/** FFmpeg filters for one effect, or none when it is disabled or neutral. */
export function audioEffectFilterList(
	effect: AudioEffect,
	options: AudioEffectFilterOptions
): string[] {
	if (!effect.enabled) {
		return [];
	}
	const params = audioEffectParams(effect);
	switch (params.type) {
		case "pitch":
			return pitchFilters(params, options);
		case "echo":
			return [
				`aecho=0.8:0.8:${filterNumber(params.delayMs)}:${filterNumber(params.decay)}`,
			];
		case "reverb":
			return [
				`aecho=0.8:${filterNumber(1 - params.wet * 0.4)}:${joinNumbers(params.delaysMs)}:${joinNumbers(params.decays)}`,
			];
		case "eq":
			return params.gainDb === 0
				? []
				: [
						`equalizer=f=${filterNumber(params.frequency)}:t=q:w=1:g=${filterNumber(params.gainDb)}`,
					];
		case "bass-boost":
			return params.gainDb === 0
				? []
				: [
						`bass=g=${filterNumber(params.gainDb)}:f=${filterNumber(params.frequency)}`,
					];
		case "treble-boost":
			return params.gainDb === 0
				? []
				: [
						`treble=g=${filterNumber(params.gainDb)}:f=${filterNumber(params.frequency)}`,
					];
		case "telephone":
			return bandFilters(params.band);
		case "radio":
			return [
				...bandFilters(params.band),
				crusher(params.bits, params.crushMix),
			];
		case "robot":
			return [
				`afftfilt=real='hypot(re,im)':imag='0':win_size=${params.windowSize}:overlap=0.75`,
			];
		case "chorus":
			return [
				`chorus=0.6:0.9:${joinNumbers(params.delaysMs)}:${joinNumbers(params.decays)}:${joinNumbers(params.speedsHz)}:${joinNumbers(params.depthsMs)}`,
			];
		case "flanger":
			return [
				`flanger=delay=0:depth=${filterNumber(params.depthMs)}:regen=${filterNumber(params.regen)}:speed=${filterNumber(params.speedHz)}`,
			];
		case "megaphone":
			return [
				...bandFilters(params.band),
				crusher(params.bits, params.crushMix),
				`volume=${filterNumber(params.gain)}`,
			];
		case "vibrato":
			return [
				`vibrato=f=${filterNumber(params.frequency)}:d=${filterNumber(params.depth)}`,
			];
		default:
			return [
				`tremolo=f=${filterNumber(params.frequency)}:d=${filterNumber(params.depth)}`,
			];
	}
}

/** The whole stack in order; disabled or neutral effects add nothing. */
export function audioEffectChainFilters(
	effects: readonly AudioEffect[] | undefined,
	options: AudioEffectFilterOptions
): string[] {
	return (effects ?? [])
		.slice(0, MAX_AUDIO_EFFECTS)
		.flatMap((effect) => audioEffectFilterList(effect, options));
}

/** Whether any enabled effect in the stack shifts pitch. */
export function stackShiftsPitch(
	effects: readonly AudioEffect[] | undefined
): boolean {
	return (effects ?? []).some(
		(effect) =>
			effect.enabled &&
			PITCH_AUDIO_EFFECTS.has(effect.type) &&
			effectSemitones(effect) !== 0
	);
}

/** A new effect of `type` with neutral-to-moderate starting values. */
export function newAudioEffect(type: AudioEffectType): AudioEffect {
	const effect: AudioEffect = { amount: 0.5, enabled: true, type };
	switch (type) {
		case "pitch":
			return { ...effect, semitones: 2 };
		case "eq":
			return { ...effect, frequency: 1000, gainDb: 3 };
		case "bass-boost":
		case "treble-boost":
			return { ...effect, gainDb: 6 };
		default:
			return effect;
	}
}

export interface AudioEffectPreset {
	effects: readonly AudioEffect[];
	id: string;
	label: string;
}

/** Named stacks for the inspector and agents; applying one replaces the stack. */
export const AUDIO_EFFECT_PRESETS: readonly AudioEffectPreset[] = [
	{
		effects: [
			{ amount: 0.5, enabled: true, frequency: 120, gainDb: 3, type: "eq" },
			{ amount: 0.5, enabled: true, frequency: 3000, gainDb: 2, type: "eq" },
		],
		id: "warm-voice",
		label: "Warm voice",
	},
	{
		effects: [{ amount: 0.6, enabled: true, type: "telephone" }],
		id: "phone-call",
		label: "Phone call",
	},
	{
		effects: [{ amount: 0.6, enabled: true, type: "radio" }],
		id: "old-radio",
		label: "Old radio",
	},
	{
		effects: [
			{ amount: 0.7, enabled: true, type: "megaphone" },
			{ amount: 0.2, enabled: true, type: "echo" },
		],
		id: "stadium-announcer",
		label: "Stadium announcer",
	},
	{
		effects: [{ amount: 0.8, enabled: true, type: "reverb" }],
		id: "cathedral",
		label: "Cathedral",
	},
	{
		effects: [
			{ amount: 0.6, enabled: true, type: "robot" },
			{ amount: 0.3, enabled: true, type: "flanger" },
		],
		id: "robot-voice",
		label: "Robot voice",
	},
	{
		effects: [{ amount: 0.5, enabled: true, semitones: 7, type: "chipmunk" }],
		id: "chipmunk",
		label: "Chipmunk",
	},
	{
		effects: [
			{ amount: 0.5, enabled: true, semitones: 5, type: "deep-voice" },
			{ amount: 0.4, enabled: true, gainDb: 4, type: "bass-boost" },
		],
		id: "deep-voice",
		label: "Deep voice",
	},
];

/** Copies of a preset's effects, ready to store on a clip. */
export function audioEffectPresetStack(id: string): AudioEffect[] | undefined {
	const preset = AUDIO_EFFECT_PRESETS.find((candidate) => candidate.id === id);
	return preset?.effects.map((effect) => ({ ...effect }));
}
