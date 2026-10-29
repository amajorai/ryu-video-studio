import { describe, expect, test } from "bun:test";
import type { TimelineTranscript } from "./filler-words.ts";
import { newProject, newSegment } from "./project.ts";
import {
	findRepeatedPhrases,
	indicesBetween,
	normalizedEditDistance,
	planBatch,
	planRanges,
	searchTokens,
	selectionBatch,
	selectionRanges,
	sentenceSpans,
	spanRange,
	spansFromIndices,
	timelineTokens,
	timelineTranscript,
	tokenIndexAt,
} from "./timeline-transcript.ts";

test("timeline transcript maps source cues through trim, speed, and timeline position", () => {
	const asset = {
		createdAt: new Date().toISOString(),
		duration: 8,
		hasAudio: true,
		height: 360,
		id: crypto.randomUUID(),
		kind: "video" as const,
		name: "Speech",
		width: 640,
	};
	const segment = newSegment(asset, 10);
	segment.sourceIn = 2;
	segment.sourceOut = 6;
	segment.speed = 2;
	const project = { ...newProject("Timeline transcript"), segments: [segment] };
	const result = timelineTranscript(project, (assetId) =>
		assetId === asset.id
			? {
					assetId: asset.id,
					cues: [{ end: 4, id: crypto.randomUUID(), start: 2, text: "Hello" }],
					duration: 8,
					nextOffset: 8,
					origin: "imported" as const,
					revision: 0,
					status: "completed" as const,
					timing: "imported" as const,
					updatedAt: new Date().toISOString(),
					words: [],
				}
			: null
	);
	expect(result.clips[0]?.cues[0]).toMatchObject({ start: 10, end: 11 });
});

type Word = [start: number, end: number, text: string];

function timeline(
	...clips: Array<{ clipId?: string; cues?: Word[]; words?: Word[] }>
): TimelineTranscript {
	const timed = ([start, end, text]: Word) => ({
		end,
		id: crypto.randomUUID(),
		start,
		text,
	});
	return {
		clips: clips.map((clip) => ({
			assetId: crypto.randomUUID(),
			clipId: clip.clipId ?? crypto.randomUUID(),
			cues: (clip.cues ?? []).map(timed),
			words: (clip.words ?? []).map(timed),
		})),
		projectId: crypto.randomUUID(),
		revision: 0,
		sourceCaptions: [],
	};
}

/** Words spaced 0.4 s apart, each 0.3 s long, from `start`. */
function spoken(text: string, start = 0): Word[] {
	return text
		.split(" ")
		.map(
			(word, index): Word => [
				start + index * 0.4,
				start + index * 0.4 + 0.3,
				word,
			]
		);
}

describe("timelineTokens", () => {
	test("orders words across clips, falls back to cues, and drops linked duplicates", () => {
		const tokens = timelineTokens(
			timeline(
				{
					words: [
						[2, 2.5, "World."],
						[0, 0.5, "Hello,"],
					],
				},
				{ cues: [[5, 7, "A whole cue"]] },
				// A linked clip transcribing the same source reports the same word.
				{ words: [[0.005, 0.51, "hello"]] }
			)
		);
		expect(tokens.map(({ index, norm, unit }) => [index, norm, unit])).toEqual([
			[0, "hello", "word"],
			[1, "world", "word"],
			[2, "a whole cue", "cue"],
		]);
	});

	test("finds the current token by binary search", () => {
		const tokens = timelineTokens(timeline({ words: spoken("one two three") }));
		expect(tokenIndexAt(tokens, 0)).toBe(0);
		expect(tokenIndexAt(tokens, 0.45)).toBe(1);
		expect(tokenIndexAt(tokens, 0.75)).toBe(-1);
		expect(tokenIndexAt(tokens, -1)).toBe(-1);
		expect(tokenIndexAt(tokens, 1.05)).toBe(2);
		expect(tokenIndexAt([], 1)).toBe(-1);
	});
});

describe("searchTokens", () => {
	const tokens = timelineTokens(
		timeline(
			{ words: spoken("The cat sat. The Cats ran") },
			{ cues: [[10, 12, "No cat here"]] }
		)
	);
	test("matches phrases with a prefix on the last word", () => {
		expect(searchTokens(tokens, "the cat")).toEqual([
			{ first: 0, last: 1 },
			{ first: 3, last: 4 },
		]);
		expect(searchTokens(tokens, "SAT!")).toEqual([{ first: 2, last: 2 }]);
		expect(searchTokens(tokens, "cat here")).toEqual([{ first: 6, last: 6 }]);
		expect(searchTokens(tokens, "  ...  ")).toEqual([]);
	});
});

describe("selection ranges", () => {
	const tokens = timelineTokens(
		timeline({ words: spoken("zero one two three four five") })
	);
	test("groups indices into runs", () => {
		expect(spansFromIndices([4, 1, 2, 2, 7, -1])).toEqual([
			{ first: 1, last: 2 },
			{ first: 4, last: 4 },
			{ first: 7, last: 7 },
		]);
		expect(indicesBetween(5, 3)).toEqual([3, 4, 5]);
	});
	test("merges overlapping runs, keeps separate ones, and clamps to the timeline", () => {
		expect(
			selectionRanges(
				tokens,
				[
					{ first: 1, last: 2 },
					{ first: 2, last: 3 },
					{ first: 5, last: 5 },
				],
				2.1
			)
		).toEqual([
			{ end: 1.5, start: 0.4 },
			{ end: 2.1, start: 2 },
		]);
		expect(selectionRanges(tokens, [{ first: 5, last: 5 }], 2.02)).toEqual([]);
		expect(spanRange(tokens, { first: 9, last: 9 })).toBeNull();
	});
});

describe("findRepeatedPhrases", () => {
	test("flags the earlier take of a repeated n-gram, longest first", () => {
		const tokens = timelineTokens(
			timeline({ words: spoken("I went to the I went to the store") })
		);
		const plans = findRepeatedPhrases(tokens);
		expect(plans).toHaveLength(1);
		expect(plans[0]).toMatchObject({
			first: 0,
			keeps: "I went to the",
			kind: "repeat",
			last: 3,
			range: { end: 1.6, start: 0 },
			text: "I went to the",
		});
	});

	test("ignores function-word repeats and repeats beyond the window", () => {
		const tokens = timelineTokens(
			timeline(
				{ words: spoken("out of the out of the box and of the") },
				{ words: spoken("green apples", 20) },
				{ words: spoken("green apples", 31) }
			)
		);
		const plans = findRepeatedPhrases(tokens);
		expect(plans.map((plan) => plan.text)).toEqual(["out of the"]);
		expect(plans[0]?.range).toEqual({ end: 1.2, start: 0 });
		expect(findRepeatedPhrases(tokens, { minN: 4 })).toEqual([]);
		expect(
			findRepeatedPhrases(tokens, { window: 15 }).map((plan) => plan.text)
		).toEqual(["out of the", "green apples"]);
	});

	test("detects a restarted sentence as a retake and folds its repeats", () => {
		const tokens = timelineTokens(
			timeline({
				words: [
					...spoken("The quick brown fox jumps."),
					...spoken("The quick brown fox jumped over everything.", 2.5),
				],
			})
		);
		const plans = findRepeatedPhrases(tokens);
		expect(plans).toHaveLength(1);
		expect(plans[0]).toMatchObject({
			first: 0,
			kind: "retake",
			last: 4,
			range: { end: 2.5, start: 0 },
			text: "The quick brown fox jumps.",
		});
		expect(plans[0]?.keeps).toBe("The quick brown fox jumped over everything.");
		expect(planRanges(plans, 100)).toEqual([{ end: 2.5, start: 0 }]);
	});

	test("different sentences are not retakes", () => {
		const tokens = timelineTokens(
			timeline({
				words: [
					...spoken("We shipped the release."),
					...spoken("Everyone celebrated with cake afterwards.", 2),
				],
			})
		);
		expect(findRepeatedPhrases(tokens)).toEqual([]);
		expect(sentenceSpans(tokens)).toEqual([
			{ first: 0, last: 3 },
			{ first: 4, last: 8 },
		]);
	});

	test("edit distance is word level and normalized", () => {
		expect(
			normalizedEditDistance(["a", "b", "c"], ["a", "x", "c"])
		).toBeCloseTo(1 / 3);
		expect(normalizedEditDistance([], [])).toBe(0);
		expect(normalizedEditDistance(["a"], [])).toBe(1);
	});
});

describe("repeat and retake guards", () => {
	test("natural repetition across clauses is not a repeat", () => {
		const tokens = timelineTokens(
			timeline({
				words: spoken(
					"I love this camera because this camera shoots in low light and my camera does not."
				),
			})
		);
		expect(findRepeatedPhrases(tokens)).toEqual([]);
	});

	test("a repeat with fillers between removes the fillers too", () => {
		const tokens = timelineTokens(
			timeline({ words: spoken("the red um the red camera") })
		);
		const plans = findRepeatedPhrases(tokens);
		expect(plans).toHaveLength(1);
		expect(plans[0]).toMatchObject({
			first: 0,
			kind: "repeat",
			last: 1,
			range: { end: 1.2, start: 0 },
		});
		expect(
			findRepeatedPhrases(
				timelineTokens(
					timeline({ words: spoken("the red um uh er the red camera") })
				)
			)
		).toEqual([]);
	});

	test("a long pause before the later take is kept", () => {
		const retake = findRepeatedPhrases(
			timelineTokens(
				timeline({
					words: [
						...spoken("the red camera"),
						...spoken("the red camera is great.", 9.8),
					],
				})
			)
		);
		expect(retake).toHaveLength(1);
		expect(retake[0]).toMatchObject({
			kind: "retake",
			range: { end: 1.1, start: 0 },
		});
		const repeat = findRepeatedPhrases(
			timelineTokens(
				timeline({
					words: [
						...spoken("We built"),
						...spoken("We built the app today.", 8),
					],
				})
			)
		);
		expect(repeat.map((plan) => plan.range)).toEqual([{ end: 0.7, start: 0 }]);
	});
});

describe("request batches", () => {
	const tokens = timelineTokens(
		timeline({
			words: Array.from(
				{ length: 130 },
				(_, index): Word => [index, index + 0.5, `w${index}`]
			),
		})
	);
	const spans = Array.from({ length: 130 }, (_, index) => ({
		first: index,
		last: index,
	}));
	test("selections beyond the request bound report what was skipped", () => {
		const batch = selectionBatch(tokens, spans, 200);
		expect(batch.ranges).toHaveLength(100);
		expect(batch.skipped).toBe(30);
		expect(selectionBatch(tokens, spans.slice(0, 3), 200).skipped).toBe(0);
	});
	test("plan batches count the plans they cover", () => {
		const plans = spans.map((span) => ({
			range: spanRange(tokens, span) ?? { end: 0, start: 0 },
		}));
		const batch = planBatch(plans, 200);
		expect(batch).toMatchObject({ covered: 100, skipped: 30 });
		expect(batch.ranges.at(-1)).toEqual({ end: 99.5, start: 99 });
		expect(planBatch(plans.slice(0, 5), 200)).toMatchObject({
			covered: 5,
			skipped: 0,
		});
	});
});
