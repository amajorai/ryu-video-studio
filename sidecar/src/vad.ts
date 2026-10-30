/**
 * Voice-activity features for source media.
 *
 * FFmpeg extracts the first audio stream as 16 kHz mono through a speech
 * band-pass (`highpass=f=120,lowpass=f=4000`). Denoising is opt-in: only a
 * request with `denoise: true` puts `arnndn` (the bundled RNNoise model)
 * before the band-pass, and only when FFmpeg has the filter. The PCM streams
 * through `VadFeatureAccumulator` into 20 ms energy and zero-crossing frames,
 * which are cached per source file so parameter changes never rerun FFmpeg.
 */
import { mkdtemp, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Asset } from "../../shared/project.ts";
import {
	VAD_SAMPLE_RATE,
	VadFeatureAccumulator,
	type VadFeatures,
} from "../../shared/vad.ts";
import { ffmpegCapabilities } from "./ffmpeg-capabilities.ts";
import { MEDIA_FORMATS, runMedia } from "./media.ts";
import { type MediaOperation, withMediaOperation } from "./media-operation.ts";
import { bundledVoiceModelPath } from "./render-stages/audio-environment.ts";
import type { StudioStore } from "./store.ts";

/** 16-bit mono PCM plus headroom for resampler overshoot. */
const PCM_BYTES_PER_SECOND = VAD_SAMPLE_RATE * 2;
const OUTPUT_HEADROOM_BYTES = 1024 * 1024;
const OPERATION_TIMEOUT_MS = 10 * 60_000;
/** Six hours of audio keeps the temporary PCM under ~700 MB. */
export const MAX_VAD_SOURCE_SECONDS = 6 * 60 * 60;
const CACHE_LIMIT = 24;
/** Paths that FFmpeg's filtergraph and option parsers both read literally. */
const PLAIN_PATH = /^[\w./-]+$/;

export const SPEECH_BAND_FILTERS = "highpass=f=120,lowpass=f=4000";

export interface VadAnalysisOptions {
	/**
	 * Run the bundled RNNoise model (when `arnndn` and the model are present)
	 * before the speech band filters. Off by default: RNNoise moves pause edges
	 * by 100-300 ms on the verified speech fixture, outside the 50 ms target,
	 * and it has not yet been measured on recorded speech.
	 */
	denoise?: boolean;
	/** Reuse an admitted media operation (several assets in one request). */
	operation?: MediaOperation;
	signal?: AbortSignal;
}

interface CacheEntry {
	features: VadFeatures;
	key: string;
}

const caches = new WeakMap<StudioStore, Map<string, CacheEntry>>();
const pending = new WeakMap<StudioStore, Map<string, Promise<VadFeatures>>>();

/**
 * The `-af` chain for VAD extraction. RNNoise runs at 48 kHz, so the optional
 * denoiser is preceded by a resample; the output is resampled to 16 kHz by
 * the encoder settings.
 */
export function vadAudioFilters(denoiseModel?: string): string {
	if (!(denoiseModel && PLAIN_PATH.test(denoiseModel))) {
		return SPEECH_BAND_FILTERS;
	}
	return `aresample=48000,arnndn=m=${denoiseModel},${SPEECH_BAND_FILTERS}`;
}

/** FFmpeg arguments that write band-limited s16le mono PCM to `output`. */
export function vadExtractionArgs(
	input: string,
	output: string,
	duration: number,
	denoiseModel?: string
): string[] {
	return [
		"-hide_banner",
		"-loglevel",
		"error",
		"-nostdin",
		"-y",
		"-protocol_whitelist",
		"file,pipe",
		"-format_whitelist",
		MEDIA_FORMATS,
		"-i",
		input,
		"-vn",
		"-sn",
		"-dn",
		"-map",
		"0:a:0",
		"-t",
		String(duration),
		"-af",
		vadAudioFilters(denoiseModel),
		"-ac",
		"1",
		"-ar",
		String(VAD_SAMPLE_RATE),
		"-c:a",
		"pcm_s16le",
		"-f",
		"s16le",
		output,
	];
}

/** The bundled RNNoise model, when present and `arnndn` is available. */
export async function denoiseModelPath(): Promise<string | undefined> {
	try {
		const capabilities = await ffmpegCapabilities();
		if (!capabilities.filters.arnndn) {
			return undefined;
		}
		const path = bundledVoiceModelPath();
		return path && PLAIN_PATH.test(path) ? path : undefined;
	} catch {
		return undefined;
	}
}

async function sourceKey(store: StudioStore, asset: Asset) {
	const info = await stat(store.mediaPath(asset.id));
	return `${info.size}:${info.mtimeMs}:${asset.duration}`;
}

function cacheFor(store: StudioStore) {
	const existing = caches.get(store);
	if (existing) {
		return existing;
	}
	const created = new Map<string, CacheEntry>();
	caches.set(store, created);
	return created;
}

function remember(store: StudioStore, id: string, entry: CacheEntry) {
	const cache = cacheFor(store);
	cache.delete(id);
	cache.set(id, entry);
	while (cache.size > CACHE_LIMIT) {
		const oldest = cache.keys().next().value;
		if (oldest === undefined) {
			break;
		}
		cache.delete(oldest);
	}
}

/** Refusal text when VAD cannot run on this asset, else undefined. */
export function vadRefusal(asset: Asset): string | undefined {
	if (!asset.hasAudio) {
		return "This media has no audio to analyze for speech.";
	}
	if (asset.duration > MAX_VAD_SOURCE_SECONDS) {
		return "Speech detection supports sources up to six hours long.";
	}
	return undefined;
}

/**
 * Cached voice-activity features for an asset. Concurrent requests for one
 * source share a single extraction; a changed media file is re-analyzed.
 */
export async function voiceActivityFeatures(
	store: StudioStore,
	asset: Asset,
	options: VadAnalysisOptions = {}
): Promise<VadFeatures> {
	const refusal = vadRefusal(asset);
	if (refusal) {
		throw new Error(refusal);
	}
	const key = `${await sourceKey(store, asset)}:${options.denoise ? "denoised" : "plain"}`;
	const cached = cacheFor(store).get(asset.id);
	if (cached?.key === key) {
		remember(store, asset.id, cached);
		return cached.features;
	}
	const running = pending.get(store) ?? new Map<string, Promise<VadFeatures>>();
	pending.set(store, running);
	const inFlight = running.get(`${asset.id}:${key}`);
	if (inFlight) {
		return await inFlight;
	}
	const work = extractFeatures(store, asset, options);
	running.set(`${asset.id}:${key}`, work);
	try {
		const features = await work;
		remember(store, asset.id, { features, key });
		return features;
	} finally {
		running.delete(`${asset.id}:${key}`);
	}
}

async function extractFeatures(
	store: StudioStore,
	asset: Asset,
	options: VadAnalysisOptions
): Promise<VadFeatures> {
	const model = options.denoise ? await denoiseModelPath() : undefined;
	return await withMediaOperation(
		OPERATION_TIMEOUT_MS,
		options,
		async (operation) => {
			const directory = await mkdtemp(join(store.directory, "vad-"));
			const output = join(directory, "speech.pcm");
			try {
				const maxBytes =
					Math.ceil(asset.duration * PCM_BYTES_PER_SECOND * 1.02) +
					OUTPUT_HEADROOM_BYTES;
				await runMedia(
					vadExtractionArgs(
						store.mediaPath(asset.id),
						output,
						asset.duration,
						model
					),
					{
						maxOutputBytes: maxBytes,
						outputPath: output,
						signal: operation.signal,
						timeoutMs: operation.remainingMs(),
					}
				);
				operation.check();
				const accumulator = new VadFeatureAccumulator();
				for await (const chunk of Bun.file(output).stream()) {
					accumulator.pushBytes(chunk);
				}
				operation.check();
				return accumulator.finish();
			} finally {
				await rm(directory, { force: true, recursive: true });
			}
		}
	);
}

/** Drop cached features, for tests and media replacement. */
export function clearVoiceActivityCache(store: StudioStore) {
	caches.delete(store);
}
