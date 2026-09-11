import { z } from "zod";

export const upscaleRequestSchema = z
	.object({
		factor: z.union([z.literal(2), z.literal(4)]).default(2),
		name: z.string().trim().min(1).max(200).optional(),
	})
	.strict();

export type UpscaleRequest = z.infer<typeof upscaleRequestSchema>;

export function upscaleDimensions(
	width: number,
	height: number,
	factor: UpscaleRequest["factor"]
) {
	if (width < 2 || height < 2) {
		throw new Error(
			"Upscale requires a visual source with measured dimensions."
		);
	}
	const limit = 3840;
	const scale = Math.min(factor, limit / Math.max(width, height));
	const even = (value: number) => Math.max(2, Math.floor(value / 2) * 2);
	return {
		height: even(height * scale),
		width: even(width * scale),
	};
}
