import { expect, test } from "bun:test";
import {
	highlightsRequestSchema,
	highlightToRanges,
	scoreHighlights,
} from "./highlights.ts";
import { removeWordsRequestSchema } from "./remove-words.ts";

interface Line {
	at: number;
	text: string;
}

/** Spread each sentence's words evenly over 0.3 s per word, starting at `at`. */
function wordsFor(lines: readonly Line[]) {
	return lines.flatMap(({ at, text }) =>
		text.split(" ").map((word, index) => ({
			end: at + index * 0.3 + 0.28,
			id: crypto.randomUUID(),
			start: at + index * 0.3,
			text: word,
		}))
	);
}

const story: Line[] = [
	{ at: 0, text: "Welcome back to the channel everyone." },
	{ at: 3, text: "Today we talk about cameras." },
	{ at: 6, text: "Why does autofocus fail in low light?" },
	{ at: 9, text: "The sensor needs contrast to lock focus." },
	{ at: 12, text: "Um so that is the basic idea here." },
	{ at: 15, text: "Lenses matter more than bodies honestly." },
	{ at: 18, text: "That changes everything you buy next!" },
	{ at: 21, text: "Thanks for watching see you soon." },
];
const starts = new Set(story.map((line) => line.at));

test("highlight request bounds count, keywords and target", () => {
	expect(
		highlightsRequestSchema.safeParse({ count: 11, target: { max: 5, min: 2 } })
			.success
	).toBe(false);
	expect(
		highlightsRequestSchema.safeParse({ count: 2, target: { max: 2, min: 5 } })
			.success
	).toBe(false);
	expect(
		highlightsRequestSchema.safeParse({
			count: 2,
			keywords: Array.from({ length: 21 }, (_, index) => `k${index}`),
			target: { max: 5, min: 2 },
		}).success
	).toBe(false);
	expect(
		highlightsRequestSchema.safeParse({
			count: 2,
			extra: true,
			target: { max: 5, min: 2 },
		}).success
	).toBe(false);
});

test("windows start and end on sentence boundaries within min and max", () => {
	const words = wordsFor(story);
	const ends = new Set(
		story.map(({ at, text }) => {
			const last = text.split(" ").length - 1;
			return Math.round((at + last * 0.3 + 0.28) * 1000) / 1000;
		})
	);
	const highlights = scoreHighlights({
		count: 10,
		cues: [],
		target: { max: 7, min: 4 },
		words,
	});
	expect(highlights.length).toBeGreaterThan(0);
	for (const highlight of highlights) {
		expect(starts.has(highlight.start)).toBe(true);
		expect(ends.has(highlight.end)).toBe(true);
		expect(highlight.end - highlight.start).toBeGreaterThanOrEqual(4);
		expect(highlight.end - highlight.start).toBeLessThanOrEqual(7);
	}
});

test("selected highlights never overlap and respect the count cap", () => {
	const words = wordsFor(story);
	const all = scoreHighlights({
		count: 10,
		cues: [],
		target: { max: 6, min: 2 },
		words,
	});
	const sorted = all.toSorted((a, b) => a.start - b.start);
	for (const [index, highlight] of sorted.entries()) {
		const next = sorted[index + 1];
		if (next) {
			expect(next.start).toBeGreaterThanOrEqual(highlight.end);
		}
	}
	const capped = scoreHighlights({
		count: 2,
		cues: [],
		target: { max: 6, min: 2 },
		words,
	});
	expect(capped).toHaveLength(2);
	expect(capped).toEqual(all.slice(0, 2));
});

test("ranking is deterministic and breaks score ties by start", () => {
	const flat: Line[] = [0, 3, 6, 9].map((at) => ({
		at,
		text: "plain words go here now.",
	}));
	const input = {
		count: 4,
		cues: [],
		target: { max: 2, min: 1 },
		words: wordsFor(flat),
	};
	const first = scoreHighlights(input);
	const second = scoreHighlights(input);
	expect(first).toEqual(second);
	expect(first.map((highlight) => highlight.start)).toEqual([0, 3, 6, 9]);
	expect(new Set(first.map((highlight) => highlight.score)).size).toBe(1);
});

test("keywords boost matching windows to the top", () => {
	const words = wordsFor(story);
	const base = { count: 1, cues: [], target: { max: 3, min: 1 }, words };
	const plain = scoreHighlights(base);
	const boosted = scoreHighlights({ ...base, keywords: ["Lenses"] });
	expect(plain[0]?.start).not.toBe(15);
	expect(boosted[0]?.start).toBe(15);
	expect(boosted[0]?.reasons).toContain("Keyword “Lenses”");
	expect(boosted[0]?.title).toBe("Lenses matter more than bodies honestly.");
});

test("questions open hooks and leading fillers are penalised", () => {
	const words = wordsFor(story);
	const highlights = scoreHighlights({
		count: 8,
		cues: [],
		target: { max: 3, min: 1 },
		words,
	});
	const question = highlights.find((highlight) => highlight.start === 6);
	const filler = highlights.find((highlight) => highlight.start === 12);
	expect(question?.reasons).toContain("Opens with a hook");
	expect(highlights[0]?.start).toBe(6);
	expect(filler).toBeDefined();
	expect(filler?.score ?? 1).toBeLessThan(question?.score ?? 0);
	expect(highlights.at(-1)?.start).toBe(12);
});

test("cues split on terminal punctuation and long pauses when words are missing", () => {
	const cues = [
		{ end: 2, id: crypto.randomUUID(), start: 0, text: "First part and" },
		{ end: 4, id: crypto.randomUUID(), start: 2.1, text: "it keeps going." },
		{ end: 7, id: crypto.randomUUID(), start: 5, text: "After a pause" },
		{ end: 9, id: crypto.randomUUID(), start: 7.2, text: "more talk" },
	];
	const highlights = scoreHighlights({
		count: 10,
		cues,
		target: { max: 4.5, min: 1 },
		words: [],
	});
	expect(
		highlights.map((highlight) => [highlight.start, highlight.end]).sort()
	).toEqual([
		[0, 4],
		[5, 9],
	]);
	expect(highlights.find((item) => item.start === 0)?.title).toBe(
		"First part and it keeps going."
	);
});

test("an empty transcript falls back to energy-only windows", () => {
	const bins = Array.from({ length: 100 }, (_, index) =>
		index >= 60 && index < 70 ? (index % 2 === 0 ? 0.9 : 0.3) : 0.05
	);
	const highlights = scoreHighlights({
		count: 1,
		cues: [],
		sceneCuts: [6],
		target: { max: 1, min: 1 },
		waveform: { bins, duration: 10 },
		words: [],
	});
	expect(highlights).toHaveLength(1);
	expect(highlights[0]?.start).toBe(6);
	expect(highlights[0]?.end).toBe(7);
	expect(highlights[0]?.title).toBe("Highlight at 0:06");
	expect(highlights[0]?.reasons).toContain("Loudness peaks");
	expect(highlights[0]?.reasons).toContain("Aligned to scene cuts");
	expect(
		scoreHighlights({
			count: 1,
			cues: [],
			target: { max: 1, min: 1 },
			words: [],
		})
	).toEqual([]);
});

test("highlight ranges cover everything outside the window, latest first", () => {
	const ranges = highlightToRanges({ end: 30, start: 10 }, 60);
	expect(ranges).toEqual([
		{ end: 60, start: 30 },
		{ end: 10, start: 0 },
	]);
	expect(
		removeWordsRequestSchema.safeParse({ ranges, revision: 0 }).success
	).toBe(true);
	expect(highlightToRanges({ end: 60, start: 0 }, 60)).toEqual([]);
	expect(highlightToRanges({ end: 60.02, start: 0.02 }, 60)).toEqual([]);
	expect(highlightToRanges({ end: 5, start: 0 }, 0)).toEqual([]);
});

test("out-of-range, inverted or non-finite highlights produce no ranges", () => {
	expect(highlightToRanges({ end: 90, start: 70 }, 60)).toEqual([]);
	expect(highlightToRanges({ end: 10, start: 30 }, 60)).toEqual([]);
	expect(highlightToRanges({ end: 20, start: 20 }, 60)).toEqual([]);
	expect(highlightToRanges({ end: 0, start: -5 }, 60)).toEqual([]);
	expect(highlightToRanges({ end: Number.NaN, start: 10 }, 60)).toEqual([]);
	expect(highlightToRanges({ end: 80, start: 50 }, 60)).toEqual([
		{ end: 50, start: 0 },
	]);
});

test("long unpunctuated speech falls back to energy windows", () => {
	const words = Array.from({ length: 1000 }, (_, index) => ({
		end: index * 0.3 + 0.28,
		start: index * 0.3,
		text: "word",
	}));
	const bins = Array.from({ length: 300 }, (_, index) =>
		index >= 120 && index < 140 ? 0.9 : 0.1 + (index % 3) * 0.05
	);
	const highlights = scoreHighlights({
		count: 2,
		cues: [],
		target: { max: 60, min: 15 },
		waveform: { bins, duration: 300 },
		words,
	});
	expect(highlights.length).toBeGreaterThan(0);
	expect(highlights[0]?.title.startsWith("Highlight at")).toBe(true);
});

test("energy features map bins over the full source beyond the analysis bound", () => {
	const bins = Array.from({ length: 600 }, (_, index) =>
		index < 300 ? 0.01 : 1
	);
	const highlights = scoreHighlights({
		count: 1,
		cues: [],
		target: { max: 600, min: 600 },
		waveform: { bins, duration: 14_400 },
		words: [],
	});
	for (const highlight of highlights) {
		expect(highlight.reasons).not.toContain("Dynamic audio");
		expect(highlight.reasons).not.toContain("Loudness peaks");
	}
});

test("energy-only windows stay bounded for long sources with wide targets", () => {
	const bins = Array.from(
		{ length: 600 },
		(_, index) => ((index * 7) % 11) / 10
	);
	const started = performance.now();
	const highlights = scoreHighlights({
		count: 10,
		cues: [],
		target: { max: 600, min: 1 },
		waveform: { bins, duration: 7200 },
		words: [],
	});
	expect(performance.now() - started).toBeLessThan(1000);
	expect(highlights.length).toBeGreaterThan(0);
});

test("symbol keywords are ignored and reasons keep the typed keyword", () => {
	const words = wordsFor([
		{ at: 0, text: "C is fine today." },
		{ at: 3, text: "Rust Lang is great." },
	]);
	const highlights = scoreHighlights({
		count: 2,
		cues: [],
		keywords: ["C++", "Rust  Lang"],
		target: { max: 3, min: 1 },
		words,
	});
	const reasons = highlights.flatMap((highlight) => highlight.reasons);
	expect(reasons.some((reason) => reason.includes("“c”"))).toBe(false);
	expect(reasons).toContain("Keyword “Rust Lang”");
});
