import { z } from "zod";
import { MAX_CANVAS } from "./limits.ts";

/**
 * Export resolution tiers. A tier scales the canvas so its short side is the
 * tier's height (720, 1080, 1440 or 2160) and keeps the canvas aspect, so a
 * 4:5 or custom-ratio project exports at "2K" without hand-computed sizes
 * and without letterboxing. Sizes are rounded to even numbers for the
 * encoders' 4:2:0 chroma subsampling.
 */

export const OUTPUT_RESOLUTIONS = ["720p", "1080p", "2k", "4k"] as const;
export const outputResolutionSchema = z.enum(OUTPUT_RESOLUTIONS);
export type OutputResolution = z.infer<typeof outputResolutionSchema>;

/** Short-side length of each tier. */
export const OUTPUT_RESOLUTION_SHORT_SIDE: Record<OutputResolution, number> = {
	"720p": 720,
	"1080p": 1080,
	"2k": 1440,
	"4k": 2160,
};

export const OUTPUT_RESOLUTION_LABELS: Record<OutputResolution, string> = {
	"720p": "720p",
	"1080p": "1080p",
	"2k": "2K (1440p)",
	"4k": "4K (2160p)",
};

const even = (value: number): number => Math.max(2, Math.round(value / 2) * 2);

/** The output size for a tier: the short side at the tier, aspect kept. */
export function outputSizeForResolution(
	canvas: { height: number; width: number },
	resolution: OutputResolution
): { height: number; width: number } {
	const shortSide = OUTPUT_RESOLUTION_SHORT_SIDE[resolution];
	const scale = shortSide / Math.min(canvas.width, canvas.height);
	if (canvas.width <= canvas.height) {
		return { width: shortSide, height: even(canvas.height * scale) };
	}
	return { width: even(canvas.width * scale), height: shortSide };
}

/** The tier a size matches for this canvas, if any. */
export function outputResolutionOf(
	canvas: { height: number; width: number },
	size: { height?: number; width?: number }
): OutputResolution | undefined {
	if (size.width === undefined || size.height === undefined) {
		return;
	}
	return OUTPUT_RESOLUTIONS.find((resolution) => {
		const tier = outputSizeForResolution(canvas, resolution);
		return tier.width === size.width && tier.height === size.height;
	});
}

/**
 * Why a tier cannot export this canvas (its long side would pass the
 * maximum frame size), or `undefined` when it can.
 */
export function outputResolutionError(
	canvas: { height: number; width: number },
	resolution: OutputResolution
): string | undefined {
	const size = outputSizeForResolution(canvas, resolution);
	if (Math.max(size.width, size.height) <= MAX_CANVAS) {
		return;
	}
	return `${OUTPUT_RESOLUTION_LABELS[resolution]} would export this ${canvas.width} × ${canvas.height} canvas at ${size.width} × ${size.height}, over the ${MAX_CANVAS} px limit. Choose a lower resolution.`;
}

/**
 * Whether `output` is the canvas aspect up to even-size rounding (at most
 * one pixel on either axis), so it scales straight instead of being fitted
 * with a one- or two-pixel letterbox bar.
 */
export function keepsCanvasAspect(
	canvas: { height: number; width: number },
	output: { height: number; width: number }
): boolean {
	return (
		Math.abs(output.height - (output.width * canvas.height) / canvas.width) <=
			1 ||
		Math.abs(output.width - (output.height * canvas.width) / canvas.height) <= 1
	);
}
