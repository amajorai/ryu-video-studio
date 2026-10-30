/**
 * Media library bulk and skim routes (W1-L1).
 *
 * - `POST /assets-delete-many {ids}` deletes every listed asset that no saved
 *   project uses and reports the rest (`in-use` with the projects to edit, or
 *   `not-found`). Unlike `/assets/:id/organize` with `delete`, it never
 *   removes timeline clips: bulk cleanup must not silently change edits.
 * - `GET /assets/:id/skim-frame?time&height` returns one cached JPEG frame
 *   for library hover-skim and source in/out marking.
 */
import { rm } from "node:fs/promises";
import { join } from "node:path";
import {
	type DeleteManyAssetsResponse,
	deleteManyAssetsRequestSchema,
	MAX_BULK_ASSET_IDS,
	planAssetDeletion,
} from "../../../shared/asset-usage.ts";
import {
	assetSkimFrame,
	DEFAULT_SKIM_HEIGHT,
	MAX_SKIM_HEIGHT,
	MIN_SKIM_HEIGHT,
	parseSkimFrameQuery,
	removeSkimFrames,
} from "../skim-frames.ts";
import type { StudioStore } from "../store.ts";
import type { StudioRoute } from "./registry.ts";

/**
 * Delete the unused assets of a request. Planning and the row deletes run
 * synchronously, so no edit can add a reference between the usage check
 * and the delete; files are removed afterwards.
 */
export async function deleteManyAssets(
	store: StudioStore,
	ids: readonly string[]
): Promise<DeleteManyAssetsResponse> {
	const plan = planAssetDeletion(store.assets(), store.projects(), ids);
	const deleted: string[] = [];
	for (const id of plan.deletable) {
		const result = store.organizeAsset(id, { delete: true });
		if (result.deleted) {
			deleted.push(id);
		}
	}
	await Promise.all(
		deleted.flatMap((id) => [
			rm(store.mediaPath(id), { force: true }),
			rm(join(store.directory, "media", `${id}.jpg`), { force: true }),
			removeSkimFrames(store, id),
		])
	);
	return { deleted, refused: plan.refused };
}

export const routes: StudioRoute[] = [
	{
		scope: "root",
		path: "assets-delete-many",
		method: "POST",
		operation: {
			id: "video_studio_delete_media_many",
			description: `Delete up to ${MAX_BULK_ASSET_IDS} media assets in one request. Assets that any saved project still uses (clips, multicam, scenes, captions, references, backgrounds and so on) are refused, never removed from timelines: the response lists them under \`refused\` with reason \`in-use\` and the projects that use them, and unknown ids with reason \`not-found\`. \`deleted\` lists the removed ids. Save pending edits first so their references count.`,
			body: deleteManyAssetsRequestSchema,
		},
		handle: async ({ json, request, store }) => {
			const input = deleteManyAssetsRequestSchema.parse(await request.json());
			return json(await deleteManyAssets(store, input.ids));
		},
	},
	{
		scope: "asset",
		action: "skim-frame",
		method: "GET",
		operation: {
			id: "video_studio_media_skim_frame",
			description:
				"Read-only. Return one base64 JPEG frame of a video at source time `time` (clamped into the media), or of a still image, scaled to `height` pixels. Frames are cached on disk per asset. Used by library hover-skim and source in/out marking.",
			query: [
				{
					name: "time",
					required: true,
					schema: { type: "number", minimum: 0, maximum: 7200 },
				},
				{
					name: "height",
					schema: {
						type: "integer",
						minimum: MIN_SKIM_HEIGHT,
						maximum: MAX_SKIM_HEIGHT,
						default: DEFAULT_SKIM_HEIGHT,
					},
				},
			],
		},
		handle: async ({ asset, json, mediaSignal, request, store, url }) =>
			json(
				await assetSkimFrame(
					store,
					asset,
					parseSkimFrameQuery(url.searchParams),
					{
						signal: mediaSignal(request),
					}
				)
			),
	},
];
