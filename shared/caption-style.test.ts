import { describe, expect, test } from "bun:test";
import {
	applyCaptionStyle,
	CAPTION_PRESETS,
	captionDisplayText,
	captionLineBreaks,
	captionPreset,
	captionWordState,
	effectiveCaptionStyle,
	hasCaptionStyle,
	hasSpeakerTint,
	mergeCaptionStyle,
	speakerColorOf,
} from "./caption-style.ts";
import { newProject } from "./project.ts";
import { captionStyleSchema } from "./schema/caption-style.ts";

const SPEAKER = "aaaaaaaa-0000-4000-8000-000000000001";

function trackProject() {
	const track = {
		captions: [{ end: 1, id: crypto.randomUUID(), start: 0, text: "Salut" }],
		id: crypto.randomUUID(),
		label: "Français",
		language: "fr",
	};
	return { ...newProject(), captionTracks: [track], track };
}

describe("caption presets", () => {
	test("twelve unique presets that each validate", () => {
		expect(CAPTION_PRESETS).toHaveLength(12);
		expect(new Set(CAPTION_PRESETS.map((item) => item.id)).size).toBe(12);
		for (const item of CAPTION_PRESETS) {
			expect(captionStyleSchema.parse(item.style)).toEqual(item.style);
			expect(item.style.presetId).toBe(item.id);
		}
		expect(captionPreset("karaoke")?.style.wordAnimation).toBe("karaoke");
		expect(captionPreset("nope")).toBeUndefined();
	});
});

describe("effective caption style", () => {
	test("legacy projects resolve to the built-in look", () => {
		const project = newProject();
		expect(hasCaptionStyle(project)).toBe(false);
		expect(effectiveCaptionStyle(project)).toMatchObject({
			color: "#ffffff",
			fontFamily: "system-sans",
			positionY: 0.92,
			wordAnimation: "highlight",
		});
	});

	test("the active track style overlays the project style", () => {
		const { track, ...base } = trackProject();
		const project = {
			...base,
			captionStyle: { color: "#ff0000", fontSize: 0.05 },
			captionTrackId: track.id,
			captionTracks: [{ ...track, style: { color: "#00ff00" } }],
		};
		expect(hasCaptionStyle(project)).toBe(true);
		expect(effectiveCaptionStyle(project)).toMatchObject({
			color: "#00ff00",
			fontSize: 0.05,
		});
		expect(
			effectiveCaptionStyle({ ...project, captionTrackId: null }).color
		).toBe("#ff0000");
	});

	test("merge ignores undefined fields", () => {
		expect(
			mergeCaptionStyle(
				{ color: "#111111" },
				{ color: undefined, uppercase: true }
			)
		).toEqual({ color: "#111111", uppercase: true });
		expect(mergeCaptionStyle(undefined, undefined)).toBeUndefined();
	});
});

describe("caption display helpers", () => {
	test("uppercase and speaker colors", () => {
		expect(captionDisplayText("Hello", { uppercase: true })).toBe("HELLO");
		expect(captionDisplayText("Hello", { uppercase: false })).toBe("Hello");
		const project = {
			speakers: [{ color: "#ff00ff", id: SPEAKER, label: "Ana" }],
		};
		expect(speakerColorOf(project, SPEAKER)).toBe("#ff00ff");
		expect(speakerColorOf(project, undefined)).toBeUndefined();
		const caption = {
			end: 1,
			id: crypto.randomUUID(),
			start: 0,
			text: "Hi",
		};
		expect(hasSpeakerTint(project, [caption])).toBe(false);
		expect(hasSpeakerTint(project, [{ ...caption, speakerId: SPEAKER }])).toBe(
			true
		);
	});

	test("line breaks balance the text within maxLines", () => {
		const canvas = { height: 1080, width: 1920 };
		const words = "one two three four five six seven eight nine ten".split(" ");
		expect(
			captionLineBreaks(words, { fontSize: 0.045, maxLines: 3 }, canvas)
		).toEqual([]);
		// A narrow vertical canvas needs two lines; breaks land mid-text.
		const vertical = { height: 1920, width: 1080 };
		const breaks = captionLineBreaks(
			words,
			{ fontSize: 0.06, maxLines: 3 },
			vertical
		);
		expect(breaks.length).toBeGreaterThan(0);
		expect(breaks.length).toBeLessThanOrEqual(2);
		expect(
			captionLineBreaks(words, { fontSize: 0.12, maxLines: 1 }, vertical)
		).toEqual([]);
	});

	test("word states per animation", () => {
		const word = { end: 1.5, start: 1 };
		expect(captionWordState("highlight", 1.2, word)).toMatchObject({
			active: true,
			highlighted: true,
			scale: 1,
		});
		expect(captionWordState("pop", 1.08, word).scale).toBeCloseTo(1.18);
		expect(captionWordState("pop", 1.3, word).scale).toBe(1);
		expect(captionWordState("bounce", 1.09, word).scale).toBeCloseTo(1.25);
		expect(captionWordState("box", 1.2, word)).toMatchObject({
			boxed: true,
			highlighted: false,
		});
		expect(captionWordState("karaoke", 1.25, word).fill).toBeCloseTo(0.5);
		expect(captionWordState("karaoke", 2, word).fill).toBe(1);
		expect(captionWordState("reveal", 0.9, word).visible).toBe(false);
		expect(captionWordState("reveal", 1, word).visible).toBe(true);
		expect(captionWordState("none", 1.2, word)).toMatchObject({
			highlighted: false,
			scale: 1,
		});
	});
});

describe("applyCaptionStyle", () => {
	test("merges, replaces, and clears the project style", () => {
		const project = newProject();
		const merged = applyCaptionStyle(project, [], {
			revision: 0,
			style: { color: "#ff0000" },
		});
		expect(merged.captionStyle).toEqual({ color: "#ff0000" });
		const more = applyCaptionStyle(merged, [], {
			revision: 0,
			style: { uppercase: true },
		});
		expect(more.captionStyle).toEqual({ color: "#ff0000", uppercase: true });
		const replaced = applyCaptionStyle(more, [], {
			mode: "replace",
			revision: 0,
			style: { positionY: 0.5 },
		});
		expect(replaced.captionStyle).toEqual({ positionY: 0.5 });
		const cleared = applyCaptionStyle(replaced, [], {
			mode: "replace",
			revision: 0,
			style: {},
		});
		expect("captionStyle" in cleared).toBe(false);
	});

	test("styles a language track", () => {
		const { track, ...project } = trackProject();
		const next = applyCaptionStyle(project, [], {
			revision: 0,
			style: { color: "#00ff00" },
			trackId: track.id,
		});
		expect(next.captionTracks[0]?.style).toEqual({ color: "#00ff00" });
		expect(next.captionStyle).toBeUndefined();
		expect(() =>
			applyCaptionStyle(project, [], {
				revision: 0,
				style: {},
				trackId: crypto.randomUUID(),
			})
		).toThrow("Caption track not found.");
		expect(() =>
			applyCaptionStyle(project, [], {
				revision: 0,
				style: { fontSize: 1 },
			})
		).toThrow();
	});
});

describe("caption font sources", () => {
	const customFont = {
		family: "Ryufont",
		id: "6f1d2b8e-6f0a-4a43-9b0c-2f0f6a1d2c3e",
	};

	test("the schema takes an imported font and a safe system family", () => {
		expect(
			captionStyleSchema.parse({ customFont, systemFont: "DejaVu Sans" })
		).toEqual({ customFont, systemFont: "DejaVu Sans" });
		expect(() => captionStyleSchema.parse({ systemFont: "a,b" })).toThrow();
		expect(() =>
			captionStyleSchema.parse({ customFont: { family: "X", id: "nope" } })
		).toThrow();
	});

	test("unstyled captions resolve no font source", () => {
		const style = effectiveCaptionStyle(newProject());
		expect(style.customFont).toBeNull();
		expect(style.systemFont).toBeNull();
	});

	test("a newly chosen source replaces the other one from the base", () => {
		expect(
			mergeCaptionStyle({ customFont }, { systemFont: "DejaVu Sans" })
		).toEqual({ systemFont: "DejaVu Sans" });
		expect(
			mergeCaptionStyle(
				{ fontFamily: "inter", systemFont: "DejaVu Sans" },
				{
					customFont,
				}
			)
		).toEqual({ customFont, fontFamily: "inter" });
		expect(mergeCaptionStyle({ customFont }, { fontSize: 0.05 })).toEqual({
			customFont,
			fontSize: 0.05,
		});
	});

	test("the caption-style route stores an imported font", () => {
		const project = newProject();
		const next = applyCaptionStyle(project, [], {
			revision: project.revision,
			style: { customFont },
		});
		expect(next.captionStyle?.customFont).toEqual(customFont);
		expect(effectiveCaptionStyle(next).customFont).toEqual(customFont);
	});
});
