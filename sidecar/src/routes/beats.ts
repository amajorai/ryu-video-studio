import { assetBeats } from "../beats.ts";
import type { StudioRoute } from "./registry.ts";

export const BEAT_SOURCE_HEADER = "x-video-studio-beat-source";

/** A source second from the query string; absent or empty means undefined. */
function sourceSecond(url: URL, name: string): number | undefined {
	const raw = url.searchParams.get(name);
	if (raw === null || raw.trim() === "") {
		return;
	}
	const value = Number(raw);
	if (!Number.isFinite(value) || value < 0 || value > 7200) {
		throw new Error(`${name} must be a source time from 0 to 7200 seconds.`);
	}
	return value;
}

export const routes: StudioRoute[] = [
	{
		scope: "asset",
		action: "beats",
		method: "GET",
		operation: {
			id: "video_studio_estimate_beats",
			description:
				"Detect tempo (bpm), beats and bar downbeats in a source with completed analysis, using a spectral-flux onset envelope, tempo autocorrelation and dynamic-programming beat tracking over a window of up to 10 minutes (the first 10 minutes by default). Pass `from`/`to` (source seconds) to detect over the span a clip plays: any span up to 10 minutes is analyzed (`analyzedFrom` reports where the window starts), and a longer span gets the estimate. The result is cached with the analysis and reused while it covers the requested span; `refresh=1` recomputes it. `times` equals `beats`. When detection cannot run or finds no steady pulse, only `times` is returned, estimated from the RMS envelope, and the `x-video-studio-beat-source` header reads `estimate`. Results are cues for review, not guaranteed tempo or beat truth.",
			query: [
				{ name: "from", schema: { type: "number", minimum: 0, maximum: 7200 } },
				{ name: "to", schema: { type: "number", minimum: 0, maximum: 7200 } },
				{
					name: "refresh",
					schema: { type: "string", enum: ["0", "1"] },
				},
			],
		},
		handle: async ({ asset, json, mediaSignal, request, store, url }) => {
			const from = sourceSecond(url, "from");
			const to = sourceSecond(url, "to");
			if (from !== undefined && to !== undefined && to < from) {
				throw new Error("to must not be before from.");
			}
			const result = await assetBeats(store, asset, {
				from,
				to,
				refresh: url.searchParams.get("refresh") === "1",
				signal: mediaSignal(request),
			});
			const response = json(result.body);
			response.headers.set(BEAT_SOURCE_HEADER, result.source);
			if (result.fallbackReason) {
				response.headers.set(
					`${BEAT_SOURCE_HEADER}-reason`,
					result.fallbackReason
				);
			}
			return response;
		},
	},
];
