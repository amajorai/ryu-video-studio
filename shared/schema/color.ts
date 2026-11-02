import { z } from "zod";
import { bounded, idSchema } from "./primitives.ts";

const signedUnit = bounded(-1, 1);
const unit = bounded(0, 1);

/** Lift/gamma/gain wheel offsets per channel. */
export const colorWheelSchema = z
	.object({ r: signedUnit, g: signedUnit, b: signedUnit, master: signedUnit })
	.strict();
export type ColorWheel = z.infer<typeof colorWheelSchema>;

export const curvePointSchema = z.object({ x: unit, y: unit }).strict();
export type CurvePoint = z.infer<typeof curvePointSchema>;

const strictlyIncreasingX = (points: readonly CurvePoint[]) =>
	points.every((point, index) => index === 0 || point.x > points[index - 1]!.x);

/** A tone curve: 2-16 control points with strictly increasing `x`. */
export const toneCurveSchema = z
	.array(curvePointSchema)
	.min(2)
	.max(16)
	.refine(strictlyIncreasingX, "Curve points need strictly increasing x.");

export const curvesSchema = z
	.object({
		master: toneCurveSchema.optional(),
		red: toneCurveSchema.optional(),
		green: toneCurveSchema.optional(),
		blue: toneCurveSchema.optional(),
	})
	.strict();
export type Curves = z.infer<typeof curvesSchema>;

export const hslBandNameSchema = z.enum([
	"red",
	"orange",
	"yellow",
	"green",
	"aqua",
	"blue",
	"purple",
	"magenta",
]);
export const hslBandSchema = z
	.object({
		band: hslBandNameSchema,
		hue: signedUnit,
		saturation: signedUnit,
		lightness: signedUnit,
	})
	.strict();
export type HslBand = z.infer<typeof hslBandSchema>;

/** A hue-vs-saturation curve: up to 16 points with strictly increasing `x`. */
export const hueVsSatSchema = z
	.array(curvePointSchema)
	.max(16)
	.refine(strictlyIncreasingX, "Curve points need strictly increasing x.");

export const lutReferenceSchema = z
	.object({ lutId: idSchema, intensity: unit })
	.strict();
export type LutReference = z.infer<typeof lutReferenceSchema>;

/** A stored `.cube` LUT (the file lives next to the project store). */
export const lutRecordSchema = z
	.object({
		id: idSchema,
		name: z.string().trim().min(1).max(120),
		size: z.number().int().min(2).max(65),
		createdAt: z.iso.datetime(),
	})
	.strict();
export type LutRecord = z.infer<typeof lutRecordSchema>;

/**
 * Per-clip color grade. The four basic controls default to neutral; every
 * advanced control is optional so legacy grades round-trip unchanged.
 */
export const colorGradeSchema = z
	.object({
		exposure: z.number().finite().min(-3).max(3).default(0),
		temperature: z.number().finite().min(-1).max(1).default(0),
		tint: z.number().finite().min(-1).max(1).default(0),
		vibrance: z.number().finite().min(-1).max(1).default(0),
		highlights: signedUnit.optional(),
		shadows: signedUnit.optional(),
		whites: signedUnit.optional(),
		blacks: signedUnit.optional(),
		lift: colorWheelSchema.optional(),
		gamma: colorWheelSchema.optional(),
		gain: colorWheelSchema.optional(),
		curves: curvesSchema.optional(),
		hsl: z
			.array(hslBandSchema)
			.max(8)
			.refine(
				(bands) =>
					new Set(bands.map((band) => band.band)).size === bands.length,
				"Each HSL band may appear once."
			)
			.optional(),
		hueVsSat: hueVsSatSchema.optional(),
		lut: lutReferenceSchema.optional(),
		look: z.string().trim().min(1).max(64).optional(),
	})
	.strict();
export type ColorGrade = z.infer<typeof colorGradeSchema>;
