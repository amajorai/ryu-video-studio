/**
 * Library hover-skim frames (W1-L1): one small JPEG of a source at a given
 * time. The library quantizes pointer positions to a few dozen times per
 * asset, so frames are cached on disk per asset (keyed by the media file's
 * identity, the millisecond time and the height) and equal concurrent
 * requests share one FFmpeg run. Deleting an asset removes its frame folder.
 */
import { mkdir, readdir, rename, rm, stat, utimes } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { Asset } from "../../shared/project.ts";
import { idSchema } from "../../shared/project.ts";
import { MAX_THUMBNAIL_BYTES, MEDIA_FORMATS, runMedia } from "./media.ts";
import type { StudioStore } from "./store.ts";

export const MIN_SKIM_HEIGHT = 48;
export const MAX_SKIM_HEIGHT = 360;
export const DEFAULT_SKIM_HEIGHT = 180;
/** Frames kept per asset before the least recently used are removed. */
export const MAX_CACHED_SKIM_FRAMES = 96;
const SKIM_DIRECTORY = "skim-frames";
const SKIM_TIMEOUT_MS = 20_000;
/** Keep the seek point before the final frame so the decoder yields one. */
const END_GUARD_SECONDS = 0.05;

export const skimFrameRequestSchema = z
	.object({
		time: z.number().finite().min(0).max(7200),
		height: z.number().int().min(MIN_SKIM_HEIGHT).max(MAX_SKIM_HEIGHT),
	})
	.strict();
export type SkimFrameRequest = z.infer<typeof skimFrameRequestSchema>;

export interface SkimFrame {
	assetId: string;
	cached: boolean;
	/** Base64 JPEG. */
	data: string;
	height: number;
	/** Source time the frame shows, after clamping to the media. */
	time: number;
}

/** Parse `?time&height` query parameters (height defaults to 180). */
export function parseSkimFrameQuery(params: URLSearchParams): SkimFrameRequest {
	const number = (name: string) => {
		const raw = params.get(name);
		return raw === null || raw.trim() === "" ? undefined : Number(raw);
	};
	return skimFrameRequestSchema.parse({
		time: number("time"),
		height: number("height") ?? DEFAULT_SKIM_HEIGHT,
	});
}

/**
 * The source time a skim frame shows: stills always show their only frame,
 * video clamps into the media (before its last frame) and rounds to a
 * millisecond so equal pointer buckets share one cached file.
 */
export function resolveSkimTime(
	asset: Pick<Asset, "duration" | "kind">,
	time: number
): number {
	if (asset.kind === "audio") {
		throw new Error("Skim frames need a video or image asset.");
	}
	if (asset.kind === "image") {
		return 0;
	}
	const last = Math.max(0, asset.duration - END_GUARD_SECONDS);
	return Math.round(Math.min(Math.max(0, time), last) * 1000) / 1000;
}

/** Cache file name; the media identity makes relinked media miss the cache. */
export function skimFrameFileName(
	media: { mtimeMs: number; size: number },
	request: SkimFrameRequest
): string {
	return [
		media.size,
		Math.round(media.mtimeMs),
		Math.round(request.time * 1000),
		request.height,
	]
		.join("-")
		.concat(".jpg");
}

/** FFmpeg arguments that write one scaled JPEG frame to `outputPath`. */
export function skimFrameArgs(
	inputPath: string,
	asset: Pick<Asset, "kind">,
	request: SkimFrameRequest,
	outputPath: string
): string[] {
	const seek =
		asset.kind === "video" ? ["-ss", request.time.toFixed(3)] : ([] as const);
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
		...seek,
		"-i",
		inputPath,
		"-frames:v",
		"1",
		"-an",
		"-vf",
		`scale=w=-2:h=${request.height}:flags=bilinear`,
		"-q:v",
		"5",
		"-f",
		"image2",
		"-c:v",
		"mjpeg",
		outputPath,
	];
}

/** The per-asset folder that holds an asset's cached skim frames. */
export function skimFrameDirectory(store: StudioStore, assetId: string) {
	return join(store.directory, SKIM_DIRECTORY, idSchema.parse(assetId));
}

/** Remove every cached skim frame of an asset (after the asset is deleted). */
export async function removeSkimFrames(store: StudioStore, assetId: string) {
	await rm(skimFrameDirectory(store, assetId), {
		force: true,
		recursive: true,
	});
}

const inflight = new Map<string, Promise<Uint8Array>>();

async function exists(path: string) {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

/** Keep at most `MAX_CACHED_SKIM_FRAMES` frames, oldest access first out. */
async function prune(directory: string, keep: string) {
	const names = (await readdir(directory)).filter((name) =>
		name.endsWith(".jpg")
	);
	if (names.length <= MAX_CACHED_SKIM_FRAMES) {
		return;
	}
	const entries = await Promise.all(
		names.map(async (name) => ({
			name,
			mtimeMs: (await stat(join(directory, name)).catch(() => null))?.mtimeMs,
		}))
	);
	const removable = entries
		.filter((entry) => entry.name !== keep && entry.mtimeMs !== undefined)
		.sort((a, b) => (a.mtimeMs ?? 0) - (b.mtimeMs ?? 0));
	const excess = names.length - MAX_CACHED_SKIM_FRAMES;
	await Promise.all(
		removable
			.slice(0, excess)
			.map((entry) => rm(join(directory, entry.name), { force: true }))
	);
}

async function renderFrame(
	store: StudioStore,
	asset: Asset,
	request: SkimFrameRequest,
	cachePath: string,
	signal?: AbortSignal
): Promise<Uint8Array> {
	const temporary = `${cachePath}.${crypto.randomUUID()}.part.jpg`;
	try {
		await runMedia(
			skimFrameArgs(store.mediaPath(asset.id), asset, request, temporary),
			{
				maxOutputBytes: MAX_THUMBNAIL_BYTES,
				outputPath: temporary,
				signal,
				timeoutMs: SKIM_TIMEOUT_MS,
			}
		);
		const bytes = new Uint8Array(await Bun.file(temporary).arrayBuffer());
		if (bytes.length === 0) {
			throw new Error("The skim frame is unavailable at this time.");
		}
		await rename(temporary, cachePath);
		return bytes;
	} finally {
		await rm(temporary, { force: true });
	}
}

/** Return the skim frame for `input`, from the disk cache when present. */
export async function assetSkimFrame(
	store: StudioStore,
	asset: Asset,
	input: SkimFrameRequest,
	options: { signal?: AbortSignal } = {}
): Promise<SkimFrame> {
	const request = { ...input, time: resolveSkimTime(asset, input.time) };
	const media = await stat(store.mediaPath(asset.id));
	const directory = skimFrameDirectory(store, asset.id);
	const fileName = skimFrameFileName(media, request);
	const cachePath = join(directory, fileName);
	let cached = false;
	let bytes: Uint8Array;
	if (await exists(cachePath)) {
		cached = true;
		const now = new Date();
		await utimes(cachePath, now, now).catch(() => undefined);
		bytes = new Uint8Array(await Bun.file(cachePath).arrayBuffer());
	} else {
		let pending = inflight.get(cachePath);
		if (!pending) {
			pending = (async () => {
				await mkdir(directory, { recursive: true, mode: 0o700 });
				const frame = await renderFrame(
					store,
					asset,
					request,
					cachePath,
					options.signal
				);
				await prune(directory, fileName);
				return frame;
			})().finally(() => inflight.delete(cachePath));
			inflight.set(cachePath, pending);
		}
		bytes = await pending;
	}
	return {
		assetId: asset.id,
		cached,
		data: Buffer.from(bytes).toString("base64"),
		height: request.height,
		time: request.time,
	};
}
