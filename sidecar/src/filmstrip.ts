/**
 * Timeline filmstrips (W1-T9): one PNG sprite of evenly spaced thumbnails
 * across a source range, laid out left to right in a single row. Sprites are
 * cached on disk under the store, keyed by the asset's media file identity
 * and the request, so the same clip at the same zoom never runs FFmpeg twice.
 */
import { createHash } from "node:crypto";
import { mkdir, readdir, rename, rm, stat, utimes } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { Asset } from "../../shared/project.ts";
import { MAX_THUMBNAIL_BYTES, MEDIA_FORMATS, runMedia } from "./media.ts";
import type { StudioStore } from "./store.ts";

export const MAX_FILMSTRIP_FRAMES = 60;
export const MAX_FILMSTRIP_HEIGHT = 90;
export const MIN_FILMSTRIP_HEIGHT = 16;
/** Thumbnails wider than this multiple of their height are center-cropped. */
export const MAX_FILMSTRIP_ASPECT = 3;
/** Sprites kept on disk before the least recently used are removed. */
export const MAX_CACHED_FILMSTRIPS = 300;
const FILMSTRIP_DIRECTORY = "filmstrips";
const FILMSTRIP_TIMEOUT_MS = 30_000;
/** Keep the seek point before the final frame so the decoder yields one. */
const END_GUARD_SECONDS = 0.05;
const CACHE_KEY_VERSION = "filmstrip-v1";

const seconds = z.number().finite().min(0).max(7200);

export const filmstripRequestSchema = z
	.object({
		start: seconds,
		end: seconds,
		count: z.number().int().min(1).max(MAX_FILMSTRIP_FRAMES),
		height: z
			.number()
			.int()
			.min(MIN_FILMSTRIP_HEIGHT)
			.max(MAX_FILMSTRIP_HEIGHT),
	})
	.strict()
	.refine((value) => value.end - value.start >= 0.001, {
		message: "The filmstrip range must end after it starts.",
		path: ["end"],
	});
export type FilmstripRequest = z.infer<typeof filmstripRequestSchema>;

/** Parse `?start&end&count&height` query parameters. */
export function parseFilmstripQuery(params: URLSearchParams): FilmstripRequest {
	const number = (name: string) => {
		const raw = params.get(name);
		return raw === null || raw.trim() === "" ? undefined : Number(raw);
	};
	return filmstripRequestSchema.parse({
		start: number("start") ?? 0,
		end: number("end"),
		count: number("count"),
		height: number("height") ?? 48,
	});
}

export interface FilmstripSprite {
	assetId: string;
	cached: boolean;
	count: number;
	/** Base64 PNG; frames are `frameWidth` wide, left to right. */
	data: string;
	end: number;
	frameHeight: number;
	frameWidth: number;
	height: number;
	start: number;
	/** Source time sampled by each frame. */
	times: number[];
	width: number;
}

const rounded = (value: number) => Number(value.toFixed(6));

/**
 * Clamp a request to the asset. Stills ignore the range: every frame is the
 * same picture. Video ranges are clamped to the source duration.
 */
export function resolveFilmstripRange(
	asset: Pick<Asset, "duration" | "kind">,
	request: FilmstripRequest
): FilmstripRequest {
	if (asset.kind === "audio") {
		throw new Error("Filmstrips need a video or image asset.");
	}
	if (asset.kind === "image") {
		return request;
	}
	const end = Math.min(request.end, asset.duration);
	if (request.start >= end) {
		throw new Error("The filmstrip range starts after the media ends.");
	}
	return { ...request, end: rounded(end) };
}

/** Source time at the middle of each of `count` equal slices of the range. */
export function filmstripSampleTimes(
	request: Pick<FilmstripRequest, "count" | "end" | "start">
): number[] {
	const step = (request.end - request.start) / request.count;
	return Array.from({ length: request.count }, (_, index) =>
		rounded(request.start + (index + 0.5) * step)
	);
}

/**
 * Stable on-disk cache key. The media file's size and modification time are
 * part of the key so relinked or replaced media never serves a stale sprite.
 */
export function filmstripCacheKey(
	assetId: string,
	media: { mtimeMs: number; size: number },
	request: FilmstripRequest
): string {
	return createHash("sha256")
		.update(
			[
				CACHE_KEY_VERSION,
				assetId,
				media.size,
				Math.round(media.mtimeMs),
				request.start.toFixed(3),
				request.end.toFixed(3),
				request.count,
				request.height,
			].join("|")
		)
		.digest("hex")
		.slice(0, 40);
}

/** FFmpeg arguments that write one single-row sprite to `outputPath`. */
export function filmstripArgs(
	inputPath: string,
	asset: Pick<Asset, "duration" | "kind">,
	request: FilmstripRequest,
	outputPath: string
): string[] {
	const span = request.end - request.start;
	// After the seek, `fps` (round=near) emits for tick k the latest frame
	// before start + (k + 0.5) * step: the frame showing each sample time.
	const seek =
		asset.kind === "image"
			? []
			: [
					"-ss",
					Math.max(
						0,
						Math.min(request.start, asset.duration - END_GUARD_SECONDS)
					).toFixed(6),
				];
	const maxWidth = request.height * MAX_FILMSTRIP_ASPECT;
	// `tpad` clones the final frame so a range past the last decodable frame,
	// or a still, still fills every tile; `-frames:v 1` stops once it does.
	const filter = [
		"tpad=stop_mode=clone:stop=-1",
		`fps=fps=${request.count * 1000}/${Math.max(1, Math.round(span * 1000))}`,
		`scale=w=-1:h=${request.height}`,
		`crop=w='min(iw,${maxWidth})':h=ih`,
		`tile=${request.count}x1`,
	].join(",");
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
		"-an",
		"-vf",
		filter,
		"-frames:v",
		"1",
		"-update",
		"1",
		"-f",
		"image2",
		"-c:v",
		"png",
		outputPath,
	];
}

/** Read width and height from a PNG's IHDR chunk. */
export function pngDimensions(bytes: Uint8Array): {
	height: number;
	width: number;
} {
	const signature = [137, 80, 78, 71, 13, 10, 26, 10];
	if (
		bytes.length < 24 ||
		signature.some((value, index) => bytes[index] !== value)
	) {
		throw new Error("The filmstrip is not a PNG image.");
	}
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	return { width: view.getUint32(16), height: view.getUint32(20) };
}

/**
 * One shared render. It runs under its own controller, aborted only when
 * every request waiting on it has gone, so one client disconnecting never
 * cancels the sprite for the others.
 */
interface InflightRender {
	cachePath: string;
	controller: AbortController;
	promise: Promise<Uint8Array>;
	waiters: number;
}

const inflight = new Map<string, InflightRender>();
/** Filmstrips run one at a time so timeline scrolling never floods FFmpeg. */
let lane: Promise<unknown> = Promise.resolve();

async function exists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

async function prune(directory: string, keep: string): Promise<void> {
	const names = (await readdir(directory)).filter((name) =>
		name.endsWith(".png")
	);
	if (names.length <= MAX_CACHED_FILMSTRIPS) {
		return;
	}
	const entries = await Promise.all(
		names.map(async (name) => {
			try {
				return { name, mtimeMs: (await stat(join(directory, name))).mtimeMs };
			} catch {
				return { name, mtimeMs: 0 };
			}
		})
	);
	entries.sort((left, right) => left.mtimeMs - right.mtimeMs);
	const excess = entries.length - MAX_CACHED_FILMSTRIPS;
	const victims = entries
		.filter((entry) => entry.name !== keep)
		.slice(0, excess);
	await Promise.all(
		victims.map((entry) => rm(join(directory, entry.name), { force: true }))
	);
}

async function renderSprite(
	store: StudioStore,
	asset: Asset,
	request: FilmstripRequest,
	cachePath: string,
	signal?: AbortSignal
): Promise<Uint8Array> {
	const temporary = `${cachePath}.${crypto.randomUUID()}.tmp.png`;
	try {
		await runMedia(
			filmstripArgs(store.mediaPath(asset.id), asset, request, temporary),
			{
				signal,
				timeoutMs: FILMSTRIP_TIMEOUT_MS,
				outputPath: temporary,
				maxOutputBytes: MAX_THUMBNAIL_BYTES,
			}
		);
		const bytes = new Uint8Array(await Bun.file(temporary).arrayBuffer());
		pngDimensions(bytes);
		await rename(temporary, cachePath);
		return bytes;
	} finally {
		await rm(temporary, { force: true });
	}
}

const canceled = () => new Error("Operation canceled.");

/**
 * Wait for a shared render on behalf of one request. Aborting `signal`
 * rejects only this wait; the render itself is aborted once its last
 * waiter has left.
 */
function awaitShared(
	render: InflightRender,
	signal: AbortSignal | undefined
): Promise<Uint8Array> {
	if (signal?.aborted) {
		return Promise.reject(canceled());
	}
	render.waiters += 1;
	return new Promise<Uint8Array>((resolve, reject) => {
		let settled = false;
		const leave = () => {
			if (settled) {
				return false;
			}
			settled = true;
			signal?.removeEventListener("abort", onAbort);
			render.waiters -= 1;
			return true;
		};
		const onAbort = () => {
			if (!leave()) {
				return;
			}
			if (render.waiters === 0) {
				// A later identical request starts a fresh render.
				if (inflight.get(render.cachePath) === render) {
					inflight.delete(render.cachePath);
				}
				render.controller.abort();
			}
			reject(canceled());
		};
		signal?.addEventListener("abort", onAbort, { once: true });
		render.promise.then(
			(bytes) => {
				if (leave()) {
					resolve(bytes);
				}
			},
			(error: unknown) => {
				if (leave()) {
					reject(error);
				}
			}
		);
	});
}

export interface FilmstripOptions {
	signal?: AbortSignal;
}

/**
 * Return the sprite for `request`, from the disk cache when present. Equal
 * concurrent requests share one FFmpeg run.
 */
export async function assetFilmstrip(
	store: StudioStore,
	asset: Asset,
	input: FilmstripRequest,
	options: FilmstripOptions = {}
): Promise<FilmstripSprite> {
	const request = resolveFilmstripRange(asset, input);
	const media = await stat(store.mediaPath(asset.id));
	const key = filmstripCacheKey(asset.id, media, request);
	const directory = join(store.directory, FILMSTRIP_DIRECTORY);
	const cachePath = join(directory, `${key}.png`);
	let cached = false;
	let bytes: Uint8Array;
	if (await exists(cachePath)) {
		cached = true;
		const now = new Date();
		await utimes(cachePath, now, now).catch(() => undefined);
		bytes = new Uint8Array(await Bun.file(cachePath).arrayBuffer());
	} else {
		let render = inflight.get(cachePath);
		if (!render) {
			const controller = new AbortController();
			const run = lane.then(async () => {
				controller.signal.throwIfAborted();
				await mkdir(directory, { recursive: true, mode: 0o700 });
				const sprite = await renderSprite(
					store,
					asset,
					request,
					cachePath,
					controller.signal
				);
				await prune(directory, `${key}.png`);
				return sprite;
			});
			const created: InflightRender = {
				cachePath,
				controller,
				promise: run.finally(() => {
					if (inflight.get(cachePath) === created) {
						inflight.delete(cachePath);
					}
				}),
				waiters: 0,
			};
			// Keep an unawaited rejection from surfacing when every waiter left.
			created.promise.catch(() => undefined);
			inflight.set(cachePath, created);
			lane = run.catch(() => undefined);
			render = created;
		}
		bytes = await awaitShared(render, options.signal);
	}
	const { width, height } = pngDimensions(bytes);
	return {
		assetId: asset.id,
		cached,
		count: request.count,
		data: Buffer.from(bytes).toString("base64"),
		end: request.end,
		frameHeight: height,
		frameWidth: Math.floor(width / request.count),
		height: request.height,
		start: request.start,
		times: filmstripSampleTimes(request),
		width,
	};
}
