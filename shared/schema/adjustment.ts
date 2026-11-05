import { z } from "zod";
import { effectSchema, MAX_EFFECT_STACK } from "../effects.ts";
import { trackIndexSchema } from "../limits.ts";
import { blendModeSchema } from "./blend.ts";
import { colorGradeSchema } from "./color.ts";
import { keyframeSchema } from "./keyframe.ts";
import { MAX_CLIP_MASKS, maskSchema } from "./mask.ts";
import { bounded, idSchema, timeSchema } from "./primitives.ts";

export const MAX_ADJUSTMENT_LAYERS = 100;

/**
 * The source moments a tracked region layer covers: the tracked clip, its
 * asset and the source seconds of the layer's first and last frame. Trims,
 * slips and speed ramps of that clip move the layer to where those source
 * moments play (`followTrackedLayers`).
 */
export const trackedSourceSchema = z
	.object({
		clipId: idSchema,
		assetId: idSchema,
		sourceStart: timeSchema,
		sourceEnd: timeSchema,
	})
	.strict();
export type TrackedSource = z.infer<typeof trackedSourceSchema>;

/**
 * A timed grade/effect pass applied to the composite of every clip whose
 * track is at or below `track`.
 */
export const adjustmentLayerSchema = z
	.object({
		id: idSchema,
		label: z.string().trim().min(1).max(80),
		start: timeSchema,
		end: timeSchema,
		track: trackIndexSchema,
		opacity: bounded(0, 1),
		brightness: bounded(-1, 1).optional(),
		contrast: bounded(0, 3).optional(),
		saturation: bounded(0, 3).optional(),
		colorGrade: colorGradeSchema.optional(),
		effects: z.array(effectSchema).max(MAX_EFFECT_STACK).optional(),
		masks: z.array(maskSchema).max(MAX_CLIP_MASKS).optional(),
		keyframes: z.array(keyframeSchema).max(200).optional(),
		blendMode: blendModeSchema.optional(),
		follows: trackedSourceSchema.optional(),
	})
	.strict();
export type AdjustmentLayer = z.infer<typeof adjustmentLayerSchema>;
