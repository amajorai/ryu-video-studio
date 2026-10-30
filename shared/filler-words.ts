import { z } from "zod";
import { trackIndexSchema } from "./limits.ts";
import { type Project, segmentDuration } from "./project.ts";
import type { timelineTranscriptSchema } from "./timeline-transcript.ts";

/** Timeline transcript as produced by `timelineTranscript` (words in timeline seconds). */
export type TimelineTranscript = z.infer<typeof timelineTranscriptSchema>;

/** Filler words and phrases flagged when no custom list is supplied. */
export const DEFAULT_FILLERS: readonly string[] = [
	"um",
	"umm",
	"uh",
	"uhh",
	"uhm",
	"erm",
	"er",
	"ah",
	"hmm",
	"mm",
	"you know",
	"i mean",
	"like",
];

/** Fillers that are only flagged when pauses isolate them from their neighbours. */
const PAUSE_GATED_FILLERS = new Set(["like"]);

/** Longest range the remove-words request accepts, in timeline seconds. */
const MAX_TIMELINE_SECONDS = 7200;
/** Shortest range the remove-words request accepts. */
const MIN_RANGE_SECONDS = 0.04;
/** Most ranges one remove-words request accepts. */
export const MAX_REMOVE_RANGES = 100;

const DEFAULT_REPEAT_WINDOW = 1;
const DEFAULT_PADDING = 0.03;
const DEFAULT_MIN_GAP_FOR_LIKE = 0.15;
const DEFAULT_MERGE_GAP = 0.05;

export const fillerPlanRequestSchema = z
	.object({
		fillers: z
			.array(z.string().trim().min(1).max(40))
			.min(1)
			.max(50)
			.optional(),
		mergeGap: z.number().finite().min(0).max(0.5).optional(),
		minGapForLike: z.number().finite().min(0).max(2).optional(),
		multiWord: z.boolean().optional(),
		padding: z.number().finite().min(0).max(0.25).optional(),
		repeatWindow: z.number().finite().min(0).max(5).optional(),
		track: trackIndexSchema.optional(),
	})
	.strict();

export type FillerPlanRequest = z.infer<typeof fillerPlanRequestSchema>;

export interface FillerHit {
	clipId: string;
	end: number;
	kind: "filler" | "repeat" | "stutter";
	start: number;
	text: string;
}

/** Timeline extent of one transcribed clip, used to bound padding and edge silence. */
export interface ClipSpan {
	clipId: string;
	end: number;
	start: number;
}

export interface FindFillersOptions {
	fillers?: readonly string[];
	minGapForLike?: number;
	multiWord?: boolean;
	padding?: number;
	/**
	 * Unfiltered (all-track) transcript whose words are protected from padding and
	 * overlap; defaults to the scanned timeline. Pass it when the scan is track-filtered.
	 */
	protect?: TimelineTranscript;
	repeatWindow?: number;
	/** Clip extents; without them padding stops at each clip's first and last word. */
	spans?: readonly ClipSpan[];
}

/** A timeline range in the shape `removeWordsRequestSchema` accepts. */
export interface TimelineRange {
	end: number;
	start: number;
}

export interface TimelineWord {
	clipId: string;
	end: number;
	start: number;
	text: string;
}

const wordSchema = z.object({
	end: z.number().finite(),
	start: z.number().finite(),
	text: z.string(),
});

/** Read valid, time-ordered words for each clip of a timeline transcript. */
export function transcriptWords(
	timeline: TimelineTranscript
): TimelineWord[][] {
	return timeline.clips.map((clip) =>
		clip.words
			.flatMap((value) => {
				const parsed = wordSchema.safeParse(value);
				return parsed.success && parsed.data.end > parsed.data.start
					? [{ clipId: clip.clipId, ...parsed.data }]
					: [];
			})
			.sort((a, b) => a.start - b.start || a.end - b.end)
	);
}

/** Lowercase a token and strip punctuation other than inner apostrophes and hyphens. */
export function normalizeTranscriptText(text: string): string {
	return text
		.toLowerCase()
		.replace(/[^\p{L}\p{N}'\- ]+/gu, " ")
		.replace(/\s+/g, " ")
		.trim()
		.replace(/^'+|'+$/g, "");
}

function round(value: number) {
	return Math.round(value * 1000) / 1000;
}

/** Timeline extents of the clips a timeline transcript covers. */
export function transcriptClipSpans(
	project: Project,
	timeline: TimelineTranscript
): ClipSpan[] {
	const ids = new Set(timeline.clips.map((clip) => clip.clipId));
	return project.segments
		.filter((segment) => ids.has(segment.id))
		.map((segment) => ({
			clipId: segment.id,
			end: segment.start + segmentDuration(segment),
			start: segment.start,
		}));
}

function phraseTokens(fillers: readonly string[], multiWord: boolean) {
	return fillers
		.map((filler) => normalizeTranscriptText(filler).split(" ").filter(Boolean))
		.filter((tokens) => tokens.length > 0 && (multiWord || tokens.length === 1))
		.sort((a, b) => b.length - a.length);
}

function matchesAt(
	tokens: readonly string[],
	phrase: readonly string[],
	at: number
) {
	return phrase.every((token, offset) => tokens[at + offset] === token);
}

interface ClipScan {
	/** Timeline bounds padding may not cross: the clip span, or its first and last word. */
	edge: TimelineRange;
	gapForLike: number;
	/** Protected words from every other clip, on any track. */
	others: readonly TimelineWord[];
	padding: number;
	phrases: string[][];
	repeatWindow: number;
	tokens: string[];
	words: TimelineWord[];
}

interface HitContext {
	after: number;
	before: number;
	first: TimelineWord;
	last: TimelineWord;
}

/**
 * Nearest word end before and word start after a run of words, across every clip.
 * Returns null when another clip's speech overlaps the run, since a ripple cut would delete it.
 */
function hitContext(
	scan: ClipScan,
	firstIndex: number,
	lastIndex: number
): HitContext | null {
	const first = scan.words[firstIndex];
	const last = scan.words[lastIndex];
	if (!(first && last)) {
		return null;
	}
	let before = scan.words[firstIndex - 1]?.end ?? Number.NEGATIVE_INFINITY;
	let after = scan.words[lastIndex + 1]?.start ?? Number.POSITIVE_INFINITY;
	for (const word of scan.others) {
		if (word.end > first.start && word.start < last.end) {
			return null;
		}
		if (word.end <= first.start) {
			before = Math.max(before, word.end);
		} else {
			after = Math.min(after, word.start);
		}
	}
	return { after, before, first, last };
}

function padded(scan: ClipScan, context: HitContext) {
	const start = Math.max(context.before, context.first.start - scan.padding);
	const end = Math.min(context.after, context.last.end + scan.padding);
	// Round to milliseconds, but never past the clip edge: the last clip's edge is the
	// timeline end, and rippleDeleteRange rejects a range that ends after it.
	const range = {
		end: Math.min(scan.edge.end, round(end)),
		start: Math.max(0, scan.edge.start, round(start)),
	};
	return range.end > range.start ? range : null;
}

function isolatedByPauses(scan: ClipScan, context: HitContext) {
	return (
		context.first.start - context.before >= scan.gapForLike &&
		context.after - context.last.end >= scan.gapForLike
	);
}

function hitAt(
	scan: ClipScan,
	index: number
): { hit: FillerHit; length: number } | null {
	const token = scan.tokens[index] ?? "";
	const word = scan.words[index];
	if (!(token && word)) {
		return null;
	}
	const hit = (kind: FillerHit["kind"], length: number) => {
		const context = hitContext(scan, index, index + length - 1);
		const range = context ? padded(scan, context) : null;
		const text = scan.words
			.slice(index, index + length)
			.map((item) => item.text.trim())
			.join(" ");
		return range
			? { hit: { clipId: word.clipId, kind, text, ...range }, length }
			: null;
	};
	for (const phrase of scan.phrases) {
		if (!matchesAt(scan.tokens, phrase, index)) {
			continue;
		}
		const context = hitContext(scan, index, index + phrase.length - 1);
		if (
			phrase.length === 1 &&
			PAUSE_GATED_FILLERS.has(token) &&
			!(context && isolatedByPauses(scan, context))
		) {
			continue;
		}
		return hit("filler", phrase.length);
	}
	const next = scan.tokens[index + 1];
	const nextWord = scan.words[index + 1];
	if (
		token.endsWith("-") &&
		token.length > 1 &&
		next?.startsWith(token.slice(0, -1)) &&
		next !== token
	) {
		return hit("stutter", 1);
	}
	if (
		nextWord &&
		next === token &&
		nextWord.start - word.end <= scan.repeatWindow
	) {
		return hit("repeat", 1);
	}
	return null;
}

/** Find filler words, immediate repeats, and stutters in timeline-time transcript words. */
export function findFillers(
	timeline: TimelineTranscript,
	options: FindFillersOptions = {}
): FillerHit[] {
	const phrases = phraseTokens(
		options.fillers ?? DEFAULT_FILLERS,
		options.multiWord ?? true
	);
	const spans = new Map(
		(options.spans ?? []).map((span) => [span.clipId, span] as const)
	);
	const protectedWords = transcriptWords(options.protect ?? timeline).flat();
	const hits: FillerHit[] = [];
	for (const words of transcriptWords(timeline)) {
		const clipId = words[0]?.clipId;
		if (!clipId) {
			continue;
		}
		const scan: ClipScan = {
			edge: spans.get(clipId) ?? {
				end: Math.max(...words.map((word) => word.end)),
				start: Math.min(...words.map((word) => word.start)),
			},
			gapForLike: options.minGapForLike ?? DEFAULT_MIN_GAP_FOR_LIKE,
			padding: options.padding ?? DEFAULT_PADDING,
			others: protectedWords.filter((word) => word.clipId !== clipId),
			phrases,
			repeatWindow: options.repeatWindow ?? DEFAULT_REPEAT_WINDOW,
			tokens: words.map((word) => normalizeTranscriptText(word.text)),
			words,
		};
		let index = 0;
		while (index < words.length) {
			const found = hitAt(scan, index);
			if (found) {
				hits.push(found.hit);
			}
			index += found?.length ?? 1;
		}
	}
	return hits.sort((a, b) => a.start - b.start || a.end - b.end);
}

/**
 * Merge ranges closer than `mergeGap`, round to milliseconds, clamp to `[0, maxEnd]`, and
 * drop sub-40 ms slivers. `maxEnd` keeps rounding from pushing the last range past the
 * timeline end; it defaults to the latest input end (or the request bound, if lower).
 */
export function mergeTimelineRanges(
	ranges: readonly TimelineRange[],
	mergeGap = 0,
	maxEnd?: number
): TimelineRange[] {
	const limit = Math.min(
		MAX_TIMELINE_SECONDS,
		maxEnd ?? Math.max(0, ...ranges.map((range) => range.end))
	);
	const sorted = ranges
		.map((range) => ({
			end: Math.min(limit, range.end),
			start: Math.max(0, range.start),
		}))
		.filter((range) => range.end > range.start)
		.sort((a, b) => a.start - b.start);
	const merged: TimelineRange[] = [];
	for (const range of sorted) {
		const previous = merged.at(-1);
		if (previous && range.start - previous.end <= mergeGap + 1e-9) {
			previous.end = Math.max(previous.end, range.end);
		} else {
			merged.push({ ...range });
		}
	}
	return merged
		.map((range) => ({
			end: Math.min(limit, round(range.end)),
			start: round(range.start),
		}))
		.filter((range) => range.end - range.start >= MIN_RANGE_SECONDS);
}

/** Turn hits into at most 100 merged remove-words ranges, latest first for ripple deletion. */
export function fillerRanges(
	hits: readonly FillerHit[],
	options: { maxEnd?: number; mergeGap?: number } = {}
): TimelineRange[] {
	return mergeTimelineRanges(
		hits,
		options.mergeGap ?? DEFAULT_MERGE_GAP,
		options.maxEnd
	)
		.slice(0, MAX_REMOVE_RANGES)
		.reverse();
}
