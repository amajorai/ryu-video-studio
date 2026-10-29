import { expect, test } from "bun:test";
import {
	type FillerHit,
	fillerPlanRequestSchema,
	fillerRanges,
	findFillers,
	mergeTimelineRanges,
	type TimelineTranscript,
	transcriptClipSpans,
} from "./filler-words.ts";
import { newProject, newSegment } from "./project.ts";
import { removeWordRanges, removeWordsRequestSchema } from "./remove-words.ts";
import { timelineTranscript } from "./timeline-transcript.ts";

function transcript(
	...clips: [number, number, string][][]
): TimelineTranscript {
	return {
		clips: clips.map((words) => ({
			assetId: crypto.randomUUID(),
			clipId: crypto.randomUUID(),
			cues: [],
			words: words.map(([start, end, text]) => ({
				end,
				id: crypto.randomUUID(),
				start,
				text,
			})),
		})),
		projectId: crypto.randomUUID(),
		revision: 0,
		sourceCaptions: [],
	};
}

test("single fillers are found case- and punctuation-insensitively and padded", () => {
	const hits = findFillers(
		transcript([
			[0, 0.4, "So,"],
			[0.6, 0.9, "Um,"],
			[1.2, 1.5, "we"],
		])
	);
	expect(hits).toHaveLength(1);
	expect(hits[0]).toMatchObject({
		end: 0.93,
		kind: "filler",
		start: 0.57,
		text: "Um,",
	});
});

test("padding never cuts into neighbouring words", () => {
	const hits = findFillers(
		transcript([
			[0, 0.5, "well"],
			[0.51, 0.8, "uh"],
			[0.81, 1, "yes"],
		])
	);
	expect(hits[0]).toMatchObject({ end: 0.81, start: 0.5 });
});

test("multi-word fillers match as one hit and can be disabled", () => {
	const words: [number, number, string][] = [
		[0, 0.3, "it's"],
		[0.4, 0.6, "You"],
		[0.6, 0.9, "know."],
		[1.1, 1.4, "fine"],
	];
	const [hit] = findFillers(transcript(words));
	expect(hit).toMatchObject({ kind: "filler", text: "You know." });
	expect(hit?.start).toBeCloseTo(0.37);
	expect(hit?.end).toBeCloseTo(0.93);
	expect(findFillers(transcript(words), { multiWord: false })).toEqual([]);
});

test("like is flagged only when pauses isolate it", () => {
	const inSentence = transcript([
		[0, 0.3, "I"],
		[0.32, 0.6, "like"],
		[0.62, 0.9, "it"],
	]);
	expect(findFillers(inSentence)).toEqual([]);
	const isolated = transcript([
		[0, 0.3, "it"],
		[0.6, 0.8, "like,"],
		[1.1, 1.4, "works"],
	]);
	expect(findFillers(isolated).map((hit) => hit.text)).toEqual(["like,"]);
});

test("immediate repeats and hyphenated stutters are flagged on the first take", () => {
	const hits = findFillers(
		transcript([
			[0, 0.2, "I"],
			[0.3, 0.5, "I"],
			[0.6, 0.8, "think"],
			[0.9, 1, "th-"],
			[1.05, 1.3, "the"],
			[1.4, 1.7, "plan"],
			[3, 3.2, "plan"],
		])
	);
	expect(hits.map((hit) => [hit.kind, hit.text])).toEqual([
		["repeat", "I"],
		["stutter", "th-"],
	]);
});

test("custom filler lists replace the defaults", () => {
	const words: [number, number, string][] = [
		[0, 0.3, "basically"],
		[0.5, 0.7, "um"],
	];
	const hits = findFillers(transcript(words), { fillers: ["Basically"] });
	expect(hits.map((hit) => hit.text)).toEqual(["basically"]);
});

test("hits keep their clip ids across a multi-clip timeline", () => {
	const timeline = transcript([[0, 0.3, "uh"]], [[5, 5.3, "erm"]]);
	expect(findFillers(timeline).map((hit) => hit.clipId)).toEqual(
		timeline.clips.map((clip) => clip.clipId)
	);
});

test("ranges merge across small gaps and are latest first", () => {
	const clipId = crypto.randomUUID();
	const hit = (start: number, end: number): FillerHit => ({
		clipId,
		end,
		kind: "filler",
		start,
		text: "um",
	});
	expect(
		fillerRanges([hit(0, 0.3), hit(0.35, 0.6), hit(1, 1.2), hit(2, 2.01)])
	).toEqual([
		{ end: 1.2, start: 1 },
		{ end: 0.6, start: 0 },
	]);
	expect(fillerRanges([hit(0, 0.3), hit(0.36, 0.6)])).toHaveLength(2);
});

test("ranges are capped at 100 and accepted by the remove-words request", () => {
	const words = Array.from(
		{ length: 150 },
		(_, index): [number, number, string] => [index, index + 0.3, "um"]
	);
	const ranges = fillerRanges(findFillers(transcript(words)));
	expect(ranges).toHaveLength(100);
	expect(ranges[0]?.start).toBeGreaterThan(ranges[99]?.start ?? 0);
	expect(
		removeWordsRequestSchema.safeParse({ ranges, revision: 0 }).success
	).toBe(true);
});

test("an empty transcript yields no hits or ranges", () => {
	expect(findFillers(transcript())).toEqual([]);
	expect(findFillers(transcript([]))).toEqual([]);
	expect(fillerRanges([])).toEqual([]);
});

test("filler plan request bounds its options", () => {
	expect(fillerPlanRequestSchema.safeParse({}).success).toBe(true);
	expect(fillerPlanRequestSchema.safeParse({ padding: 1 }).success).toBe(false);
	expect(fillerPlanRequestSchema.safeParse({ extra: true }).success).toBe(
		false
	);
});

function speechProject(
	clips: { start: number; words: [number, number, string][] }[]
) {
	const assets = clips.map(() => ({
		createdAt: new Date().toISOString(),
		duration: 10,
		hasAudio: true,
		height: 360,
		id: crypto.randomUUID(),
		kind: "video" as const,
		name: "Speech",
		width: 640,
	}));
	const segments = clips.map((clip, index) =>
		newSegment(assets[index] ?? assets[0], clip.start)
	);
	const project = { ...newProject("Fillers"), segments };
	const transcriptFor = (assetId: string) => {
		const index = assets.findIndex((asset) => asset.id === assetId);
		const clip = clips[index];
		return clip
			? {
					assetId,
					cues: [],
					duration: 10,
					nextOffset: 10,
					origin: "imported" as const,
					revision: 0,
					status: "completed" as const,
					timing: "imported" as const,
					updatedAt: new Date().toISOString(),
					words: clip.words.map(([start, end, text]) => ({
						end,
						id: crypto.randomUUID(),
						start,
						text,
					})),
				}
			: null;
	};
	return { assets, project, transcriptFor };
}

test("a filler at a clip edge stays inside the clip and applies cleanly", () => {
	const { assets, project, transcriptFor } = speechProject([
		{
			start: 0,
			words: [
				[0, 0.3, "uh"],
				[1, 2, "so"],
				[9.8, 10, "um"],
			],
		},
	]);
	const timeline = timelineTranscript(project, transcriptFor);
	const spans = transcriptClipSpans(project, timeline);
	const hits = findFillers(timeline, { spans });
	expect(hits.map(({ end, start }) => ({ end, start }))).toEqual([
		{ end: 0.33, start: 0 },
		{ end: 10, start: 9.77 },
	]);
	expect(findFillers(timeline).at(-1)?.end).toBe(10);
	const ranges = fillerRanges(hits);
	const next = removeWordRanges(project, assets, { ranges, revision: 0 });
	expect(next.segments.length).toBeGreaterThan(0);
});

test("padding stops at words from adjacent clips and skips overlapped speech", () => {
	const adjacent = transcript(
		[
			[4, 4.5, "ok"],
			[4.7, 5, "um"],
		],
		[[5, 5.5, "next"]]
	);
	expect(findFillers(adjacent)[0]).toMatchObject({ end: 5, start: 4.67 });
	const overlapped = transcript([[1, 1.4, "um"]], [[1, 1.5, "important"]]);
	expect(findFillers(overlapped)).toEqual([]);
});

test("speech on other tracks is protected when the scan is track-filtered", () => {
	const full = transcript([[1, 1.4, "um"]], [[1.2, 1.8, "guest"]]);
	const scanned = { ...full, clips: full.clips.slice(0, 1) };
	expect(findFillers(scanned)).toHaveLength(1);
	expect(findFillers(scanned, { protect: full })).toEqual([]);
});

test("merged ranges round to milliseconds but never pass the timeline end", () => {
	expect(mergeTimelineRanges([{ end: 20 / 3, start: 1 / 3 }])).toEqual([
		{ end: 20 / 3, start: 0.333 },
	]);
	expect(mergeTimelineRanges([{ end: 6.6662, start: 1 }], 0, 6.666_55)).toEqual(
		[{ end: 6.666, start: 1 }]
	);
	expect(mergeTimelineRanges([{ end: 6.6666, start: 1 }], 0, 6.666_65)).toEqual(
		[{ end: 6.666_65, start: 1 }]
	);
});
