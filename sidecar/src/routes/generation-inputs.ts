import { z } from "zod";
import { generationInputRequestSchema } from "../../../shared/generation-inputs.ts";
import {
	prepareGenerationInput,
	readGenerationInputChunk,
} from "../generation-inputs.ts";
import type { StudioRoute } from "./registry.ts";

/**
 * Bounded reference inputs for generation models (G78, G79, G80, G46): the
 * editor prepares an extract, reads it back in chunks, and sends it to the
 * host bridge as a `data:` URI. Nothing here contacts a model.
 */
export const routes: StudioRoute[] = [
	{
		scope: "asset",
		action: "generation-input",
		method: "POST",
		operation: {
			id: "video_studio_prepare_generation_input",
			description:
				"Prepare a bounded extract of library media to send to a generation model as a reference input. `kind: clip` writes a source range of at most 10 s, scaled so the short side is at most 720 px, H.264 CRF 28 with AAC audio unless `audio` is false (at most 24 MiB). `kind: frame` writes exactly source frame `frame` (zero-based at the media's frame rate) as PNG or JPEG. `kind: audio` writes a source range of at most 120 s as AAC in MP4. Returns `{id, mediaType, size, start, end, width?, height?, frame?}`; read the bytes with GET /generation-inputs/{id}/data. Extracts are not library media and are deleted after the last chunk is read or after 15 minutes. Takes one media admission slot.",
			body: generationInputRequestSchema,
			bodyJsonSchema: z.toJSONSchema(generationInputRequestSchema, {
				io: "input",
			}),
		},
		handle: async ({ asset, json, mediaSignal, request, store }) =>
			json(
				await prepareGenerationInput(store, asset, await request.json(), {
					signal: mediaSignal(request),
				}),
				201
			),
	},
	{
		scope: "item",
		resource: "generation-inputs",
		action: "data",
		method: "GET",
		operation: {
			id: "video_studio_read_generation_input",
			description:
				"Read a prepared generation input in 512 KiB base64 chunks (`{data, offset, size, done, mediaType}`). The offset query is a byte offset and defaults to zero. The extract is deleted once the last chunk is read.",
			query: [
				{
					name: "offset",
					schema: { type: "integer", minimum: 0 },
				},
			],
		},
		handle: async ({ id, json, url }) =>
			json(
				await readGenerationInputChunk(
					id,
					z.coerce
						.number()
						.int()
						.nonnegative()
						.parse(url.searchParams.get("offset") ?? 0)
				)
			),
	},
];
