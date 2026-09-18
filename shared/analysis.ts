import { z } from "zod";
export const analysisSchema = z
	.object({
		assetId: z.uuid(),
		status: z.enum(["running", "completed", "failed", "canceled"]),
		createdAt: z.iso.datetime(),
		error: z.string().optional(),
		sceneCuts: z.array(z.number().min(0).max(7200)).max(2000),
		waveform: z.array(z.number().min(0).max(1)).max(600),
		duration: z.number().min(0).max(7200),
	})
	.strict();
export type MediaAnalysis = z.infer<typeof analysisSchema>;

export function parseSceneCuts(output: string, duration: number): number[] {
	const cuts: number[] = [];
	for (const line of output.split("\n")) {
		const match = line.match(/pts_time:([\d.]+)/);
		if (!match) {
			continue;
		}
		const time = Number(match[1]);
		if (
			Number.isFinite(time) &&
			time > 0.05 &&
			time < duration - 0.05 &&
			(cuts.length === 0 || time - (cuts.at(-1) ?? 0) > 0.05)
		) {
			cuts.push(time);
		}
	}
	if (cuts.length > 2000) {
		throw new Error(
			"Scene analysis found too many cuts. Analyze a shorter source."
		);
	}
	return cuts;
}
export function parseWaveform(output: string, duration: number): number[] {
	const bins = Array.from(
		{ length: Math.min(600, Math.max(1, Math.ceil(duration * 10))) },
		() => 0
	);
	let time = 0;
	for (const line of output.split("\n")) {
		const stamp = line.match(/pts_time:([\d.]+)/);
		if (stamp) {
			time = Number(stamp[1]);
		}
		const level = line.match(
			/lavfi\.astats\.Overall\.RMS_level=(-?[\d.]+|-inf)/
		);
		if (!level) {
			continue;
		}
		const db = Number(level[1]);
		const amplitude = Number.isFinite(db) ? Math.min(1, 10 ** (db / 20)) : 0;
		const index = Math.min(
			bins.length - 1,
			Math.max(0, Math.floor((time / Math.max(duration, 0.1)) * bins.length))
		);
		bins[index] = Math.max(bins[index] ?? 0, amplitude);
	}
	return bins;
}

export function loudnessPeakTimes(
	waveform: readonly number[],
	duration: number,
	maxPeaks = 24
): number[] {
	if (!(Number.isFinite(duration) && duration > 0) || waveform.length < 3) {
		return [];
	}
	const limit = Math.max(1, Math.min(80, Math.trunc(maxPeaks)));
	const highest = Math.max(...waveform);
	if (!(highest >= 0.08)) {
		return [];
	}
	const threshold = highest * 0.55;
	const candidates = waveform
		.map((value, index) => ({ index, value }))
		.filter(
			({ index, value }) =>
				value >= threshold &&
				value >= (waveform[index - 1] ?? 0) &&
				value >= (waveform[index + 1] ?? 0)
		)
		.sort((a, b) => b.value - a.value);
	const minimumSpacing = Math.max(0.25, duration / limit);
	const selected: Array<{ index: number; value: number }> = [];
	for (const candidate of candidates) {
		const time = ((candidate.index + 0.5) / waveform.length) * duration;
		if (
			selected.every(
				(previous) =>
					Math.abs(
						((previous.index + 0.5) / waveform.length) * duration - time
					) >= minimumSpacing
			)
		) {
			selected.push(candidate);
		}
		if (selected.length >= limit) {
			break;
		}
	}
	return selected
		.sort((a, b) => a.index - b.index)
		.map((candidate) =>
			Number(
				(((candidate.index + 0.5) / waveform.length) * duration).toFixed(3)
			)
		);
}

/** Estimate recurring beat onsets from the measured RMS envelope. */
export function estimateBeatTimes(
	waveform: readonly number[],
	duration: number,
	maxBeats = 96
): number[] {
	if (!(Number.isFinite(duration) && duration > 0) || waveform.length < 4) {
		return [];
	}
	const limit = Number.isFinite(maxBeats)
		? Math.max(2, Math.min(160, Math.trunc(maxBeats)))
		: 96;
	const values = waveform.map((value) =>
		Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0
	);
	const highest = Math.max(...values);
	if (!(highest >= 0.08)) {
		return [];
	}
	const baseline =
		values.reduce((total, value) => total + value, 0) / values.length;
	const threshold = Math.max(0.08, baseline + (highest - baseline) * 0.25);
	const prominence = Math.max(0.03, highest * 0.12);
	const candidates = values
		.map((value, index) => ({ index, value }))
		.filter(({ index, value }) => {
			const previous = values[index - 1] ?? 0;
			const next = values[index + 1] ?? 0;
			return (
				value >= threshold &&
				value >= previous &&
				value >= next &&
				value - Math.min(previous, next) >= prominence
			);
		})
		.sort((a, b) => a.index - b.index);
	if (candidates.length < 2) {
		return [];
	}
	const times = candidates.map(
		({ index }) => ((index + 0.5) / values.length) * duration
	);
	const intervals = times
		.slice(1)
		.map((time, index) => time - times[index]!)
		.filter((interval) => interval >= 0.2 && interval <= 2.5);
	if (intervals.length < Math.max(1, Math.ceil((times.length - 1) * 0.5))) {
		return [];
	}
	return times.slice(0, limit).map((time) => Number(time.toFixed(3)));
}

/** Find bounded silent source intervals in the measured RMS envelope. */
export function silenceRanges(
	waveform: readonly number[],
	duration: number,
	minimumDuration = 0.25
): [number, number][] {
	if (!(Number.isFinite(duration) && duration > 0) || waveform.length < 2) {
		return [];
	}
	const minimum = Number.isFinite(minimumDuration)
		? Math.max(0.05, Math.min(5, minimumDuration))
		: 0.25;
	const values = waveform.map((value) =>
		Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0
	);
	const highest = Math.max(...values);
	if (!(highest >= 0.08)) {
		return [];
	}
	const threshold = Math.max(0.025, highest * 0.14);
	const binDuration = duration / values.length;
	const ranges: [number, number][] = [];
	let startIndex: number | null = null;
	const flush = (endIndex: number) => {
		if (startIndex === null) {
			return;
		}
		const start = startIndex * binDuration;
		const end = endIndex * binDuration;
		if (end - start >= minimum) {
			ranges.push([Number(start.toFixed(3)), Number(end.toFixed(3))]);
		}
		startIndex = null;
	};
	for (const [index, value] of values.entries()) {
		if (value < threshold) {
			startIndex ??= index;
		} else {
			flush(index);
		}
		if (ranges.length >= 80) {
			break;
		}
	}
	if (ranges.length < 80 && startIndex !== null) {
		flush(values.length);
	}
	return ranges;
}
