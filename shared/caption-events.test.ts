import { expect, test } from "bun:test";
import { captionEvents } from "./caption-events.ts";
import {
	activeCaptions,
	type Caption,
	newProject,
	newSegment,
	validateProject,
	withActiveCaptions,
} from "./project.ts";
import {
	applyTranslations,
	highlightedCaptionsForSource,
	transcriptSchema,
} from "./transcript.ts";

function cue(): Caption {
	return {
		id: crypto.randomUUID(),
		start: 0,
		end: 2,
		text: "Hello world",
		words: [
			{ id: crypto.randomUUID(), start: 0, end: 0.6, text: "Hello" },
			{ id: crypto.randomUUID(), start: 0.8, end: 1.4, text: "world" },
		],
		highlightColor: "#ffd43b",
	};
}
test("caption events retain full text and highlight only measured word intervals", () => {
	const events = captionEvents(cue());
	expect(
		events.map((event) =>
			event.parts.filter((part) => part.active).map((part) => part.text.trim())
		)
	).toEqual([["Hello"], [], ["world"], []]);
	expect(
		events.every(
			(event) => event.parts.map((part) => part.text).join("") === "Hello world"
		)
	).toBe(true);
});
test("caption alignment rejects changed text or words outside the cue", () => {
	const caption = cue();
	const project = { ...newProject(), captions: [caption] };
	expect(() => validateProject(project, [])).not.toThrow();
	expect(() =>
		validateProject(
			{ ...project, captions: [{ ...caption, text: "Other words" }] },
			[]
		)
	).toThrow("alignment");
	expect(() =>
		validateProject({ ...project, captions: [{ ...caption, end: 1 }] }, [])
	).toThrow("word timing");
	expect(
		applyTranslations([caption], {
			translations: [{ id: caption.id, text: "Bonjour monde" }],
		})[0]?.words
	).toBeUndefined();
});

test("localized caption tracks keep source timing and become the active export", () => {
	const source = cue();
	const translated = { ...source, text: "Bonjour le monde", words: undefined };
	const track = {
		captions: [translated],
		id: crypto.randomUUID(),
		label: "Français",
		language: "fr",
	};
	const project = {
		...newProject(),
		captionTracks: [track],
		captionTrackId: track.id,
		captions: [source],
	};

	expect(() => validateProject(project, [])).not.toThrow();
	expect(activeCaptions(project)).toEqual([translated]);
	expect(
		withActiveCaptions(project, [{ ...translated, text: "Salut" }])
	).toEqual({
		...project,
		captionTracks: [{ ...track, captions: [{ ...translated, text: "Salut" }] }],
	});
});

test("highlight groups remain bounded and separate repeated source clips", () => {
	const asset = {
		id: crypto.randomUUID(),
		name: "Voice",
		kind: "audio" as const,
		duration: 8,
		width: 0,
		height: 0,
		hasAudio: true,
		createdAt: new Date().toISOString(),
	};
	const words = Array.from({ length: 14 }, (_, index) => ({
		id: crypto.randomUUID(),
		start: index * 0.4,
		end: index * 0.4 + 0.2,
		text: `word${index}`,
	}));
	const transcript = transcriptSchema.parse({
		assetId: asset.id,
		revision: 0,
		status: "completed",
		nextOffset: 8,
		duration: 8,
		cues: words,
		words,
		updatedAt: new Date().toISOString(),
	});
	const project = {
		...newProject(),
		segments: [newSegment(asset), newSegment(asset, 10)],
	};
	const captions = highlightedCaptionsForSource(project, transcript);
	expect(captions).toHaveLength(6);
	expect(captions.every((caption) => caption.words!.length <= 6)).toBe(true);
	expect(captions[3]?.start).toBe(10);
	expect(() =>
		validateProject({ ...project, captions }, [asset])
	).not.toThrow();
});
