import { z } from "zod";
import {
	DEFAULT_FILLERS,
	MAX_REMOVE_RANGES,
	mergeTimelineRanges,
	normalizeTranscriptText,
	type TimelineRange,
	type TimelineTranscript,
	type TimelineWord,
	transcriptWords,
} from "./filler-words.ts";
import type { Project } from "./project.ts";
import { captionsForSource, type Transcript } from "./transcript.ts";

export const timelineTranscriptSchema = z
	.object({
		clips: z
			.array(
				z
					.object({
						assetId: z.uuid(),
						clipId: z.uuid(),
						cues: z.array(z.unknown()).max(5000),
						words: z.array(z.unknown()).max(50_000),
					})
					.strict()
			)
			.max(200),
		projectId: z.uuid(),
		revision: z.number().int().nonnegative(),
		sourceCaptions: z.array(z.unknown()).max(5000),
	})
	.strict();

export function timelineTranscript(
	project: Project,
	transcriptFor: (assetId: string) => Transcript | null,
	track?: number
) {
	const clips = project.segments
		.filter((segment) => track === undefined || segment.track === track)
		.flatMap((segment) => {
			const transcript = transcriptFor(segment.assetId);
			if (transcript?.status !== "completed") {
				return [];
			}
			const cues = captionsForSource(
				{ ...project, segments: [segment] },
				transcript
			);
			const words = captionsForSource(
				{ ...project, segments: [segment] },
				{ ...transcript, cues: transcript.words }
			);
			return [{ assetId: segment.assetId, clipId: segment.id, cues, words }];
		});
	return timelineTranscriptSchema.parse({
		clips,
		projectId: project.id,
		revision: project.revision,
		sourceCaptions: project.captions,
	});
}

/** A transcript unit in timeline seconds: a timed word, or a whole cue when its clip has no word timing. */
export interface TranscriptToken {
	clipId: string;
	end: number;
	/** Position in the timeline-ordered token list. */
	index: number;
	/** `normalizeTranscriptText(text)`; empty for punctuation-only tokens. */
	norm: string;
	start: number;
	text: string;
	unit: "cue" | "word";
}

/** An inclusive run of token indices. */
export interface TokenSpan {
	first: number;
	last: number;
}

/** A one-click removal suggested by the repeated-phrase and retake scan. */
export interface TranscriptRemovalPlan extends TokenSpan {
	id: string;
	/** Text of the later take that the removal keeps. */
	keeps: string;
	kind: "repeat" | "retake";
	range: TimelineRange;
	/** Text the removal deletes. */
	text: string;
}

export interface RepeatedPhraseOptions {
	maxN?: number;
	/** Normalized word-level edit distance below which a sentence counts as a retake. */
	maxRetakeDistance?: number;
	minN?: number;
	/** Seconds after the earlier take within which the repeat must start. */
	window?: number;
}

const timedTextSchema = z.object({
	end: z.number().finite(),
	start: z.number().finite(),
	text: z.string(),
});

/** Two transcripts of one source on linked clips report the same word twice. */
const DUPLICATE_TOLERANCE = 0.02;
/** A pause this long ends a sentence even without terminal punctuation. */
const SENTENCE_PAUSE = 0.7;
const SENTENCE_END = /[.?!…]["')\]]*$/u;
const DEFAULT_MIN_N = 2;
const DEFAULT_MAX_N = 6;
const DEFAULT_REPEAT_WINDOW = 10;
const DEFAULT_RETAKE_DISTANCE = 0.3;
const MIN_RETAKE_WORDS = 3;
/**
 * Longest pause before a kept take that a plan removes with the earlier take.
 * Anything longer is deliberate, and may hold B-roll or titles on other tracks.
 */
const MAX_HESITATION = 1;
/** Most filler words allowed between a phrase and its immediate repeat. */
const MAX_REPEAT_FILLERS = 2;
const SINGLE_WORD_FILLERS = new Set(
	DEFAULT_FILLERS.filter((filler) => !filler.includes(" "))
);

/** Function words: an n-gram made only of these is ordinary speech, not a repeat. */
const STOP_WORDS = new Set([
	"a",
	"an",
	"and",
	"are",
	"as",
	"at",
	"be",
	"but",
	"by",
	"do",
	"for",
	"from",
	"have",
	"he",
	"i",
	"if",
	"in",
	"is",
	"it",
	"it's",
	"its",
	"of",
	"on",
	"or",
	"so",
	"that",
	"the",
	"there",
	"they",
	"this",
	"to",
	"was",
	"we",
	"with",
	"you",
]);

function cueUnits(clip: TimelineTranscript["clips"][number]): TimelineWord[] {
	return clip.cues.flatMap((value) => {
		const parsed = timedTextSchema.safeParse(value);
		return parsed.success && parsed.data.end > parsed.data.start
			? [{ clipId: clip.clipId, ...parsed.data }]
			: [];
	});
}

/**
 * Every clip's words in timeline order. A clip without word timing contributes
 * its cues as whole units; the same word reported by two clips (linked
 * picture and sound transcribing one source) appears once.
 */
export function timelineTokens(
	timeline: TimelineTranscript
): TranscriptToken[] {
	const perClip = transcriptWords(timeline);
	const units = timeline.clips.flatMap(
		(clip, position): Array<TimelineWord & Pick<TranscriptToken, "unit">> => {
			const words = perClip[position] ?? [];
			return words.length > 0
				? words.map((word) => ({ ...word, unit: "word" }))
				: cueUnits(clip).map((cue) => ({ ...cue, unit: "cue" }));
		}
	);
	units.sort(
		(a, b) =>
			a.start - b.start || a.end - b.end || a.clipId.localeCompare(b.clipId)
	);
	const tokens: TranscriptToken[] = [];
	for (const unit of units) {
		const norm = normalizeTranscriptText(unit.text);
		if (!isDuplicate(tokens, unit, norm)) {
			tokens.push({ ...unit, index: tokens.length, norm });
		}
	}
	return tokens;
}

/** Whether another clip already reported `unit` (tokens are sorted by start). */
function isDuplicate(
	tokens: readonly TranscriptToken[],
	unit: TimelineWord,
	norm: string
) {
	for (let index = tokens.length - 1; index >= 0; index--) {
		const token = tokens[index];
		if (!token || token.start < unit.start - DUPLICATE_TOLERANCE) {
			return false;
		}
		if (
			token.clipId !== unit.clipId &&
			token.norm === norm &&
			Math.abs(token.end - unit.end) <= DUPLICATE_TOLERANCE
		) {
			return true;
		}
	}
	return false;
}

/** Index of the token playing at `time` (binary search), or -1 between tokens. */
export function tokenIndexAt(
	tokens: readonly TranscriptToken[],
	time: number
): number {
	let low = 0;
	let high = tokens.length - 1;
	let found = -1;
	while (low <= high) {
		const middle = (low + high) >> 1;
		if ((tokens[middle]?.start ?? 0) <= time) {
			found = middle;
			low = middle + 1;
		} else {
			high = middle - 1;
		}
	}
	const token = tokens[found];
	return token && time < token.end ? found : -1;
}

/**
 * Runs of tokens matching `query` (case and punctuation insensitive). The last
 * query word matches as a prefix so results follow typing; a cue unit matches
 * when its text contains the whole query.
 */
export function searchTokens(
	tokens: readonly TranscriptToken[],
	query: string
): TokenSpan[] {
	const needle = normalizeTranscriptText(query);
	const words = needle.split(" ").filter(Boolean);
	if (words.length === 0) {
		return [];
	}
	const hits: TokenSpan[] = [];
	for (let index = 0; index < tokens.length; index++) {
		const token = tokens[index];
		if (token?.unit === "cue") {
			if (token.norm.includes(needle)) {
				hits.push({ first: index, last: index });
			}
			continue;
		}
		const matches = words.every((word, offset) => {
			const candidate = tokens[index + offset];
			if (candidate?.unit !== "word") {
				return false;
			}
			return offset === words.length - 1
				? candidate.norm.startsWith(word)
				: candidate.norm === word;
		});
		if (matches) {
			hits.push({ first: index, last: index + words.length - 1 });
		}
	}
	return hits;
}

/** Group sorted token indices into inclusive runs of consecutive indices. */
export function spansFromIndices(indices: Iterable<number>): TokenSpan[] {
	const sorted = [...new Set(indices)]
		.filter((index) => Number.isInteger(index) && index >= 0)
		.sort((a, b) => a - b);
	const spans: TokenSpan[] = [];
	for (const index of sorted) {
		const previous = spans.at(-1);
		if (previous && index === previous.last + 1) {
			previous.last = index;
		} else {
			spans.push({ first: index, last: index });
		}
	}
	return spans;
}

/** Every index from `from` to `to`, in either order. */
export function indicesBetween(from: number, to: number): number[] {
	const low = Math.min(from, to);
	return Array.from({ length: Math.abs(to - from) + 1 }, (_, i) => low + i);
}

/** Timeline extent of a token run: the first token's start to the latest end inside it. */
export function spanRange(
	tokens: readonly TranscriptToken[],
	span: TokenSpan
): TimelineRange | null {
	const run = tokens.slice(span.first, span.last + 1);
	const first = run[0];
	if (!first) {
		return null;
	}
	return {
		end: Math.max(...run.map((token) => token.end)),
		start: first.start,
	};
}

/**
 * Selected token runs as ascending remove-words ranges: touching or overlapping
 * runs merge, ranges clamp to `[0, timelineEnd]`, sub-40 ms slivers drop, and at
 * most 100 ranges (the request bound) are returned.
 */
export function selectionRanges(
	tokens: readonly TranscriptToken[],
	spans: readonly TokenSpan[],
	timelineEnd: number
): TimelineRange[] {
	return selectionBatch(tokens, spans, timelineEnd).ranges;
}

/** `selectionRanges` plus how many merged ranges did not fit in the request. */
export function selectionBatch(
	tokens: readonly TranscriptToken[],
	spans: readonly TokenSpan[],
	timelineEnd: number
): RangeBatch {
	const ranges = spans.flatMap((span) => {
		const range = spanRange(tokens, span);
		return range ? [range] : [];
	});
	return rangeBatch(ranges, timelineEnd);
}

/**
 * Sentence runs: a boundary follows terminal punctuation or a pause of at
 * least 0.7 s, and each cue unit is a sentence of its own.
 */
export function sentenceSpans(tokens: readonly TranscriptToken[]): TokenSpan[] {
	const spans: TokenSpan[] = [];
	let start = 0;
	for (let index = 0; index < tokens.length; index++) {
		const token = tokens[index];
		const next = tokens[index + 1];
		if (!token) {
			continue;
		}
		const boundary =
			!next ||
			token.unit === "cue" ||
			next.unit === "cue" ||
			SENTENCE_END.test(token.text.trim()) ||
			next.start - token.end >= SENTENCE_PAUSE;
		if (boundary) {
			spans.push({ first: start, last: index });
			start = index + 1;
		}
	}
	return spans;
}

/** Word-level Levenshtein distance divided by the longer length (0 when both are empty). */
export function normalizedEditDistance(
	a: readonly string[],
	b: readonly string[]
): number {
	const longest = Math.max(a.length, b.length);
	if (longest === 0) {
		return 0;
	}
	let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
	for (let i = 1; i <= a.length; i++) {
		const current = [i];
		for (let j = 1; j <= b.length; j++) {
			const substitution =
				(previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1);
			current.push(
				Math.min(
					(previous[j] ?? 0) + 1,
					(current[j - 1] ?? 0) + 1,
					substitution
				)
			);
		}
		previous = current;
	}
	return (previous[b.length] ?? 0) / longest;
}

const spanText = (tokens: readonly TranscriptToken[], span: TokenSpan) =>
	tokens
		.slice(span.first, span.last + 1)
		.map((token) => token.text.trim())
		.join(" ");

const isWord = (token: TranscriptToken | undefined): token is TranscriptToken =>
	token?.unit === "word" && token.norm !== "";

function round(value: number) {
	return Math.round(value * 1000) / 1000;
}

function removalRange(
	tokens: readonly TranscriptToken[],
	span: TokenSpan,
	keptStart: number
): TimelineRange | null {
	const range = spanRange(tokens, span);
	if (!range) {
		return null;
	}
	// A short hesitation (and any fillers in it) before the kept take goes with
	// the earlier take; a longer pause stays, like the padding around fillers.
	const gap = keptStart - range.end;
	const end = gap > 0 && gap <= MAX_HESITATION ? keptStart : range.end;
	const result = { end: round(end), start: round(range.start) };
	return result.end - result.start >= 0.04 ? result : null;
}

function retakePlans(
	tokens: readonly TranscriptToken[],
	window: number,
	maxDistance: number
): TranscriptRemovalPlan[] {
	const sentences = sentenceSpans(tokens);
	const plans: TranscriptRemovalPlan[] = [];
	for (let position = 0; position + 1 < sentences.length; position++) {
		const abandoned = sentences[position];
		const restart = sentences[position + 1];
		if (!(abandoned && restart)) {
			continue;
		}
		const first = tokens.slice(abandoned.first, abandoned.last + 1);
		const second = tokens.slice(restart.first, restart.last + 1);
		const restartStart = second[0]?.start ?? Number.POSITIVE_INFINITY;
		const lastEnd = first.at(-1)?.end ?? 0;
		if (
			!(first.every(isWord) && second.every(isWord)) ||
			first.length < MIN_RETAKE_WORDS ||
			second.length < first.length ||
			restartStart - lastEnd > window
		) {
			continue;
		}
		const distance = normalizedEditDistance(
			first.map((token) => token.norm),
			second.slice(0, first.length).map((token) => token.norm)
		);
		const range = removalRange(tokens, abandoned, restartStart);
		if (distance < maxDistance && range) {
			plans.push({
				...abandoned,
				id: `retake:${abandoned.first}-${abandoned.last}`,
				keeps: spanText(tokens, restart),
				kind: "retake",
				range,
				text: spanText(tokens, abandoned),
			});
		}
	}
	return plans;
}

function gramKey(tokens: readonly TranscriptToken[], at: number, n: number) {
	const run = tokens.slice(at, at + n);
	if (run.length < n || !run.every(isWord)) {
		return null;
	}
	if (run.every((token) => STOP_WORDS.has(token.norm))) {
		return null;
	}
	return run.map((token) => token.norm).join(" ");
}

/**
 * Index of the repeat of the n-gram at `at` when it follows immediately (at
 * most two filler words between, within `window` seconds), else -1. A phrase
 * that recurs later in ordinary speech is not a stammer.
 */
function immediateRepeat(
	tokens: readonly TranscriptToken[],
	at: number,
	n: number,
	key: string,
	window: number
): number {
	const lastEnd = tokens[at + n - 1]?.end ?? 0;
	for (let skipped = 0; skipped <= MAX_REPEAT_FILLERS; skipped++) {
		const next = at + n + skipped;
		const between = tokens.slice(at + n, next);
		if (!between.every((token) => SINGLE_WORD_FILLERS.has(token.norm))) {
			return -1;
		}
		if ((tokens[next]?.start ?? Number.POSITIVE_INFINITY) - lastEnd > window) {
			return -1;
		}
		if (gramKey(tokens, next, n) === key) {
			return next;
		}
	}
	return -1;
}

function repeatPlans(
	tokens: readonly TranscriptToken[],
	minN: number,
	maxN: number,
	window: number
): TranscriptRemovalPlan[] {
	const used = new Set<number>();
	const plans: TranscriptRemovalPlan[] = [];
	for (let n = maxN; n >= minN; n--) {
		for (let at = 0; at + n <= tokens.length; at++) {
			const key = gramKey(tokens, at, n);
			if (
				key === null ||
				indicesBetween(at, at + n - 1).some((i) => used.has(i))
			) {
				continue;
			}
			const later = immediateRepeat(tokens, at, n, key, window);
			const keptStart = tokens[later]?.start;
			if (later < 0 || keptStart === undefined) {
				continue;
			}
			const span = { first: at, last: at + n - 1 };
			const range = removalRange(tokens, span, keptStart);
			if (!range) {
				continue;
			}
			for (const index of indicesBetween(span.first, span.last)) {
				used.add(index);
			}
			plans.push({
				...span,
				id: `repeat:${span.first}-${span.last}`,
				keeps: spanText(tokens, { first: later, last: later + n - 1 }),
				kind: "repeat",
				range,
				text: spanText(tokens, span),
			});
		}
	}
	return plans;
}

/**
 * Repeated phrases (a 2-6 word n-gram repeated immediately, with at most two
 * filler words between, within `window` seconds; longest first, skipping
 * function-word-only n-grams) and retakes (a sentence of 3+ words restarted by
 * the next one at a normalized edit distance below 0.3). Each plan removes the
 * earlier take and keeps the later one; a pause of up to 1 s before the kept
 * take goes too, a longer one stays. Repeats inside a retake are folded into
 * it. Plans are sorted by start time.
 */
export function findRepeatedPhrases(
	tokens: readonly TranscriptToken[],
	options: RepeatedPhraseOptions = {}
): TranscriptRemovalPlan[] {
	const window = options.window ?? DEFAULT_REPEAT_WINDOW;
	const minN = Math.max(2, Math.floor(options.minN ?? DEFAULT_MIN_N));
	const maxN = Math.max(minN, Math.floor(options.maxN ?? DEFAULT_MAX_N));
	const retakes = retakePlans(
		tokens,
		window,
		options.maxRetakeDistance ?? DEFAULT_RETAKE_DISTANCE
	);
	const repeats = repeatPlans(tokens, minN, maxN, window).filter(
		(plan) =>
			!retakes.some(
				(retake) => plan.first >= retake.first && plan.last <= retake.last
			)
	);
	return [...retakes, ...repeats].sort(
		(a, b) => a.range.start - b.range.start || a.range.end - b.range.end
	);
}

/** Ranges merged, clamped, and split into the first request-sized batch. */
export interface RangeBatch {
	ranges: TimelineRange[];
	/** Merged ranges left for a later request. */
	skipped: number;
}

function rangeBatch(
	ranges: readonly TimelineRange[],
	timelineEnd: number
): RangeBatch {
	const merged = mergeTimelineRanges(ranges, 0, timelineEnd);
	return {
		ranges: merged.slice(0, MAX_REMOVE_RANGES),
		skipped: Math.max(0, merged.length - MAX_REMOVE_RANGES),
	};
}

/**
 * Remove-words ranges for a set of plans: merged, clamped to the timeline,
 * ascending, and bounded by the request limit.
 */
export function planRanges(
	plans: readonly Pick<TranscriptRemovalPlan, "range">[],
	timelineEnd: number
): TimelineRange[] {
	return planBatch(plans, timelineEnd).ranges;
}

/**
 * The first request-sized batch of plan ranges, with how many of the plans it
 * fully covers, so a caller can say "first 40 of 130" instead of implying all.
 */
export function planBatch(
	plans: readonly Pick<TranscriptRemovalPlan, "range">[],
	timelineEnd: number
): RangeBatch & { covered: number } {
	const batch = rangeBatch(
		plans.map((plan) => plan.range),
		timelineEnd
	);
	const covered = plans.filter((plan) => {
		const start = Math.max(0, plan.range.start);
		const end = Math.min(timelineEnd, plan.range.end);
		return batch.ranges.some(
			(range) => range.start <= start + 0.001 && range.end >= end - 0.001
		);
	}).length;
	return { ...batch, covered };
}
