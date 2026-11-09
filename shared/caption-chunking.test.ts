import { describe, expect, test } from "bun:test";
import {
	captionWords,
	chunkingOf,
	rechunk,
	rechunkProject,
} from "./caption-chunking.ts";
import { type Caption, newProject, validateProject } from "./project.ts";

let counter = 0;
const uuid = () => {
	counter += 1;
	return `00000000-0000-4000-8000-${String(counter).padStart(12, "0")}`;
};
const SPEAKER_A = "aaaaaaaa-0000-4000-8000-000000000001";
const SPEAKER_B = "bbbbbbbb-0000-4000-8000-000000000002";

/** One cue with measured words spaced `step` seconds apart. */
function wordCue(
	texts: string[],
	start = 0,
	step = 0.4,
	speakerIds: (string | undefined)[] = []
): Caption {
	const words = texts.map((text, index) => {
		const word: NonNullable<Caption["words"]>[number] = {
			end: start + index * step + step * 0.8,
			id: uuid(),
			start: start + index * step,
			text,
		};
		const speakerId = speakerIds[index];
		if (speakerId) {
			word.speakerId = speakerId;
		}
		return word;
	});
	return {
		end: start + texts.length * step,
		id: uuid(),
		start,
		text: texts.join(" "),
		words,
	};
}

const texts = (captions: Caption[]) => captions.map((caption) => caption.text);

describe("rechunk", () => {
	test("resolves defaults per mode", () => {
		expect(chunkingOf(undefined)).toMatchObject({
			maxWords: 20,
			mode: "segments",
			profanity: "none",
		});
		expect(chunkingOf({ mode: "words" })).toMatchObject({
			maxChars: 32,
			maxWords: 6,
		});
		expect(chunkingOf({ maxWords: 9, mode: "single-word" }).maxWords).toBe(1);
	});

	test("splits by max words and keeps word ids and alignment", () => {
		const cue = wordCue(["one", "two", "three", "four", "five"]);
		const result = rechunk([cue], undefined, { maxWords: 2, mode: "words" });
		expect(texts(result)).toEqual(["one two", "three four", "five"]);
		expect(result.flatMap((c) => c.words?.map((w) => w.id) ?? [])).toEqual(
			cue.words?.map((w) => w.id) ?? []
		);
		// The first chunk keeps the cue start and the last keeps the cue end.
		expect(result[0]?.start).toBe(cue.start);
		expect(result.at(-1)?.end).toBe(cue.end);
		const project = { ...newProject(), captions: result };
		expect(() => validateProject(project, [])).not.toThrow();
	});

	test("splits by max characters", () => {
		const cue = wordCue(["alpha", "beta", "gamma", "delta"]);
		expect(
			texts(rechunk([cue], undefined, { maxChars: 10, mode: "words" }))
		).toEqual(["alpha beta", "gamma", "delta"]);
	});

	test("single-word mode shows one word per caption", () => {
		const result = rechunk([wordCue(["a", "b", "c"])], undefined, {
			minDuration: 0.5,
			mode: "single-word",
		});
		expect(texts(result)).toEqual(["a", "b", "c"]);
		// Short words grow into the silence but never overlap the next word.
		expect(result.map((c) => [c.start, c.end])).toEqual([
			[0, 0.4],
			[0.4, 0.8],
			// The last word has no neighbour, so it simply lasts minDuration.
			[0.8, 1.3],
		]);
	});

	test("regroups across cues but breaks at sentence ends and pauses", () => {
		const first = wordCue(["Hi", "there."], 0);
		const second = wordCue(["How", "are"], 0.8);
		const third = wordCue(["you"], 3);
		expect(
			texts(rechunk([first, second, third], undefined, { mode: "words" }))
		).toEqual(["Hi there.", "How are", "you"]);
	});

	test("merges captions shorter than minDuration with a neighbour", () => {
		const cue = wordCue(["a", "b", "c", "d"], 0, 0.1);
		const result = rechunk([cue], undefined, {
			maxWords: 1,
			minDuration: 0.25,
			mode: "words",
		});
		expect(texts(result)).toEqual(["a b", "c d"]);
		expect(result.every((c) => c.end - c.start >= 0.15)).toBe(true);
	});

	test("closes gaps shorter than closeGaps", () => {
		const a = { end: 1, id: uuid(), start: 0, text: "First" };
		const b = { end: 2, id: uuid(), start: 1.2, text: "Second" };
		const c = { end: 4, id: uuid(), start: 3, text: "Third" };
		const result = rechunk([a, b, c], undefined, {
			closeGaps: 0.5,
			mode: "segments",
		});
		expect(result.map((cue) => [cue.start, cue.end])).toEqual([
			[0, 1.2],
			[1.2, 2],
			[3, 4],
		]);
	});

	test("segments mode keeps cue boundaries and timing", () => {
		const a = { end: 2, id: uuid(), start: 0.5, text: "Keep this cue whole" };
		const b = wordCue(["and", "this"], 3);
		const result = rechunk([a, b], undefined, { mode: "segments" });
		expect(texts(result)).toEqual(["Keep this cue whole", "and this"]);
		expect(result[0]).toMatchObject({ end: 2, start: 0.5 });
		expect(result[0]?.words).toBeUndefined();
	});

	test("segments mode keeps long untimed cues and their line breaks whole", () => {
		const long = Array.from({ length: 25 }, (_, index) => `w${index}`).join(
			" "
		);
		const masked = rechunk(
			[{ end: 10, id: uuid(), start: 0, text: long }],
			undefined,
			{ mode: "segments", profanity: "mask" }
		);
		expect(masked).toHaveLength(1);
		expect(masked[0]).toMatchObject({ end: 10, start: 0, text: long });
		const lines = rechunk(
			[{ end: 2, id: uuid(), start: 0, text: "Line one\nshit two" }],
			undefined,
			{ mode: "segments", profanity: "mask" }
		);
		expect(texts(lines)).toEqual(["Line one\ns*** two"]);
		const removed = rechunk(
			[{ end: 2, id: uuid(), start: 0, text: "Line one\nshit" }],
			undefined,
			{ mode: "segments", profanity: "remove" }
		);
		expect(texts(removed)).toEqual(["Line one"]);
	});

	test("segments mode splits untimed cues only with an explicit limit", () => {
		const cue = { end: 4, id: uuid(), start: 0, text: "one two three four" };
		expect(
			texts(rechunk([cue], undefined, { maxWords: 2, mode: "segments" }))
		).toEqual(["one two", "three four"]);
		const timed = wordCue(
			Array.from({ length: 20 }, (_, index) => `t${index}`),
			0,
			0.2
		);
		expect(rechunk([timed], undefined, { mode: "segments" })).toHaveLength(1);
	});

	test("estimates word times for captions without words", () => {
		const words = captionWords({
			end: 2,
			id: uuid(),
			start: 0,
			text: "aaa b",
		});
		expect(words.map((w) => [w.start, w.end])).toEqual([
			[0, 4 / 3],
			[4 / 3, 2],
		]);
		const result = rechunk(
			[{ end: 2, id: uuid(), start: 0, text: "aaa b" }],
			undefined,
			{ mode: "single-word" }
		);
		expect(texts(result)).toEqual(["aaa", "b"]);
		expect(result.every((c) => c.words === undefined)).toBe(true);
	});

	test("never mixes speakers and preserves speakerId", () => {
		const cue = wordCue(["yes", "no", "maybe"], 0, 0.4, [
			SPEAKER_A,
			SPEAKER_A,
			SPEAKER_B,
		]);
		const result = rechunk([cue], undefined, { mode: "words" });
		expect(texts(result)).toEqual(["yes no", "maybe"]);
		expect(result.map((c) => c.speakerId)).toEqual([SPEAKER_A, SPEAKER_B]);
		expect(result[1]?.words?.[0]?.speakerId).toBe(SPEAKER_B);
		const plain = {
			end: 1,
			id: uuid(),
			speakerId: SPEAKER_B,
			start: 0,
			text: "whole cue",
		};
		expect(
			rechunk([plain], undefined, { mode: "single-word" }).map(
				(c) => c.speakerId
			)
		).toEqual([SPEAKER_B, SPEAKER_B]);
	});

	test("profanity is masked or removed per word", () => {
		const cue = wordCue(["what", "the", "fuck"]);
		expect(
			texts(rechunk([cue], undefined, { mode: "segments", profanity: "mask" }))
		).toEqual(["what the f***"]);
		const removed = rechunk([cue], undefined, {
			mode: "segments",
			profanity: "remove",
		});
		expect(texts(removed)).toEqual(["what the"]);
		expect(removed[0]?.words).toHaveLength(2);
		expect(
			texts(
				rechunk(
					[cue],
					undefined,
					{ mode: "segments", profanity: "mask" },
					{
						profanityWords: ["what"],
					}
				)
			)
		).toEqual(["w*** the f***"]);
	});

	test("is deterministic with an injected id factory", () => {
		const cue = wordCue(["a", "b", "c"]);
		const ids = () => {
			let n = 0;
			return () => {
				n += 1;
				return `id-${n}`;
			};
		};
		expect(
			rechunk([cue], undefined, { mode: "single-word" }, { newId: ids() })
		).toEqual(
			rechunk([cue], undefined, { mode: "single-word" }, { newId: ids() })
		);
	});
});

describe("rechunkProject", () => {
	test("rewrites the active captions and stores the chunking", () => {
		const project = {
			...newProject(),
			captions: [wordCue(["one", "two", "three"])],
		};
		const next = rechunkProject(project, [], {
			chunking: { mode: "single-word" },
			revision: project.revision,
		});
		expect(texts(next.captions)).toEqual(["one", "two", "three"]);
		expect(next.captionChunking).toEqual({ mode: "single-word" });
	});

	test("targets a language track and rejects unknown tracks", () => {
		const track = {
			captions: [{ end: 2, id: uuid(), start: 0, text: "Bonjour le monde" }],
			id: uuid(),
			label: "Français",
			language: "fr",
		};
		const project = {
			...newProject(),
			captionTracks: [track],
			captions: [wordCue(["hi"])],
		};
		const next = rechunkProject(project, [], {
			chunking: { maxWords: 2, mode: "words" },
			revision: 0,
			trackId: track.id,
		});
		expect(texts(next.captionTracks[0]?.captions ?? [])).toEqual([
			"Bonjour le",
			"monde",
		]);
		expect(texts(next.captions)).toEqual(["hi"]);
		expect(() =>
			rechunkProject(project, [], {
				chunking: { mode: "words" },
				revision: 0,
				trackId: uuid(),
			})
		).toThrow("Caption track not found.");
		expect(() =>
			rechunkProject(newProject(), [], {
				chunking: { mode: "words" },
				revision: 0,
			})
		).toThrow("no captions");
	});
});
