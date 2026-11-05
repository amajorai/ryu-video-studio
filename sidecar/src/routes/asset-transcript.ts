import { z } from "zod";
import { transcriptLanguageSchema } from "../../../shared/caption-languages.ts";
import { captionSchema } from "../../../shared/project.ts";
import type { StudioRoute } from "./registry.ts";

export const beginTranscriptRequestSchema = z
	.object({
		/**
		 * Language hint (`auto` or BCP-47) the caller forwards to the
		 * transcription engine for every window; stored on the transcript.
		 */
		language: transcriptLanguageSchema.optional(),
		restart: z.boolean().default(false),
		revision: z.number().int().nonnegative().nullable().optional(),
	})
	.strict();

const saveTranscriptWindowRequestSchema = z
	.object({
		revision: z.number().int().nonnegative(),
		offset: z.number().finite().nonnegative(),
		cues: z.array(captionSchema).max(1000),
		words: z.array(captionSchema).max(1000).default([]),
		timing: z.enum(["windows", "segments"]).default("windows"),
	})
	.strict();

export const routes: StudioRoute[] = [
	{
		scope: "asset",
		action: "transcript",
		method: "POST",
		operation: {
			id: "video_studio_begin_transcript",
			description:
				"Begin or resume source transcription. Returns the next source offset and revision. An optional language ('auto' or a BCP-47 tag such as 'en' or 'pt-BR') is stored on the transcript (`language`) and forwarded by the caller as the transcription engine's language hint for each window (`auto` included: it overrides a saved engine language); resuming without one keeps the stored hint, and resuming saved windows with a different language is refused (409) — restart to change it.",
			body: beginTranscriptRequestSchema,
			bodyJsonSchema: {
				type: "object",
				properties: {
					language: {
						type: "string",
						maxLength: 35,
						pattern: "^(?:auto|[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*)$",
					},
					restart: { type: "boolean", default: false },
					revision: { type: ["integer", "null"], minimum: 0 },
				},
			},
		},
		handle: async ({ asset, json, request, store }) => {
			const body = await request.text();
			const input = beginTranscriptRequestSchema.parse(
				body.trim() ? JSON.parse(body) : {}
			);
			return json(
				input.restart
					? store.restartTranscript(
							asset,
							input.revision ?? null,
							input.language
						)
					: store.beginTranscript(asset, input.language)
			);
		},
	},
	{
		scope: "asset",
		action: "transcript",
		method: "PUT",
		operation: {
			id: "video_studio_save_transcript_window",
			description:
				"Append source-timed cues for exactly the next 20-second window, using its current revision.",
			body: saveTranscriptWindowRequestSchema,
			bodyJsonSchema: {
				type: "object",
				properties: {
					revision: { type: "integer" },
					offset: { type: "number" },
					timing: {
						type: "string",
						enum: ["windows", "segments"],
						default: "windows",
					},
					cues: { type: "array", items: z.toJSONSchema(captionSchema) },
				},
				required: ["revision", "offset", "cues"],
			},
		},
		handle: async ({ asset, json, request, store }) => {
			const input = saveTranscriptWindowRequestSchema.parse(
				await request.json()
			);
			return json(
				store.appendTranscript(
					asset.id,
					input.revision,
					input.offset,
					input.cues,
					input.timing,
					input.words
				)
			);
		},
	},
];
