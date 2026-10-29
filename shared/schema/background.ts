import { z } from "zod";
import { bounded, hexColorSchema, idSchema } from "./primitives.ts";

/** Canvas fill behind clips: project-wide, or per clip while it plays. */
export const canvasBackgroundSchema = z.discriminatedUnion("type", [
	z.object({ type: z.literal("color"), color: hexColorSchema }).strict(),
	z
		.object({
			type: z.literal("gradient"),
			color: hexColorSchema,
			color2: hexColorSchema,
			angle: bounded(0, 360),
		})
		.strict(),
	z
		.object({
			type: z.literal("blur"),
			amount: bounded(0, 1),
			dim: bounded(0, 1),
		})
		.strict(),
	z.object({ type: z.literal("image"), assetId: idSchema }).strict(),
]);
export type CanvasBackground = z.infer<typeof canvasBackgroundSchema>;
