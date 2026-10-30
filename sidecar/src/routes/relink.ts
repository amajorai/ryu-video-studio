import {
	MAX_RELINK_BATCH,
	RELINK_DURATION_TOLERANCE_SECONDS,
	relinkBatchRequestSchema,
	relinkRequestSchema,
} from "../../../shared/relink.ts";
import { offlineAssetReports, relinkAsset, relinkBatch } from "../relink.ts";
import type { StudioRoute } from "./registry.ts";

const sourceDescription = `The replacement is a library asset, normally a fresh upload (POST /uploads, then /uploads/{id}/finish). It must be the same kind (video, audio, image), last within ${RELINK_DURATION_TOLERANCE_SECONDS} s of the original for video and audio, and be unused by every project. Its media moves onto the offline asset, which keeps its id, so clips, transcripts and analyses stay attached; the replacement's own library entry is then removed. The offline asset's old preview proxies are deleted (removedProxyAssetIds) and the replacement's proxies become its proxies (proxyAssets). Preview proxies and nested sequences are never offline media and cannot be relinked.`;

export const routes: StudioRoute[] = [
	{
		scope: "root",
		path: "offline-assets",
		method: "GET",
		operation: {
			id: "video_studio_list_offline_media",
			description:
				"List library media (not preview proxies or nested sequences) whose stored file is missing, empty, not a file, or unreadable, with the projects and clip counts that use each. Pass `probe=1` to also run FFprobe on present files and report ones that no longer decode (slower). Renders that read offline media are refused until it is relinked.",
			query: [
				{
					name: "probe",
					schema: { type: "string", enum: ["0", "1"] },
				},
			],
		},
		handle: async ({ json, mediaSignal, request, store, url }) =>
			json({
				offline: await offlineAssetReports(store, {
					probe: url.searchParams.get("probe") === "1",
					signal: mediaSignal(request),
				}),
			}),
	},
	{
		scope: "asset",
		action: "relink",
		method: "POST",
		operation: {
			id: "video_studio_relink_media",
			description: `Relink one offline media asset to a replacement file. ${sourceDescription} With dryRun the replacement is validated and the resulting asset is returned without changes. A target whose file is present but no longer decodes (FFprobe fails) counts as offline. Returns {asset, dryRun, proxyAssets, removedAssetId, removedProxyAssetIds, warnings}.`,
			body: relinkRequestSchema,
		},
		handle: async ({ id, json, request, store }) =>
			json(
				await relinkAsset(
					store,
					id,
					relinkRequestSchema.parse(await request.json())
				)
			),
	},
	{
		scope: "root",
		path: "relink",
		method: "POST",
		operation: {
			id: "video_studio_relink_media_batch",
			description: `Relink offline media in one batch from up to ${MAX_RELINK_BATCH} uploaded replacements. Each offline asset is matched to a replacement with the same file name (ignoring extension, case and copy suffixes such as " (2)") and the closest duration; every replacement is used once. The candidates are \`targetAssetIds\` when given (pass the ids of a probed \`GET /offline-assets?probe=1\` report to include damaged files), otherwise every asset whose file is missing or unreadable. ${sourceDescription} Returns the matches, the relinked assets, per-pair failures, the offline assets left unmatched with a reason, and the replacements nothing used (left in the library). With dryRun nothing changes.`,
			body: relinkBatchRequestSchema,
		},
		handle: async ({ json, request, store }) =>
			json(
				await relinkBatch(
					store,
					relinkBatchRequestSchema.parse(await request.json())
				)
			),
	},
];
