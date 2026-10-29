import { z } from "zod";
import { sfxRequestSchema } from "../../../shared/sfx.ts";
import { conformGeneratedAudioRequestSchema } from "../../../shared/soundtrack.ts";
import { generateSfx } from "../sfx.ts";
import { conformGeneratedAudio } from "../soundtrack.ts";
import type { StudioRoute } from "./registry.ts";

export const routes: StudioRoute[] = [
	{
		scope: "root",
		path: "sfx",
		method: "POST",
		operation: {
			id: "video_studio_generate_sfx",
			description:
				"Synthesize a procedural sound effect (whoosh, riser, hit, impact, click, pop, swoosh or ding) locally and save it as an app-owned audio asset. The same kind, duration and seed always give the same sound. Shares the soundtrack concurrency budget.",
			body: sfxRequestSchema,
		},
		handle: async ({ json, request, soundtrackSignal, store }) =>
			json(
				await generateSfx(store, sfxRequestSchema.parse(await request.json()), {
					signal: soundtrackSignal(request),
				}),
				201
			),
	},
	{
		scope: "root",
		path: "sfx-conform",
		method: "POST",
		operation: {
			id: "video_studio_conform_generated_sfx",
			description:
				"Fit a generated sound effect (an audio asset saved from the host's media.audio bridge with `generation` provenance) to `duration` seconds with a short fade-out (`fadeOut`, default 1, at most half the length) and peak limiting, saved as a new WAV asset in the sfx folder that keeps the provider and model provenance. The procedural generator at POST /sfx stays the default. Shares the soundtrack concurrency budget.",
			body: conformGeneratedAudioRequestSchema,
			bodyJsonSchema: z.toJSONSchema(conformGeneratedAudioRequestSchema, {
				io: "input",
			}),
		},
		handle: async ({ json, request, soundtrackSignal, store }) =>
			json(
				await conformGeneratedAudio(store, await request.json(), "sfx", {
					signal: soundtrackSignal(request),
				}),
				201
			),
	},
];
