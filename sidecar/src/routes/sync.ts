import { syncRequestSchema } from "../../../shared/sync.ts";
import { ConflictError } from "../store.ts";
import { decodeSyncWindow, runSync } from "../sync-runner.ts";
import type { StudioRoute } from "./registry.ts";

export const routes: StudioRoute[] = [
	{
		scope: "project",
		action: "sync",
		method: "POST",
		operation: {
			id: "video_studio_sync_clips",
			description:
				"Align audio-bearing timeline clips to a reference using embedded source timecode, completed local audio envelopes, or a bounded manual offset. Audio modes refine the anchor from decoded audio and measure clock drift from a second window near the end of the overlap: drift within ±0.5% sets the target speed to 1+drift (driftCorrection, default true), larger drift is reported in warnings. Each match reports drift {status, driftPercent, speed, endErrorFrames, reason}. dryRun measures without saving. Requires the current project revision.",
			body: syncRequestSchema,
		},
		handle: async ({ id, json, mediaSignal, request, store }) => {
			const input = syncRequestSchema.parse(await request.json());
			const project = store.project(id);
			if (project.revision !== input.revision) {
				throw new ConflictError(
					"The project changed. Reload before syncing clips."
				);
			}
			const clipIds = new Set([input.referenceClipId, ...input.targetClipIds]);
			const sourceIds = new Set(
				project.segments
					.filter((clip) => clipIds.has(clip.id))
					.map((clip) => clip.assetId)
			);
			const projectAssetIds = new Set(
				project.segments.map((clip) => clip.assetId)
			);
			const assets = store
				.assets()
				.filter((asset) => projectAssetIds.has(asset.id));
			const analysesByAsset = new Map(
				[...sourceIds].map((assetId) => [assetId, store.analysis(assetId)])
			);
			const result = await runSync(
				project,
				assets,
				analysesByAsset,
				input,
				mediaSignal(request),
				{
					decodeWindow: (asset, start, duration, operation) =>
						decodeSyncWindow(store, asset, start, duration, operation),
				}
			);
			if (input.dryRun) {
				return json({
					dryRun: true,
					matches: result.matches,
					shiftedFrames: result.shiftedFrames,
					warnings: result.warnings ?? [],
				});
			}
			if (store.project(id).revision !== project.revision) {
				throw new ConflictError(
					"The project changed. Reload before syncing clips."
				);
			}
			return json({
				...result,
				project: store.save(result.project),
			});
		},
	},
];
