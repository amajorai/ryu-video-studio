import { z } from "zod";
import { generationTaskSchema } from "../generation-models.ts";
import { idSchema } from "./primitives.ts";

export const assetDerivationSchema = z.enum([
	"audio",
	"reverse",
	"cutout",
	"stabilize",
	"proxy",
	"interpolate",
	"enhance",
	"matte",
	"lottie",
	"render",
	"recording",
	"sticker",
	"ai-edit",
	"gap-fill",
	"ai-matte",
	"lipsync",
]);
export type AssetDerivation = z.infer<typeof assetDerivationSchema>;

export const assetColorTransferSchema = z.enum([
	"bt709",
	"pq",
	"hlg",
	"unknown",
]);
export type AssetColorTransfer = z.infer<typeof assetColorTransferSchema>;

/** Provenance of host-generated media (image, video or audio models). */
export const assetGenerationSchema = z
	.object({
		kind: z.enum(["image", "video", "audio"]),
		prompt: z.string().max(8000),
		provider: z.string().trim().min(1).max(200).optional(),
		model: z.string().trim().min(1).max(200).optional(),
		inputAssetIds: z.array(idSchema).max(8).optional(),
		requestId: z.string().trim().min(1).max(120).optional(),
		/** The reference-input task that produced the media, when one did. */
		task: generationTaskSchema.optional(),
		/** Set when the sender accepted the likeness consent notice. */
		consent: z.literal("subjects-agreed").optional(),
	})
	.strict();
export type AssetGeneration = z.infer<typeof assetGenerationSchema>;
