import { z } from "zod";
import {
	SHOT_DESCRIPTION_BATCH,
	shotDescriptionBatchSchema,
} from "../../../shared/shot-index.ts";
import {
	analyzeShots,
	beginShotIndexing,
	describeStoredShots,
	pruneShotIndexEntry,
	readShotIndex,
	searchStoredShots,
	shotIndexIsCurrent,
	shotKeyframes,
	shotSearchIndexes,
	updateShotIndexEntry,
} from "../shot-stats.ts";
import type { StudioRoute } from "./registry.ts";

export const analyzeShotsRequestSchema = z
	.object({ refresh: z.boolean().optional() })
	.strict();

export const beginShotIndexRequestSchema = z
	.object({
		spaceId: z.string().min(1).max(200),
		spaceName: z.string().min(1).max(200),
		rebuild: z.boolean().default(false),
	})
	.strict();

export const updateShotIndexRequestSchema = z
	.object({
		revision: z.number().int().nonnegative(),
		key: z.string().min(1).max(100),
		docId: z.string().min(1).max(200),
		ready: z.boolean(),
	})
	.strict();

export const pruneShotIndexRequestSchema = z
	.object({
		revision: z.number().int().nonnegative(),
		docId: z.string().min(1).max(200),
	})
	.strict();

export const shotSearchRequestSchema = z
	.object({
		q: z.string().trim().min(1).max(200),
		assetId: z.uuid().optional(),
		limit: z.coerce.number().int().min(1).max(50).default(20),
	})
	.strict();

export const shotKeyframesRequestSchema = z
	.object({
		offset: z.number().int().min(0).max(399).default(0),
		limit: z
			.number()
			.int()
			.min(1)
			.max(SHOT_DESCRIPTION_BATCH)
			.default(SHOT_DESCRIPTION_BATCH),
	})
	.strict();

export const shotDescriptionsRequestSchema = z
	.object({
		analysisCreatedAt: z.iso.datetime(),
		revision: z.number().int().nonnegative(),
		/** The vision model the editor used, recorded as provenance. */
		provider: z.string().trim().max(200).default(""),
		model: z.string().trim().max(200).default(""),
		shots: shotDescriptionBatchSchema.shape.shots.min(1),
	})
	.strict();

export const routes: StudioRoute[] = [
	{
		scope: "asset",
		action: "shots",
		method: "GET",
		operation: {
			id: "video_studio_get_shots",
			description:
				"Read the stored visual shot index of a video source: per scene-cut shot, dominant colors (k-means on 32x18 frames, with plain color names and pixel shares), brightness, saturation, motion energy (mean frame difference), edge density and search labels (`bright`/`dark`, `vivid`/`muted`, `close-up`/`wide`, `static`/`motion`, `short`/`long`, color names). `shots` is null before analysis; `current` is false once the source analysis was re-run. Labels are heuristic cues, not scene understanding.",
		},
		handle: ({ asset, json, store }) => {
			const shots = readShotIndex(store, asset.id);
			return json({
				shots,
				current: shots ? shotIndexIsCurrent(store, shots) : false,
			});
		},
	},
	{
		scope: "asset",
		action: "shots",
		method: "POST",
		operation: {
			id: "video_studio_analyze_shots",
			description:
				"Measure visual shot statistics for a video source with completed analysis, using its scene cuts as shot boundaries (up to 400 shots, frames sampled at up to 4 fps). Returns the stored index while it still matches the analysis unless `refresh` is true. Takes one media admission slot.",
			body: analyzeShotsRequestSchema,
		},
		handle: async ({
			asset,
			json,
			mediaSignal,
			optionalBody,
			request,
			store,
		}) => {
			const input = analyzeShotsRequestSchema.parse(
				await optionalBody(request)
			);
			return json(
				await analyzeShots(store, asset, {
					refresh: input.refresh ?? false,
					signal: mediaSignal(request),
				})
			);
		},
	},
	{
		scope: "asset",
		action: "shots",
		subaction: "index",
		method: "POST",
		operation: {
			id: "video_studio_begin_shot_index",
			description:
				"Start projecting a source's current shot index into a Space: one app-owned document per shot whose text lists labels and colors. Returns entries to create; documents of a previous projection move to `obsolete` for the client to delete. The Ryu host creates the documents; Space access settings apply.",
			body: beginShotIndexRequestSchema,
		},
		handle: async ({ asset, json, request, store }) => {
			const input = beginShotIndexRequestSchema.parse(await request.json());
			return json(beginShotIndexing(store, asset, input));
		},
	},
	{
		scope: "asset",
		action: "shots",
		subaction: "index",
		method: "PUT",
		operation: {
			id: "video_studio_update_shot_index",
			description:
				"Record the Spaces document id of one shot index entry and whether its body was written. Revision-checked; a stale revision answers 409.",
			body: updateShotIndexRequestSchema,
		},
		handle: async ({ asset, json, request, store }) => {
			const input = updateShotIndexRequestSchema.parse(await request.json());
			return json(updateShotIndexEntry(store, asset, input));
		},
	},
	{
		scope: "asset",
		action: "shots",
		subaction: "prune-index",
		method: "POST",
		operation: {
			id: "video_studio_prune_shot_index",
			description:
				"Forget an obsolete shot document after the client deleted it from its Space. Revision-checked.",
			body: pruneShotIndexRequestSchema,
		},
		handle: async ({ asset, json, request, store }) => {
			const input = pruneShotIndexRequestSchema.parse(await request.json());
			return json(pruneShotIndexEntry(store, asset, input));
		},
	},
	{
		scope: "root",
		path: "shot-indexes",
		method: "GET",
		operation: {
			id: "video_studio_list_shot_indexes",
			description:
				"List every shot-to-Space projection with its entries and whether it still matches the source's current shot analysis.",
		},
		handle: ({ json, store }) => json({ indexes: shotSearchIndexes(store) }),
	},
	{
		scope: "root",
		path: "shot-search",
		method: "GET",
		operation: {
			id: "video_studio_search_shots",
			description:
				'Find shots by visual description across analyzed sources, for example "dark blue motion" or "bright wide static". Query words map to shot labels (synonyms such as dim, moving, cyan and closeup are understood); every recognized label must match, a negated term ("not dark", "without blue") lands in `excluded` and must not match, phrases such as "low light" and "dimly lit" mean dark, and `ignored` lists words with no visual meaning. Results carry `assetId`, `start` and `end` source seconds ready to place as a source range, ranked by how strongly each label applies.',
			query: [
				{
					name: "q",
					required: true,
					schema: { type: "string", maxLength: 200 },
				},
				{ name: "assetId", schema: { type: "string", format: "uuid" } },
				{
					name: "limit",
					schema: { type: "integer", minimum: 1, maximum: 50 },
				},
			],
		},
		handle: ({ json, store, url }) => {
			const input = shotSearchRequestSchema.parse({
				q: url.searchParams.get("q") ?? "",
				assetId: url.searchParams.get("assetId") ?? undefined,
				limit: url.searchParams.get("limit") ?? undefined,
			});
			return json(
				searchStoredShots(store, input.q, {
					assetId: input.assetId,
					limit: input.limit,
				})
			);
		},
	},
	{
		scope: "asset",
		action: "shots",
		subaction: "keyframes",
		method: "POST",
		operation: {
			id: "video_studio_shot_keyframes",
			description:
				"Render keyframes for vision-model shot description (G76): the middle frame of each shot from `offset`, at most 6 per call, as `data:image/jpeg` URIs at most 384 px on the long side. Returns `{keyframes:[{index,start,end,frame,image}], total, revision, analysisCreatedAt}` for a current shot index. Nothing is sent to a model by this route. Takes one media admission slot.",
			body: shotKeyframesRequestSchema,
			bodyJsonSchema: z.toJSONSchema(shotKeyframesRequestSchema, {
				io: "input",
			}),
		},
		handle: async ({
			asset,
			json,
			mediaSignal,
			optionalBody,
			request,
			store,
		}) => {
			const input = shotKeyframesRequestSchema.parse(
				(await optionalBody(request)) ?? {}
			);
			return json(
				await shotKeyframes(store, asset, input, {
					signal: mediaSignal(request),
				})
			);
		},
	},
	{
		scope: "asset",
		action: "shots",
		subaction: "descriptions",
		method: "POST",
		operation: {
			id: "video_studio_describe_shots",
			description:
				"Store vision captions and tags on a current shot index: each entry names a shot `index`, a one-sentence `caption` and up to 12 `tags`. `analysisCreatedAt` and `revision` must match the index the keyframes came from (409 otherwise). `provider` and `model` record which vision model described them. Captioned shots become searchable by those words in GET /search and GET /shot-search; the measured labels still apply. Shots not named keep their description.",
			body: shotDescriptionsRequestSchema,
			bodyJsonSchema: z.toJSONSchema(shotDescriptionsRequestSchema, {
				io: "input",
			}),
		},
		handle: async ({ asset, json, request, store }) => {
			const input = shotDescriptionsRequestSchema.parse(await request.json());
			return json(describeStoredShots(store, asset, input));
		},
	},
];
