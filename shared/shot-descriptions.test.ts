import { describe, expect, test } from "bun:test";
import { searchMedia } from "./media-search.ts";
import {
	applyShotDescriptions,
	parseShotDescriptions,
	type ShotIndex,
	searchShots,
	shotDescriptionPrompt,
} from "./shot-index.ts";

const assetId = "00000000-0000-4000-8000-000000000001";

function index(): ShotIndex {
	const shot = (
		start: number,
		labels: ShotIndex["shots"][number]["labels"]
	) => ({
		brightness: 0.8,
		colors: [],
		edgeDensity: 0.5,
		end: start + 2,
		labels,
		motion: 0,
		saturation: 0.2,
		start,
	});
	return {
		analysisCreatedAt: "2026-01-01T00:00:00.000Z",
		assetId,
		format: "ryu.video-studio.shots.v1",
		revision: 0,
		sampleRate: 4,
		shots: [shot(0, ["bright", "static"]), shot(2, ["bright", "motion"])],
		updatedAt: "2026-01-01T00:00:00.000Z",
	};
}

describe("vision shot descriptions", () => {
	test("the prompt names the shot indices and the JSON shape", () => {
		const prompt = shotDescriptionPrompt([3, 4]);
		expect(prompt).toContain("3, 4");
		expect(prompt).toContain('{"shots":[');
	});

	test("answers are parsed from plain or fenced JSON and filtered to the batch", () => {
		const answer =
			'Here you go:\n```json\n{"shots":[{"index":0,"caption":"A dog on grass.","tags":["dog","grass"]},{"index":9,"caption":"x","tags":[]}]}\n```';
		expect(parseShotDescriptions(answer, [0, 1])).toEqual([
			{ caption: "A dog on grass.", index: 0, tags: ["dog", "grass"] },
		]);
		expect(() => parseShotDescriptions("I cannot see images.", [0])).toThrow(
			"did not answer"
		);
		expect(() => parseShotDescriptions('{"shots":[]}', [0])).toThrow("none");
	});

	test("descriptions are applied without touching measured labels", () => {
		const described = applyShotDescriptions(
			index(),
			[{ caption: "A dog on grass.", index: 1, tags: ["Dog", "dog", "GRASS"] }],
			{ model: "m", provider: "p" },
			"2026-02-01T00:00:00.000Z"
		);
		expect(described.shots[1]).toMatchObject({
			caption: "A dog on grass.",
			labels: ["bright", "motion"],
			tags: ["dog", "grass"],
		});
		expect(described.shots[0]?.caption).toBeUndefined();
		expect(described.describedBy?.describedAt).toBe("2026-02-01T00:00:00.000Z");
	});

	test("words search captions and tags; labels stay the fallback", () => {
		const described = applyShotDescriptions(
			index(),
			[
				{
					caption: "Two dogs running on a beach.",
					index: 1,
					tags: ["dogs", "beach"],
				},
			],
			{ model: "m", provider: "p" }
		);
		expect(searchShots([described], "dog").results.map((m) => m.start)).toEqual(
			[2]
		);
		// The described match ranks first; the undescribed shot still matches
		// on its labels alone, below it.
		expect(
			searchShots([described], "bright beach").results.map((m) => m.start)
		).toEqual([2, 0]);
		// A described shot must contain every word; shot 1 is not static.
		expect(
			searchShots([described], "static beach").results.map((m) => m.start)
		).toEqual([0]);
		expect(
			searchShots([described], "bright not beach").results.map((m) => m.start)
		).toEqual([0]);
		// Without descriptions, the measured labels still answer.
		expect(
			searchShots([index()], "bright dog").results.map((m) => m.start)
		).toEqual([0, 2]);
		expect(searchShots([index()], "dog").results).toEqual([]);
	});

	test("media search merges shot matches with transcript matches", () => {
		const described = applyShotDescriptions(
			index(),
			[{ caption: "A red car.", index: 0, tags: ["car"] }],
			{ model: "m", provider: "p" }
		);
		const found = searchMedia(
			[],
			[
				{
					createdAt: "2026-01-01T00:00:00.000Z",
					duration: 4,
					hasAudio: false,
					height: 720,
					id: assetId,
					kind: "video",
					name: "Street",
					width: 1280,
				},
			],
			{ q: "car" },
			[described]
		);
		expect(found.results).toEqual([
			expect.objectContaining({
				assetName: "Street",
				source: "shot",
				start: 0,
				text: "A red car. (car)",
			}),
		]);
	});
});
