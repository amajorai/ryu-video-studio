import { describe, expect, test } from "bun:test";
import { insertClips } from "./insert.ts";
import { newProject, newSegment, projectDuration } from "./project.ts";

function asset(id: string, kind: "video" | "audio" = "video") {
	return {
		id,
		name: id,
		kind,
		duration: 4,
		width: kind === "audio" ? 0 : 640,
		height: kind === "audio" ? 0 : 360,
		hasAudio: kind === "audio",
		createdAt: new Date().toISOString(),
	};
}

describe("ripple clip insertion", () => {
	test("splits crossing clips and shifts later timed layers", () => {
		const source = asset(crypto.randomUUID());
		const inserted = asset(crypto.randomUUID());
		const project = newProject("Insert");
		const crossing = newSegment(source, 0, 0);
		crossing.sourceOut = 4;
		project.segments = [crossing, newSegment(source, 5, 1)];
		project.titles = [
			{
				id: crypto.randomUUID(),
				start: 1,
				end: 5,
				text: "Title",
				x: 0.5,
				y: 0.5,
				fontSize: 0.05,
				color: "#ffffff",
				fadeIn: 0,
				fadeOut: 0,
				animation: "fade",
			},
		];
		project.captionTracks = [
			{
				captions: [
					{
						end: 5,
						id: crypto.randomUUID(),
						start: 1,
						text: "Translated title",
					},
				],
				id: crypto.randomUUID(),
				label: "Français",
				language: "fr",
			},
		];
		const next = insertClips(project, [source, inserted], 2, 0, [
			{ assetId: inserted.id, sourceIn: 0, speed: 1, volume: 1 },
		]);
		expect(
			next.segments.map((segment) => [segment.start, segment.sourceIn])
		).toEqual([
			[0, 0],
			[2, 0],
			[6, 2],
			[9, 0],
		]);
		expect(next.titles[0]?.start).toBe(1);
		expect(next.titles[0]?.end).toBe(9);
		expect(next.captionTracks[0]?.captions[0]?.end).toBe(9);
		expect(projectDuration(next)).toBe(13);
	});
	test("rejects a source range that cannot be inserted", () => {
		const source = asset(crypto.randomUUID());
		const project = newProject("Invalid insert");
		expect(() =>
			insertClips(project, [source], 0, 0, [
				{
					assetId: source.id,
					sourceIn: 3.98,
					sourceOut: 4,
					speed: 1,
					volume: 1,
				},
			])
		).toThrow("outside its source duration");
	});
});
