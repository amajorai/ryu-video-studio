import { z } from "zod";

/** Slowest and fastest speed a curve point may hold (CapCut-style curve range). */
export const MIN_CURVE_SPEED = 0.1;
export const MAX_CURVE_SPEED = 10;
/** Points the curve editor lets a person place. */
export const MAX_EDITABLE_CURVE_POINTS = 12;
/**
 * Points a stored curve may hold: the editable maximum plus the two boundary
 * points a split adds, so a split of a full curve stays valid.
 */
export const MAX_STORED_CURVE_POINTS = MAX_EDITABLE_CURVE_POINTS + 4;

/** One curve point: `t` 0 is the clip's source in, 1 its source out. */
export const speedCurvePointSchema = z
	.object({
		t: z.number().finite().min(0).max(1),
		speed: z.number().finite().min(MIN_CURVE_SPEED).max(MAX_CURVE_SPEED),
	})
	.strict();
export type SpeedCurvePoint = z.infer<typeof speedCurvePointSchema>;

/**
 * A clip's continuous speed curve: speed varies linearly between points over
 * the clip's source range and holds outside the first and last point. The
 * clip's `speed` stays its average speed (source seconds over timeline
 * seconds), so its length is unchanged; the curve only shapes how that time
 * is spread across the source.
 */
export const speedCurveSchema = z
	.object({
		points: z.array(speedCurvePointSchema).min(2).max(MAX_STORED_CURVE_POINTS),
		/**
		 * Whether the curve's audio keeps its pitch (`atempo`, the default) or
		 * plays tape-style, pitch following speed (a varispeed resample).
		 * Missing means true, so curves saved before the option are unchanged.
		 */
		preservePitch: z.boolean().optional(),
	})
	.strict()
	.refine(
		(curve) =>
			new Set(curve.points.map((point) => point.t)).size ===
			curve.points.length,
		"Speed curve points need distinct positions."
	);
export type SpeedCurve = z.infer<typeof speedCurveSchema>;

/** Whether a curve keeps its audio pitch (missing means true). */
export const curvePreservesPitch = (
	curve: Pick<SpeedCurve, "preservePitch"> | undefined
): boolean => curve?.preservePitch ?? true;
