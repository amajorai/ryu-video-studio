import { describe, expect, test } from "bun:test";
import {
	assPlainText,
	detectSubtitleFormat,
	parseSubtitles,
	parseSubtitlesLenient,
	subtitleSeconds,
	subtitleText,
} from "./subtitles.ts";

const MALFORMED_SRT = `1
00:00:01,000 --> 00:00:02,000
First line

2
00:00:03,000 --> 00:00:02,500
End before start

3
00:00:xx,000 --> 00:00:05,000
Bad timestamp

4
00:00:06,000 --> 00:00:07,500
Last line
spans two rows
`;

const ASS = `[Script Info]
Title: Example
ScriptType: v4.00+

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,20,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,2,2,10,10,10,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Comment: 0,0:00:00.00,0:00:01.00,Default,,0,0,0,,ignored comment
Dialogue: 0,0:00:01.50,0:00:03.25,Default,,0,0,0,,{\\b1}Hello{\\b0}, world\\Nsecond line
Dialogue: 0,0:00:04.00,0:00:05.00,Default,,0,0,0,,{\\p1}m 0 0 l 100 0 100 100{\\p0}
Dialogue: 0,0:00:06.00,0:00:05.00,Default,,0,0,0,,Backwards
Dialogue: 0,0:00:07.00,0:00:08.00,Default,,0,0,0,,{\\an8\\pos(10,10)}Top\\hline, with commas, kept
`;

const SSA = `[Script Info]
ScriptType: v4.00

[Events]
Format: Marked, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: Marked=0,0:00:00.50,0:00:01.00,Default,NTP,0000,0000,0000,!Effect,Old style
`;

describe("subtitle import", () => {
	test("SRT import strips trailing blank-line whitespace from the final cue", () => {
		const cues = parseSubtitles(
			"1\n00:00:00,250 --> 00:00:01,250\nFirst spoken cue\n\n2\n00:00:01,500 --> 00:00:02,250\nSecond spoken cue\n"
		);

		expect(cues).toHaveLength(2);
		expect(cues).toMatchObject([
			{ start: 0.25, end: 1.25, text: "First spoken cue" },
			{ start: 1.5, end: 2.25, text: "Second spoken cue" },
		]);
	});

	test("timestamps accept SRT, VTT, and ASS forms", () => {
		expect(subtitleSeconds("00:00:01,500")).toBe(1.5);
		expect(subtitleSeconds("01:02.250")).toBe(62.25);
		expect(subtitleSeconds("1:00:00.50")).toBe(3600.5);
		expect(subtitleSeconds("00:61:00,000")).toBeNaN();
		expect(subtitleSeconds("nope")).toBeNaN();
	});

	test("detects the format from the text", () => {
		expect(detectSubtitleFormat(ASS)).toBe("ass");
		expect(detectSubtitleFormat("WEBVTT\n\n00:01.000 --> 00:02.000\nHi")).toBe(
			"vtt"
		);
		expect(detectSubtitleFormat(MALFORMED_SRT)).toBe("srt");
	});

	test("lenient SRT keeps valid cues and reports two skipped cues", () => {
		const result = parseSubtitlesLenient(MALFORMED_SRT, "srt");
		expect(result.captions.map((cue) => cue.text)).toEqual([
			"First line",
			"Last line\nspans two rows",
		]);
		expect(result.skipped).toEqual([
			{ line: 6, reason: "Caption end must follow its start." },
			{ line: 10, reason: "Invalid subtitle timestamp." },
		]);
	});

	test("strict parsing throws on the first malformed cue", () => {
		expect(() => parseSubtitles(MALFORMED_SRT)).toThrow(
			"Caption end must follow its start."
		);
		expect(() => parseSubtitles("")).toThrow("Import between 1 and 5000");
	});

	test("lenient import reports blocks without a timing line, except VTT headers", () => {
		const result = parseSubtitlesLenient(
			"WEBVTT\n\nNOTE a comment\n\n1\nno timing here\n\n00:01.000 --> 00:02.000 align:start\n<b>Bold</b> &amp; <c.yellow>bright</c>\n",
			"vtt"
		);
		expect(result.captions.map((cue) => cue.text)).toEqual(["Bold & bright"]);
		expect(result.skipped).toEqual([
			{ line: 5, reason: "Missing a `start --> end` timing line." },
		]);
	});

	test("ASS dialogue drops override tags and honours start and end", () => {
		const result = parseSubtitlesLenient(ASS);
		expect(
			result.captions.map(({ start, end, text }) => ({ end, start, text }))
		).toEqual([
			{ end: 3.25, start: 1.5, text: "Hello, world\nsecond line" },
			{ end: 8, start: 7, text: "Top line, with commas, kept" },
		]);
		expect(result.skipped.map((item) => item.reason)).toEqual([
			"Vector drawings are not captions.",
			"Caption end must follow its start.",
		]);
		expect(result.skipped.map((item) => item.line)).toEqual([13, 14]);
		expect(() => parseSubtitles(ASS)).toThrow();
	});

	test("SSA v4 scripts use their own Format line", () => {
		expect(parseSubtitles(SSA)).toMatchObject([
			{ end: 1, start: 0.5, text: "Old style" },
		]);
	});

	test("plain text of ASS overrides", () => {
		expect(assPlainText("{\\c&H00FF00&}Green\\h{\\i1}text\\nnext")).toBe(
			"Green text\nnext"
		);
	});

	test("round-trips exported SRT", () => {
		const cues = parseSubtitlesLenient(MALFORMED_SRT, "srt").captions;
		expect(
			parseSubtitles(subtitleText(cues, "srt")).map((cue) => cue.text)
		).toEqual(cues.map((cue) => cue.text));
		expect(
			parseSubtitles(subtitleText(cues, "vtt")).map((cue) => cue.start)
		).toEqual([1, 6]);
	});
});

describe("subtitle export", () => {
	const cues = [
		{ end: 4, id: "b", start: 2, text: "Second\nline" },
		{ end: 1.5, id: "a", start: 0, text: "First" },
	];
	test("txt writes one cue per line in time order", () => {
		expect(subtitleText(cues, "txt")).toBe("First\nSecond line\n");
		expect(subtitleText([], "txt")).toBe("");
	});
	test("srt and vtt keep their timing", () => {
		expect(subtitleText(cues, "srt")).toContain(
			"00:00:00,000 --> 00:00:01,500"
		);
		expect(subtitleText(cues, "vtt")).toStartWith("WEBVTT\n\n1\n00:00:00.000");
	});
});
