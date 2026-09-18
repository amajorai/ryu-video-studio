import { z } from "zod";
import { idSchema } from "./project.ts";
export const generationRouteSchema = z.enum([
	"node-default",
	"local",
	"managed",
	"byok",
]);
export const generationRequestSchema = z
	.object({
		id: idSchema,
		projectId: idSchema,
		kind: z.enum(["image", "video", "audio"]),
		prompt: z.string().trim().min(1).max(8000),
		provider: z.string().trim().max(200).default(""),
		model: z.string().trim().max(200).default(""),
		voice: z.string().trim().max(100).default(""),
		language: z.string().trim().max(35).default(""),
		speed: z.number().finite().min(0.5).max(2).default(1),
		route: generationRouteSchema.default("node-default"),
		rationale: z.string().trim().max(1000).default(""),
	})
	.strict();
export const generationOutcomeSchema = z
	.object({
		status: z.enum(["completed", "incomplete"]),
		assetIds: z.array(idSchema).max(16).default([]),
		message: z.string().max(1000).default(""),
	})
	.strict();
export const generationJobSchema = z
	.object({
		id: idSchema,
		request: generationRequestSchema,
		projectRevision: z.number().int().nonnegative(),
		status: z.enum(["requested", "completed", "incomplete", "interrupted"]),
		assetIds: z.array(idSchema).max(16),
		message: z.string().max(1000),
		createdAt: z.iso.datetime(),
		updatedAt: z.iso.datetime(),
	})
	.strict();
export type GenerationJob = z.infer<typeof generationJobSchema>;
