import {
	listStickers,
	STICKER_LIST_LIMIT,
	STICKER_SOURCE_ORDER,
	STICKER_SOURCES,
	stickerListQuerySchema,
} from "../../../shared/stickers/catalog.ts";
import {
	STICKER_ANIMATION_LABELS,
	STICKER_ANIMATION_PRESETS,
	STICKER_CLIP_SECONDS,
	stickerPlacementRequestSchema,
} from "../../../shared/stickers/place.ts";
import { addBundledSticker } from "../stickers.ts";
import type { StudioRoute } from "./registry.ts";

/** Bundled sticker library for agents: search it, then place a sticker. */
export const routes: StudioRoute[] = [
	{
		scope: "root",
		path: "stickers",
		method: "GET",
		operation: {
			id: "video_studio_list_stickers",
			description:
				"Search the bundled, license-clean sticker library (Twemoji emoji, flag-icons country flags and Ryu's original shapes) by name or keyword. Every query word must match a name or keyword word or prefix; whole-name matches rank first. Returns `stickers` (id, name, category, keywords, aspect, source, attribution and license), the match `total`, the animation `presets` with labels, and each source's credit. Place one with POST /projects/{id}/stickers.",
			query: [
				{ name: "query", schema: { type: "string", maxLength: 200 } },
				{
					name: "category",
					schema: {
						type: "string",
						enum: ["all", "emoji", "flags", "shapes"],
						default: "all",
					},
				},
				{
					name: "limit",
					schema: {
						type: "integer",
						minimum: 1,
						maximum: STICKER_LIST_LIMIT,
						default: 50,
					},
				},
			],
		},
		handle: ({ json, url }) => {
			const input = stickerListQuerySchema.parse({
				category: url.searchParams.get("category") ?? undefined,
				limit: url.searchParams.get("limit") ?? undefined,
				query: url.searchParams.get("query") ?? undefined,
			});
			return json({
				...listStickers(input),
				presets: STICKER_ANIMATION_PRESETS.map((id) => ({
					id,
					label: STICKER_ANIMATION_LABELS[id],
				})),
				sources: STICKER_SOURCE_ORDER.map((id) => ({
					attribution: STICKER_SOURCES[id].attribution,
					id,
					licenseName: STICKER_SOURCES[id].licenseName,
					licenseUrl: STICKER_SOURCES[id].licenseUrl,
				})),
			});
		},
	},
	{
		scope: "project",
		action: "stickers",
		method: "POST",
		operation: {
			id: "video_studio_add_sticker",
			description: `Place a bundled sticker (an id from GET /stickers) as an image clip at project \`time\` (default 0) for \`duration\` seconds (default ${STICKER_CLIP_SECONDS}), at 35% scale on the lowest free unlocked track above every visual clip in that span, with an optional animation \`preset\` (${STICKER_ANIMATION_PRESETS.join(", ")}). The first use rasterizes the SVG to a 1024 px transparent PNG with FFmpeg and imports it into the library folder "Stickers" with its bundled license origin and \`derivation: sticker\`, so the project credits list it; later uses reuse that asset. Returns the saved \`project\`, the \`asset\`, the new \`segmentId\` and \`track\`, and \`reused\`. Requires the current project revision; takes one media admission slot when rasterizing.`,
			body: stickerPlacementRequestSchema,
		},
		handle: async ({ id, json, mediaSignal, request, store }) =>
			json(
				await addBundledSticker(store, id, await request.json(), {
					signal: mediaSignal(request),
				}),
				201
			),
	},
];
