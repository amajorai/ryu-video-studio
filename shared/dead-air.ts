import { z } from "zod";
import {
	type ClipSpan,
	MAX_REMOVE_RANGES,
	mergeTimelineRanges,
	type TimelineRange,
	type TimelineTranscript,
	transcriptWords,
} from "./filler-words.ts";
import { trackIndexSchema } from "./limits.ts";
import { type SourceMapping, subtractRanges, vadParamsSchema } from "./vad.ts";

/** Clip-span helpers live with the shared transcript helpers; re-exported for dead-air callers. */
export { type ClipSpan, transcriptClipSpans } from "./filler-words.ts";

const DEFAULT_MIN_PAUSE = 0.6;
const DEFAULT_KEEP_PAUSE = 0.2;
const DEFAULT_PADDING = 0.05;
const DEFAULT_REFINE_MIN_LENGTH = 0.3;
const EPSILON = 1e-9;

export const deadAirPlanRequestSchema = z
	.object({
		keepPause: z.number().finite().min(0).max(2).optional(),
		minPause: z.number().finite().min(0.1).max(10).optional(),
		padding: z.number().finite().min(0).max(0.5).optional(),
		track: trackIndexSchema.optional(),
		/**
		 * Confirm transcript pauses with voice activity detection: only the parts
		 * of each pause where no audible clip has detected speech are kept.
		 */
		vad: z.boolean().optional(),
		/** VAD onset in dB above the adaptive noise floor (with `vad`). */
		threshold: vadParamsSchema.shape.threshold,
		/** Shortest VAD speech run in seconds (with `vad`). */
		minSpeech: vadParamsSchema.shape.minSpeech,
	})
	.strict();

export type DeadAirPlanRequest = z.infer<typeof deadAirPlanRequestSchema>;

export interface DeadAirOptions {
	keepPause?: number;
	minPause?: number;
	padding?: number;
	/**
	 * Unfiltered (all-track) transcript whose speech is never removed; defaults to the
	 * scanned timeline. Ripple deletion cuts every track, so pass it when `track` filters the scan.
	 */
	protect?: TimelineTranscript;
	/** Clip extents; without them only pauses between a clip's first and last word are found. */
	spans?: readonly ClipSpan[];
}

export interface DeadAirPlan {
	ranges: TimelineRange[];
	removedSeconds: number;
}

interface Gap {
	end: number;
	endsAtWord: boolean;
	start: number;
	startsAtWord: boolean;
}

function round(value: number) {
	return Math.round(value * 1000) / 1000;
}

/** Union of overlapping or touching intervals, used for speech and clip regions. */
function speechIntervals(words: readonly TimelineRange[]) {
	const merged: TimelineRange[] = [];
	for (const word of [...words].sort((a, b) => a.start - b.start)) {
		const previous = merged.at(-1);
		if (previous && word.start <= previous.end) {
			previous.end = Math.max(previous.end, word.end);
		} else {
			merged.push({ end: word.end, start: word.start });
		}
	}
	return merged;
}

function regionGaps(
	region: TimelineRange,
	speech: readonly TimelineRange[]
): Gap[] {
	const gaps: Gap[] = [];
	let cursor = region.start;
	let cursorAtWord = false;
	for (const interval of speech) {
		if (interval.end <= region.start || interval.start >= region.end) {
			continue;
		}
		if (interval.start > cursor) {
			gaps.push({
				end: interval.start,
				endsAtWord: true,
				start: cursor,
				startsAtWord: cursorAtWord,
			});
		}
		if (interval.end > cursor) {
			cursor = interval.end;
			cursorAtWord = true;
		}
	}
	if (region.end > cursor) {
		gaps.push({
			end: region.end,
			endsAtWord: false,
			start: cursor,
			startsAtWord: cursorAtWord,
		});
	}
	return gaps;
}

/**
 * Find pauses longer than `minPause` between transcript words (and at clip edges when spans
 * are given), keeping `keepPause` split across both word sides plus `padding` per word edge.
 * Ranges are timeline seconds, merged, at most 100, and latest first for ripple deletion.
 */
export function deadAirRanges(
	timeline: TimelineTranscript,
	options: DeadAirOptions = {}
): DeadAirPlan {
	const minPause = options.minPause ?? DEFAULT_MIN_PAUSE;
	const keepSide =
		(options.keepPause ?? DEFAULT_KEEP_PAUSE) / 2 +
		(options.padding ?? DEFAULT_PADDING);
	const wordsByClip = transcriptWords(timeline);
	const speech = speechIntervals([
		...wordsByClip.flat(),
		...(options.protect ? transcriptWords(options.protect).flat() : []),
	]);
	const spans = new Map(
		(options.spans ?? []).map((span) => [span.clipId, span] as const)
	);
	const regions = speechIntervals(
		timeline.clips.flatMap((clip, index) => {
			const words = wordsByClip[index] ?? [];
			const region = spans.get(clip.clipId) ?? {
				end: Math.max(...words.map((word) => word.end)),
				start: Math.min(...words.map((word) => word.start)),
			};
			return region.end > region.start ? [region] : [];
		})
	);
	const cuts: TimelineRange[] = [];
	for (const gap of regions.flatMap((region) => regionGaps(region, speech))) {
		if (gap.end - gap.start - minPause <= EPSILON) {
			continue;
		}
		const start = gap.start + (gap.startsAtWord ? keepSide : 0);
		const end = gap.end - (gap.endsAtWord ? keepSide : 0);
		if (end > start) {
			cuts.push({ end, start });
		}
	}
	const timelineEnd = Math.max(0, ...regions.map((region) => region.end));
	const ranges = mergeTimelineRanges(cuts, 0, timelineEnd)
		.sort((a, b) => b.end - b.start - (a.end - a.start) || a.start - b.start)
		.slice(0, MAX_REMOVE_RANGES)
		.sort((a, b) => b.start - a.start);
	return {
		ranges,
		removedSeconds: round(
			ranges.reduce((total, range) => total + (range.end - range.start), 0)
		),
	};
}

/**
 * Shrink or split dead-air ranges around waveform energy. The waveform covers
 * `[0, duration]` timeline seconds. Ranges with no energy are kept unchanged; pieces
 * left by a shrink or split are dropped when shorter than `minLength`.
 */
export function refineWithWaveform(
	ranges: readonly TimelineRange[],
	waveform: { bins: readonly number[]; duration: number },
	options: { minLength?: number } = {}
): TimelineRange[] {
	const { bins, duration } = waveform;
	const values = bins.map((value) =>
		Number.isFinite(value) ? Math.min(1, Math.abs(value)) : 0
	);
	const highest = Math.max(0, ...values);
	const usable =
		Number.isFinite(duration) &&
		duration > 0 &&
		values.length >= 2 &&
		highest >= 0.08;
	const threshold = Math.max(0.025, highest * 0.14);
	const binDuration = duration / values.length;
	const minLength = Math.max(
		0.04,
		options.minLength ?? DEFAULT_REFINE_MIN_LENGTH
	);
	const pieces: TimelineRange[] = [];
	for (const range of ranges) {
		const loud = usable ? loudSpans(range, values, threshold, binDuration) : [];
		if (loud.length === 0) {
			pieces.push({ end: range.end, start: range.start });
			continue;
		}
		let cursor = range.start;
		const split: TimelineRange[] = [];
		for (const span of loud) {
			if (span.start > cursor) {
				split.push({ end: span.start, start: cursor });
			}
			cursor = Math.max(cursor, span.end);
		}
		if (range.end > cursor) {
			split.push({ end: range.end, start: cursor });
		}
		pieces.push(
			...split.filter((piece) => piece.end - piece.start >= minLength - EPSILON)
		);
	}
	return mergeTimelineRanges(pieces).sort((a, b) => b.start - a.start);
}

/** Loud bins that overlap a range, as timeline intervals in time order. */
function loudSpans(
	range: TimelineRange,
	values: readonly number[],
	threshold: number,
	binDuration: number
): TimelineRange[] {
	const spans: TimelineRange[] = [];
	const first = Math.max(0, Math.floor(range.start / binDuration));
	const last = Math.min(values.length - 1, Math.ceil(range.end / binDuration));
	for (let index = first; index <= last; index += 1) {
		const start = index * binDuration;
		const end = start + binDuration;
		if (
			(values[index] ?? 0) >= threshold &&
			end > range.start &&
			start < range.end
		) {
			spans.push({ end, start });
		}
	}
	return spans;
}

/** One clip's source envelope, used to build a timeline waveform. */
export interface ClipEnvelope {
	clip: SourceMapping;
	duration: number;
	/** Source RMS envelope bins (0..1) spanning `[0, duration]` source seconds. */
	waveform: readonly number[];
}

const TIMELINE_WAVEFORM_BIN = 0.05;
const MAX_TIMELINE_WAVEFORM_BINS = 200_000;

/**
 * Sample several clips' source envelopes onto one timeline waveform covering
 * `[0, timelineEnd]`; where clips overlap the louder value wins.
 */
export function timelineWaveform(
	clips: readonly ClipEnvelope[],
	timelineEnd: number
): { bins: number[]; duration: number } {
	if (!(Number.isFinite(timelineEnd) && timelineEnd > 0)) {
		return { bins: [], duration: 0 };
	}
	const count = Math.min(
		MAX_TIMELINE_WAVEFORM_BINS,
		Math.max(2, Math.ceil(timelineEnd / TIMELINE_WAVEFORM_BIN))
	);
	const binDuration = timelineEnd / count;
	const bins = new Array<number>(count).fill(0);
	for (const { clip, duration, waveform } of clips) {
		if (!(clip.speed > 0 && duration > 0 && waveform.length > 0)) {
			continue;
		}
		const clipEnd = clip.start + (clip.sourceOut - clip.sourceIn) / clip.speed;
		const first = Math.max(0, Math.floor(clip.start / binDuration));
		const last = Math.min(count - 1, Math.ceil(clipEnd / binDuration));
		for (let index = first; index <= last; index += 1) {
			const time = (index + 0.5) * binDuration;
			if (time < clip.start || time > clipEnd) {
				continue;
			}
			const source = clip.sourceIn + (time - clip.start) * clip.speed;
			const sourceBin = Math.min(
				waveform.length - 1,
				Math.max(0, Math.floor((source / duration) * waveform.length))
			);
			const value = waveform[sourceBin] ?? 0;
			if (Number.isFinite(value) && value > (bins[index] ?? 0)) {
				bins[index] = value;
			}
		}
	}
	return { bins, duration: timelineEnd };
}

export interface VoiceActivityConfirmation {
	/** Pieces shorter than this after VAD trimming are dropped (seconds). */
	minLength?: number;
	/** Seconds of each pause kept next to detected speech. */
	padding?: number;
	/** Timeline speech intervals detected by VAD across audible clips. */
	speech: readonly TimelineRange[];
	/** Optional timeline waveform for `refineWithWaveform`. */
	waveform?: { bins: readonly number[]; duration: number };
}

/**
 * Intersect a transcript dead-air plan with VAD non-speech: speech detected
 * by VAD (widened by `padding`) is subtracted from every planned range, the
 * remainder is refined around waveform energy, and pieces a trim left
 * shorter than `minLength` are dropped. Ranges are latest first.
 */
export function confirmDeadAirWithVoiceActivity(
	plan: DeadAirPlan,
	options: VoiceActivityConfirmation
): DeadAirPlan {
	const padding = Math.max(0, options.padding ?? 0);
	const minLength = Math.max(
		0.04,
		options.minLength ?? DEFAULT_REFINE_MIN_LENGTH
	);
	const widened = options.speech.map((range) => ({
		end: range.end + padding,
		start: Math.max(0, range.start - padding),
	}));
	const pieces: TimelineRange[] = [];
	for (const range of plan.ranges) {
		const kept = subtractRanges([range], widened);
		const untouched =
			kept.length === 1 &&
			Math.abs((kept[0]?.start ?? 0) - range.start) < EPSILON &&
			Math.abs((kept[0]?.end ?? 0) - range.end) < EPSILON;
		pieces.push(
			...(untouched
				? kept
				: kept.filter(
						(piece) => piece.end - piece.start >= minLength - EPSILON
					))
		);
	}
	const refined = options.waveform
		? refineWithWaveform(pieces, options.waveform, { minLength })
		: mergeTimelineRanges(pieces).sort((a, b) => b.start - a.start);
	const ranges = refined
		.slice(0, MAX_REMOVE_RANGES)
		.map((range) => ({ end: round(range.end), start: round(range.start) }));
	return {
		ranges,
		removedSeconds: round(
			ranges.reduce((total, range) => total + (range.end - range.start), 0)
		),
	};
}
