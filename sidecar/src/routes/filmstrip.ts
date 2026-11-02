import {
	assetFilmstrip,
	MAX_FILMSTRIP_FRAMES,
	MAX_FILMSTRIP_HEIGHT,
	MIN_FILMSTRIP_HEIGHT,
	parseFilmstripQuery,
} from "../filmstrip.ts";
import type { StudioRoute } from "./registry.ts";

export const routes: StudioRoute[] = [
	{
		scope: "asset",
		action: "filmstrip",
		method: "GET",
		operation: {
			id: "video_studio_media_filmstrip",
			description:
				"Read-only. Return a base64 PNG sprite of `count` evenly spaced thumbnails across the source range `start`..`end` of a video (or a repeated still image), laid out left to right in one row, with each frame's sampled source time. Sprites are cached on disk, so repeated requests are cheap.",
			query: [
				{
					name: "start",
					schema: { type: "number", minimum: 0, maximum: 7200 },
				},
				{
					name: "end",
					required: true,
					schema: { type: "number", minimum: 0, maximum: 7200 },
				},
				{
					name: "count",
					required: true,
					schema: {
						type: "integer",
						minimum: 1,
						maximum: MAX_FILMSTRIP_FRAMES,
					},
				},
				{
					name: "height",
					schema: {
						type: "integer",
						minimum: MIN_FILMSTRIP_HEIGHT,
						maximum: MAX_FILMSTRIP_HEIGHT,
					},
				},
			],
		},
		handle: async ({ asset, json, mediaSignal, request, store, url }) =>
			json(
				await assetFilmstrip(
					store,
					asset,
					parseFilmstripQuery(url.searchParams),
					{ signal: mediaSignal(request) }
				)
			),
	},
];
