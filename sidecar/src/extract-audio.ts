import { rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { extractableAudioRefusal } from "../../shared/detach-audio.ts";
import { type Asset, assetSchema } from "../../shared/project.ts";
import { MEDIA_FORMATS, probe, runMedia } from "./media.ts";
import { type MediaOperation, withMediaOperation } from "./media-operation.ts";
import type { StudioStore } from "./store.ts";

/** 48 kHz stereo 16-bit PCM plus container headroom. */
const PCM_BYTES_PER_SECOND = 48_000 * 2 * 2;
const HEADER_BYTES = 1024 * 1024;
const OPERATION_TIMEOUT_MS = 20 * 60_000;

interface ExtractOptions {
	operation?: MediaOperation;
	signal?: AbortSignal;
}

/** Concurrent requests for one source share a single extraction. */
const inFlight = new WeakMap<StudioStore, Map<string, Promise<Asset>>>();

/** The app-owned audio derivative already extracted from a video asset. */
export function derivedAudioFor(
	assets: readonly Asset[],
	videoAssetId: string
): Asset | undefined {
	return assets.find(
		(asset) =>
			asset.kind === "audio" &&
			asset.derivation === "audio" &&
			asset.derivedFromAssetId === videoAssetId
	);
}

/**
 * Derivatives are keyed only by source id, so media that changes in place
 * (nested sequences refresh under the same id) or is itself a derivative
 * (reversals) is refused rather than risking stale, out-of-sync audio.
 */
function assertExtractable(asset: Asset) {
	const refusal = extractableAudioRefusal(asset);
	if (refusal) {
		throw new Error(refusal);
	}
}

/**
 * Extract a video's first audio stream into app-owned PCM storage and register
 * it as a derived audio asset on the same source timebase. Idempotent: an
 * existing derivative is returned without running FFmpeg.
 */
export async function extractAssetAudio(
	store: StudioStore,
	asset: Asset,
	options: ExtractOptions = {}
): Promise<{ asset: Asset; created: boolean }> {
	assertExtractable(asset);
	const existing = derivedAudioFor(store.assets(), asset.id);
	if (existing) {
		return { asset: existing, created: false };
	}
	const pending = inFlight.get(store) ?? new Map<string, Promise<Asset>>();
	inFlight.set(store, pending);
	const running = pending.get(asset.id);
	if (running) {
		return { asset: await running, created: false };
	}
	const work = extract(store, asset, options);
	pending.set(asset.id, work);
	try {
		return { asset: await work, created: true };
	} finally {
		pending.delete(asset.id);
	}
}

async function extract(
	store: StudioStore,
	asset: Asset,
	options: ExtractOptions
): Promise<Asset> {
	return await withMediaOperation(
		OPERATION_TIMEOUT_MS,
		options,
		async (operation) => {
			const maxBytes =
				Math.ceil(asset.duration * PCM_BYTES_PER_SECOND * 1.02) + HEADER_BYTES;
			const reservation = store.reserveMediaStorage(maxBytes);
			const id = crypto.randomUUID();
			const output = join(store.directory, "media", `.audio-${id}.wav`);
			try {
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
						"-i",
						store.mediaPath(asset.id),
						"-vn",
						"-sn",
						"-dn",
						"-map",
						"0:a:0",
						"-t",
						String(asset.duration),
						"-ac",
						"2",
						"-ar",
						"48000",
						"-c:a",
						"pcm_s16le",
						"-f",
						"wav",
						output,
					],
					{
						signal: operation.signal,
						timeoutMs: operation.remainingMs(),
						outputPath: output,
						maxOutputBytes: maxBytes,
					}
				);
				operation.check();
				const size = (await stat(output)).size;
				if (!size || size > maxBytes) {
					throw new Error("The extracted audio exceeded its output budget.");
				}
				const info = await probe(output, operation.signal);
				operation.check();
				if (info.kind !== "audio") {
					throw new Error("The extracted file contains no audio.");
				}
				const existing = derivedAudioFor(store.assets(), asset.id);
				if (existing) {
					return existing;
				}
				const nextInput = {
					...info,
					createdAt: new Date().toISOString(),
					derivation: "audio",
					derivedFromAssetId: asset.id,
					id,
					name: `${asset.name.slice(0, 190)} · audio`,
				};
				if (asset.folder) {
					Object.assign(nextInput, { folder: asset.folder });
				}
				if (asset.origin) {
					Object.assign(nextInput, { origin: asset.origin });
				}
				const next = assetSchema.parse(nextInput);
				await rename(output, store.mediaPath(next.id));
				store.putAsset(next);
				reservation.commit();
				return next;
			} finally {
				await rm(output, { force: true });
				reservation.release();
			}
		}
	);
}
