import { z } from "zod";
import { assetOriginSchema } from "./project.ts";

const importSourceSchema = z
	.object({
		bytes: z.string().min(1).max(20_000_000).optional(),
		mimeType: z.string().trim().min(1).max(120).optional(),
		path: z.string().min(1).max(2000).optional(),
		url: z.string().min(1).max(2000).optional(),
	})
	.strict()
	.superRefine((source, context) => {
		const configured = [source.bytes, source.path, source.url].filter(
			(value) => value !== undefined
		);
		if (configured.length !== 1) {
			context.addIssue({
				code: "custom",
				message: "Choose exactly one import source: url, path, or bytes.",
				path: ["source"],
			});
		}
		if (source.bytes !== undefined && source.mimeType === undefined) {
			context.addIssue({
				code: "custom",
				message: "Inline bytes require mimeType.",
				path: ["source", "mimeType"],
			});
		}
		if (source.url !== undefined) {
			try {
				if (new URL(source.url).protocol !== "https:") {
					throw new Error("URL is not HTTPS.");
				}
			} catch {
				context.addIssue({
					code: "custom",
					message: "URL imports require an HTTPS URL.",
					path: ["source", "url"],
				});
			}
		}
		if (
			source.bytes !== undefined &&
			(!/^[A-Za-z0-9+/]*={0,2}$/.test(source.bytes) ||
				source.bytes.length > 20_000_000)
		) {
			context.addIssue({
				code: "custom",
				message: "Inline media bytes are too large or malformed.",
				path: ["source", "bytes"],
			});
		}
	});

/**
 * Provenance an import may carry. Only app-bundled media (stickers) declare it
 * at import time; stock providers record their origin through their own
 * search-and-import routes, so callers cannot forge third-party credits here.
 */
const importOriginSchema = assetOriginSchema.refine(
	(origin) => origin.provider === "bundled",
	{ message: "Only bundled media can declare its origin on import." }
);

export const importMediaRequestSchema = z
	.object({
		derivation: z.literal("sticker").optional(),
		folder: z.string().trim().max(300).optional(),
		name: z.string().trim().min(1).max(200).optional(),
		origin: importOriginSchema.optional(),
		source: importSourceSchema,
	})
	.strict();
export type ImportMediaRequest = z.infer<typeof importMediaRequestSchema>;
