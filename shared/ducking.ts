/**
 * Ducking: a "Duck under voice" clip dips by a set amount while the other
 * audible clips carry sound, and comes back when they fall silent. The
 * export and the Web Audio preview share these defaults, the threshold and
 * the envelope math so what you hear while editing matches the file.
 *
 * Export (`duckFilterChain`): a fast FFmpeg `sidechaingate` turns the other
 * clips' mix into a 0/1 "someone is talking" signal; a second gate, used as
 * a linear one-pole envelope follower on that signal, gates a copy of the
 * clip, and the copy is subtracted at the set depth
 * (`ducked = clip - (1 - 10^(-dB/20)) * envelope * clip`). The dip is
 * exactly the set amount whatever the voice level, and it goes down and
 * comes back on exponential curves whose 10-90% times are the attack and
 * release, the same curves Web Audio's `setTargetAtTime` draws in the
 * preview.
 */
import type { DuckSettings } from "./schema/audio-ext.ts";

export interface ResolvedDuck {
	/** Reduction while the other audio plays, in dB (3 to 24). */
	amountDb: number;
	/** Milliseconds to reach the full dip once the other audio starts. */
	attackMs: number;
	/** Milliseconds to come back to full level once the other audio stops. */
	releaseMs: number;
}

/** Defaults: within CapCut's suggested 6-12 dB, fast attack, 250 ms release. */
export const DUCK_DEFAULTS: Readonly<ResolvedDuck> = {
	amountDb: 9,
	attackMs: 20,
	releaseMs: 250,
};

export const DUCK_LIMITS = {
	amountDb: { max: 24, min: 3 },
	attackMs: { max: 500, min: 5 },
	releaseMs: { max: 2000, min: 50 },
} as const;

/**
 * Linear RMS level of the other clips' mix above which the ducked clip dips
 * (about -34 dBFS): quiet room tone stays below it, speech sits above it.
 */
export const DUCK_THRESHOLD = 0.02;

/**
 * DC offset added to the export's gate keys. FFmpeg's gate leaves its gain
 * at unity on exact digital silence, which would hold the dip through gaps
 * between voice clips; -120 dBFS of DC keeps each key measurable.
 */
export const DUCK_KEY_FLOOR = 0.000_001;

/**
 * Attack and release (FFmpeg ms) of the export's voice detector: fast, with
 * a short hold so the dip does not flutter between syllables. The preview
 * reads the same mix over a 21 ms block every 10 ms.
 */
export const DUCK_DETECT_ATTACK_MS = 5;
export const DUCK_DETECT_RELEASE_MS = 60;

/**
 * 10-90% rise time of a one-pole envelope in time constants (ln 9). The
 * preview's `setTargetAtTime` takes time constants; FFmpeg's gate runs its
 * envelope with a time constant of a quarter of its attack or release.
 */
const RISE_TIME_CONSTANTS = Math.log(9);

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

/** The clip's ducking settings with defaults filled and bounds applied. */
export function resolveDuck(settings: DuckSettings | undefined): ResolvedDuck {
	const pick = (field: keyof ResolvedDuck) => {
		const value = settings?.[field];
		const { max, min } = DUCK_LIMITS[field];
		return typeof value === "number" && Number.isFinite(value)
			? clamp(value, min, max)
			: DUCK_DEFAULTS[field];
	};
	return {
		amountDb: pick("amountDb"),
		attackMs: pick("attackMs"),
		releaseMs: pick("releaseMs"),
	};
}

/** Linear gain of a ducked clip while the other audio plays. */
export function duckGain(amountDb: number): number {
	return 10 ** (-amountDb / 20);
}

/**
 * Stable key for clips that share identical ducking, so grouped exports mix
 * them through one gate.
 */
export function duckKey(duck: ResolvedDuck): string {
	return `${round(duck.amountDb)}:${round(duck.attackMs)}:${round(duck.releaseMs)}`;
}

function round(value: number): number {
	return Number(value.toFixed(6));
}

/** FFmpeg gate attack or release for a 10-90% time of `ms`. */
export function ffmpegEnvelopeMs(ms: number): number {
	return round((ms * 4) / RISE_TIME_CONSTANTS);
}

/**
 * FFmpeg filters that duck `source` against `key` into `output`, using
 * `prefix` for the intermediate labels. Both inputs must already be held to
 * the same length (see `DUCK_HOLD_MARGIN` in the sidecar).
 */
export function duckFilterChain({
	duck,
	key,
	output,
	prefix,
	source,
}: {
	duck: ResolvedDuck;
	key: string;
	output: string;
	prefix: string;
	source: string;
}): string[] {
	const cut = round(1 - duckGain(duck.amountDb));
	const label = (name: string) => `[${prefix}${name}]`;
	return [
		`${key}dcshift=shift=${DUCK_KEY_FLOOR},asplit=2${label("KeyA")}${label("KeyB")}`,
		`${label("KeyA")}aeval=exprs=1:c=mono${label("One")}`,
		// 0/1: whether the other audio is above the threshold right now.
		`${label("One")}${label("KeyB")}sidechaingate=threshold=${DUCK_THRESHOLD}:ratio=9000:range=${DUCK_KEY_FLOOR}:knee=1:attack=${DUCK_DETECT_ATTACK_MS}:release=${DUCK_DETECT_RELEASE_MS}:detection=rms${label("Voiced")}`,
		`${source}asplit=2${label("Dry")}${label("Wet")}`,
		// Threshold 1 and ratio 2 make the gain equal the envelope of the
		// 0/1 signal: a one-pole follower with the clip's attack and release.
		`${label("Wet")}${label("Voiced")}sidechaingate=threshold=1:ratio=2:range=0:knee=1:attack=${ffmpegEnvelopeMs(duck.attackMs)}:release=${ffmpegEnvelopeMs(duck.releaseMs)}:detection=peak,volume=${-cut}${label("Cut")}`,
		`${label("Dry")}${label("Cut")}amix=inputs=2:normalize=0${output}`,
	];
}

/**
 * Preview envelope step: the gain a ducked clip should head toward for the
 * other audio's current RMS `level`, and the Web Audio `setTargetAtTime`
 * time constant whose 10-90% time is the attack or release.
 */
export function previewDuckTarget(
	level: number,
	duck: ResolvedDuck
): { gain: number; timeConstant: number } {
	const active = level > DUCK_THRESHOLD;
	const ms = active ? duck.attackMs : duck.releaseMs;
	return {
		gain: active ? duckGain(duck.amountDb) : 1,
		timeConstant: ms / 1000 / RISE_TIME_CONSTANTS,
	};
}
