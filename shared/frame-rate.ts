import type { ProjectFps } from "./project.ts";

/**
 * Frame-rate math shared by settings, interchange, probing and the renderer.
 *
 * Project rates are stored as the familiar decimal labels (`29.97`), but the
 * NTSC family is really `N × 1000/1001`. Everything that writes a timebase
 * (FFmpeg `-r`/`fps=`, FCPXML `frameDuration`, XMEML `<ntsc>`) goes through
 * `fpsRational`, so a 29.97 export is exactly 30000/1001 rather than the
 * 2997/100 FFmpeg would derive from the decimal.
 *
 * This module is pure and imports nothing at runtime, so `project.ts` can
 * depend on it without a cycle.
 */

/** Every rate a project can use, in menu order. */
export const PROJECT_FRAME_RATES = [
	23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60, 120,
] as const satisfies readonly ProjectFps[];

export interface FrameRateRational {
	/** Denominator: 1 for integer rates, 1001 for the NTSC family. */
	den: number;
	/** True for `N × 1000/1001` rates (23.976, 29.97, 59.94, …). */
	ntsc: boolean;
	/** Numerator: frames per `den` seconds. */
	num: number;
}

/** Decimal labels that identify an NTSC rate, within this tolerance. */
const NTSC_TOLERANCE = 0.002;
const MAX_DENOMINATOR = 1001;

function greatestCommonDivisor(a: number, b: number): number {
	let x = Math.abs(a);
	let y = Math.abs(b);
	while (y > 0) {
		[x, y] = [y, x % y];
	}
	return x;
}

function assertRate(fps: number): void {
	if (!Number.isFinite(fps) || fps <= 0 || fps > 1000) {
		throw new Error(`Frame rate ${fps} is not a positive rate.`);
	}
}

/** Closest fraction with a denominator ≤ `MAX_DENOMINATOR` (Stern-Brocot). */
function closestFraction(value: number): { den: number; num: number } {
	let lowerNum = Math.floor(value);
	let lowerDen = 1;
	let upperNum = lowerNum + 1;
	let upperDen = 1;
	let best = { den: 1, num: Math.round(value) };
	let bestError = Math.abs(value - best.num);
	while (lowerDen + upperDen <= MAX_DENOMINATOR && bestError > 1e-12) {
		const num = lowerNum + upperNum;
		const den = lowerDen + upperDen;
		const error = Math.abs(value - num / den);
		if (error < bestError) {
			best = { den, num };
			bestError = error;
		}
		if (num / den < value) {
			lowerNum = num;
			lowerDen = den;
		} else {
			upperNum = num;
			upperDen = den;
		}
	}
	const divisor = greatestCommonDivisor(best.num, best.den);
	return { den: best.den / divisor, num: best.num / divisor };
}

/**
 * Exact rational form of a frame rate. Integer rates are `fps/1`; decimals
 * within 0.002 of `N × 1000/1001` (23.976, 29.97, 47.952, 59.94, 119.88) are
 * `N×1000/1001`; any other decimal becomes its closest fraction with a
 * denominator up to 1001 (12.5 → 25/2).
 */
export function fpsRational(fps: number): FrameRateRational {
	assertRate(fps);
	if (Number.isInteger(fps)) {
		return { den: 1, ntsc: false, num: fps };
	}
	const nominal = Math.round((fps * 1001) / 1000);
	if (
		nominal > 0 &&
		Math.abs((nominal * 1000) / 1001 - fps) <= NTSC_TOLERANCE
	) {
		return { den: 1001, ntsc: true, num: nominal * 1000 };
	}
	return { ...closestFraction(fps), ntsc: false };
}

/** Frames per second as a float, exact for the rational form. */
export function fpsValue(fps: number): number {
	const { den, num } = fpsRational(fps);
	return num / den;
}

/**
 * FFmpeg rate string for `-r`, `-framerate`, `fps=` and lavfi `r=`. Integer
 * rates stay plain (`30`) so existing render arguments are unchanged; NTSC
 * rates are `30000/1001`.
 */
export function ffmpegFrameRate(fps: number): string {
	const { den, num } = fpsRational(fps);
	return den === 1 ? String(num) : `${num}/${den}`;
}

/**
 * The whole-number timebase interchange formats pair with `<ntsc>`:
 * 24 for 23.976, 30 for 29.97, 60 for 59.94; integer rates map to themselves.
 */
export function nominalFrameRate(fps: number): number {
	const { den, num } = fpsRational(fps);
	return Math.round(num / den);
}

/** Seconds per frame. */
export function frameDuration(fps: number): number {
	const { den, num } = fpsRational(fps);
	return den / num;
}

export type FrameRounding = "ceil" | "floor" | "round";

/** Whole frame index for `seconds` (never negative). */
export function timeToFrames(
	seconds: number,
	fps: number,
	rounding: FrameRounding = "round"
): number {
	const { den, num } = fpsRational(fps);
	// Remove float noise (0.1 × 30 = 3.0000000000000004) before ceil/floor.
	const exact = Number(((seconds * num) / den).toFixed(6));
	return Math.max(0, Math[rounding](exact));
}

/** Timeline seconds at the start of frame `frames`, rounded to 1 ns. */
export function framesToTime(frames: number, fps: number): number {
	const { den, num } = fpsRational(fps);
	return Number(((frames * den) / num).toFixed(9));
}

/** Snap `seconds` to the frame grid of `fps`. */
export function frameQuantize(
	seconds: number,
	fps: number,
	rounding: FrameRounding = "round"
): number {
	return framesToTime(timeToFrames(seconds, fps, rounding), fps);
}

/**
 * Rational seconds for FCPXML, `frames × den / num` followed by `s`
 * (`1001/30000s` is one frame at 29.97; `0s` is zero). Not reduced, so every
 * value shares the format's `frameDuration` denominator.
 */
export function rationalFrameTime(frames: number, fps: number): string {
	if (!Number.isInteger(frames) || frames < 0) {
		throw new Error("Frame counts are non-negative integers.");
	}
	if (frames === 0) {
		return "0s";
	}
	const { den, num } = fpsRational(fps);
	return `${frames * den}/${num}s`;
}

/** Whether two rates describe the same frame grid. */
export function sameFrameRate(a: number, b: number): boolean {
	const left = fpsRational(a);
	const right = fpsRational(b);
	return left.num * right.den === right.num * left.den;
}

/**
 * The project rate matching a measured media rate, or undefined when the
 * media runs at a rate projects do not offer (15, 12.5, variable streams).
 * A 0.01 fps tolerance absorbs rounded container rates.
 */
export function projectFpsForRate(rate: number): ProjectFps | undefined {
	if (!Number.isFinite(rate) || rate <= 0) {
		return;
	}
	let best: ProjectFps | undefined;
	let bestError = Number.POSITIVE_INFINITY;
	for (const candidate of PROJECT_FRAME_RATES) {
		const error = Math.abs(fpsValue(candidate) - rate);
		if (error < bestError) {
			best = candidate;
			bestError = error;
		}
	}
	return bestError <= 0.01 ? best : undefined;
}

/** Menu label: `29.97 fps (NTSC)`, `30 fps`. */
export function frameRateLabel(fps: number): string {
	return `${fps} fps${fpsRational(fps).ntsc ? " (NTSC)" : ""}`;
}

/**
 * Parse an FFprobe rate (`30000/1001`, `25/1`, `0/0`) into a stored media rate:
 * frames per second rounded to 3 decimals (29.97, 23.976, 59.94), or
 * undefined when absent, invalid, or outside 1..240.
 */
export function parseProbeFrameRate(
	value: string | undefined
): number | undefined {
	const match = /^(\d+)(?:\/(\d+))?$/.exec(value?.trim() ?? "");
	if (!match) {
		return;
	}
	const num = Number(match[1]);
	const den = match[2] === undefined ? 1 : Number(match[2]);
	if (!(num > 0 && den > 0)) {
		return;
	}
	const rate = Number((num / den).toFixed(3));
	return rate >= 1 && rate <= 240 ? rate : undefined;
}
