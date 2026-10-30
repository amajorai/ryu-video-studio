import { z } from "zod";
import {
	DEFAULT_SCOPE_COLUMNS,
	MAX_SCOPE_COLUMNS,
	scopeColumnsSchema,
} from "../../../shared/color-scopes.ts";
import {
	inspectColorAsset,
	inspectColorAssetDetail,
	inspectTimelineScopes,
} from "../color-scopes.ts";
import type { StudioQueryParameter, StudioRoute } from "./registry.ts";

const timeSchema = z.coerce.number().finite().min(0).max(7200);
const columnsSchema = z.coerce.number().pipe(scopeColumnsSchema);
const detailSchema = z.enum(["summary", "full"]);

const timeQuery: StudioQueryParameter = {
	name: "time",
	schema: { type: "number", minimum: 0, maximum: 7200 },
};
const columnsQuery: StudioQueryParameter = {
	name: "columns",
	schema: {
		type: "integer",
		minimum: 1,
		maximum: MAX_SCOPE_COLUMNS,
		default: DEFAULT_SCOPE_COLUMNS,
	},
};

function columnsFrom(url: URL): number {
	return columnsSchema.parse(
		url.searchParams.get("columns") ?? DEFAULT_SCOPE_COLUMNS
	);
}

export const routes: StudioRoute[] = [
	{
		scope: "asset",
		action: "scopes",
		method: "GET",
		operation: {
			id: "video_studio_inspect_color",
			description:
				"Measure luma, chroma, saturation, hue, and clipping for one sampled image or video frame. With detail=full, also return a 256-bin luma histogram, an RGB parade (per column, 64 value bins per channel), and a 64x64 BT.709 vectorscope as pixel counts.",
			query: [
				timeQuery,
				{
					name: "detail",
					schema: {
						type: "string",
						enum: ["summary", "full"],
						default: "summary",
					},
				},
				columnsQuery,
			],
		},
		handle: async ({ asset, json, mediaSignal, request, store, url }) => {
			const sampledAt = timeSchema.parse(url.searchParams.get("time") ?? 0);
			const detail = detailSchema.parse(
				url.searchParams.get("detail") ?? "summary"
			);
			const signal = mediaSignal(request);
			if (detail === "full") {
				return json(
					await inspectColorAssetDetail(
						store,
						asset,
						sampledAt,
						columnsFrom(url),
						{ signal }
					)
				);
			}
			return json(await inspectColorAsset(store, asset, sampledAt, { signal }));
		},
	},
	{
		scope: "project",
		action: "scopes",
		method: "GET",
		operation: {
			id: "video_studio_timeline_scopes",
			description:
				"Measure the composited timeline frame at a time (the frame inspect-frame returns): a 256-bin luma histogram, an RGB parade (per column, 64 value bins per channel), a 64x64 BT.709 vectorscope (Cb right, Cr up), luma range, and the clipped black and white fractions.",
			query: [timeQuery, columnsQuery],
		},
		handle: async ({ id, json, mediaSignal, request, store, url }) => {
			const time = timeSchema.parse(url.searchParams.get("time") ?? 0);
			const columns = columnsFrom(url);
			return json(
				await inspectTimelineScopes(store, store.project(id), time, columns, {
					signal: mediaSignal(request),
				})
			);
		},
	},
];
