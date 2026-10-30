/**
 * Decibel conversions and level metering shared by the inspector, the track
 * mixer, the preview meter and the render mix. Everything here is pure and
 * deterministic so the preview and the FFmpeg render agree on the numbers.
 */

/** Level treated as silence wherever a finite decibel value is required. */
export const SILENCE_DB = -96;
/** Clip volume is stored linear in 0..4, which tops out at about +12 dB. */
export const MAX_CLIP_GAIN = 4;
/** Track gain bounds, matching `trackSettingSchema.gainDb`. */
export const MIN_TRACK_GAIN_DB = -60;
export const MAX_TRACK_GAIN_DB = 12;
/** The meter latches a clip indicator once a sample peaks above this level. */
export const CLIP_THRESHOLD_DBFS = -0.1;

/** Linear amplitude to decibels; zero and below map to `-Infinity`. */
export function gainToDb(gain: number): number {
	if (!Number.isFinite(gain) || gain <= 0) {
		return Number.NEGATIVE_INFINITY;
	}
	return 20 * Math.log10(gain);
}

/** Decibels to linear amplitude; `-Infinity` maps to exact silence. */
export function dbToGain(db: number): number {
	if (Number.isNaN(db) || db === Number.NEGATIVE_INFINITY) {
		return 0;
	}
	return 10 ** (db / 20);
}

/**
 * The stored linear clip volume for a decibel value entered in the
 * inspector, clamped to the schema's 0..4 range. Values at or below
 * `SILENCE_DB` mute the clip.
 */
export function clipVolumeFromDb(db: number): number {
	if (Number.isNaN(db) || db <= SILENCE_DB) {
		return 0;
	}
	return Math.min(MAX_CLIP_GAIN, dbToGain(db));
}

/** Clamp a track gain to the schema bounds, rounded to 0.1 dB. */
export function clampTrackGainDb(db: number): number {
	if (!Number.isFinite(db)) {
		return db > 0 ? MAX_TRACK_GAIN_DB : MIN_TRACK_GAIN_DB;
	}
	const bounded = Math.min(MAX_TRACK_GAIN_DB, Math.max(MIN_TRACK_GAIN_DB, db));
	return Math.round(bounded * 10) / 10;
}

/**
 * Human-readable decibels: one decimal, an explicit sign above zero, and
 * `-∞ dB` for silence.
 */
export function formatDb(db: number): string {
	if (Number.isNaN(db) || db <= SILENCE_DB) {
		return "-∞ dB";
	}
	const rounded = Math.round(db * 10) / 10;
	if (Object.is(rounded, -0) || rounded === 0) {
		return "0.0 dB";
	}
	return `${rounded > 0 ? "+" : ""}${rounded.toFixed(1)} dB`;
}

/** A finite decibel value for display widgets (silence becomes `SILENCE_DB`). */
export function displayDb(db: number): number {
	return Number.isFinite(db) ? Math.max(SILENCE_DB, db) : SILENCE_DB;
}

/** Peak and RMS of one block of samples, both linear 0..∞. */
export interface ChannelLevel {
	peak: number;
	rms: number;
}

/** Peak absolute sample and root-mean-square level of `samples`. */
export function channelLevel(samples: ArrayLike<number>): ChannelLevel {
	const count = samples.length;
	if (!count) {
		return { peak: 0, rms: 0 };
	}
	let peak = 0;
	let sumSquares = 0;
	for (let index = 0; index < count; index++) {
		const sample = samples[index] ?? 0;
		const magnitude = Number.isFinite(sample) ? Math.abs(sample) : 0;
		if (magnitude > peak) {
			peak = magnitude;
		}
		sumSquares += magnitude * magnitude;
	}
	return { peak, rms: Math.sqrt(sumSquares / count) };
}

/** Whether a linear peak is above the clip threshold. */
export function isClipping(peak: number): boolean {
	return gainToDb(peak) > CLIP_THRESHOLD_DBFS;
}

/**
 * Meter fall-back: levels rise instantly and fall at `releaseDbPerSecond`,
 * so short peaks stay readable at 30 fps. Works in decibels.
 */
export function meterBallistics(
	previousDb: number,
	nextDb: number,
	elapsedSeconds: number,
	releaseDbPerSecond = 24
): number {
	const previous = displayDb(previousDb);
	const next = displayDb(nextDb);
	if (next >= previous) {
		return next;
	}
	const fallen = previous - releaseDbPerSecond * Math.max(0, elapsedSeconds);
	return Math.max(next, fallen);
}

/**
 * Position of a level on a meter scale from `floorDb` (0) to 0 dBFS (1).
 * Levels above full scale pin to 1.
 */
export function meterFraction(db: number, floorDb = -60): number {
	if (!Number.isFinite(db) || db <= floorDb) {
		return 0;
	}
	return Math.min(1, (db - floorDb) / -floorDb);
}
