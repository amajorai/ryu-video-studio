import { z } from "zod";
import { aiMatteRequestSchema } from "../../../shared/ai-matte.ts";
import { aiMatteAsset } from "../ai-matte.ts";
import type { StudioRoute } from "./registry.ts";

/** `POST /assets/:id/ai-matte`: apply a model's subject matte (G46). */
export const routes: StudioRoute[] = [
	{
		scope: "asset",
		action: "ai-matte",
		method: "POST",
		operation: {
			id: "video_studio_ai_matte_media",
			description:
				'Apply a subject matte returned by a cloud matting model to library media with FFmpeg alphamerge, creating a transparent derivative (`derivation: "ai-matte"`). `matteAssetId` names the matte: a still for an image source, a video for a video source. The matte is read from its alpha channel when it has one (a cutout PNG or video with transparency), otherwise as a luma matte (white keeps, black removes); `invert` keeps the background instead. For video, the derivative covers `start` to `end` source seconds (default: the matte\'s length from `start`) and is ProRes 4444 with alpha (needs prores_ks), so the clip\'s source in point moves to 0 when swapped onto it. A matted clip also gets a VP9 WebM copy with alpha for the browser preview (`derivation: "proxy"`, `derivedFromAssetId` = the derivative) when FFmpeg has libvpx-vp9; exports read the ProRes master. Stills become PNG with alpha. The source and matte are unchanged; clip masks still apply on top. Takes one media admission slot.',
			body: aiMatteRequestSchema,
			bodyJsonSchema: z.toJSONSchema(aiMatteRequestSchema, { io: "input" }),
		},
		handle: async ({ asset, json, mediaSignal, request, store }) =>
			json(
				await aiMatteAsset(store, asset, await request.json(), {
					signal: mediaSignal(request),
				}),
				201
			),
	},
];
