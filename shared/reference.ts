import { z } from "zod";
import type { MediaAnalysis } from "./analysis.ts";
import type { ColorScopes } from "./color-scopes.ts";
import type { Asset, Caption } from "./project.ts";

const profilePace = z.enum(["slow", "steady", "fast"]);

export const referenceConceptSchema = z
	.object({
		id: z.uuid(),
		title: z.string().min(1).max(200),
		hook: z.string().min(1).max(1000),
		direction: z.string().min(1).max(2000),
		duration: z.number().finite().min(1).max(7200),
		brief: z.string().min(1).max(4000),
	})
	.strict();
export type ReferenceConcept = z.infer<typeof referenceConceptSchema>;

export const referenceVisualStyleSchema = z
	.object({
		clipping: z.object({ black: z.boolean(), white: z.boolean() }).strict(),
		hueDegrees: z.number().finite().min(0).max(360),
		luma: z.number().finite().min(0).max(1),
		saturation: z.number().finite().min(0).max(1),
	})
	.strict();
export type ReferenceVisualStyle = z.infer<typeof referenceVisualStyleSchema>;

export const referenceCostEstimateSchema = z
	.object({
		audio: z.number().int().nonnegative().max(1_000_000_000),
		image: z.number().int().nonnegative().max(1_000_000_000),
		total: z.number().int().nonnegative().max(1_000_000_000),
		video: z.number().int().nonnegative().max(1_000_000_000),
	})
	.strict();
export type ReferenceCostEstimate = z.infer<typeof referenceCostEstimateSchema>;

export const referenceProfileSchema = z
	.object({
		assetId: z.uuid(),
		assetName: z.string().min(1).max(200),
		duration: z.number().finite().min(0).max(7200),
		width: z.number().int().min(0).max(16_384),
		height: z.number().int().min(0).max(16_384),
		shotCount: z.number().int().min(1).max(2001),
		averageShotSeconds: z.number().finite().min(0).max(7200),
		pace: profilePace,
		audioPeak: z.number().finite().min(0).max(1),
		captionCount: z.number().int().min(0).max(5000),
		visualStyle: referenceVisualStyleSchema.optional(),
		estimatedCostMicroUsd: referenceCostEstimateSchema,
		brief: z.string().min(1).max(4000),
		concepts: z.array(referenceConceptSchema).max(3).default([]),
		createdAt: z.iso.datetime(),
	})
	.strict();

export type ReferenceProfile = z.infer<typeof referenceProfileSchema>;

function paceForAverageShot(
	averageShotSeconds: number
): ReferenceProfile["pace"] {
	if (averageShotSeconds <= 2.5) {
		return "fast";
	}
	if (averageShotSeconds >= 6) {
		return "slow";
	}
	return "steady";
}

export function referenceBrief(profile: {
	assetName: string;
	shotCount: number;
	averageShotSeconds: number;
	pace: ReferenceProfile["pace"];
	audioPeak: number;
	captionCount: number;
	visualStyle?: ReferenceVisualStyle;
	estimatedCostMicroUsd?: ReferenceCostEstimate;
}): string {
	const audio =
		profile.audioPeak > 0.01
			? "with an audible soundtrack"
			: "with restrained audio";
	const captions = profile.captionCount
		? ` Keep ${profile.captionCount} timed caption cue${profile.captionCount === 1 ? "" : "s"} legible.`
		: " Leave space for captions if they are added later.";
	const style = profile.visualStyle
		? ` The sampled opening frame averages ${Math.round(profile.visualStyle.luma * 100)}% luma and ${Math.round(profile.visualStyle.saturation * 100)}% saturation around ${Math.round(profile.visualStyle.hueDegrees)}° hue${profile.visualStyle.clipping.black || profile.visualStyle.clipping.white ? "; review clipped values" : ""}.`
		: "";
	const cost = profile.estimatedCostMicroUsd
		? ` Planning estimate: ${(profile.estimatedCostMicroUsd.total / 1_000_000).toFixed(2)} USD across image, video, and narration work; Gateway receipts remain authoritative.`
		: "";
	return `Use ${profile.assetName} as a ${profile.pace}-paced reference: ${profile.shotCount} shots averaging ${profile.averageShotSeconds.toFixed(1)} seconds, ${audio}.${captions}${style}${cost}`;
}

export function referenceCostEstimate(
	duration: number,
	shotCount: number
): ReferenceCostEstimate {
	const boundedShots = Math.max(1, Math.min(200, Math.ceil(shotCount)));
	const boundedDuration = Math.max(1, Math.min(7200, duration));
	const image = boundedShots * 250_000;
	const video = boundedShots * 1_000_000;
	const audio = Math.max(1, Math.ceil(boundedDuration / 30)) * 100_000;
	return referenceCostEstimateSchema.parse({
		audio,
		image,
		total: image + video + audio,
		video,
	});
}

export function referenceConcepts(profile: {
	assetName: string;
	duration: number;
	averageShotSeconds: number;
	pace: ReferenceProfile["pace"];
}): ReferenceConcept[] {
	const duration = Math.max(1, profile.duration);
	const concepts = [
		{
			title: "Keep the observed rhythm",
			hook: "Open on the clearest visual promise, then let each beat land at the reference pace.",
			direction: `Use ${profile.pace} pacing with shots averaging ${profile.averageShotSeconds.toFixed(1)} seconds. Replace every source shot with original footage or generated media.`,
			duration,
		},
		{
			title: "Build a slower reveal",
			hook: "Start with one unanswered question and reveal the answer across fewer, longer shots.",
			direction:
				"Hold the opening image longer, use a restrained transition, and reserve the final beat for the thesis.",
			duration: Math.min(7200, Math.max(1, duration * 1.5)),
		},
		{
			title: "Lead with a fast hook",
			hook: "Cut three original details into the first few seconds, then settle into the story.",
			direction:
				"Use short opening shots before returning to the measured rhythm; keep the source structure as a pacing reference only.",
			duration: Math.max(1, duration * 0.75),
		},
	].map((concept) => ({
		...concept,
		id: crypto.randomUUID(),
		brief: `${concept.hook} ${concept.direction} The reference is ${profile.assetName}; do not reuse its media or text.`,
	}));
	return concepts.map((concept) => referenceConceptSchema.parse(concept));
}

export function buildReferenceProfile(
	asset: Asset,
	analysis: MediaAnalysis,
	captions: Caption[] = [],
	visualStyle?: ColorScopes
): ReferenceProfile {
	if (asset.kind !== "video") {
		throw new Error("Reference studies require a video source.");
	}
	if (analysis.assetId !== asset.id || analysis.status !== "completed") {
		throw new Error(
			"Complete source analysis before building a reference profile."
		);
	}
	const duration = Math.max(asset.duration, analysis.duration);
	const shotCount = analysis.sceneCuts.length + 1;
	const averageShotSeconds = duration / shotCount;
	const audioPeak = Math.max(0, ...analysis.waveform);
	const profile = {
		assetId: asset.id,
		assetName: asset.name,
		duration,
		width: asset.width,
		height: asset.height,
		shotCount,
		averageShotSeconds,
		pace: paceForAverageShot(averageShotSeconds),
		audioPeak,
		captionCount: captions.filter(
			(caption) => caption.sourceAssetId === asset.id
		).length,
		visualStyle: visualStyle
			? {
					clipping: visualStyle.clipping,
					hueDegrees: visualStyle.hueDegrees,
					luma: visualStyle.luma.average,
					saturation: visualStyle.saturation.average,
				}
			: undefined,
		estimatedCostMicroUsd: referenceCostEstimate(duration, shotCount),
		brief: "",
		concepts: [] as ReferenceConcept[],
		createdAt: new Date().toISOString(),
	};
	return referenceProfileSchema.parse({
		...profile,
		brief: referenceBrief(profile),
		concepts: referenceConcepts(profile),
	});
}
