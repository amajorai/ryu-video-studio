import { z } from "zod";
import { bounded, hexColorSchema, idSchema } from "./primitives.ts";
import { fontFamilySchema } from "./text-style.ts";

export const MAX_CLIP_MASKS = 4;

export const maskShapeSchema = z.enum([
	"rectangle",
	"ellipse",
	"linear",
	"mirror",
	"polygon",
	"star",
	"heart",
	"text",
	"freeform",
]);
export type MaskShape = z.infer<typeof maskShapeSchema>;

/** Where a mask's outline stroke sits relative to the mask edge. */
export const maskStrokeAlignSchema = z.enum(["center", "inside", "outside"]);
export type MaskStrokeAlign = z.infer<typeof maskStrokeAlignSchema>;

/** Widest mask stroke, as a fraction of the clip frame's height. */
export const MAX_MASK_STROKE_WIDTH = 0.1;

const coordinate = bounded(-1, 1);

/** A freeform vertex with optional Bezier handles, in clip-normalized space. */
export const maskPathPointSchema = z
	.object({
		x: coordinate,
		y: coordinate,
		inX: coordinate.optional(),
		inY: coordinate.optional(),
		outX: coordinate.optional(),
		outY: coordinate.optional(),
	})
	.strict();
export type MaskPathPoint = z.infer<typeof maskPathPointSchema>;

/**
 * A clip mask. Geometry is clip-normalized: `x`/`y` are the center in
 * `-1..1`, and `width`/`height` are fractions of the clip frame (`0..2`).
 * An optional outline stroke (`strokeWidth` as a fraction of the frame's
 * height, `strokeColor`, `strokeAlign`) is drawn over the masked clip along
 * the mask edge; text masks have no stroke.
 */
export const maskSchema = z
	.object({
		id: idSchema,
		shape: maskShapeSchema,
		x: coordinate,
		y: coordinate,
		width: bounded(0, 2),
		height: bounded(0, 2),
		rotation: bounded(-180, 180),
		feather: bounded(0, 1),
		invert: z.boolean(),
		opacity: bounded(0, 1),
		cornerRadius: bounded(0, 0.5).optional(),
		sides: z.number().int().min(3).max(12).optional(),
		points: z.number().int().min(3).max(12).optional(),
		innerRadius: bounded(0.1, 0.95).optional(),
		text: z.string().min(1).max(80).optional(),
		fontFamily: fontFamilySchema.optional(),
		path: z.array(maskPathPointSchema).min(3).max(64).optional(),
		strokeColor: hexColorSchema.optional(),
		strokeWidth: bounded(0, MAX_MASK_STROKE_WIDTH).optional(),
		strokeAlign: maskStrokeAlignSchema.optional(),
	})
	.strict()
	.refine(
		(mask) => mask.shape !== "text" || mask.text !== undefined,
		"Text masks need text."
	)
	.refine(
		(mask) => mask.shape !== "freeform" || mask.path !== undefined,
		"Freeform masks need a path of at least three points."
	)
	.refine(
		(mask) => mask.shape !== "text" || (mask.strokeWidth ?? 0) === 0,
		"Text masks cannot have a stroke."
	);
export type Mask = z.infer<typeof maskSchema>;

/** A centered, full-size mask of `shape` with neutral settings. */
export function defaultMask(shape: MaskShape, id: string): Mask {
	const base: Mask = {
		id,
		shape,
		x: 0,
		y: 0,
		width: 1,
		height: 1,
		rotation: 0,
		feather: 0,
		invert: false,
		opacity: 1,
	};
	switch (shape) {
		case "polygon":
			return { ...base, sides: 6 };
		case "star":
			return { ...base, innerRadius: 0.5, points: 5 };
		case "text":
			return { ...base, fontFamily: "system-sans", text: "Text" };
		case "freeform":
			return {
				...base,
				path: [
					{ x: 0, y: -0.5 },
					{ x: 0.5, y: 0.5 },
					{ x: -0.5, y: 0.5 },
				],
			};
		default:
			return base;
	}
}
