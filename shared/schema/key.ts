import { z } from "zod";
import { bounded, hexColorSchema } from "./primitives.ts";

export const keyTypeSchema = z.enum(["chroma", "color", "hsv", "luma"]);
export type KeyType = z.infer<typeof keyTypeSchema>;

/**
 * Clip keying. Chroma, color and HSV keys need a key `color`; luma keys use
 * `lumaLow`/`lumaHigh` instead.
 */
export const keySchema = z
	.object({
		type: keyTypeSchema,
		color: hexColorSchema.optional(),
		similarity: bounded(0.01, 1).optional(),
		blend: bounded(0, 1).optional(),
		spill: bounded(0, 1).optional(),
		hueRange: bounded(0, 180).optional(),
		lumaLow: bounded(0, 1).optional(),
		lumaHigh: bounded(0, 1).optional(),
	})
	.strict()
	.refine(
		(key) => key.type === "luma" || key.color !== undefined,
		"Chroma, color and HSV keys need a key color."
	)
	.refine(
		(key) =>
			key.lumaLow === undefined ||
			key.lumaHigh === undefined ||
			key.lumaLow <= key.lumaHigh,
		"The luma key low threshold must not exceed the high threshold."
	);
export type Key = z.infer<typeof keySchema>;
