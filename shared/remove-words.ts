import { z } from "zod";
import type { Asset, Project } from "./project.ts";
import { rippleDeleteRange } from "./project.ts";

const rangeSchema = z
	.object({
		end: z.number().finite().min(0).max(7200),
		start: z.number().finite().min(0).max(7200),
	})
	.strict()
	.refine(
		(range) => range.end > range.start && range.end - range.start >= 0.04
	);

export const removeWordsRequestSchema = z
	.object({
		ranges: z.array(rangeSchema).min(1).max(100),
		revision: z.number().int().nonnegative(),
	})
	.strict();

function mergedRanges(ranges: Array<{ end: number; start: number }>) {
	const sorted = [...ranges].sort((a, b) => a.start - b.start);
	const merged: Array<{ end: number; start: number }> = [];
	for (const range of sorted) {
		const previous = merged.at(-1);
		if (previous && range.start <= previous.end) {
			previous.end = Math.max(previous.end, range.end);
		} else {
			merged.push({ ...range });
		}
	}
	return merged;
}

/** Remove transcript-selected timeline ranges in one descending ripple edit. */
export function removeWordRanges(
	project: Project,
	assets: readonly Asset[],
	input: unknown
): Project {
	const request = removeWordsRequestSchema.parse(input);
	let next = project;
	for (const range of mergedRanges(request.ranges).sort(
		(a, b) => b.start - a.start
	)) {
		next = rippleDeleteRange(next, assets, range.start, range.end);
	}
	return next;
}
