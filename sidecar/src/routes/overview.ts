import { z } from "zod";
import {
	DEFAULT_OVERVIEW_COUNT,
	DEFAULT_OVERVIEW_HEIGHT,
	MAX_OVERVIEW_COUNT,
	MAX_OVERVIEW_HEIGHT,
	MIN_OVERVIEW_HEIGHT,
	overviewRequestSchema,
	renderOverview,
} from "../overview.ts";
import type { StudioRoute } from "./registry.ts";

const optionalNumber = (url: URL, name: string) => {
	const value = url.searchParams.get(name);
	return value === null ? undefined : z.coerce.number().parse(value);
};

const formatSchema = z.enum(["png", "json"]);

export const routes: StudioRoute[] = [
	{
		scope: "project",
		action: "overview",
		method: "GET",
		operation: {
			id: "video_studio_timeline_overview",
			description:
				"Render evenly spaced composited timeline frames and tile them into one PNG filmstrip (row by row). format=png (default) returns the image; format=json returns the base64 PNG with its layout and the sampled times.",
			query: [
				{
					name: "count",
					schema: {
						type: "integer",
						minimum: 1,
						maximum: MAX_OVERVIEW_COUNT,
						default: DEFAULT_OVERVIEW_COUNT,
					},
				},
				{
					name: "height",
					schema: {
						type: "integer",
						minimum: MIN_OVERVIEW_HEIGHT,
						maximum: MAX_OVERVIEW_HEIGHT,
						default: DEFAULT_OVERVIEW_HEIGHT,
					},
				},
				{
					name: "columns",
					schema: { type: "integer", minimum: 1, maximum: MAX_OVERVIEW_COUNT },
				},
				{
					name: "start",
					schema: { type: "number", minimum: 0, maximum: 7200 },
				},
				{ name: "end", schema: { type: "number", minimum: 0, maximum: 7200 } },
				{
					name: "format",
					schema: { type: "string", enum: ["png", "json"], default: "png" },
				},
			],
		},
		handle: async ({ id, json, mediaSignal, request, store, url }) => {
			const input = overviewRequestSchema.parse({
				columns: optionalNumber(url, "columns"),
				count: optionalNumber(url, "count"),
				end: optionalNumber(url, "end"),
				height: optionalNumber(url, "height"),
				start: optionalNumber(url, "start"),
			});
			const format = formatSchema.parse(
				url.searchParams.get("format") ?? "png"
			);
			const overview = await renderOverview(store, store.project(id), input, {
				signal: mediaSignal(request),
			});
			if (format === "json") {
				return json(overview);
			}
			return new Response(Buffer.from(overview.data, "base64"), {
				headers: {
					"cache-control": "no-store",
					"content-type": "image/png",
					"x-overview-columns": String(overview.columns),
					"x-overview-rows": String(overview.rows),
					"x-overview-times": overview.times.join(","),
				},
			});
		},
	},
];
