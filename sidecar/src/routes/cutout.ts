import { z } from "zod";
import { cutoutRequestSchema } from "../../../shared/keying.ts";
import { cutoutAsset } from "../cutout.ts";
import type { StudioRoute } from "./registry.ts";

/** `POST /assets/:id/cutout`: static-background cutout derivative (W2-V4). */
export const routes: StudioRoute[] = [
	{
		scope: "asset",
		action: "cutout",
		method: "POST",
		operation: {
			id: "video_studio_cutout_media",
			description:
				"Create an app-owned transparent derivative of a static-camera video (derivation `cutout`) by keying every frame against a clean-plate frame of the empty shot with FFmpeg backgroundkey, in bounded ten-second chunks. Sources up to ten minutes, less at high resolution or frame rate (the transparent copy and its chunks must fit 10 GiB; 1080p30 allows about two minutes); the source stays unchanged. Output is ProRes 4444 with alpha (needs the prores_ks encoder); VP9 is not offered because exports would decode it without alpha. The browser preview gets a separate VP9 WebM copy with alpha (`derivation: proxy`) when FFmpeg has libvpx-vp9; exports read the ProRes master. `threshold` is the scene-change fraction that re-captures the background (keep it high when the subject fills much of the frame); `similarity` and `blend` tune the key. Swap a clip onto the result with swap-clip-media.",
			body: cutoutRequestSchema,
			// Input mode: defaulted tuning fields are optional for callers.
			bodyJsonSchema: z.toJSONSchema(cutoutRequestSchema, { io: "input" }),
		},
		handle: async ({ asset, json, mediaSignal, request, store }) => {
			const input = cutoutRequestSchema.parse(await request.json());
			return json(
				await cutoutAsset(store, asset, input, {
					signal: mediaSignal(request),
				}),
				201
			);
		},
	},
];
