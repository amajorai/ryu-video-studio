import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { type Asset, assetSchema } from "../../shared/project.ts";
import { MEDIA_FORMATS, probe, runMedia, thumbnail } from "./media.ts";
import {
	MediaBusyError,
	type MediaOperation,
	withMediaOperation,
} from "./media-operation.ts";
import type { StudioStore } from "./store.ts";

/**
 * Proxy media (G35): small H.264 copies of heavy video that only the preview
 * plays. Proxies are app-owned derivatives (`derivation: "proxy"`) linked to
 * their source by `derivedFromAssetId`. Timeline clips always reference the
 * original asset, so the render never reads a proxy.
 */

/** Sources wider than this get a proxy automatically at import. */
export const PROXY_TRIGGER_WIDTH = 1920;
/** Sources whose average bitrate exceeds this (bits per second) get a proxy. */
export const PROXY_TRIGGER_BITRATE = 30_000_000;
/** Width of the proxy created at import and by default on demand. */
export const PROXY_STANDARD_WIDTH = 960;
/** Keyframe interval: short GOPs keep preview scrubbing responsive. */
export const PROXY_GOP = 12;
const OPERATION_TIMEOUT_MS = 60 * 60_000;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024 * 1024;
/** Proxy widths within this many pixels count as the same variant. */
const WIDTH_TOLERANCE = 2;
/** Assets one auto-proxy sweep may consider. */
export const MAX_PROXY_SWEEP = 50;

export const proxyVariantSchema = z.enum(["standard", "half", "quarter"]);
export type ProxyVariant = z.infer<typeof proxyVariantSchema>;

export const proxyRequestSchema = z
	.object({ variant: proxyVariantSchema.optional() })
	.strict();

export const proxySweepRequestSchema = z
	.object({
		assetIds: z.array(z.uuid()).max(MAX_PROXY_SWEEP).optional(),
	})
	.strict();

export const proxySettingsSchema = z
	.object({
		/** Create proxies for heavy video at import. On unless opted out. */
		autoProxy: z.boolean(),
	})
	.strict();
export type ProxySettings = z.infer<typeof proxySettingsSchema>;

export const DEFAULT_PROXY_SETTINGS: ProxySettings = { autoProxy: true };

const SETTINGS_FILE = "proxy-settings.json";

function evenWidth(value: number): number {
	return Math.max(2, Math.floor(value / 2) * 2);
}

/** True for an app-owned proxy derivative. */
export function isProxyAsset(asset: Pick<Asset, "derivation">): boolean {
	return asset.derivation === "proxy";
}

/** The library listing without proxies; proxies are an implementation detail. */
export function libraryAssets<Item extends Pick<Asset, "derivation">>(
	assets: readonly Item[]
): Item[] {
	return assets.filter((asset) => !isProxyAsset(asset));
}

/** Average bitrate in bits per second, or 0 when it cannot be known. */
export function averageBitrate(bytes: number, duration: number): number {
	if (!(Number.isFinite(bytes) && bytes > 0 && duration > 0)) {
		return 0;
	}
	return (bytes * 8) / duration;
}

/** Whether an asset may have a proxy at all (video that is not itself derived for preview). */
export function canProxy(
	asset: Pick<Asset, "derivation" | "kind" | "width">
): boolean {
	return asset.kind === "video" && !isProxyAsset(asset) && asset.width > 0;
}

/**
 * Whether import should create a proxy: video above 1920 px wide or above
 * 30 Mb/s average bitrate. `bytes` is the source file size.
 */
export function needsProxy(
	asset: Pick<Asset, "derivation" | "duration" | "kind" | "width">,
	bytes: number
): boolean {
	if (!canProxy(asset)) {
		return false;
	}
	return (
		asset.width > PROXY_TRIGGER_WIDTH ||
		averageBitrate(bytes, asset.duration) > PROXY_TRIGGER_BITRATE
	);
}

/**
 * Output width for a proxy variant: `standard` is 960 px (never wider than the
 * source), `half` and `quarter` scale the source width. Always even and at
 * least 2 px so H.264 4:2:0 accepts it.
 */
export function proxyVariantWidth(
	source: Pick<Asset, "width">,
	variant: ProxyVariant
): number {
	const width = source.width;
	if (variant === "half") {
		return evenWidth(width / 2);
	}
	if (variant === "quarter") {
		return evenWidth(width / 4);
	}
	return evenWidth(Math.min(PROXY_STANDARD_WIDTH, width));
}

/** Every proxy of `sourceId`, narrowest first (ties by id). */
export function proxiesFor(
	assets: readonly Asset[],
	sourceId: string
): Asset[] {
	return assets
		.filter(
			(asset) => isProxyAsset(asset) && asset.derivedFromAssetId === sourceId
		)
		.sort((a, b) => a.width - b.width || a.id.localeCompare(b.id));
}

/** The existing proxy of `sourceId` at `width`, within a 2 px tolerance. */
export function proxyAt(
	assets: readonly Asset[],
	sourceId: string,
	width: number
): Asset | undefined {
	return proxiesFor(assets, sourceId).find(
		(asset) => Math.abs(asset.width - width) <= WIDTH_TOLERANCE
	);
}

/** FFmpeg arguments that encode a proxy of `width` px into `output` (MP4). */
export function proxyArgs(
	source: string,
	output: string,
	width: number,
	hasAudio: boolean
): string[] {
	const audio = hasAudio
		? ["-map", "0:a:0", "-c:a", "aac", "-b:a", "128k", "-ac", "2"]
		: ["-an"];
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
		source,
		"-map",
		"0:v:0",
		"-vf",
		`scale=${width}:-2:flags=bilinear,format=yuv420p`,
		"-c:v",
		"libx264",
		"-preset",
		"veryfast",
		"-crf",
		"23",
		"-g",
		String(PROXY_GOP),
		"-keyint_min",
		String(PROXY_GOP),
		"-sc_threshold",
		"0",
		"-pix_fmt",
		"yuv420p",
		...audio,
		"-sn",
		"-dn",
		"-movflags",
		"+faststart",
		"-f",
		"mp4",
		output,
	];
}

/** Read the opt-out setting; a missing or unreadable file means the default. */
export async function readProxySettings(
	store: Pick<StudioStore, "directory">
): Promise<ProxySettings> {
	try {
		const text = await readFile(join(store.directory, SETTINGS_FILE), "utf8");
		const parsed = proxySettingsSchema.safeParse(JSON.parse(text));
		return parsed.success ? parsed.data : { ...DEFAULT_PROXY_SETTINGS };
	} catch {
		return { ...DEFAULT_PROXY_SETTINGS };
	}
}

export async function writeProxySettings(
	store: Pick<StudioStore, "directory">,
	settings: ProxySettings
): Promise<ProxySettings> {
	const next = proxySettingsSchema.parse(settings);
	const path = join(store.directory, SETTINGS_FILE);
	const temporary = `${path}.${crypto.randomUUID()}.tmp`;
	await writeFile(temporary, `${JSON.stringify(next)}\n`, { mode: 0o600 });
	await rename(temporary, path);
	return next;
}

interface ProxyOptions {
	operation?: MediaOperation;
	signal?: AbortSignal;
}

/** The slice of a media operation one encode needs. */
type EncodeOperation = Pick<MediaOperation, "check" | "remainingMs" | "signal">;

/**
 * One in-flight encode shared by every caller asking for the same proxy. It
 * runs under its own controller, so a caller that disconnects only stops
 * waiting; the encode is aborted when every waiter has gone.
 */
interface SharedEncode {
	controller: AbortController;
	promise: Promise<Asset>;
	waiters: number;
}

const inflight = new Map<string, SharedEncode>();

function canceled(): Error {
	return new Error("Media operation canceled.");
}

/** Wait for a shared encode as one waiter, leaving it when `signal` aborts. */
function waitForEncode(
	run: SharedEncode,
	signal: AbortSignal | undefined
): Promise<Asset> {
	if (signal?.aborted) {
		return Promise.reject(canceled());
	}
	run.waiters++;
	return new Promise<Asset>((resolve, reject) => {
		let settled = false;
		const leave = () => {
			run.waiters--;
			if (run.waiters <= 0) {
				run.controller.abort();
			}
		};
		const onAbort = () => {
			if (settled) {
				return;
			}
			settled = true;
			leave();
			reject(canceled());
		};
		signal?.addEventListener("abort", onAbort, { once: true });
		run.promise.then(
			(value) => {
				if (!settled) {
					settled = true;
					signal?.removeEventListener("abort", onAbort);
					resolve(value);
				}
			},
			(error: unknown) => {
				if (!settled) {
					settled = true;
					signal?.removeEventListener("abort", onAbort);
					reject(error);
				}
			}
		);
	});
}

/**
 * A view of the caller's operation (admission and deadline) whose abort
 * signal belongs to the shared encode instead of the caller.
 */
function sharedOperationView(
	operation: MediaOperation,
	signal: AbortSignal
): EncodeOperation {
	const deadline = Date.now() + operation.remainingMs();
	const combined = AbortSignal.any([
		signal,
		AbortSignal.timeout(Math.max(1, deadline - Date.now())),
	]);
	const check = () => {
		if (Date.now() >= deadline) {
			throw new Error("The complete media operation exceeded its time limit.");
		}
		if (combined.aborted) {
			throw canceled();
		}
	};
	return {
		check,
		remainingMs: () => {
			check();
			return Math.max(1, deadline - Date.now());
		},
		signal: combined,
	};
}

function startEncode(
	store: StudioStore,
	asset: Asset,
	width: number,
	operation: MediaOperation | undefined
): SharedEncode {
	const controller = new AbortController();
	const promise = operation
		? encode(
				store,
				asset,
				width,
				sharedOperationView(operation, controller.signal)
			)
		: withMediaOperation(
				OPERATION_TIMEOUT_MS,
				{ signal: controller.signal },
				async (owned) => await encode(store, asset, width, owned)
			);
	// Waiters observe the rejection; this keeps an abandoned run quiet.
	promise.catch(() => undefined);
	return { controller, promise, waiters: 0 };
}

/**
 * Create (or reuse) the proxy of `asset` for `variant`. The source is never
 * modified; the proxy is stored as a new hidden library asset. Concurrent
 * requests for the same proxy share one FFmpeg run.
 */
export async function createProxy(
	store: StudioStore,
	asset: Asset,
	variant: ProxyVariant = "standard",
	options: ProxyOptions = {}
): Promise<{ asset: Asset; created: boolean }> {
	if (!canProxy(asset)) {
		throw new Error("Only video media can have a proxy.");
	}
	const width = proxyVariantWidth(asset, variant);
	const existing = proxyAt(store.assets(), asset.id, width);
	if (existing) {
		return { asset: existing, created: false };
	}
	const signal = options.operation?.signal ?? options.signal;
	const key = `${store.directory}\u0000${asset.id}\u0000${width}`;
	const running = inflight.get(key);
	if (running && !running.controller.signal.aborted) {
		return { asset: await waitForEncode(running, signal), created: false };
	}
	signal?.throwIfAborted();
	const run = startEncode(store, asset, width, options.operation);
	inflight.set(key, run);
	const forget = () => {
		if (inflight.get(key) === run) {
			inflight.delete(key);
		}
	};
	run.promise.then(forget, forget);
	return { asset: await waitForEncode(run, signal), created: true };
}

async function encode(
	store: StudioStore,
	asset: Asset,
	width: number,
	operation: EncodeOperation
): Promise<Asset> {
	const source = store.mediaPath(asset.id);
	const size = await stat(source).then(
		(metadata) => metadata.size,
		() => 0
	);
	// A proxy is far smaller than its source; reserve a bounded share of it.
	const reservation = store.reserveMediaStorage(
		Math.min(MAX_OUTPUT_BYTES, Math.ceil(size / 2) + 16 * 1024 * 1024)
	);
	const id = crypto.randomUUID();
	const workDirectory = join(store.directory, "media", `.proxy-${id}`);
	const output = join(workDirectory, "proxy.mp4");
	try {
		await mkdir(workDirectory, { recursive: true, mode: 0o700 });
		await runMedia(proxyArgs(source, output, width, asset.hasAudio), {
			cwd: workDirectory,
			signal: operation.signal,
			timeoutMs: operation.remainingMs(),
			outputPath: output,
			maxOutputBytes: MAX_OUTPUT_BYTES,
		});
		operation.check();
		const info = await probe(output, operation.signal);
		operation.check();
		if (info.kind !== "video") {
			throw new Error("The proxy lost its picture.");
		}
		const raced = proxyAt(store.assets(), asset.id, info.width);
		if (raced) {
			return raced;
		}
		const nextInput: Record<string, unknown> = {
			...info,
			createdAt: new Date().toISOString(),
			derivation: "proxy",
			derivedFromAssetId: asset.id,
			id,
			name: `${asset.name.slice(0, 180)} · proxy ${info.width}w`,
		};
		if (asset.folder) {
			nextInput.folder = asset.folder;
		}
		const next = assetSchema.parse(nextInput);
		await rename(output, store.mediaPath(next.id));
		store.putAsset(next);
		await thumbnail(
			store.mediaPath(next.id),
			join(store.directory, "media"),
			next.id,
			operation.signal
		).catch(() => undefined);
		reservation.commit();
		return next;
	} finally {
		await rm(workDirectory, { recursive: true, force: true });
		reservation.release();
	}
}

/**
 * Import hook: create the standard proxy when the setting allows it and the
 * source is heavy. Returns the proxy, or `null` when none is needed.
 */
export async function autoProxyOnImport(
	store: StudioStore,
	asset: Asset,
	options: ProxyOptions = {}
): Promise<Asset | null> {
	if (!(await readProxySettings(store)).autoProxy) {
		return null;
	}
	const bytes = await stat(store.mediaPath(asset.id)).then(
		(metadata) => metadata.size,
		() => 0
	);
	if (!needsProxy(asset, bytes)) {
		return null;
	}
	return (await createProxy(store, asset, "standard", options)).asset;
}

/** Delete proxies whose source asset is gone, with their files. */
export async function pruneOrphanProxies(
	store: StudioStore
): Promise<string[]> {
	const assets = store.assets();
	const ids = new Set(assets.map((asset) => asset.id));
	const orphans = assets.filter(
		(asset) =>
			isProxyAsset(asset) &&
			!(asset.derivedFromAssetId && ids.has(asset.derivedFromAssetId))
	);
	for (const orphan of orphans) {
		store.discardAsset(orphan.id);
		await rm(store.mediaPath(orphan.id), { force: true });
		await rm(join(store.directory, "media", `${orphan.id}.jpg`), {
			force: true,
		});
	}
	return orphans.map((orphan) => orphan.id);
}

export interface ProxySweepFailure {
	assetId: string;
	message: string;
}

export interface ProxySweepResult {
	created: Asset[];
	/** Assets whose proxy could not be made; the sweep carried on. */
	failed: ProxySweepFailure[];
	pruned: string[];
	/** Heavy video still without a proxy after this sweep's limit. */
	remaining: number;
	/** Considered assets that needed no work (light, already proxied, or opted out). */
	skipped: string[];
}

async function mediaBytes(
	store: StudioStore,
	assetId: string
): Promise<number | null> {
	return await stat(store.mediaPath(assetId)).then(
		(metadata) => metadata.size,
		() => null
	);
}

interface SweepPlan {
	failed: ProxySweepFailure[];
	pending: Asset[];
	skipped: string[];
}

/**
 * Sort the considered assets into heavy video that still lacks its standard
 * proxy (`pending`), assets that need nothing (`skipped`), and assets whose
 * media file is gone (`failed`). Done-or-light assets are filtered out before
 * any limit applies, so older heavy video is never starved.
 */
async function planSweep(
	store: StudioStore,
	assetIds: readonly string[] | undefined
): Promise<SweepPlan> {
	const assets = store.assets();
	const wanted = assetIds ? new Set(assetIds) : null;
	const plan: SweepPlan = { failed: [], pending: [], skipped: [] };
	for (const asset of assets) {
		if (wanted ? !wanted.has(asset.id) : !canProxy(asset)) {
			continue;
		}
		if (
			!canProxy(asset) ||
			proxyAt(assets, asset.id, proxyVariantWidth(asset, "standard"))
		) {
			plan.skipped.push(asset.id);
			continue;
		}
		const bytes = await mediaBytes(store, asset.id);
		if (bytes === null) {
			plan.failed.push({
				assetId: asset.id,
				message: "The media file is missing.",
			});
			continue;
		}
		if (needsProxy(asset, bytes)) {
			plan.pending.push(asset);
		} else {
			plan.skipped.push(asset.id);
		}
	}
	return plan;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Create missing standard proxies for heavy video (all of it, or only
 * `assetIds`), and remove proxies whose source was deleted. Honours the
 * opt-out setting: when auto proxies are off nothing is created. One failing
 * asset is reported in `failed` and does not stop the sweep; a canceled
 * sweep, its deadline, or a busy media queue stops it.
 */
export async function sweepProxies(
	store: StudioStore,
	assetIds: readonly string[] | undefined,
	options: { signal?: AbortSignal } = {}
): Promise<ProxySweepResult> {
	const pruned = await pruneOrphanProxies(store);
	const settings = await readProxySettings(store);
	const plan = await planSweep(store, assetIds);
	const batch = plan.pending.slice(0, MAX_PROXY_SWEEP);
	const result: ProxySweepResult = {
		created: [],
		failed: plan.failed,
		pruned,
		remaining: plan.pending.length - batch.length,
		skipped: plan.skipped,
	};
	if (!settings.autoProxy) {
		result.skipped.push(...plan.pending.map((asset) => asset.id));
		result.remaining = 0;
		return result;
	}
	const deadline = AbortSignal.timeout(OPERATION_TIMEOUT_MS);
	const signal = options.signal
		? AbortSignal.any([options.signal, deadline])
		: deadline;
	for (const asset of batch) {
		if (deadline.aborted) {
			throw new Error("The complete media operation exceeded its time limit.");
		}
		if (signal.aborted) {
			throw canceled();
		}
		try {
			const made = await createProxy(store, asset, "standard", { signal });
			if (made.created) {
				result.created.push(made.asset);
			} else {
				result.skipped.push(asset.id);
			}
		} catch (error) {
			if (signal.aborted || error instanceof MediaBusyError) {
				throw error;
			}
			result.failed.push({ assetId: asset.id, message: errorMessage(error) });
		}
	}
	return result;
}
