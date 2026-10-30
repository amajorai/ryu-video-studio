import { assetSchema } from "../../../shared/project.ts";
import { hostGenerationServices } from "../ai/media-bridge.ts";
import { request, studioResponseSchema } from "../bridge.ts";
import type { EditorRuntime } from "../editor/runtime.ts";
import {
	type ScriptPipelineServices,
	searchStockVisuals,
	transcribeNarration,
} from "./script-to-video-pipeline.ts";

/** Host- and sidecar-backed pipeline services for the open editor. */
export function hostServices(runtime: EditorRuntime): ScriptPipelineServices {
	const services: ScriptPipelineServices = {
		generation: hostGenerationServices(() => undefined),
		importStock: async (result) =>
			assetSchema.parse(
				await request(studioResponseSchema, "/stock", "POST", {
					identifier: result.identifier,
					provider: result.provider,
				})
			),
		onAsset: (asset) =>
			runtime.setAssets((current) =>
				current.some((item) => item.id === asset.id)
					? current
					: [...current, asset]
			),
		searchStock: searchStockVisuals,
	};
	const complete = window.ryu?.model?.complete;
	if (complete) {
		services.complete = (input) => complete(input);
	}
	if (window.ryu?.media?.transcribe) {
		services.transcribe = transcribeNarration;
	}
	return services;
}
