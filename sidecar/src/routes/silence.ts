import { z } from "zod";
import { silenceRanges } from "../../../shared/analysis.ts";
import {
	resolveVadParams,
	vadParamsSchema,
	vadSilence,
} from "../../../shared/vad.ts";
import { vadRefusal, voiceActivityFeatures } from "../vad.ts";
import type { StudioQueryParameter, StudioRoute } from "./registry.ts";

const VAD_KEYS = ["threshold", "minPause", "padding", "minSpeech"] as const;

const silenceQuerySchema = z
	.object({
		method: z.enum(["vad", "rms"]).optional(),
		minPause: z.coerce
			.number()
			.pipe(vadParamsSchema.shape.minPause.unwrap())
			.optional(),
		minSpeech: z.coerce
			.number()
			.pipe(vadParamsSchema.shape.minSpeech.unwrap())
			.optional(),
		padding: z.coerce
			.number()
			.pipe(vadParamsSchema.shape.padding.unwrap())
			.optional(),
		threshold: z.coerce
			.number()
			.pipe(vadParamsSchema.shape.threshold.unwrap())
			.optional(),
	})
	.strict();

/** Parse the silence query. Without `method`, any VAD parameter selects VAD. */
export function parseSilenceQuery(searchParams: URLSearchParams) {
	const raw: Record<string, string> = {};
	for (const [key, value] of searchParams) {
		raw[key] = value;
	}
	const query = silenceQuerySchema.parse(raw);
	const method =
		query.method ??
		(VAD_KEYS.some((key) => query[key] !== undefined) ? "vad" : "rms");
	return {
		method,
		params: resolveVadParams({
			...(query.minPause === undefined ? {} : { minPause: query.minPause }),
			...(query.minSpeech === undefined ? {} : { minSpeech: query.minSpeech }),
			...(query.padding === undefined ? {} : { padding: query.padding }),
			...(query.threshold === undefined ? {} : { threshold: query.threshold }),
		}),
	};
}

const numberParameter = (
	name: string,
	minimum: number,
	maximum: number
): StudioQueryParameter => ({
	name,
	schema: { type: "number", minimum, maximum },
});

export const routes: StudioRoute[] = [
	{
		scope: "asset",
		action: "silence",
		method: "GET",
		operation: {
			id: "video_studio_detect_silence",
			description:
				"Detect non-speech source intervals. method=vad (selected automatically when any of threshold, minPause, padding, or minSpeech is given) runs voice-activity detection on 16 kHz band-limited audio: threshold is dB above the adaptive noise floor, minPause the shortest reported pause, padding the seconds kept beside speech, minSpeech the shortest speech run. It returns {assetId, method, noiseFloorDb, params, ranges}. method=rms (the default without parameters) reads a completed RMS envelope and returns {assetId, ranges}. Ranges are [start, end] source seconds. Review ranges before applying a ripple edit.",
			query: [
				{ name: "method", schema: { type: "string", enum: ["vad", "rms"] } },
				numberParameter("threshold", 1, 40),
				numberParameter("minPause", 0.05, 10),
				numberParameter("padding", 0, 0.5),
				numberParameter("minSpeech", 0, 2),
			],
		},
		handle: async ({ asset, json, mediaSignal, request, store, url }) => {
			const { method, params } = parseSilenceQuery(url.searchParams);
			if (method === "vad") {
				const refusal = vadRefusal(asset);
				if (refusal) {
					throw new Error(refusal);
				}
				const features = await voiceActivityFeatures(store, asset, {
					signal: mediaSignal(request),
				});
				return json({
					assetId: asset.id,
					method,
					params,
					...vadSilence(features, params),
				});
			}
			const analysis = store.analysis(asset.id);
			if (analysis?.status !== "completed") {
				throw new Error(
					"Complete source analysis before detecting silent ranges."
				);
			}
			return json({
				assetId: asset.id,
				ranges: silenceRanges(analysis.waveform, analysis.duration),
			});
		},
	},
];
