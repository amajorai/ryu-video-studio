import { z } from "zod";
import { MAX_CANVAS } from "../limits.ts";

export const exportContainerSchema = z.enum([
	"mp4",
	"mov",
	"webm",
	"gif",
	"wav",
	"mp3",
	"aac",
	"png-sequence",
	"jpeg-sequence",
]);
export type ExportContainer = z.infer<typeof exportContainerSchema>;

export const rateControlSchema = z.enum(["crf", "cbr", "vbr"]);
export const encoderPresetSchema = z.enum([
	"ultrafast",
	"superfast",
	"veryfast",
	"faster",
	"fast",
	"medium",
	"slow",
	"slower",
	"veryslow",
]);
export type EncoderPreset = z.infer<typeof encoderPresetSchema>;

const outputDimension = z.number().int().min(128).max(MAX_CANVAS).multipleOf(2);

/**
 * Explicit export settings. Absent fields fall back to the values derived
 * from `exportPreset`/`exportCodec` (see `exportSettingsOf`).
 */
export const exportSettingsSchema = z
	.object({
		container: exportContainerSchema,
		includeAudio: z.boolean().optional(),
		alpha: z.boolean().optional(),
		rateControl: rateControlSchema.optional(),
		crf: z.number().int().min(0).max(51).optional(),
		bitrateKbps: z.number().int().min(100).max(200_000).optional(),
		audioBitrateKbps: z.number().int().min(32).max(512).optional(),
		encoderPreset: encoderPresetSchema.optional(),
		outputWidth: outputDimension.optional(),
		outputHeight: outputDimension.optional(),
		gifFps: z.number().int().min(1).max(30).optional(),
		gifWidth: z.number().int().min(64).max(1920).optional(),
		hdr: z.enum(["auto", "off"]).optional(),
		platformPreset: z.string().trim().min(1).max(40).optional(),
	})
	.strict()
	.refine(
		(settings) =>
			(settings.outputWidth === undefined) ===
			(settings.outputHeight === undefined),
		"Provide output width and height together."
	);
export type ExportSettings = z.infer<typeof exportSettingsSchema>;
