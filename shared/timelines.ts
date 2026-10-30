import { z } from "zod";
import { idSchema, type Project, projectDuration } from "./project.ts";

export const timelineCreateRequestSchema = z
	.object({
		from: idSchema.optional(),
		title: z.string().trim().min(1).max(200).optional(),
	})
	.strict();

export const timelineSummarySchema = z
	.object({
		duration: z.number().finite().nonnegative(),
		fps: z.number().finite().positive(),
		height: z.number().int().positive(),
		id: idSchema,
		revision: z.number().int().nonnegative(),
		title: z.string().min(1),
		updatedAt: z.iso.datetime(),
		width: z.number().int().positive(),
	})
	.strict();

export function timelineSummaryFor(project: Project) {
	return timelineSummarySchema.parse({
		duration: projectDuration(project),
		fps: project.fps,
		height: project.height,
		id: project.id,
		revision: project.revision,
		title: project.title,
		updatedAt: project.updatedAt,
		width: project.width,
	});
}
