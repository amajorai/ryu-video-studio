import { z } from "zod";
import {
	applyGapFill,
	gapFillBoundaryFrames,
	gapFillNeighbors,
	gapFillRequestSchema,
	motionBridgeSeconds,
	motionGapRefusal,
	stampGapFillAsset,
} from "../../../shared/gap-fill.ts";
import { idSchema } from "../../../shared/project.ts";
import { prepareGenerationInput } from "../generation-inputs.ts";
import { acquireMediaOperation } from "../media-operation.ts";
import type { StudioRoute } from "./registry.ts";

export const gapFillFramesRequestSchema = z
	.object({
		afterClipId: idSchema,
		revision: z.number().int().nonnegative(),
	})
	.strict();

export const routes: StudioRoute[] = [
	{
		scope: "project",
		action: "gap-fill",
		method: "POST",
		operation: {
			id: "video_studio_gap_fill",
			description:
				"AI transition gap fill. With a still image asset (usually one generated from the outgoing clip's last frame and the incoming clip's first frame) between clip afterClipId and the next picture clip on its track. With a gap the still fills it; at a cut it sits over the cut. By default each side overlaps its neighbour by up to 0.5 s (a 1 s bridge at a cut); `duration` sets the still's total length, centred on the gap or cut. The still dissolves in over the outgoing clip, the incoming clip dissolves in over the still (`transitionIn: dissolve`, length `transitionDuration` clamped to the overlap), and the still gets a Ken Burns push from scale 1 to `zoom` (default 1.1). No other clip moves. With a video asset (Generate motion: a clip animated from the exact boundary frames) the clip fills the gap exactly with hard cuts, trimmed to the gap length, or slowed when it is shorter; a plain cut, a gap under two frames, or a clip too short to fill the gap at 10% speed is refused. Generated media is tagged `derivation: gap-fill`. Returns `{project, clipId}`. Requires the current project revision.",
			body: gapFillRequestSchema,
		},
		handle: async ({ currentProject, id, json, request, store }) => {
			const input = gapFillRequestSchema.parse(await request.json());
			const project = currentProject(
				id,
				input.revision,
				"The project changed. Reload before filling the gap."
			);
			const assets = store.assets();
			const result = applyGapFill(project, assets, input);
			const saved = store.save(result.project);
			const still = assets.find((asset) => asset.id === input.assetId);
			if (still) {
				const stamped = stampGapFillAsset(still);
				if (stamped !== still) {
					store.upsertAsset(stamped);
				}
			}
			return json({ clipId: result.clipId, project: saved });
		},
	},
	{
		scope: "project",
		action: "gap-fill-frames",
		method: "POST",
		operation: {
			id: "video_studio_gap_fill_frames",
			description:
				"Extract the exact boundary frames for a Generate motion gap fill as PNG: the last source frame clip afterClipId shows (the frame before its sourceOut) and the first source frame the next picture clip on its track shows (the frame at its sourceIn); stills contribute their only frame. Returns `{previous, next, gap, motionSeconds}` where each side is `{assetId, frame, sourceTime, kind, input}` and `input` is a prepared generation input to read with GET /generation-inputs/{id}/data. A cut, a gap shorter than two frames, or a gap wider than 100 s (a 10 s clip slowed to 10%) is refused (use the still bridge). Revision-checked; does not change the project.",
			body: gapFillFramesRequestSchema,
		},
		handle: async ({
			currentProject,
			id,
			json,
			mediaSignal,
			request,
			store,
		}) => {
			const input = gapFillFramesRequestSchema.parse(await request.json());
			const project = currentProject(
				id,
				input.revision,
				"The project changed. Reload before generating motion."
			);
			const assets = store.assets();
			const neighbors = gapFillNeighbors(project, assets, input.afterClipId);
			const refusal = motionGapRefusal(neighbors.gap, project.fps);
			if (refusal) {
				throw new Error(refusal);
			}
			const frames = gapFillBoundaryFrames(neighbors, assets);
			const operation = acquireMediaOperation(60_000, mediaSignal(request));
			try {
				const extract = async (side: typeof frames.previous) => {
					const asset = assets.find((item) => item.id === side.assetId);
					if (!asset) {
						throw new Error("A neighbouring clip's media is missing.");
					}
					return {
						...side,
						input: await prepareGenerationInput(
							store,
							asset,
							{ format: "png", frame: side.frame, kind: "frame" },
							{ operation }
						),
					};
				};
				const previous = await extract(frames.previous);
				const next = await extract(frames.next);
				return json({
					gap: neighbors.gap,
					motionSeconds: motionBridgeSeconds(neighbors.gap),
					next,
					previous,
				});
			} finally {
				operation.release();
			}
		},
	},
];
