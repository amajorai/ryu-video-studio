import { upscaleRequestSchema } from "../../../shared/upscale.ts";
import { upscaleAsset } from "../upscale.ts";
import type { StudioRoute } from "./registry.ts";

export const routes: StudioRoute[] = [
	{
		scope: "asset",
		action: "upscale",
		method: "POST",
		operation: {
			id: "video_studio_upscale_media",
			description:
				'Create a new app-owned image or video derivative with a bounded local Lanczos upscale. The source remains unchanged; dimensions are capped at 3840 pixels on the long edge. With `enhance: true` the resize is wrapped in a denoise (hqdn3d, or nlmeans for stills) and a CAS/unsharp sharpen, the cap rises to the 8192-pixel canvas bound, and the asset is tagged `derivation: "enhance"`; enhanced video is limited to 10 minutes. Output sizes follow the displayed (autorotated) frame, and storage is admitted against the media quota before rendering. This is a classical filter chain, not ML super-resolution.',
			body: upscaleRequestSchema,
			bodyJsonSchema: {
				type: "object",
				properties: {
					factor: { type: "integer", enum: [2, 4], default: 2 },
					enhance: { type: "boolean" },
					name: { type: "string", minLength: 1, maxLength: 200 },
				},
			},
		},
		handle: async ({ asset, json, mediaSignal, request, store }) => {
			const input = upscaleRequestSchema.parse(await request.json());
			return json(
				await upscaleAsset(store, asset, input, {
					signal: mediaSignal(request),
				}),
				201
			);
		},
	},
];
