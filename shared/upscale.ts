import { z } from "zod";
import { MAX_CANVAS, MAX_UPSCALE_EDGE } from "./limits.ts";

export const upscaleRequestSchema = z
	.object({
		factor: z.union([z.literal(2), z.literal(4)]).default(2),
		/**
		 * Denoise before and sharpen after the Lanczos resize. Enhanced
		 * upscales may reach the canvas bound instead of the UHD edge.
		 */
		enhance: z.boolean().optional(),
		name: z.string().trim().min(1).max(200).optional(),
	})
	.strict();

export type UpscaleRequest = z.infer<typeof upscaleRequestSchema>;

/** Longest output edge: UHD for a plain resize, the canvas bound when enhanced. */
export function upscaleEdgeLimit(enhance: boolean | undefined): number {
	return enhance ? MAX_CANVAS : MAX_UPSCALE_EDGE;
}

export function upscaleDimensions(
	width: number,
	height: number,
	factor: UpscaleRequest["factor"],
	limit: number = MAX_UPSCALE_EDGE
) {
	if (width < 2 || height < 2) {
		throw new Error(
			"Upscale requires a visual source with measured dimensions."
		);
	}
	const scale = Math.min(factor, limit / Math.max(width, height));
	const even = (value: number) => Math.max(2, Math.floor(value / 2) * 2);
	return {
		height: even(height * scale),
		width: even(width * scale),
	};
}
