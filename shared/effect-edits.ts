import { z } from "zod";
import { effectStackSchema } from "./effects.ts";
import type { Asset, Project } from "./project.ts";
import { trackSettingFor, validateProject } from "./project.ts";

export const effectEditRequestSchema = z
	.object({
		clipIds: z.array(z.uuid()).min(1).max(8),
		effects: effectStackSchema,
		revision: z.number().int().nonnegative(),
	})
	.strict();

/** Replace the bounded effect stack on one or more visual clips. */
export function applyEffects(
	project: Project,
	assets: readonly Asset[],
	input: unknown
): Project {
	const request = effectEditRequestSchema.parse(input);
	if (new Set(request.clipIds).size !== request.clipIds.length) {
		throw new Error("Choose each effect target once.");
	}
	const targets = project.segments.filter((segment) =>
		request.clipIds.includes(segment.id)
	);
	if (targets.length !== request.clipIds.length) {
		throw new Error("An effect target clip was not found.");
	}
	for (const target of targets) {
		if (trackSettingFor(project, target.track).locked) {
			throw new Error(
				"Unlock every effect target track before editing effects."
			);
		}
		if (assets.find((asset) => asset.id === target.assetId)?.kind === "audio") {
			throw new Error("Visual effects only apply to visual clips.");
		}
	}
	const targetIds = new Set(request.clipIds);
	return validateProject(
		{
			...project,
			segments: project.segments.map((segment) =>
				targetIds.has(segment.id)
					? { ...segment, effects: request.effects }
					: segment
			),
		},
		[...assets]
	);
}
