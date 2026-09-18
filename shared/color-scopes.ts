import { z } from "zod";
import { idSchema } from "./project.ts";

const normalized = z.number().finite().min(0).max(1);

export const colorScopesSchema = z
	.object({
		assetId: idSchema,
		hueDegrees: z.number().finite().min(0).max(360),
		luma: z
			.object({
				average: normalized,
				max: normalized,
				min: normalized,
			})
			.strict(),
		sampledAt: z.number().finite().min(0).max(7200),
		saturation: z
			.object({
				average: normalized,
				max: normalized,
				min: normalized,
			})
			.strict(),
		clipping: z
			.object({
				black: z.boolean(),
				white: z.boolean(),
			})
			.strict(),
		chroma: z
			.object({
				u: normalized,
				v: normalized,
			})
			.strict(),
	})
	.strict();

export type ColorScopes = z.infer<typeof colorScopesSchema>;
