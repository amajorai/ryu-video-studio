import { z } from "zod";
import {
	type FillerHit,
	fillerRanges,
	type TimelineRange,
} from "../../shared/filler-words.ts";

const rangeSchema = z.object({ end: z.number(), start: z.number() });
export const fillerPlanSchema = z.object({
	hits: z.array(
		z.object({
			clipId: z.string(),
			end: z.number(),
			kind: z.enum(["filler", "repeat", "stutter"]),
			start: z.number(),
			text: z.string(),
		})
	),
	revision: z.number(),
});
export const deadAirPlanSchema = z.object({
	ranges: z.array(rangeSchema),
	removedSeconds: z.number().optional(),
	revision: z.number(),
	vad: z.object({ analyzed: z.number(), skipped: z.number() }).optional(),
});

export const hitKey = (hit: Pick<FillerHit, "clipId" | "start">) =>
	`${hit.clipId}:${hit.start}`;
export const rangeKey = (range: TimelineRange) => `${range.start}-${range.end}`;
export const rangeSeconds = (ranges: readonly TimelineRange[]) =>
	Number(
		ranges
			.reduce((total, range) => total + (range.end - range.start), 0)
			.toFixed(3)
	);

/** Selected filler hits as merged remove-words ranges, bounded by the timeline. */
export function selectedFillerRanges(
	hits: readonly FillerHit[],
	selected: ReadonlySet<string>,
	timelineEnd: number
): TimelineRange[] {
	return fillerRanges(
		hits.filter((hit) => selected.has(hitKey(hit))),
		{ maxEnd: timelineEnd }
	);
}

export const errorText = (error: unknown) =>
	error instanceof Error ? error.message : "The cleanup plan failed.";
export const STALE_PLAN_TEXT =
	"The timeline changed since this plan. Find again before removing anything.";
export const kindLabels: Record<FillerHit["kind"], string> = {
	filler: "Filler",
	repeat: "Repeat",
	stutter: "Stutter",
};
