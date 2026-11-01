import { describe, expect, test } from "bun:test";
import { type Asset, newProject, newSegment, type Project } from "./project.ts";
import { placeTitleNarration, titleNarrationText } from "./title-narration.ts";

const TITLE_ID = "11111111-1111-4111-8111-111111111111";

function asset(kind: Asset["kind"], duration: number): Asset {
	return {
		createdAt: new Date(0).toISOString(),
		duration,
		hasAudio: kind !== "image",
		height: kind === "audio" ? 0 : 720,
		id: crypto.randomUUID(),
		kind,
		name: `${kind}.media`,
		width: kind === "audio" ? 0 : 1280,
	};
}

function project(segments: Project["segments"]): Project {
	return {
		...newProject("Narration"),
		segments,
		titles: [
			{
				animation: "fade",
				color: "#ffffff",
				end: 7,
				fadeIn: 0.2,
				fadeOut: 0.2,
				fontSize: 0.08,
				id: TITLE_ID,
				start: 4,
				text: "Ada Lovelace · Mathematician",
				x: 0.5,
				y: 0.8,
			},
		],
	};
}

describe("title narration", () => {
	test("turns title lines into speakable sentences", () => {
		expect(titleNarrationText("Ada Lovelace · Mathematician")).toBe(
			"Ada Lovelace, Mathematician."
		);
		expect(titleNarrationText("Chapter one\n\n  The   beginning!")).toBe(
			"Chapter one. The beginning!"
		);
		expect(titleNarrationText(" \n ")).toBe("");
	});

	test("places the narration at the title's start on the first free audio track", () => {
		const video = asset("video", 20);
		const music = asset("audio", 20);
		const voice = asset("audio", 2.5);
		const base = project([newSegment(video, 0, 0), newSegment(music, 0, 1)]);
		const placed = placeTitleNarration(base, [video, music, voice], {
			assetId: voice.id,
			titleId: TITLE_ID,
		});
		const clip = placed.project.segments.find(
			(segment) => segment.id === placed.segmentId
		);
		expect(clip?.start).toBe(4);
		expect(clip?.assetId).toBe(voice.id);
		expect(clip?.sourceOut).toBe(2.5);
		expect(placed.track).toBe(2);
		expect(clip?.track).toBe(2);
	});

	test("refuses missing titles and non-audio assets", () => {
		const image = asset("image", 5);
		const voice = asset("audio", 1);
		const base = project([]);
		expect(() =>
			placeTitleNarration(base, [voice], {
				assetId: voice.id,
				titleId: crypto.randomUUID(),
			})
		).toThrow("no longer in the project");
		expect(() =>
			placeTitleNarration(base, [image], {
				assetId: image.id,
				titleId: TITLE_ID,
			})
		).toThrow("must be an audio asset");
		expect(() =>
			placeTitleNarration(base, [], { assetId: voice.id, titleId: TITLE_ID })
		).toThrow("not in the library");
	});
});
