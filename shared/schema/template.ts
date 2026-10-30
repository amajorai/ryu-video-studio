import { z } from "zod";
import { idSchema } from "./primitives.ts";

export const templateSlotKindSchema = z.enum([
	"video",
	"image",
	"audio",
	"any",
]);

export const templateSlotSchema = z
	.object({
		id: idSchema,
		segmentId: idSchema,
		label: z.string().trim().min(1).max(80),
		kind: templateSlotKindSchema,
		fixedDuration: z.boolean(),
	})
	.strict();
export type TemplateSlot = z.infer<typeof templateSlotSchema>;

/** Marks a project as a reusable template whose slots are replaceable clips. */
export const projectTemplateSchema = z
	.object({
		slots: z.array(templateSlotSchema).max(100),
		description: z.string().max(2000).optional(),
		category: z.string().trim().max(40).optional(),
	})
	.strict();
export type ProjectTemplate = z.infer<typeof projectTemplateSchema>;
