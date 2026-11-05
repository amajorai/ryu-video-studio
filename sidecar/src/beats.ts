import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import {
	type AssetBeatsResponse,
	estimateBeatTimes,
} from "../../shared/analysis.ts";
import {
	BEAT_MAX_SECONDS,
	BEAT_SAMPLE_RATE,
	type BeatAnalysis,
	type BeatWindow,
	beatDetectionWindow,
	beatsCover,
	detectBeats,
} from "../../shared/beat-detect.ts";
import type { Asset } from "../../shared/project.ts";
import { MEDIA_FORMATS, runMedia } from "./media.ts";
import { type MediaOperation, withMediaOperation } from "./media-operation.ts";
import type { StudioStore } from "./store.ts";

const BYTES_PER_SECOND = BEAT_SAMPLE_RATE * 4;
const OPERATION_TIMEOUT_MS = 5 * 60_000;

/** Decode a source window (at most `BEAT_MAX_SECONDS`) of an asset's first audio stream to mono 11025 Hz float PCM. */
export async function decodeBeatAudio(
	store: StudioStore,
	asset: Asset,
	operation: MediaOperation,
	window: BeatWindow = beatDetectionWindow(asset.duration)
): Promise<Float32Array> {
	const seconds = Math.min(BEAT_MAX_SECONDS, Math.max(0, window.seconds));
	const directory = await mkdtemp(join(store.directory, "beats-"));
	try {
		const output = join(directory, "beats.pcm");
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
				...(window.start > 0 ? ["-ss", window.start.toFixed(6)] : []),
				"-i",
				store.mediaPath(asset.id),
				"-t",
				seconds.toFixed(6),
				"-vn",
				"-sn",
				"-dn",
				"-map",
				"0:a:0",
				"-ac",
				"1",
				"-ar",
				String(BEAT_SAMPLE_RATE),
				"-c:a",
				"pcm_f32le",
				"-f",
				"f32le",
				output,
			],
			{
				maxOutputBytes: Math.ceil(seconds * BYTES_PER_SECOND * 1.05) + 65_536,
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
 * One detection shared by every concurrent request for the same asset
 * window. It runs under its own controller, aborted only once every waiter
 * has stopped waiting, so one client disconnecting never cancels the work
 * for the others.
 */
interface SharedDetection {
	controller: AbortController;
	promise: Promise<BeatAnalysis | null>;
	settled: boolean;
	waiters: number;
}

const inFlight = new WeakMap<StudioStore, Map<string, SharedDetection>>();

const canceled = () => new Error("Media operation canceled.");

/** Wait for a shared detection until it settles or `signal` aborts. */
function joinDetection(
	pending: Map<string, SharedDetection>,
	key: string,
	shared: SharedDetection,
	signal?: AbortSignal
): Promise<BeatAnalysis | null> {
	shared.waiters++;
	let left = false;
	const leave = () => {
		if (left) {
			return;
		}
		left = true;
		shared.waiters--;
		if (shared.waiters === 0 && !shared.settled) {
			// Nobody is waiting: stop the work, and let later callers start afresh.
			if (pending.get(key) === shared) {
				pending.delete(key);
			}
			shared.controller.abort();
		}
	};
	return new Promise<BeatAnalysis | null>((resolve, reject) => {
		const onAbort = () => {
			leave();
			reject(canceled());
		};
		if (signal?.aborted) {
			onAbort();
			return;
		}
		signal?.addEventListener("abort", onAbort, { once: true });
		shared.promise.then(
			(value) => {
				signal?.removeEventListener("abort", onAbort);
				leave();
				resolve(value);
			},
			(error: unknown) => {
				signal?.removeEventListener("abort", onAbort);
				leave();
				reject(error);
			}
		);
	});
}

/**
 * Decode and detect one source window under one media admission; null when
 * nothing periodic was found. The window defaults to the first
 * `BEAT_MAX_SECONDS` of the source.
 */
export function detectAssetBeats(
	store: StudioStore,
	asset: Asset,
	signal?: AbortSignal,
	window: BeatWindow = beatDetectionWindow(asset.duration)
): Promise<BeatAnalysis | null> {
	if (!asset.hasAudio) {
		return Promise.reject(
			new Error("This media has no audio to detect beats in.")
		);
	}
	if (signal?.aborted) {
		return Promise.reject(canceled());
	}
	const pending = inFlight.get(store) ?? new Map<string, SharedDetection>();
	inFlight.set(store, pending);
	const key = `${asset.id}:${window.start}:${window.seconds}`;
	const running = pending.get(key);
	if (running) {
		return joinDetection(pending, key, running, signal);
	}
	const controller = new AbortController();
	const shared: SharedDetection = {
		controller,
		promise: Promise.resolve(null),
		settled: false,
		waiters: 0,
	};
	shared.promise = withMediaOperation(
		OPERATION_TIMEOUT_MS,
		{ signal: controller.signal },
		async (operation) => {
			const samples = await decodeBeatAudio(store, asset, operation, window);
			operation.check();
			return detectBeats(samples, BEAT_SAMPLE_RATE, window.start);
		}
	).finally(() => {
		shared.settled = true;
		if (pending.get(key) === shared) {
			pending.delete(key);
		}
	});
	// Waiters observe failures; this keeps an abandoned run from being unhandled.
	shared.promise.catch(() => undefined);
	pending.set(key, shared);
	return joinDetection(pending, key, shared, signal);
}

export interface AssetBeatsResult {
	body: AssetBeatsResponse;
	/** Why detection was skipped when the body is the RMS estimate. */
	fallbackReason?: string;
	source: "cache" | "detected" | "estimate";
}

const detectedBody = (
	assetId: string,
	beats: BeatAnalysis
): AssetBeatsResponse => ({
	assetId,
	times: beats.beats,
	...beats,
});

/** The source span a caller wants beats for, in source seconds. */
export interface BeatRange {
	from?: number;
	to?: number;
}

/**
 * Beats for a source with completed analysis: the cached detection when it
 * analyzed the requested range, a fresh spectral-flux detection over a
 * window covering it (cached with the analysis, replacing the previous
 * window), or, when detection cannot run, finds no periodic onsets, or the
 * range is longer than `BEAT_MAX_SECONDS`, the RMS-envelope estimate.
 */
export async function assetBeats(
	store: StudioStore,
	asset: Asset,
	options: BeatRange & { refresh?: boolean; signal?: AbortSignal } = {}
): Promise<AssetBeatsResult> {
	const analysis = store.analysis(asset.id);
	if (analysis?.status !== "completed") {
		throw new Error("Complete source analysis before estimating beat markers.");
	}
	const duration = Math.max(0, asset.duration);
	const from = Math.max(0, Math.min(duration, options.from ?? 0));
	const to = Math.max(
		from,
		Math.min(
			duration,
			options.to ?? Math.min(duration, from + BEAT_MAX_SECONDS)
		)
	);
	if (
		analysis.beats &&
		!options.refresh &&
		beatsCover(analysis.beats, from, to, duration)
	) {
		return {
			body: detectedBody(asset.id, analysis.beats),
			source: "cache",
		};
	}
	const estimate = (fallbackReason: string): AssetBeatsResult => ({
		body: {
			assetId: asset.id,
			times: estimateBeatTimes(analysis.waveform, analysis.duration),
		},
		fallbackReason,
		source: "estimate",
	});
	if (!asset.hasAudio) {
		return estimate("no-audio");
	}
	if (to - from > BEAT_MAX_SECONDS + 1e-6) {
		return estimate("range-too-long");
	}
	let detected: BeatAnalysis | null;
	try {
		detected = await detectAssetBeats(
			store,
			asset,
			options.signal,
			beatDetectionWindow(duration, from, to)
		);
	} catch (error) {
		if (options.signal?.aborted) {
			throw error;
		}
		return estimate("detection-failed");
	}
	if (!detected) {
		return estimate("no-periodic-onsets");
	}
	// Cache only onto the analysis run the detection was made for.
	const latest = store.analysis(asset.id);
	if (
		latest?.status === "completed" &&
		latest.createdAt === analysis.createdAt
	) {
		store.putAnalysis({ ...latest, beats: detected });
	}
	return { body: detectedBody(asset.id, detected), source: "detected" };
}
