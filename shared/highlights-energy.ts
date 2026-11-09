import { loudnessPeakTimes } from "./analysis.ts";
import type { ScoreHighlightsInput } from "./highlights.ts";

/** Boundary grid used when there is no transcript to align windows to. */
const ENERGY_STEP_SECONDS = 1;
/** Upper bound on grid windows scored in energy-only mode; the grid coarsens past it. */
const MAX_ENERGY_WINDOWS = 20_000;

export interface Window {
	end: number;
	first: number;
	last: number;
	start: number;
}

export function round(value: number) {
	return Math.round(value * 1000) / 1000;
}

/** Grid step that keeps the energy-only window count near `MAX_ENERGY_WINDOWS`. */
function energyStep(duration: number, target: { max: number; min: number }) {
	const lengths = target.max - target.min + ENERGY_STEP_SECONDS;
	return Math.max(
		ENERGY_STEP_SECONDS,
		Math.ceil(Math.sqrt((duration * lengths) / MAX_ENERGY_WINDOWS))
	);
}

/** Grid windows (plus scene cuts) for sources without a usable transcript. */
export function energyWindows(
	duration: number,
	sceneCuts: readonly number[],
	target: { max: number; min: number }
): Window[] {
	const step = energyStep(duration, target);
	const boundaries = new Set<number>([0, round(duration)]);
	for (let time = step; time < duration; time += step) {
		boundaries.add(round(time));
	}
	for (const cut of sceneCuts) {
		if (cut > 0 && cut < duration) {
			boundaries.add(round(cut));
		}
	}
	const sorted = [...boundaries].sort((a, b) => a - b);
	const windows: Window[] = [];
	for (const [index, start] of sorted.entries()) {
		for (let next = index + 1; next < sorted.length; next += 1) {
			const end = sorted[next] ?? start;
			const length = end - start;
			if (length > target.max + 1e-9) {
				break;
			}
			if (length >= target.min - 1e-9) {
				windows.push({ end, first: -1, last: -1, start });
				if (windows.length >= MAX_ENERGY_WINDOWS * 2) {
					return windows;
				}
			}
		}
	}
	return windows;
}

export interface Energy {
	bins: number[];
	/** Full source duration the bins span; used to map times to bins. */
	duration: number;
	highest: number;
	peaks: number[];
	prefix: number[];
	prefixSquares: number[];
}

export function energyProfile(
	waveform: ScoreHighlightsInput["waveform"]
): Energy | null {
	if (
		!waveform ||
		waveform.bins.length === 0 ||
		!(Number.isFinite(waveform.duration) && waveform.duration > 0)
	) {
		return null;
	}
	const bins = waveform.bins.map((value) =>
		Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0
	);
	const highest = Math.max(...bins);
	if (!(highest > 0)) {
		return null;
	}
	const prefix = [0];
	const prefixSquares = [0];
	for (const value of bins) {
		prefix.push((prefix.at(-1) ?? 0) + value);
		prefixSquares.push((prefixSquares.at(-1) ?? 0) + value * value);
	}
	return {
		bins,
		duration: waveform.duration,
		highest,
		peaks: loudnessPeakTimes(bins, waveform.duration, 80),
		prefix,
		prefixSquares,
	};
}

export function energyFeatures(energy: Energy, start: number, end: number) {
	const count = energy.bins.length;
	const from = Math.max(
		0,
		Math.min(count - 1, Math.floor((start / energy.duration) * count))
	);
	const to = Math.max(
		from + 1,
		Math.min(count, Math.ceil((end / energy.duration) * count))
	);
	const size = to - from;
	const sum = (energy.prefix[to] ?? 0) - (energy.prefix[from] ?? 0);
	const squares =
		(energy.prefixSquares[to] ?? 0) - (energy.prefixSquares[from] ?? 0);
	const mean = sum / size;
	const deviation = Math.sqrt(Math.max(0, squares / size - mean * mean));
	const peaks = energy.peaks.filter((time) => time >= start && time < end);
	const perTenSeconds = peaks.length / Math.max(1, (end - start) / 10);
	return {
		energy: mean / energy.highest,
		peaks: Math.min(1, perTenSeconds),
		variance: Math.min(1, (deviation / energy.highest) * 2),
	};
}
