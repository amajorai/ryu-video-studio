import { describe, expect, test } from "bun:test";
import {
	applyEmojiSuggestions,
	editCaptions,
	emojiPrompt,
	importCaptions,
	parseEmojiSuggestions,
	subtitleFormatOfFile,
} from "./caption-edits.ts";
import { newProject, validateProject } from "./project.ts";

const cue = (text: string, start = 0) => ({
	end: start + 1,
	id: crypto.randomUUID(),
	start,
	text,
});

test("caption edits append, replace, and remove on a selected track", () => {
	const source = cue("Source");
	const translated = cue("Bonjour");
	const track = {
		captions: [translated],
		id: crypto.randomUUID(),
		label: "Français",
		language: "fr",
	};
	const project = {
		...newProject("Caption edits"),
		captionTracks: [track],
		captionTrackId: track.id,
		captions: [source],
	};
	const appended = editCaptions(project, [], {
		action: "append",
		captions: [cue("Encore", 1)],
		revision: project.revision,
		trackId: track.id,
	});
	expect(appended.captionTracks[0]?.captions).toHaveLength(2);
	const removed = editCaptions(appended, [], {
		action: "remove",
		captionIds: [translated.id],
		revision: appended.revision,
		trackId: track.id,
	});
	expect(removed.captionTracks[0]?.captions.map((item) => item.text)).toEqual([
		"Encore",
	]);
	const replaced = editCaptions(removed, [], {
		action: "replace",
		captions: [cue("Replaced")],
		revision: removed.revision,
		trackId: null,
	});
	expect(replaced.captions[0]?.text).toBe("Replaced");
});

describe("caption import", () => {
	const srt =
		"1\n00:00:01,000 --> 00:00:02,000\nHello\n\n2\n00:00:03,000 --> 00:00:02,000\nBad\n\n3\nbroken\n\n4\n00:00:04,000 --> 00:00:05,000\nBye\n";

	test("lenient import reports skipped cues and replaces captions", () => {
		const project = { ...newProject(), captions: [cue("Old")] };
		const result = importCaptions(project, [], {
			format: "srt",
			lenient: true,
			revision: 0,
			text: srt,
		});
		expect(result.imported).toBe(2);
		expect(result.skipped).toHaveLength(2);
		expect(result.project.captions.map((item) => item.text)).toEqual([
			"Hello",
			"Bye",
		]);
	});

	test("strict import fails and append keeps existing captions", () => {
		const project = { ...newProject(), captions: [cue("Old", 10)] };
		expect(() =>
			importCaptions(project, [], { format: "srt", revision: 0, text: srt })
		).toThrow("Caption end must follow its start.");
		const appended = importCaptions(project, [], {
			format: "ass",
			mode: "append",
			revision: 0,
			text: "[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:00.00,0:00:01.00,Default,,0,0,0,,{\\i1}New{\\i0}\n",
		});
		expect(appended.project.captions.map((item) => item.text)).toEqual([
			"Old",
			"New",
		]);
		expect(() =>
			importCaptions(project, [], {
				format: "srt",
				lenient: true,
				revision: 0,
				text: "garbage",
			})
		).toThrow("No valid captions found; 1 cue was skipped.");
	});

	test("file extensions map to formats", () => {
		expect(subtitleFormatOfFile("a.SRT")).toBe("srt");
		expect(subtitleFormatOfFile("a.vtt")).toBe("vtt");
		expect(subtitleFormatOfFile("a.ssa")).toBe("ass");
		expect(subtitleFormatOfFile("a.ass")).toBe("ass");
		expect(subtitleFormatOfFile("a.txt")).toBeNull();
	});
});

describe("emoji suggestions", () => {
	const plain = cue("We won the game");
	const timed = {
		end: 2,
		id: crypto.randomUUID(),
		start: 0,
		text: "so hot",
		words: [
			{ end: 0.5, id: crypto.randomUUID(), start: 0, text: "so" },
			{ end: 1, id: crypto.randomUUID(), start: 0.5, text: "hot" },
		],
	};

	test("prompt lists caption ids and texts", () => {
		const { prompt, system } = emojiPrompt([plain]);
		expect(JSON.parse(prompt)).toEqual([{ id: plain.id, text: plain.text }]);
		expect(system).toContain("JSON");
	});

	test("parses only known ids with real emoji", () => {
		const reply = `Sure! {"suggestions":[{"id":"${plain.id}","emoji":"🏆"},{"id":"${plain.id}","emoji":"🎉"},{"id":"unknown","emoji":"🔥"},{"id":"${timed.id}","emoji":"hot"}]}`;
		expect(parseEmojiSuggestions(reply, [plain, timed])).toEqual([
			{ captionId: plain.id, emoji: "🏆" },
		]);
		expect(parseEmojiSuggestions("no json", [plain])).toEqual([]);
		expect(parseEmojiSuggestions("{bad json}", [plain])).toEqual([]);
		expect(
			parseEmojiSuggestions(
				`{"suggestions":[{"id":"${plain.id}","emoji":"👍🏽"}]}`,
				[plain]
			)
		).toEqual([{ captionId: plain.id, emoji: "👍🏽" }]);
	});

	test("applying keeps word alignment valid", () => {
		const applied = applyEmojiSuggestions(
			[plain, timed],
			[
				{ captionId: plain.id, emoji: "🏆" },
				{ captionId: timed.id, emoji: "🔥" },
			]
		);
		expect(applied.map((item) => item.text)).toEqual([
			"We won the game 🏆",
			"so hot 🔥",
		]);
		expect(() =>
			validateProject({ ...newProject(), captions: applied }, [])
		).not.toThrow();
	});
});
