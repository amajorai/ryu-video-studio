import { z } from "zod";
import {
	DEFAULT_FILLERS,
	MAX_REMOVE_RANGES,
	mergeTimelineRanges,
	type TimelineRange,
} from "./filler-words.ts";
import {
	type Energy,
	energyFeatures,
	energyProfile,
	energyWindows,
	round,
	type Window,
} from "./highlights-energy.ts";
import type { Caption } from "./project.ts";

/** Longest source the highlight scorer reads, matching the analysis bound. */
const MAX_SECONDS = 7200;
/** A pause this long ends a sentence even without terminal punctuation. */
const SENTENCE_GAP_SECONDS = 0.6;
/** Scene cuts closer than this to a window edge count as aligned. */
const SCENE_TOLERANCE_SECONDS = 0.3;
/** Keywords containing other symbols (for example `C++`) cannot match whole words reliably. */
const KEYWORD_PATTERN = /^[\p{L}\p{N}'\-\s]+$/u;
/** Speech rate (tokens per second) that scores full density. */
const FULL_DENSITY_RATE = 3;
const TITLE_LENGTH = 60;

const WEIGHTS = {
	density: 0.25,
	energy: 0.15,
	filler: 0.15,
	hook: 0.15,
	keyword: 0.3,
	peaks: 0.15,
	scene: 0.1,
	variance: 0.1,
} as const;

export const highlightsRequestSchema = z
	.object({
		count: z.number().int().min(1).max(10),
		keywords: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
		target: z
			.object({
				max: z.number().finite().min(1).max(600),
				min: z.number().finite().min(1).max(600),
			})
			.strict()
			.refine((target) => target.max >= target.min, {
				message: "The highlight maximum must be at least the minimum.",
			}),
	})
	.strict();

export type HighlightsRequest = z.infer<typeof highlightsRequestSchema>;

export interface HighlightCandidate {
	end: number;
	reasons: string[];
	score: number;
	start: number;
	title: string;
}

type TimedText = Pick<Caption, "end" | "start" | "text">;

export interface ScoreHighlightsInput
	extends z.input<typeof highlightsRequestSchema> {
	cues: readonly TimedText[];
	sceneCuts?: readonly number[];
	waveform?: { bins: readonly number[]; duration: number };
	words: readonly TimedText[];
}

interface Sentence {
	end: number;
	firstToken: string;
	hook: boolean;
	keywordHits: number[];
	start: number;
	text: string;
	tokens: number;
}

/** Lowercase text and collapse punctuation so keyword phrases match whole words. */
function normalize(text: string) {
	return text
		.toLowerCase()
		.replace(/[^\p{L}\p{N}'\- ]+/gu, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function countOccurrences(haystack: string, needle: string) {
	if (!needle) {
		return 0;
	}
	const padded = ` ${haystack} `;
	const target = ` ${needle} `;
	let count = 0;
	let index = padded.indexOf(target);
	while (index !== -1) {
		count += 1;
		index = padded.indexOf(target, index + target.length - 1);
	}
	return count;
}

function endsSentence(text: string) {
	return /[.?!…]["')\]”’]*$/u.test(text.trim());
}

function validTimed(items: readonly TimedText[]) {
	return items
		.filter(
			(item) =>
				Number.isFinite(item.start) &&
				Number.isFinite(item.end) &&
				item.end > item.start &&
				item.start >= 0 &&
				item.end <= MAX_SECONDS &&
				item.text.trim().length > 0
		)
		.toSorted((a, b) => a.start - b.start || a.end - b.end);
}

/** Group words (or cues) into sentences ending on `.?!` or a 0.6 s pause. */
function sentences(
	units: readonly TimedText[],
	keywords: readonly string[]
): Sentence[] {
	const groups: TimedText[][] = [];
	let current: TimedText[] = [];
	for (const [index, unit] of units.entries()) {
		current.push(unit);
		const next = units[index + 1];
		if (
			!next ||
			endsSentence(unit.text) ||
			next.start - unit.end >= SENTENCE_GAP_SECONDS
		) {
			groups.push(current);
			current = [];
		}
	}
	return groups.flatMap((group) => {
		const first = group[0];
		const last = group.at(-1);
		if (!(first && last)) {
			return [];
		}
		const text = group
			.map((unit) => unit.text.trim())
			.join(" ")
			.trim();
		const normalized = normalize(text);
		const tokens = normalized.split(" ").filter(Boolean);
		return [
			{
				end: Math.max(...group.map((unit) => unit.end)),
				firstToken: tokens[0] ?? "",
				hook: /[?!]["')\]”’]*$/u.test(text),
				keywordHits: keywords.map((keyword) =>
					countOccurrences(normalized, keyword)
				),
				start: first.start,
				text,
				tokens: tokens.length,
			},
		];
	});
}

/** Contiguous sentence runs whose span fits the target length. */
function sentenceWindows(
	list: readonly Sentence[],
	target: { max: number; min: number }
): Window[] {
	const windows: Window[] = [];
	for (const [first, opening] of list.entries()) {
		for (let last = first; last < list.length; last += 1) {
			const closing = list[last];
			if (!closing) {
				break;
			}
			const length = closing.end - opening.start;
			if (length > target.max + 1e-9) {
				break;
			}
			if (length >= target.min - 1e-9) {
				windows.push({ end: closing.end, first, last, start: opening.start });
			}
		}
	}
	return windows;
}

function sceneAlignment(
	sceneCuts: readonly number[],
	start: number,
	end: number
) {
	const near = (time: number) =>
		sceneCuts.some((cut) => Math.abs(cut - time) <= SCENE_TOLERANCE_SECONDS);
	return (near(start) ? 0.5 : 0) + (near(end) ? 0.5 : 0);
}

function clockLabel(seconds: number) {
	const whole = Math.max(0, Math.floor(seconds));
	const minutes = Math.floor(whole / 60);
	return `${minutes}:${String(whole % 60).padStart(2, "0")}`;
}

function truncate(text: string) {
	const trimmed = text.replace(/\s+/g, " ").trim();
	return trimmed.length <= TITLE_LENGTH
		? trimmed
		: `${trimmed.slice(0, TITLE_LENGTH - 1).trimEnd()}…`;
}

interface Keyword {
	label: string;
	normalized: string;
}

/** Keep keywords that normalize without losing symbols, deduplicated, labelled as typed. */
function keywordList(raw: readonly string[]): Keyword[] {
	const seen = new Map<string, Keyword>();
	for (const keyword of raw) {
		const label = keyword.trim().replace(/\s+/g, " ");
		const normalized = normalize(label);
		if (KEYWORD_PATTERN.test(label) && normalized && !seen.has(normalized)) {
			seen.set(normalized, { label, normalized });
		}
	}
	return [...seen.values()];
}

interface ScoreContext {
	energy: Energy | null;
	fillers: ReadonlySet<string>;
	keywords: readonly Keyword[];
	sceneCuts: readonly number[];
	sentences: readonly Sentence[];
}

function scoreWindow(
	context: ScoreContext,
	window: Window
): HighlightCandidate {
	const reasons: string[] = [];
	let score = 0;
	const length = window.end - window.start;
	const run =
		window.first < 0
			? []
			: context.sentences.slice(window.first, window.last + 1);
	if (run.length > 0) {
		const tokens = run.reduce((total, sentence) => total + sentence.tokens, 0);
		const density = Math.min(1, tokens / length / FULL_DENSITY_RATE);
		score += WEIGHTS.density * density;
		if (density >= 0.75) {
			reasons.push("Dense speech");
		}
		const hooks = run.filter((sentence) => sentence.hook).length;
		const opensWithHook = run[0]?.hook === true;
		score += WEIGHTS.hook * (opensWithHook ? 1 : Math.min(1, hooks / 2) * 0.5);
		if (opensWithHook) {
			reasons.push("Opens with a hook");
		} else if (hooks > 0) {
			reasons.push("Question or exclamation");
		}
		const matched = context.keywords.filter((_, index) =>
			run.some((sentence) => (sentence.keywordHits[index] ?? 0) > 0)
		);
		if (matched.length > 0) {
			const hits = run.reduce(
				(total, sentence) =>
					total + sentence.keywordHits.reduce((sum, value) => sum + value, 0),
				0
			);
			score += WEIGHTS.keyword * Math.min(1, (hits + 1) / 3);
			reasons.push(...matched.map((keyword) => `Keyword “${keyword.label}”`));
		}
		if (context.fillers.has(run[0]?.firstToken ?? "")) {
			score -= WEIGHTS.filler;
		}
	}
	if (context.energy) {
		const features = energyFeatures(context.energy, window.start, window.end);
		score += WEIGHTS.energy * features.energy;
		score += WEIGHTS.variance * features.variance;
		score += WEIGHTS.peaks * features.peaks;
		if (features.peaks > 0) {
			reasons.push("Loudness peaks");
		}
		if (features.variance >= 0.5) {
			reasons.push("Dynamic audio");
		}
	}
	const scene = sceneAlignment(context.sceneCuts, window.start, window.end);
	score += WEIGHTS.scene * scene;
	if (scene > 0) {
		reasons.push("Aligned to scene cuts");
	}
	const title = run[0]?.text
		? truncate(run[0].text)
		: `Highlight at ${clockLabel(window.start)}`;
	return {
		end: round(window.end),
		reasons,
		score: round(score),
		start: round(window.start),
		title,
	};
}

/** Pick the best non-overlapping windows, ranked by score with ties broken by start. */
function selectGreedy(
	candidates: readonly HighlightCandidate[],
	count: number
): HighlightCandidate[] {
	const ranked = candidates.toSorted(
		(a, b) => b.score - a.score || a.start - b.start || a.end - b.end
	);
	const chosen: HighlightCandidate[] = [];
	for (const candidate of ranked) {
		if (chosen.length >= count) {
			break;
		}
		if (
			chosen.every(
				(picked) =>
					candidate.end <= picked.start || candidate.start >= picked.end
			)
		) {
			chosen.push(candidate);
		}
	}
	return chosen;
}

/** Score sentence-aligned windows and return up to `count` ranked, non-overlapping highlights. */
export function scoreHighlights(
	input: ScoreHighlightsInput
): HighlightCandidate[] {
	const request = highlightsRequestSchema.parse({
		count: input.count,
		keywords: input.keywords,
		target: input.target,
	});
	const keywords = keywordList(request.keywords ?? []);
	const words = validTimed(input.words);
	const units = words.length > 0 ? words : validTimed(input.cues);
	const list = sentences(
		units,
		keywords.map((keyword) => keyword.normalized)
	);
	const energy = energyProfile(input.waveform);
	const sceneCuts = (input.sceneCuts ?? []).filter(Number.isFinite);
	// Fall back to the energy grid when no sentence run fits the target (for
	// example long unpunctuated speech), so a usable waveform is never ignored.
	let windows = sentenceWindows(list, request.target);
	if (windows.length === 0 && energy) {
		windows = energyWindows(
			Math.min(MAX_SECONDS, energy.duration),
			sceneCuts,
			request.target
		);
	}
	if (windows.length === 0) {
		return [];
	}
	const context: ScoreContext = {
		energy,
		fillers: new Set(DEFAULT_FILLERS.filter((filler) => !filler.includes(" "))),
		keywords,
		sceneCuts,
		sentences: list,
	};
	return selectGreedy(
		windows.map((window) => scoreWindow(context, window)),
		request.count
	);
}

/** Timeline ranges outside a highlight, latest first; `[]` for an invalid or out-of-range window. */
export function highlightToRanges(
	candidate: Pick<HighlightCandidate, "end" | "start">,
	totalDuration: number
): TimelineRange[] {
	if (
		!(
			Number.isFinite(totalDuration) &&
			totalDuration > 0 &&
			Number.isFinite(candidate.start) &&
			Number.isFinite(candidate.end) &&
			candidate.end > candidate.start &&
			candidate.start < totalDuration &&
			candidate.end > 0
		)
	) {
		return [];
	}
	const start = Math.max(0, candidate.start);
	const end = Math.min(totalDuration, candidate.end);
	return mergeTimelineRanges([
		{ end: start, start: 0 },
		{ end: totalDuration, start: end },
	])
		.slice(0, MAX_REMOVE_RANGES)
		.reverse();
}
