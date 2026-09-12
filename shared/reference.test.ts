import { describe, expect, test } from "bun:test";
import {
	buildReferenceProfile,
	referenceBrief,
	referenceConcepts,
	referenceCostEstimate,
} from "./reference.ts";

const asset = {
	id: "11111111-1111-4111-8111-111111111111",
	name: "reference-cut.mp4",
	kind: "video" as const,
	duration: 12,
	width: 1920,
	height: 1080,
	hasAudio: true,
	createdAt: "2026-09-09T00:00:00.000Z",
};

describe("reference profiles", () => {
	test("derives pace, shot count, audio and caption coverage from source analysis", () => {
		const profile = buildReferenceProfile(
			asset,
			{
				assetId: asset.id,
				status: "completed",
				createdAt: "2026-09-09T00:00:00.000Z",
				sceneCuts: [2, 4, 6, 8, 10],
				waveform: [0, 0.4, 0.8],
				duration: 12,
			},
			[
				{
					id: "22222222-2222-4222-8222-222222222222",
					sourceAssetId: asset.id,
					start: 0,
					end: 2,
					text: "A caption",
				},
			],
			{
				assetId: asset.id,
				clipping: { black: false, white: true },
				hueDegrees: 42,
				luma: { average: 0.64, max: 0.9, min: 0.1 },
				sampledAt: 0,
				saturation: { average: 0.32, max: 0.8, min: 0.02 },
				chroma: { u: 0.5, v: 0.5 },
			}
		);
		expect(profile.shotCount).toBe(6);
		expect(profile.averageShotSeconds).toBe(2);
		expect(profile.pace).toBe("fast");
		expect(profile.audioPeak).toBe(0.8);
		expect(profile.captionCount).toBe(1);
		expect(profile.visualStyle?.hueDegrees).toBe(42);
		expect(profile.estimatedCostMicroUsd.total).toBe(7_600_000);
		expect(profile.brief).toContain("64% luma");
		expect(profile.brief).toContain("7.60 USD");
		expect(profile.brief).toContain("fast-paced reference");
		expect(profile.concepts).toHaveLength(3);
		expect(new Set(profile.concepts.map((concept) => concept.title)).size).toBe(
			3
		);
	});

	test("brief keeps quiet references and caption guidance explicit", () => {
		expect(
			referenceBrief({
				assetName: "quiet.mov",
				shotCount: 2,
				averageShotSeconds: 8,
				pace: "slow",
				audioPeak: 0,
				captionCount: 0,
			})
		).toContain("restrained audio");
	});

	test("reference cost estimates stay bounded and kind-specific", () => {
		const estimate = referenceCostEstimate(60, 4);
		expect(estimate).toEqual({
			audio: 200_000,
			image: 1_000_000,
			total: 5_200_000,
			video: 4_000_000,
		});
	});

	test("concept durations remain bounded and explicitly avoid source reuse", () => {
		const concepts = referenceConcepts({
			assetName: "reference.mov",
			duration: 10,
			averageShotSeconds: 5,
			pace: "steady",
		});
		expect(
			concepts.every(
				(concept) => concept.duration >= 1 && concept.duration <= 7200
			)
		).toBe(true);
		expect(
			concepts.every((concept) => concept.brief.includes("do not reuse"))
		).toBe(true);
	});
});
