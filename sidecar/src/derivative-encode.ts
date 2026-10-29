/**
 * Shared plumbing for app-owned media derivatives (stabilize, interpolate,
 * enhanced upscale): filter support, the H.264 encode arguments, and the
 * step that turns a finished file into a library asset.
 */
import { rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import {
	type DerivativeFilterSupport,
	type DerivativeSpec,
	derivationOf,
	derivativeName,
	displayedSize,
	findDerivative,
} from "../../shared/derivatives.ts";
import { type Asset, assetSchema } from "../../shared/project.ts";
import {
	ffmpegCapabilities,
	parseFfmpegFilters,
} from "./ffmpeg-capabilities.ts";
import {
	MEDIA_FORMATS,
	probe,
	readProbeFile,
	runMedia,
	thumbnail,
} from "./media.ts";
import type { MediaOperation } from "./media-operation.ts";
import type { StudioStore } from "./store.ts";

export const DERIVATIVE_MAX_OUTPUT_BYTES = 10 * 1024 * 1024 * 1024;

export type FilterLister = () => Promise<string>;

const listFilters: FilterLister = () =>
	runMedia(["-hide_banner", "-filters"], { timeoutMs: 15_000 });

/**
 * Probe which optional filters the derivative builders may use. `cas` and
 * `nlmeans` are not part of `GET /capabilities`, so they are read here.
 */
export async function probeDerivativeFilterSupport(
	list: FilterLister = listFilters,
	tracked: () => Promise<{
		filters: {
			minterpolate: boolean;
			vidstabdetect: boolean;
			vidstabtransform: boolean;
		};
	}> = ffmpegCapabilities
): Promise<DerivativeFilterSupport> {
	const [names, capabilities] = await Promise.all([
		list().then(parseFfmpegFilters, () => new Set<string>()),
		tracked(),
	]);
	return {
		cas: names.has("cas"),
		minterpolate: capabilities.filters.minterpolate,
		nlmeans: names.has("nlmeans"),
		vidstab:
			capabilities.filters.vidstabdetect &&
			capabilities.filters.vidstabtransform,
	};
}

let cachedSupport: Promise<DerivativeFilterSupport> | undefined;

/** Process-wide cached filter support for derivative renders. */
export function derivativeFilterSupport(): Promise<DerivativeFilterSupport> {
	cachedSupport ??= probeDerivativeFilterSupport().catch((error: unknown) => {
		cachedSupport = undefined;
		throw error;
	});
	return cachedSupport;
}

const videoStreamProbeSchema = z.object({
	streams: z
		.array(
			z.object({
				duration: z.union([z.string(), z.number()]).optional(),
				height: z.number().optional(),
				side_data_list: z
					.array(z.object({ rotation: z.number().optional() }))
					.optional(),
				tags: z.record(z.string(), z.string()).optional(),
				width: z.number().optional(),
			})
		)
		.optional(),
});

export interface VideoStreamGeometry {
	/** Video stream duration in seconds (the container's when unmeasured). */
	duration: number;
	/** Displayed (autorotated) frame height. */
	height: number;
	/** Displayed (autorotated) frame width. */
	width: number;
}

/** Read the displayed size and video duration from ffprobe JSON. */
export function parseVideoStreamGeometry(
	output: string,
	fallback: { duration: number; height: number; width: number }
): VideoStreamGeometry {
	const stream = videoStreamProbeSchema.parse(JSON.parse(output)).streams?.[0];
	const width = stream?.width ?? fallback.width;
	const height = stream?.height ?? fallback.height;
	const rotation =
		stream?.side_data_list?.find((entry) => entry.rotation !== undefined)
			?.rotation ?? Number(stream?.tags?.rotate ?? 0);
	const measured = Number(stream?.duration);
	return {
		...displayedSize(width, height, rotation),
		duration:
			Number.isFinite(measured) && measured > 0 ? measured : fallback.duration,
	};
}

/**
 * Probe the first video stream as FFmpeg will decode it: autorotation swaps
 * the coded size for portrait phone footage, and the video stream may end
 * before the container (audio often runs longer).
 */
export async function probeVideoStreamGeometry(
	path: string,
	fallback: { duration: number; height: number; width: number },
	signal?: AbortSignal
): Promise<VideoStreamGeometry> {
	const outputPath = join(
		dirname(path),
		`.ryu-geometry-${crypto.randomUUID()}.json`
	);
	try {
		const stdout = await runMedia(
			[
				"-v",
				"error",
				"-protocol_whitelist",
				"file,pipe",
				"-format_whitelist",
				MEDIA_FORMATS,
				"-select_streams",
				"v:0",
				"-show_entries",
				"stream=width,height,duration:stream_tags=rotate:stream_side_data=rotation",
				"-of",
				"json",
				"-o",
				outputPath,
				path,
			],
			{ outputPath, probe: true, signal }
		);
		const fileOutput = await readProbeFile(outputPath).catch(() => "");
		return parseVideoStreamGeometry(fileOutput || stdout, fallback);
	} finally {
		await rm(outputPath, { force: true });
	}
}

const baseArgs = [
	"-hide_banner",
	"-loglevel",
	"error",
	"-nostdin",
	"-y",
	"-protocol_whitelist",
	"file,pipe",
	"-format_whitelist",
	MEDIA_FORMATS,
];

/** Decode `source` through `filter` and discard the picture (analysis passes). */
export function analysisArgs(source: string, filter: string): string[] {
	return [
		...baseArgs,
		"-i",
		source,
		"-map",
		"0:v:0",
		"-vf",
		filter,
		"-an",
		"-sn",
		"-dn",
		"-f",
		"null",
		"-",
	];
}

/** Decode `source` through `filter` into raw 8-bit gray frames at `output`. */
export function grayFramesArgs(
	source: string,
	filter: string,
	output: string
): string[] {
	return [
		...baseArgs,
		"-i",
		source,
		"-map",
		"0:v:0",
		"-vf",
		filter,
		"-an",
		"-sn",
		"-dn",
		"-f",
		"rawvideo",
		"-pix_fmt",
		"gray",
		output,
	];
}

/**
 * Encode `source` through `filter` into an H.264 MP4 at `output`, keeping the
 * first audio stream (re-encoded to AAC) when the source has one.
 */
export function derivativeVideoArgs(
	source: string,
	output: string,
	filter: string,
	hasAudio: boolean
): string[] {
	const audio = hasAudio
		? ["-map", "0:a:0", "-c:a", "aac", "-b:a", "192k"]
		: ["-an"];
	return [
		...baseArgs,
		"-i",
		source,
		"-map",
		"0:v:0",
		"-vf",
		filter,
		"-c:v",
		"libx264",
		"-preset",
		"medium",
		"-crf",
		"18",
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

/** A derivative render's result: the asset and whether it is new. */
export interface StoredDerivative {
	asset: Asset;
	created: boolean;
}

/**
 * Probe a finished derivative and add it to the library. Without a custom
 * name, a derivative with the same settings that finished meanwhile wins, so
 * concurrent requests end with one asset (reported as not created). A custom
 * name always stores the new render under that name.
 */
export async function storeDerivative(
	store: StudioStore,
	source: Asset,
	spec: DerivativeSpec,
	output: string,
	operation: MediaOperation,
	options: { id: string; name?: string | undefined }
): Promise<StoredDerivative> {
	const info = await probe(output, operation.signal);
	operation.check();
	if (info.kind !== source.kind) {
		throw new Error("The derivative lost its picture.");
	}
	if (options.name === undefined) {
		const raced = findDerivative(store.assets(), source.id, spec);
		if (raced) {
			return { asset: raced, created: false };
		}
	}
	const nextInput: Record<string, unknown> = {
		...info,
		createdAt: new Date().toISOString(),
		derivation: derivationOf(spec),
		derivedFromAssetId: source.id,
		id: options.id,
		name: options.name ?? derivativeName(source.name, spec),
	};
	if (source.folder) {
		nextInput.folder = source.folder;
	}
	if (source.origin) {
		nextInput.origin = source.origin;
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
	return { asset: next, created: true };
}

/** In-flight derivative renders keyed by store, source and settings. */
const inflight = new Map<string, Promise<StoredDerivative>>();

/**
 * Share one render between concurrent requests for the same derivative.
 * Only the request that started the render may report the asset as created.
 */
export async function onceInflight(
	key: string,
	work: () => Promise<StoredDerivative>
): Promise<StoredDerivative> {
	const running = inflight.get(key);
	if (running) {
		return { asset: (await running).asset, created: false };
	}
	const promise = work();
	inflight.set(key, promise);
	try {
		return await promise;
	} finally {
		inflight.delete(key);
	}
}
