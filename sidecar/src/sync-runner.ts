import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import type { MediaAnalysis } from "../../shared/analysis.ts";
import type { Asset, Project } from "../../shared/project.ts";
import {
	coarseStepSeconds,
	DRIFT_DECODE_RATE,
	DRIFT_ENVELOPE_RATE,
	pcmEnvelope,
	refineSyncMatch,
	type SyncRefinement,
	type SyncRequest,
	type SyncResult,
	syncClips,
} from "../../shared/sync.ts";
import { MEDIA_FORMATS, runMedia } from "./media.ts";
import { type MediaOperation, withMediaOperation } from "./media-operation.ts";
import type { StudioStore } from "./store.ts";

export interface SyncWorkerInput {
	analyses: [string, MediaAnalysis | null][];
	assets: Asset[];
	input: SyncRequest;
	project: Project;
}
export type SyncWorkerResult = { result: SyncResult } | { error: string };
type SyncWorker = Pick<
	Worker,
	"addEventListener" | "removeEventListener" | "postMessage" | "terminate"
>;
/** Decode `duration` seconds of an asset's audio from `start` to mono PCM at `DRIFT_DECODE_RATE`. */
export type SyncWindowDecoder = (
	asset: Asset,
	start: number,
	duration: number,
	operation: MediaOperation
) => Promise<Float32Array>;

interface SyncWorkerDependencies {
	createWorker?: (moduleUrl: string) => SyncWorker;
	/** Enables the fine anchor and drift pass for audio modes. */
	decodeWindow?: SyncWindowDecoder;
}

/** Decode one sync window with FFmpeg under the caller's media admission. */
export async function decodeSyncWindow(
	store: StudioStore,
	asset: Asset,
	start: number,
	duration: number,
	operation: MediaOperation
): Promise<Float32Array> {
	const directory = await mkdtemp(join(store.directory, "sync-window-"));
	try {
		const output = join(directory, "window.pcm");
		await runMedia(
			[
				"-hide_banner",
				"-loglevel",
				"error",
				"-nostdin",
				"-y",
				"-protocol_whitelist",
				"file,pipe",
				"-format_whitelist",
				MEDIA_FORMATS,
				"-ss",
				start.toFixed(6),
				"-t",
				duration.toFixed(6),
				"-i",
				store.mediaPath(asset.id),
				"-vn",
				"-sn",
				"-dn",
				"-map",
				"0:a:0",
				"-ac",
				"1",
				"-ar",
				String(DRIFT_DECODE_RATE),
				"-c:a",
				"pcm_f32le",
				"-f",
				"f32le",
				output,
			],
			{
				maxOutputBytes:
					Math.ceil(duration * DRIFT_DECODE_RATE * 4 * 1.05) + 65_536,
				outputPath: output,
				signal: operation.signal,
				timeoutMs: operation.remainingMs(),
			}
		);
		const bytes = await Bun.file(output).arrayBuffer();
		return new Float32Array(bytes, 0, Math.floor(bytes.byteLength / 4));
	} finally {
		await rm(directory, { force: true, recursive: true });
	}
}

/**
 * Replace each coarse audio match with a fine anchor lag and a clock-drift
 * measurement from two decoded windows. Targets that cannot be measured keep
 * their coarse lag and report why.
 */
export async function measureSyncRefinements(
	project: Project,
	assets: readonly Asset[],
	analyses: ReadonlyMap<string, MediaAnalysis | null>,
	input: SyncRequest,
	coarse: SyncResult,
	decode: SyncWindowDecoder,
	operation: MediaOperation
): Promise<Map<string, SyncRefinement>> {
	const refinements = new Map<string, SyncRefinement>();
	const reference = project.segments.find(
		(segment) => segment.id === input.referenceClipId
	);
	const media = new Map(assets.map((asset) => [asset.id, asset]));
	const referenceAsset = reference ? media.get(reference.assetId) : undefined;
	if (!(reference && referenceAsset)) {
		return refinements;
	}
	const block = DRIFT_DECODE_RATE / DRIFT_ENVELOPE_RATE;
	for (const match of coarse.matches) {
		const target = project.segments.find(
			(segment) => segment.id === match.clipId
		);
		const targetAsset = target ? media.get(target.assetId) : undefined;
		const referenceAnalysis = analyses.get(referenceAsset.id);
		const targetAnalysis = targetAsset ? analyses.get(targetAsset.id) : null;
		if (!(target && targetAsset && referenceAnalysis && targetAnalysis)) {
			continue;
		}
		operation.check();
		refinements.set(
			target.id,
			await refineSyncMatch(
				{
					coarse: {
						confidence: match.confidence,
						lagSeconds: match.alignmentOffsetSeconds,
					},
					coarseStepSeconds: coarseStepSeconds(
						referenceAnalysis,
						targetAnalysis
					),
					correct: input.driftCorrection,
					fps: project.fps,
					reference,
					target,
					targetDuration: targetAsset.duration,
				},
				async (role, start, duration) => {
					const asset = role === "reference" ? referenceAsset : targetAsset;
					// Whole envelope blocks keep window starts on exact sample times.
					const length =
						Math.floor(duration * DRIFT_ENVELOPE_RATE + 1e-6) /
						DRIFT_ENVELOPE_RATE;
					const samples = await decode(asset, start, length, operation);
					return pcmEnvelope(
						samples.subarray(0, Math.floor(samples.length / block) * block)
					);
				}
			)
		);
	}
	return refinements;
}

export async function runSync(
	project: Project,
	assets: Asset[],
	analyses: ReadonlyMap<string, MediaAnalysis | null>,
	input: SyncRequest,
	signal?: AbortSignal,
	dependencies: SyncWorkerDependencies = {}
): Promise<SyncResult> {
	if (input.mode === "manual" || input.mode === "timecode") {
		signal?.throwIfAborted();
		return syncClips(project, assets, analyses, input);
	}
	return await withMediaOperation(60_000, { signal }, async (operation) => {
		const moduleUrl = decodeURI(import.meta.url);
		const bundled =
			moduleUrl.includes("/~BUN/") || moduleUrl.includes("/$bunfs/");
		const workerExtension =
			bundled || import.meta.url.endsWith(".js") ? "js" : "ts";
		const workerUrl = bundled
			? "./sync-worker.ts"
			: new URL(`./sync-worker.${workerExtension}`, import.meta.url).href;
		const worker =
			dependencies.createWorker?.(workerUrl) ?? new Worker(workerUrl);
		const closed = Promise.withResolvers<void>();
		worker.addEventListener("close", () => closed.resolve(), { once: true });
		let abort: (() => void) | undefined;
		try {
			const result = await new Promise<SyncResult>((resolve, reject) => {
				abort = () =>
					reject(
						new Error(
							"Audio sync canceled or exceeded its one-minute deadline."
						)
					);
				operation.signal.addEventListener("abort", abort, { once: true });
				worker.addEventListener("error", (event) =>
					reject(new Error(event.message))
				);
				worker.addEventListener("close", () =>
					reject(
						new Error(
							"The audio sync worker stopped before returning a result."
						)
					)
				);
				worker.addEventListener(
					"message",
					(event: MessageEvent<SyncWorkerResult>) => {
						const message = event.data;
						if ("error" in message) {
							reject(new Error(message.error));
						} else {
							resolve(message.result);
						}
					}
				);
				worker.postMessage({
					project,
					assets,
					analyses: [...analyses],
					input,
				} satisfies SyncWorkerInput);
				if (operation.signal.aborted) {
					abort();
				}
			});
			operation.check();
			if (!dependencies.decodeWindow) {
				return result;
			}
			const refinements = await measureSyncRefinements(
				project,
				assets,
				analyses,
				input,
				result,
				dependencies.decodeWindow,
				operation
			);
			operation.check();
			return refinements.size
				? syncClips(project, assets, analyses, input, refinements)
				: result;
		} finally {
			if (abort) {
				operation.signal.removeEventListener("abort", abort);
			}
			// Keep admission until Bun reports the worker has terminated.
			worker.terminate();
			await closed.promise;
		}
	});
}
