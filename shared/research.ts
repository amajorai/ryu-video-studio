import { z } from "zod";

const httpsUrl = z
	.string()
	.url()
	.refine(
		(value) => value.startsWith("https://"),
		"Research sources require HTTPS."
	);

export const researchSourceSchema = z
	.object({
		id: z.uuid(),
		note: z.string().trim().max(2000).optional(),
		retrievedAt: z.iso.datetime(),
		title: z.string().trim().min(1).max(240),
		url: httpsUrl,
	})
	.strict();
export type ResearchSource = z.infer<typeof researchSourceSchema>;

export const researchMutationSchema = z
	.object({
		action: z.enum(["append", "remove"]),
		revision: z.number().int().nonnegative(),
		source: researchSourceSchema.optional(),
		sourceId: z.uuid().optional(),
	})
	.strict()
	.refine(
		(input) =>
			(input.action === "append" && input.source !== undefined) ||
			(input.action === "remove" && input.sourceId !== undefined),
		"Append requires a source and remove requires a sourceId."
	);

export function appendResearchSource(
	sources: readonly ResearchSource[],
	source: unknown
): ResearchSource[] {
	const next = researchSourceSchema.parse(source);
	if (sources.some((item) => item.url === next.url)) {
		throw new Error("This research source is already saved.");
	}
	if (sources.length >= 100) {
		throw new Error("Projects can contain at most 100 research sources.");
	}
	return [...sources, next];
}

export function removeResearchSource(
	sources: readonly ResearchSource[],
	sourceId: string
): ResearchSource[] {
	if (!sources.some((source) => source.id === sourceId)) {
		throw new Error("Research source was not found.");
	}
	return sources.filter((source) => source.id !== sourceId);
}
