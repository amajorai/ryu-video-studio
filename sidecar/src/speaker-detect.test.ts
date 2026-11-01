import { expect, test } from "bun:test";
import {
	type Asset,
	type Caption,
	newProject,
	newSegment,
	type Project,
	projectSchema,
} from "../../shared/project.ts";
import { SPEAKER_SAMPLE_RATE } from "../../shared/speakers.ts";
import {
	type DecodeAudio,
	detectSpeakersWith,
	ffmpegSeconds,
	planDecodeRanges,
} from "./speaker-detect.ts";

const uuid = (n: number) =>
	`00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;

const audio = (id: number, name: string): Asset => ({
	createdAt: "2026-01-01T00:00:00.000Z",
	duration: 20,
	hasAudio: true,
	height: 0,
	id: uuid(id),
	kind: "audio",
	name,
	width: 0,
});

/** One caption of half-second words from 0 to `count / 2` seconds. */
function caption(count: number): Caption {
	const words = Array.from({ length: count }, (_, index) => ({
		end: index / 2 + 0.5,
		id: uuid(200 + index),
		start: index / 2,
		text: `w${index}`,
	}));
	return {
		end: count / 2,
		id: uuid(100),
		start: 0,
		text: words.map((word) => word.text).join(" "),
		words,
	};
}

/** Synthetic decoder: `level(assetId, time)` gives amplitude and pitch. */
function synthetic(
	level: (assetId: string, time: number) => { amplitude: number; pitch: number }
): { calls: [string, number, number][]; decode: DecodeAudio } {
	const calls: [string, number, number][] = [];
	return {
		calls,
		decode: (asset, start, duration) => {
			calls.push([asset.id, start, duration]);
			const samples = new Float32Array(
				Math.round(duration * SPEAKER_SAMPLE_RATE)
			);
			for (let index = 0; index < samples.length; index++) {
				const time = start + index / SPEAKER_SAMPLE_RATE;
				const { amplitude, pitch } = level(asset.id, time);
				samples[index] = amplitude * Math.sin(2 * Math.PI * pitch * time);
			}
			return Promise.resolve(samples);
		},
	};
}

function project(segments: Project["segments"], words = 8): Project {
	return projectSchema.parse({
		...newProject("Speakers"),
		captions: [caption(words)],
		segments,
	});
}

test("mic dominance labels each word with the louder mic", async () => {
	const host = audio(1, "Host lav");
	const guest = audio(2, "Guest lav");
	const timeline = project([
		{ ...newSegment(host, 0, 0), id: uuid(10) },
		{ ...newSegment(guest, 0, 1), id: uuid(11) },
	]);
	const { calls, decode } = synthetic((assetId, time) => {
		const hostTalks = time < 2;
		const loud = assetId === host.id ? hostTalks : !hostTalks;
		return { amplitude: loud ? 0.5 : 0.02, pitch: 200 };
	});
	let next = 900;
	const result = await detectSpeakersWith(
		timeline,
		[host, guest],
		{ mode: "mic-dominance", revision: timeline.revision },
		decode,
		() => uuid(next++)
	);
	expect(result.speakers.map((speaker) => speaker.label)).toEqual([
		"Host lav",
		"Guest lav",
	]);
	expect(
		result.project.captions[0]?.words?.map((word) => word.speakerId)
	).toEqual([...new Array(4).fill(uuid(900)), ...new Array(4).fill(uuid(901))]);
	// One merged decode per mic.
	expect(calls).toHaveLength(2);
	expect(result.assigned).toBe(8);
});

test("mic dominance tags each lav clip with its own mic on an uneven split", async () => {
	const alice = audio(1, "Alice lav");
	const bob = audio(2, "Bob lav");
	const music = audio(3, "Music bed");
	const title: Asset = {
		...audio(4, "Title card"),
		hasAudio: false,
		height: 1080,
		kind: "image",
		width: 1920,
	};
	const timeline = project(
		[
			{ ...newSegment(alice, 0, 0), id: uuid(10) },
			{ ...newSegment(bob, 0, 1), id: uuid(11) },
			{ ...newSegment(music, 0, 2), id: uuid(12) },
			{ ...newSegment(title, 0, 3), id: uuid(13) },
		],
		10
	);
	// Alice talks for 7 of 10 words (70/30); the music bed stays quiet.
	const { decode } = synthetic((assetId, time) => {
		const aliceTalks = time < 3.5;
		if (assetId === music.id) {
			return { amplitude: 0.01, pitch: 440 };
		}
		const loud = assetId === alice.id ? aliceTalks : !aliceTalks;
		return { amplitude: loud ? 0.5 : 0.02, pitch: 200 };
	});
	let next = 900;
	const result = await detectSpeakersWith(
		timeline,
		[alice, bob, music, title],
		{ mode: "mic-dominance", revision: timeline.revision },
		decode,
		() => uuid(next++)
	);
	const labelOf = (segmentId: string) => {
		const segment = result.project.segments.find(
			(item) => item.id === segmentId
		);
		return result.speakers.find((speaker) => speaker.id === segment?.speakerId)
			?.label;
	};
	expect(labelOf(uuid(10))).toBe("Alice lav");
	expect(labelOf(uuid(11))).toBe("Bob lav");
	expect(labelOf(uuid(12))).toBeUndefined();
	expect(labelOf(uuid(13))).toBeUndefined();
});

test("re-running mic dominance keeps mic names with their mics", async () => {
	const alice = audio(1, "Alice lav");
	const bob = audio(2, "Bob lav");
	const segments = [
		{ ...newSegment(alice, 0, 0), id: uuid(10) },
		{ ...newSegment(bob, 0, 1), id: uuid(11) },
	];
	const run = (timeline: Project, aliceFirst: boolean) =>
		detectSpeakersWith(
			timeline,
			[alice, bob],
			{ mode: "mic-dominance", revision: timeline.revision },
			synthetic((assetId, time) => {
				const firstTalks = time < 2;
				const aliceTalks = aliceFirst ? firstTalks : !firstTalks;
				const loud = assetId === alice.id ? aliceTalks : !aliceTalks;
				return { amplitude: loud ? 0.5 : 0.02, pitch: 200 };
			}).decode
		);
	const first = await run(project(segments), true);
	const second = await run(first.project, false);
	const byLabel = (result: typeof first, label: string) =>
		result.speakers.find((speaker) => speaker.label === label);
	expect(second.speakers.map((speaker) => speaker.label)).toEqual([
		"Bob lav",
		"Alice lav",
	]);
	// Same ids and colors stay with the same mic.
	expect(byLabel(second, "Alice lav")).toEqual(byLabel(first, "Alice lav"));
	expect(byLabel(second, "Bob lav")).toEqual(byLabel(first, "Bob lav"));
	const firstWord = second.project.captions[0]?.words?.[0]?.speakerId;
	expect(firstWord).toBe(byLabel(second, "Bob lav")?.id);
});

test("FFmpeg time options never use exponent notation", () => {
	expect(ffmpegSeconds(0.1 + 0.2 - 0.3)).toBe("0.000000");
	expect(ffmpegSeconds(5.551_115_123_125_783e-17)).toBe("0.000000");
	expect(ffmpegSeconds(-1e-9)).toBe("0.000000");
	expect(ffmpegSeconds(12.5)).toBe("12.500000");
});

test("mic dominance refuses a single source", async () => {
	const mic = audio(1, "Mic");
	const timeline = project([newSegment(mic, 0, 0)]);
	await expect(
		detectSpeakersWith(
			timeline,
			[mic],
			{ mode: "mic-dominance", revision: 0 },
			synthetic(() => ({ amplitude: 0.5, pitch: 200 })).decode
		)
	).rejects.toThrow("at least two audible mics");
});

test("cluster mode separates a low and a high voice on one mic", async () => {
	const mic = audio(1, "Mic");
	const timeline = project([newSegment(mic, 0, 0)], 12);
	const result = await detectSpeakersWith(
		timeline,
		[mic],
		{ k: 2, mode: "cluster", revision: 0 },
		synthetic((_, time) => ({
			amplitude: 0.4,
			pitch: time < 3 ? 120 : 260,
		})).decode
	);
	const ids = result.project.captions[0]?.words?.map((word) => word.speakerId);
	expect(new Set(ids?.slice(0, 6)).size).toBe(1);
	expect(new Set(ids?.slice(6)).size).toBe(1);
	expect(ids?.[0]).not.toBe(ids?.[6]);
	expect(result.speakers).toHaveLength(2);
});

test("silent words stay unassigned and too few voiced words are refused", async () => {
	const mic = audio(1, "Mic");
	const timeline = project([newSegment(mic, 0, 0)], 4);
	await expect(
		detectSpeakersWith(
			timeline,
			[mic],
			{ k: 3, mode: "cluster", revision: 0 },
			synthetic((_, time) => ({
				amplitude: time < 1 ? 0.4 : 0,
				pitch: 150,
			})).decode
		)
	).rejects.toThrow("needs at least 3");
});

test("projects without captions are refused", async () => {
	const mic = audio(1, "Mic");
	const timeline = projectSchema.parse({
		...newProject("Empty"),
		segments: [newSegment(mic, 0, 0)],
	});
	await expect(
		detectSpeakersWith(
			timeline,
			[mic],
			{ mode: "cluster", revision: 0 },
			synthetic(() => ({ amplitude: 0, pitch: 0 })).decode
		)
	).rejects.toThrow("timed captions");
});

test("decode ranges merge nearby spans and split long ones", () => {
	const candidate = (
		assetId: string,
		sourceStart: number,
		sourceEnd: number
	) => ({
		candidate: {
			assetId,
			label: "x",
			segmentId: "s",
			sourceEnd,
			sourceKey: assetId,
			sourceStart,
		},
		slot: 0,
		window: 0,
	});
	const ranges = planDecodeRanges([
		candidate("a", 0, 1),
		candidate("a", 2.5, 3),
		candidate("a", 10, 11),
		candidate("a", 11, 400),
		candidate("b", 0, 1),
	]);
	expect(
		ranges.map((range) => [range.assetId, range.start, range.end])
	).toEqual([
		["a", 0, 3],
		["a", 10, 11],
		["a", 11, 400],
		["b", 0, 1],
	]);
});
