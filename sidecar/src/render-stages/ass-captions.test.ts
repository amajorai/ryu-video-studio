import { describe, expect, test } from "bun:test";
import { captionPreset } from "../../../shared/caption-style.ts";
import { type Caption, newProject } from "../../../shared/project.ts";
import { assCaptions } from "../render-ass.ts";
import {
	CAPTION_STYLE_NAME,
	captionDialogue,
	captionStyleLine,
	styledCaptionLine,
	usesStyledCaptions,
} from "./ass-captions.ts";

const SPEAKER = "aaaaaaaa-0000-4000-8000-000000000001";
const id = (n: number) =>
	`00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function wordCaption(): Caption {
	return {
		end: 2,
		id: id(1),
		start: 0,
		text: "Hello world",
		words: [
			{ end: 0.6, id: id(2), start: 0, text: "Hello" },
			{ end: 1.4, id: id(3), start: 0.8, text: "world" },
		],
	};
}

function project(overrides: Partial<ReturnType<typeof newProject>> = {}) {
	return { ...newProject(), captions: [wordCaption()], ...overrides };
}

describe("legacy captions", () => {
	test("projects without a caption style keep the historical output", () => {
		const p = project();
		expect(usesStyledCaptions(p)).toBe(false);
		expect(captionStyleLine(p)).toBe(
			"Style: Default,Arial,49,&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,2,0,2,40,40,86,1"
		);
		expect(captionDialogue(p)).toEqual([
			"Dialogue: 0,0:00:00.00,0:00:00.60,Default,,0,0,0,,{\\c&H3bd4ff&}Hello{\\c&HFFFFFF&} world",
			"Dialogue: 0,0:00:00.60,0:00:00.80,Default,,0,0,0,,{\\c&HFFFFFF&}Hello{\\c&HFFFFFF&} world",
			"Dialogue: 0,0:00:00.80,0:00:01.40,Default,,0,0,0,,{\\c&HFFFFFF&}Hello{\\c&H3bd4ff&} world",
			"Dialogue: 0,0:00:01.40,0:00:02.00,Default,,0,0,0,,{\\c&HFFFFFF&}Hello{\\c&HFFFFFF&} world",
		]);
	});
});

describe("styled captions", () => {
	test("the Caption style line maps font, colors, box, and margins", () => {
		const p = project({
			captionStyle: {
				backgroundColor: "#102030",
				backgroundOpacity: 0.5,
				color: "#ff0000",
				fontFamily: "inter",
				fontSize: 0.05,
				fontWeight: 700,
				highlightColor: "#00ff00",
			},
		});
		expect(usesStyledCaptions(p)).toBe(true);
		const line = styledCaptionLine(p);
		expect(line).toBe(
			"Style: Caption,Inter,54,&H000000FF,&H0000FF00,&H80302010,&H80302010,-1,0,0,0,100,100,0,0,3,8.1,0,2,40,40,86,1"
		);
		const lines = captionStyleLine(p).split("\n");
		expect(lines[0]).toStartWith("Style: Default,Arial,49,");
		expect(lines.slice(1)).toEqual([line]);
	});

	test("an outline style without a box", () => {
		const p = project({
			captionStyle: { outlineWidth: 0.004, shadowDepth: 0.002 },
		});
		expect(styledCaptionLine(p)).toBe(
			"Style: Caption,Arial,49,&H00FFFFFF,&H003BD4FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,4.32,2.16,2,40,40,86,1"
		);
	});

	test("position, uppercase, and highlight words", () => {
		const p = project({
			captionStyle: { positionX: 0.25, positionY: 0.5, uppercase: true },
		});
		const events = captionDialogue(p);
		expect(events).toHaveLength(4);
		expect(events[0]).toBe(
			`Dialogue: 0,0:00:00.00,0:00:00.60,${CAPTION_STYLE_NAME},,0,0,0,,{\\an2\\pos(480,540)}{\\r\\c&H3bd4ff&}HELLO{\\r} WORLD`
		);
		expect(events[1]).toBe(
			"Dialogue: 0,0:00:00.60,0:00:00.80,Caption,,0,0,0,,{\\an2\\pos(480,540)}HELLO WORLD"
		);
	});

	test("pop and bounce add a swell on the word's first event", () => {
		const pop = captionDialogue(
			project({ captionStyle: { wordAnimation: "pop" } })
		);
		expect(pop[0]).toContain(
			"{\\r\\c&H3bd4ff&\\t(0,80,\\fscx118\\fscy118)\\t(80,160,\\fscx100\\fscy100)}Hello"
		);
		const bounce = captionDialogue(
			project({ captionStyle: { wordAnimation: "bounce" } })
		);
		expect(bounce[2]).toContain("\\t(0,90,\\fscx125\\fscy125)");
	});

	test("box draws the active word's outline in the highlight color", () => {
		const events = captionDialogue(
			project({ captionStyle: { wordAnimation: "box" } })
		);
		expect(events[0]).toContain("{\\r\\3c&H3bd4ff&\\3a&H00&\\bord7.29}Hello");
		expect(events[1]).not.toContain("\\3c");
	});

	test("reveal hides words that have not been spoken", () => {
		const events = captionDialogue(
			project({ captionStyle: { wordAnimation: "reveal" } })
		);
		expect(events[0]).toBe(
			"Dialogue: 0,0:00:00.00,0:00:00.60,Caption,,0,0,0,,{\\an2\\pos(960,994)}Hello{\\r\\alpha&HFF&} world"
		);
		expect(events[2]).not.toContain("alpha");
	});

	test("karaoke is one event with timed fills", () => {
		const events = captionDialogue(
			project({ captionStyle: { wordAnimation: "karaoke" } })
		);
		expect(events).toEqual([
			"Dialogue: 0,0:00:00.00,0:00:02.00,Caption,,0,0,0,,{\\an2\\pos(960,994)}{\\1c&H3bd4ff&}{\\2c&Hffffff&\\kf60}Hello{\\k20}{\\2c&Hffffff&\\kf60} world",
		]);
	});

	test("none and captions without words are one static event", () => {
		const p = project({
			captionStyle: { wordAnimation: "none" },
			captions: [{ end: 3, id: id(9), start: 1, text: "Plain {braces}" }],
		});
		expect(captionDialogue(p)).toEqual([
			"Dialogue: 0,0:00:01.00,0:00:03.00,Caption,,0,0,0,,{\\an2\\pos(960,994)}Plain ｛braces｝",
		]);
	});

	test("long captions wrap into balanced lines", () => {
		const text = "this caption is long enough to need two lines on a phone";
		const p = {
			...project({
				captionStyle: { fontSize: 0.06, maxLines: 2 },
				captions: [{ end: 3, id: id(9), start: 1, text }],
			}),
			height: 1920,
			width: 1080,
		};
		const event = captionDialogue(p)[0] ?? "";
		expect(event.match(/\\N/g)).toHaveLength(1);
	});

	test("speaker tint colors words by speaker even without a style", () => {
		const caption = wordCaption();
		const words = caption.words ?? [];
		const p = project({
			captions: [
				{
					...caption,
					words: [{ ...words[0]!, speakerId: SPEAKER }, words[1]!],
				},
			],
			speakers: [{ color: "#ff00ff", id: SPEAKER, label: "Ana" }],
		});
		expect(usesStyledCaptions(p)).toBe(true);
		const events = captionDialogue(p);
		expect(events[1]).toContain("{\\r\\c&Hff00ff&}Hello{\\r} world");
	});

	test("presets render a complete script", () => {
		const style = captionPreset("broadcast")?.style;
		const script = assCaptions(project({ captionStyle: style }));
		expect(script).toContain("Style: Caption,Roboto,43,");
		expect(script).toContain(",Caption,,0,0,0,,{\\an2\\pos(960,929)}");
	});
});

describe("caption font sources", () => {
	const customFont = {
		family: "Ryufont",
		id: "6f1d2b8e-6f0a-4a43-9b0c-2f0f6a1d2c3e",
	};

	test("an imported font names its family in the Caption style", () => {
		const p = project({ captionStyle: { customFont, fontFamily: "inter" } });
		expect(styledCaptionLine(p)).toStartWith("Style: Caption,Ryufont,");
	});

	test("a system font is named by family; an imported font wins", () => {
		expect(
			styledCaptionLine(
				project({ captionStyle: { systemFont: "DejaVu Sans" } })
			)
		).toStartWith("Style: Caption,DejaVu Sans,");
		expect(
			styledCaptionLine(
				project({ captionStyle: { customFont, systemFont: "DejaVu Sans" } })
			)
		).toStartWith("Style: Caption,Ryufont,");
	});

	test("a language track's system font replaces the project's imported font", () => {
		const trackId = id(9);
		const p = project({
			captionStyle: { customFont },
			captionTrackId: trackId,
			captionTracks: [
				{
					captions: [wordCaption()],
					id: trackId,
					label: "Deutsch",
					language: "de",
					style: { systemFont: "DejaVu Sans" },
				},
			],
		});
		expect(styledCaptionLine(p)).toStartWith("Style: Caption,DejaVu Sans,");
	});
});
