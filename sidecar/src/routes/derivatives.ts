import {
	applySmoothSlowMotion,
	interpolateRequestSchema,
	planSmoothSlowMotion,
	smoothSlowMotionRequestSchema,
	stabilizeRequestSchema,
} from "../../../shared/derivatives.ts";
import { interpolateAsset } from "../interpolate.ts";
import { stabilizeAsset } from "../stabilize.ts";
import type { StudioRoute } from "./registry.ts";

const STALE_SMOOTH =
	"The project changed. Reload before rendering smooth slow motion.";

export const routes: StudioRoute[] = [
	{
		scope: "asset",
		action: "stabilize",
		method: "POST",
		operation: {
			id: "video_studio_stabilize_media",
			description:
				'Create (or reuse) a stabilized app-owned derivative of a video (`derivation: "stabilize"`, up to 10 minutes). `level` low, medium or high sets the camera-path smoothing (10, 20 or 30 frames) and the zoom margin (4, 6 or 8% per edge). Uses libvidstab\'s two passes when FFmpeg has them, else a built-in two-pass translation tracker. The source is unchanged; swap a clip onto the result with `swap-clip-media`. Returns `{asset, created, method}`.',
			body: stabilizeRequestSchema,
		},
		handle: async ({
			asset,
			json,
			mediaSignal,
			optionalBody,
			request,
			store,
		}) => {
			const input = stabilizeRequestSchema.parse(await optionalBody(request));
			const result = await stabilizeAsset(store, asset, input, {
				signal: mediaSignal(request),
			});
			return json(result, result.created ? 201 : 200);
		},
	},
	{
		scope: "asset",
		action: "interpolate",
		method: "POST",
		operation: {
			id: "video_studio_interpolate_media",
			description:
				'Create (or reuse) a derivative of a video resampled to `fps` (1-240) with synthesized in-between frames (`derivation: "interpolate"`). `mode` optical-flow uses motion-compensated minterpolate when FFmpeg has it and otherwise falls back to blend (framerate frame blending); the default is optical flow when available. Duration and source time are preserved. Returns `{asset, created, method, mode}`.',
			body: interpolateRequestSchema,
		},
		handle: async ({ asset, json, mediaSignal, request, store }) => {
			const input = interpolateRequestSchema.parse(await request.json());
			const result = await interpolateAsset(store, asset, input, {
				signal: mediaSignal(request),
			});
			return json(result, result.created ? 201 : 200);
		},
	},
	{
		scope: "project",
		action: "smooth-slow-motion",
		method: "POST",
		operation: {
			id: "video_studio_smooth_slow_motion",
			description:
				"Render smooth slow motion for a video clip slower than 1x: interpolate its original media to project fps / speed (capped at 240) using `mode` or the clip's `frameInterpolation` (blend or optical-flow), then swap the clip onto that derivative. Speed, sourceIn and sourceOut are preserved because the derivative keeps the source timebase. Revision-checked.",
			body: smoothSlowMotionRequestSchema,
		},
		handle: async ({
			currentProject,
			id,
			mediaSignal,
			request,
			revisionedProjectEdit,
			store,
		}) => {
			const input = smoothSlowMotionRequestSchema.parse(await request.json());
			const project = currentProject(id, input.revision, STALE_SMOOTH);
			const plan = planSmoothSlowMotion(project, store.assets(), input);
			const result = await interpolateAsset(
				store,
				plan.source,
				{ fps: plan.fps, mode: plan.mode },
				{ signal: mediaSignal(request) }
			);
			return revisionedProjectEdit(
				id,
				input.revision,
				STALE_SMOOTH,
				(current, assets) =>
					applySmoothSlowMotion(current, assets, {
						assetId: result.asset.id,
						clipId: input.clipId,
						mode: result.mode,
					})
			);
		},
	},
];
