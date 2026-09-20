import {
	type MediaAnalysis,
	parseSceneCuts,
	parseWaveform,
} from "../../shared/analysis.ts";
import type { Asset } from "../../shared/project.ts";
import { MEDIA_FORMATS, runMedia } from "./media.ts";
import type { StudioStore } from "./store.ts";

export class AnalysisQueue {
	private readonly active = new Map<string, AbortController>();
	constructor(private readonly store: StudioStore) {}
	start(asset: Asset): MediaAnalysis {
		const current = this.store.analysis(asset.id);
		if (this.active.has(asset.id) && current) {
			return current;
		}
		if (this.active.size) {
			throw new Error(
				"Another media analysis is running. Wait for it to finish."
			);
		}
		const result: MediaAnalysis = {
			assetId: asset.id,
			status: "running",
			createdAt: new Date().toISOString(),
			sceneCuts: [],
			waveform: [],
			duration: asset.duration,
		};
		const controller = new AbortController();
		this.active.set(asset.id, controller);
		this.store.putAnalysis(result);
		void this.analyze(asset, result, controller);
		return result;
	}
	private async analyze(
		asset: Asset,
		result: MediaAnalysis,
		controller: AbortController
	) {
		try {
			const input = [
				"-hide_banner",
				"-loglevel",
				"error",
				"-nostdin",
				"-protocol_whitelist",
				"file,pipe",
				"-format_whitelist",
				MEDIA_FORMATS,
				"-i",
				this.store.mediaPath(asset.id),
			];
			if (asset.kind === "video") {
				const output = await runMedia(
					[
						...input,
						"-an",
						"-vf",
						"select='gt(scene,0.35)',metadata=print:file=-",
						"-f",
						"null",
						"-",
					],
					{ signal: controller.signal }
				);
				result.sceneCuts = parseSceneCuts(output, asset.duration);
			}
			if (asset.hasAudio) {
				const output = await runMedia(
					[
						...input,
						"-vn",
						"-af",
						"aresample=48000,asetnsamples=n=4800,astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level:file=-",
						"-f",
						"null",
						"-",
					],
					{ signal: controller.signal }
				);
				result.waveform = parseWaveform(output, asset.duration);
			}
			if (controller.signal.aborted) {
				throw new Error("Analysis canceled.");
			}
			result.status = "completed";
			this.store.putAnalysis(result);
		} catch (error) {
			result.status = controller.signal.aborted ? "canceled" : "failed";
			result.error =
				error instanceof Error ? error.message : "Media analysis failed.";
			this.store.putAnalysis(result);
		} finally {
			this.active.delete(asset.id);
		}
	}
	cancel(id: string) {
		const controller = this.active.get(id);
		if (!controller) {
			throw new Error("This analysis is no longer running.");
		}
		controller.abort();
	}
	stop() {
		for (const controller of this.active.values()) {
			controller.abort();
		}
	}
}
