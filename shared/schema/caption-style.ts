import { z } from "zod";
import { customFontSchema, systemFontSchema } from "./font.ts";
import { bounded, hexColorSchema } from "./primitives.ts";
import { fontFamilySchema, fontWeightSchema } from "./text-style.ts";

export const captionWordAnimationSchema = z.enum([
	"none",
	"highlight",
	"pop",
	"bounce",
	"box",
	"karaoke",
	"reveal",
]);
export type CaptionWordAnimation = z.infer<typeof captionWordAnimationSchema>;

/**
 * Burned-in caption look. Every field is optional; `captionStyleOf` resolves
 * absent fields to the legacy built-in style. Sizes are fractions of the
 * canvas height and positions are fractions of the canvas.
 */
export const captionStyleSchema = z
	.object({
		presetId: z.string().trim().min(1).max(40).optional(),
		fontFamily: fontFamilySchema.optional(),
		/** An imported font; `fontFamily` is the fallback when it is missing. */
		customFont: customFontSchema.optional(),
		/** An installed system font by family; ignored when `customFont` is set. */
		systemFont: systemFontSchema.optional(),
		fontSize: bounded(0.02, 0.12).optional(),
		fontWeight: fontWeightSchema.optional(),
		uppercase: z.boolean().optional(),
		color: hexColorSchema.optional(),
		highlightColor: hexColorSchema.optional(),
		outlineColor: hexColorSchema.optional(),
		outlineWidth: bounded(0, 0.02).optional(),
		shadowDepth: bounded(0, 0.02).optional(),
		backgroundColor: hexColorSchema.optional(),
		backgroundOpacity: bounded(0, 1).optional(),
		positionX: bounded(0, 1).optional(),
		positionY: bounded(0, 1).optional(),
		maxLines: z.number().int().min(1).max(3).optional(),
		wordAnimation: captionWordAnimationSchema.optional(),
	})
	.strict();
export type CaptionStyle = z.infer<typeof captionStyleSchema>;

export const captionChunkingSchema = z
	.object({
		mode: z.enum(["segments", "words", "single-word"]),
		maxWords: z.number().int().min(1).max(20).optional(),
		maxChars: z.number().int().min(8).max(120).optional(),
		minDuration: bounded(0.1, 5).optional(),
		closeGaps: bounded(0, 2).optional(),
		profanity: z.enum(["none", "mask", "remove"]).optional(),
		emoji: z.boolean().optional(),
	})
	.strict();
export type CaptionChunking = z.infer<typeof captionChunkingSchema>;
