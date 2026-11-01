import { z } from "zod";
import { MAX_CANVAS } from "./limits.ts";
import { hexColorSchema } from "./schema/primitives.ts";

/**
 * Solid color mattes (G60): a one-frame PNG image asset filled with a single
 * color. A matte is a still like any imported image: it is placed with the
 * standard 5 second still length and holds for any length it is trimmed to,
 * so it is cheap to store at any canvas size.
 */

/** Shortest matte edge, in pixels. */
export const MIN_MATTE_EDGE = 2;
/**
 * A matte asset's nominal duration, in seconds: the same 5 second length the
 * timeline gives every still when it is placed.
 */
export const MATTE_STILL_SECONDS = 5;

const matteEdgeSchema = z.number().int().min(MIN_MATTE_EDGE).max(MAX_CANVAS);

export const matteRequestSchema = z
	.object({
		color: hexColorSchema,
		height: matteEdgeSchema,
		name: z.string().trim().min(1).max(200).optional(),
		width: matteEdgeSchema,
	})
	.strict();
export type MatteRequest = z.infer<typeof matteRequestSchema>;

/** Parse `#RRGGBB` into 0-255 channels. */
export function matteRgb(color: string): [number, number, number] {
	const hex = hexColorSchema.parse(color).slice(1);
	return [
		Number.parseInt(hex.slice(0, 2), 16),
		Number.parseInt(hex.slice(2, 4), 16),
		Number.parseInt(hex.slice(4, 6), 16),
	];
}

/** Library name for a matte: the given name, or `Color matte #RRGGBB`. */
export function matteName(input: Pick<MatteRequest, "color" | "name">): string {
	return input.name ?? `Color matte ${input.color.toUpperCase()}`;
}
