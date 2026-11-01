import { expect, test } from "bun:test";
import {
	confirmDeadAirWithVoiceActivity,
	deadAirPlanRequestSchema,
	deadAirRanges,
	refineWithWaveform,
	timelineWaveform,
	transcriptClipSpans,
} from "./dead-air.ts";
import type { TimelineTranscript } from "./filler-words.ts";
import { newProject, newSegment, projectDuration } from "./project.ts";
import { removeWordRanges, removeWordsRequestSchema } from "./remove-words.ts";
import { timelineTranscript } from "./timeline-transcript.ts";

function transcript(...clips: [number, number][][]): TimelineTranscript {
	return {
		clips: clips.map((words) => ({
			assetId: crypto.randomUUID(),
			clipId: crypto.randomUUID(),
			cues: [],
			words: words.map(([start, end]) => ({
				end,
				id: crypto.randomUUID(),
				start,
				text: "word",
			})),
		})),
		projectId: crypto.randomUUID(),
		revision: 0,
		sourceCaptions: [],
	};
}

const noKeep = { keepPause: 0, padding: 0 };

test("a gap exactly at minPause is kept and a longer one is removed", () => {
	const exact = transcript([
		[0, 1],
		[1.6, 2],
	]);
	expect(deadAirRanges(exact, noKeep).ranges).toEqual([]);
	const longer = transcript([
		[0, 1],
		[1.7, 2],
	]);
	expect(deadAirRanges(longer, noKeep).ranges).toEqual([
		{ end: 1.7, start: 1 },
	]);
});

test("keepPause is split evenly and padding protects each word edge", () => {
	const timeline = transcript([
		[0, 1],
		[3, 4],
	]);
	expect(deadAirRanges(timeline, { keepPause: 0.4, padding: 0 })).toEqual({
		ranges: [{ end: 2.8, start: 1.2 }],
		removedSeconds: 1.6,
	});
	expect(deadAirRanges(timeline).ranges).toEqual([{ end: 2.85, start: 1.15 }]);
});

test("leading and trailing silence is removed up to the clip edges", () => {
	const timeline = transcript([[2, 3]]);
	const clipId = timeline.clips[0]?.clipId ?? "";
	expect(deadAirRanges(timeline).ranges).toEqual([]);
	const plan = deadAirRanges(timeline, {
		spans: [{ clipId, end: 5, start: 0 }],
	});
	expect(plan.ranges).toEqual([
		{ end: 5, start: 3.15 },
		{ end: 1.85, start: 0 },
	]);
	expect(plan.removedSeconds).toBe(3.7);
});

test("multi-clip timelines use timeline time and protect overlapping speech", () => {
	const asset = {
		createdAt: new Date().toISOString(),
		duration: 10,
		hasAudio: true,
		height: 360,
		id: crypto.randomUUID(),
		kind: "video" as const,
		name: "Speech",
		width: 640,
	};
	const first = newSegment(asset, 0);
	first.sourceOut = 4;
	const second = newSegment(asset, 4);
	second.sourceIn = 6;
	second.sourceOut = 10;
	const project = {
		...newProject("Dead air"),
		segments: [first, second],
	};
	const timeline = timelineTranscript(project, (assetId) =>
		assetId === asset.id
			? {
					assetId: asset.id,
					cues: [],
					duration: 10,
					nextOffset: 10,
					origin: "imported" as const,
					revision: 0,
					status: "completed" as const,
					timing: "imported" as const,
					updatedAt: new Date().toISOString(),
					words: [
						{ end: 1, id: crypto.randomUUID(), start: 0, text: "one" },
						{ end: 3, id: crypto.randomUUID(), start: 2.5, text: "two" },
						{ end: 7, id: crypto.randomUUID(), start: 6.5, text: "three" },
						{ end: 9, id: crypto.randomUUID(), start: 8.5, text: "four" },
					],
				}
			: null
	);
	const plan = deadAirRanges(timeline, {
		...noKeep,
		spans: transcriptClipSpans(project, timeline),
	});
	expect(plan.ranges).toEqual([
		{ end: 8, start: 7 },
		{ end: 6.5, start: 5 },
		{ end: 4.5, start: 3 },
		{ end: 2.5, start: 1 },
	]);
	const overlapping = transcript(
		[
			[0, 1],
			[3, 4],
		],
		[[1.5, 2.5]]
	);
	expect(deadAirRanges(overlapping, noKeep).ranges).toEqual([]);
});

test("ranges are latest first, capped at 100, and valid remove-words input", () => {
	const words = Array.from({ length: 130 }, (_, index): [number, number] => [
		index * 2,
		index * 2 + 0.5,
	]);
	const plan = deadAirRanges(transcript(words));
	expect(plan.ranges).toHaveLength(100);
	const starts = plan.ranges.map((range) => range.start);
	expect(starts).toEqual([...starts].sort((a, b) => b - a));
	expect(
		removeWordsRequestSchema.safeParse({ ranges: plan.ranges, revision: 0 })
			.success
	).toBe(true);
});

test("an empty transcript yields no ranges", () => {
	expect(deadAirRanges(transcript())).toEqual({
		ranges: [],
		removedSeconds: 0,
	});
	expect(deadAirRanges(transcript([]))).toEqual({
		ranges: [],
		removedSeconds: 0,
	});
});

test("waveform refinement shrinks and splits ranges around energy", () => {
	const bins = Array.from({ length: 10 }, () => 0);
	bins[0] = 1;
	bins[5] = 0.5;
	const refined = refineWithWaveform(
		[{ end: 9, start: 0.5 }],
		{ bins, duration: 10 },
		{ minLength: 0.3 }
	);
	expect(refined).toEqual([
		{ end: 9, start: 6 },
		{ end: 5, start: 1 },
	]);
	expect(
		refineWithWaveform([{ end: 2, start: 1 }], {
			bins: [0.01, 0.01],
			duration: 4,
		})
	).toEqual([{ end: 2, start: 1 }]);
});

test("dead-air plan request bounds its options", () => {
	expect(deadAirPlanRequestSchema.safeParse({ minPause: 0.6 }).success).toBe(
		true
	);
	expect(deadAirPlanRequestSchema.safeParse({ minPause: 0 }).success).toBe(
		false
	);
	expect(deadAirPlanRequestSchema.safeParse({ track: 32 }).success).toBe(false);
});

test("trailing silence on a sped-up clip applies through remove-words", () => {
	const asset = {
		createdAt: new Date().toISOString(),
		duration: 10,
		hasAudio: true,
		height: 360,
		id: crypto.randomUUID(),
		kind: "video" as const,
		name: "Speech",
		width: 640,
	};
	const segment = newSegment(asset, 0);
	segment.speed = 1.5;
	const project = { ...newProject("Speed"), segments: [segment] };
	const timeline = timelineTranscript(project, () => ({
		assetId: asset.id,
		cues: [],
		duration: 10,
		nextOffset: 10,
		origin: "imported" as const,
		revision: 0,
		status: "completed" as const,
		timing: "imported" as const,
		updatedAt: new Date().toISOString(),
		words: [{ end: 2, id: crypto.randomUUID(), start: 1, text: "hi" }],
	}));
	const plan = deadAirRanges(timeline, {
		spans: transcriptClipSpans(project, timeline),
	});
	expect(plan.ranges[0]?.end).toBeLessThanOrEqual(projectDuration(project));
	const next = removeWordRanges(project, [asset], {
		ranges: plan.ranges,
		revision: 0,
	});
	expect(projectDuration(next)).toBeCloseTo(
		projectDuration(project) - plan.removedSeconds,
		2
	);
});

test("speech on other tracks is protected when the scan is track-filtered", () => {
	const scanned = transcript([
		[0, 1],
		[9, 10],
	]);
	const full = { ...scanned, clips: [...scanned.clips] };
	full.clips.push(...transcript([[4, 6]]).clips);
	expect(deadAirRanges(scanned).ranges).toEqual([{ end: 8.85, start: 1.15 }]);
	expect(deadAirRanges(scanned, { protect: full }).ranges).toEqual([
		{ end: 8.85, start: 6.15 },
		{ end: 3.85, start: 1.15 },
	]);
});

test("waveform refinement keeps silent ranges regardless of length or loudness elsewhere", () => {
	const bins = Array.from({ length: 100 }, () => 0);
	bins[0] = 1;
	expect(
		refineWithWaveform([{ end: 5.2, start: 5 }], { bins, duration: 10 })
	).toEqual([{ end: 5.2, start: 5 }]);
	expect(
		refineWithWaveform(
			[
				{ end: 1, start: 0.5 },
				{ end: 3, start: 2 },
			],
			{ bins: [0, 0], duration: 4 }
		)
	).toEqual([
		{ end: 3, start: 2 },
		{ end: 1, start: 0.5 },
	]);
});

test("the plan request accepts optional VAD settings and rejects bad ones", () => {
	expect(
		deadAirPlanRequestSchema.parse({ minSpeech: 0.1, threshold: 12, vad: true })
	).toEqual({ minSpeech: 0.1, threshold: 12, vad: true });
	expect(deadAirPlanRequestSchema.safeParse({ threshold: 0 }).success).toBe(
		false
	);
	expect(deadAirPlanRequestSchema.safeParse({ vad: "yes" }).success).toBe(
		false
	);
});

test("VAD speech trims transcript pauses, with padding, latest first", () => {
	const plan = {
		ranges: [
			{ end: 9, start: 7 },
			{ end: 4, start: 2 },
		],
		removedSeconds: 4,
	};
	const confirmed = confirmDeadAirWithVoiceActivity(plan, {
		padding: 0.1,
		speech: [
			{ end: 3, start: 2.6 },
			{ end: 12, start: 10 },
		],
	});
	expect(confirmed.ranges).toEqual([
		{ end: 9, start: 7 },
		{ end: 4, start: 3.1 },
		{ end: 2.5, start: 2 },
	]);
	expect(confirmed.removedSeconds).toBe(3.4);
});

test("VAD trimming drops slivers but keeps untouched short ranges", () => {
	const confirmed = confirmDeadAirWithVoiceActivity(
		{
			ranges: [
				{ end: 5.2, start: 5 },
				{ end: 3, start: 1 },
			],
			removedSeconds: 2.2,
		},
		{ minLength: 0.3, speech: [{ end: 2.9, start: 1.1 }] }
	);
	expect(confirmed.ranges).toEqual([{ end: 5.2, start: 5 }]);
});

test("a pause fully covered by speech on another clip is not removed", () => {
	const confirmed = confirmDeadAirWithVoiceActivity(
		{ ranges: [{ end: 4, start: 2 }], removedSeconds: 2 },
		{ speech: [{ end: 5, start: 1 }] }
	);
	expect(confirmed).toEqual({ ranges: [], removedSeconds: 0 });
});

test("VAD confirmation refines against the timeline waveform", () => {
	const waveform = timelineWaveform(
		[
			{
				clip: { sourceIn: 0, sourceOut: 10, speed: 1, start: 0 },
				duration: 10,
				waveform: [0.5, 0, 0, 0, 0.6, 0, 0, 0, 0, 0],
			},
		],
		10
	);
	const confirmed = confirmDeadAirWithVoiceActivity(
		{ ranges: [{ end: 9, start: 1 }], removedSeconds: 8 },
		{ speech: [], waveform }
	);
	expect(confirmed.ranges).toEqual([
		{ end: 9, start: 5 },
		{ end: 4, start: 1 },
	]);
});

test("the timeline waveform maps clip envelopes through source range and speed", () => {
	const waveform = timelineWaveform(
		[
			{
				clip: { sourceIn: 2, sourceOut: 4, speed: 2, start: 1 },
				duration: 4,
				waveform: [0, 0, 0.9, 0.3],
			},
			{
				clip: { sourceIn: 0, sourceOut: 1, speed: 1, start: 1.5 },
				duration: 1,
				waveform: [0.5],
			},
		],
		4
	);
	expect(waveform.duration).toBe(4);
	expect(waveform.bins).toHaveLength(80);
	const at = (time: number) =>
		waveform.bins[Math.floor(time / (4 / waveform.bins.length))];
	expect(at(0.5)).toBe(0);
	expect(at(1.2)).toBe(0.9);
	expect(at(1.7)).toBe(0.5);
	expect(at(1.9)).toBe(0.5);
	expect(at(3)).toBe(0);
	expect(timelineWaveform([], 0)).toEqual({ bins: [], duration: 0 });
});
