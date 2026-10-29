import {
	lottieFramesRequestSchema,
	lottieSessionRequestSchema,
} from "../../../shared/lottie.ts";
import { matteRequestSchema } from "../../../shared/matte.ts";
import { idSchema } from "../../../shared/project.ts";
import {
	abortLottieSession,
	appendLottieFrames,
	finishLottieSession,
} from "../lottie-encode.ts";
import { createMatte } from "../matte.ts";
import type { StudioRoute } from "./registry.ts";

/**
 * Color mattes and Lottie import (G60). Both create app-owned library
 * assets at the API root: a matte is a solid PNG image asset, and a Lottie
 * import uploads rendered PNG frames in ordered chunks and then encodes
 * them as a ProRes 4444 video with alpha.
 */
export const routes: StudioRoute[] = [
	{
		scope: "root",
		path: "matte",
		method: "POST",
		operation: {
			id: "video_studio_create_matte",
			description:
				'Create a solid color matte: a one-color PNG image asset (`derivation: "matte"`) of the given width and height in pixels. Like any still it is placed with a 5 second length and holds for any length it is trimmed to.',
			body: matteRequestSchema,
		},
		handle: async ({ json, mediaSignal, request, store }) =>
			json(
				await createMatte(
					store,
					matteRequestSchema.parse(await request.json()),
					{
						signal: mediaSignal(request),
					}
				),
				201
			),
	},
	{
		scope: "root",
		path: "lottie-frames",
		method: "POST",
		operation: {
			id: "video_studio_upload_lottie_frames",
			description:
				"Upload one ordered chunk (at most 50) of base64 PNG frames for a Lottie import. The first chunk has `index` 0, a new client-chosen `sessionId` and `meta` (name, fps, even width and height up to 1920, frameCount up to 600). Each later chunk must start at the next missing frame; anything else is a 409 conflict. Sessions idle for 10 minutes are discarded.",
			body: lottieFramesRequestSchema,
		},
		handle: async ({ json, request, store }) =>
			json(
				await appendLottieFrames(
					store,
					lottieFramesRequestSchema.parse(await request.json())
				)
			),
	},
	{
		scope: "root",
		path: "lottie-frames",
		method: "DELETE",
		operation: {
			id: "video_studio_abort_lottie_frames",
			description:
				"Abort a Lottie import session and delete its uploaded frames. Returns whether the session existed.",
			query: [
				{
					name: "sessionId",
					required: true,
					schema: { type: "string", format: "uuid" },
				},
			],
		},
		handle: async ({ json, store, url }) =>
			json({
				aborted: await abortLottieSession(
					store,
					idSchema.parse(url.searchParams.get("sessionId"))
				),
			}),
	},
	{
		scope: "root",
		path: "lottie-frames-finish",
		method: "POST",
		operation: {
			id: "video_studio_finish_lottie_frames",
			description:
				'Encode a complete Lottie frame session as a ProRes 4444 (`yuva444p10le`) video with alpha and save it as a library asset with `derivation: "lottie"`. Returns `{asset, preview?}`: `preview` is a VP9 WebM copy with alpha (`derivation: "proxy"`, `derivedFromAssetId` = the asset) for the browser preview, present when FFmpeg has libvpx-vp9. Timelines reference `asset`. The session is consumed. Shares the media operation budget.',
			body: lottieSessionRequestSchema,
		},
		handle: async ({ json, mediaSignal, request, store }) =>
			json(
				await finishLottieSession(
					store,
					lottieSessionRequestSchema.parse(await request.json()).sessionId,
					{ signal: mediaSignal(request) }
				),
				201
			),
	},
];
