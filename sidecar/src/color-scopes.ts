import { rm } from "node:fs/promises";
import { join } from "node:path";
import {
	type ColorScopes,
	type ColorScopesDetail,
	colorScopesDetailSchema,
	colorScopesSchema,
	computeScopeWaveforms,
	DEFAULT_SCOPE_COLUMNS,
	type ScopeWaveforms,
	scopeSampleSize,
	type TimelineScopes,
	timelineScopesSchema,
} from "../../shared/color-scopes.ts";
import type { Asset, Project } from "../../shared/project.ts";
import { renderTimelineFrame } from "./capture.ts";
import { runMedia } from "./media.ts";
import { type MediaOperation, withMediaOperation } from "./media-operation.ts";
import type { StudioStore } from "./store.ts";

interface ScopeOptions {
	operation?: MediaOperation;
	signal?: AbortSignal;
}

function stats(output: string): Map<string, number> {
	const values = new Map<string, number>();
	for (const line of output.split("\n")) {
		const match = line.match(
			/^lavfi\.signalstats\.([A-Z]+)=(-?\d+(?:\.\d+)?)$/
		);
		if (match) {
			values.set(match[1], Number(match[2]));
		}
	}
	return values;
}

const channel = (value: number | undefined) =>
	Number(Math.max(0, Math.min(1, (value ?? 0) / 255)).toFixed(6));

function requireVisual(asset: Asset) {
	if (asset.kind === "audio") {
		throw new Error("Color scopes require an image or video asset.");
	}
}

/** Frame rate assumed when the probe recorded none; low, so the clamp is safe. */
const FALLBACK_SCOPE_FPS = 24;
/** How far before the clamped time the one retry seeks. */
const SCOPE_RETRY_BACKOFF_SECONDS = 0.5;

/**
 * Where to decode the sampled frame. Stills have one frame at zero; a video
 * is clamped to the start of its last frame, because a seek between the last
 * frame's timestamp and the duration (or past it) decodes nothing.
 */
export function scopeSeekTime(
	asset: Pick<Asset, "duration" | "frameRate" | "kind">,
	sampledAt: number
): number {
	if (asset.kind === "image") {
		return 0;
	}
	const frame = 1 / (asset.frameRate ?? FALLBACK_SCOPE_FPS);
	return Math.max(0, Math.min(sampledAt, asset.duration - frame));
}

const NO_FRAME_MESSAGE = "The sampled frame could not be decoded for scopes.";

async function measureSignalStats(
	store: StudioStore,
	asset: Asset,
	sampledAt: number,
	operation: MediaOperation
): Promise<ColorScopes> {
	const seek = scopeSeekTime(asset, sampledAt);
	const attempts =
		asset.kind === "image" || seek === 0
			? [seek]
			: [seek, Math.max(0, seek - SCOPE_RETRY_BACKOFF_SECONDS)];
	for (const attempt of attempts) {
		const values = await readSignalStats(store, asset, attempt, operation);
		if (values.has("YAVG")) {
			return summarize(
				asset,
				values,
				asset.kind === "image" ? Math.min(sampledAt, asset.duration) : attempt
			);
		}
	}
	throw new Error(NO_FRAME_MESSAGE);
}

async function readSignalStats(
	store: StudioStore,
	asset: Asset,
	seek: number,
	operation: MediaOperation
): Promise<Map<string, number>> {
	// Bun's test runner and some embedded Bun hosts do not expose stdout from
	// child processes reliably. Keep the FFmpeg metadata on a private file in
	// the store and read it through Bun, just like the probe path does.
	const metadataFile = `.ryu-scopes-${crypto.randomUUID()}.log`;
	const metadataPath = join(store.directory, metadataFile);
	try {
		const output = await runMedia(
			[
				"-hide_banner",
				"-loglevel",
				"error",
				"-nostdin",
				"-ss",
				String(seek),
				"-i",
				store.mediaPath(asset.id),
				"-vf",
				`signalstats,metadata=print:file=${metadataFile}`,
				"-frames:v",
				"1",
				"-f",
				"null",
				"-",
			],
			{
				cwd: store.directory,
				signal: operation.signal,
				timeoutMs: operation.remainingMs(),
				outputPath: metadataPath,
			}
		);
		operation.check();
		const metadata = await Bun.file(metadataPath).text();
		return stats(metadata || output);
	} finally {
		await rm(metadataPath, { force: true });
	}
}

function summarize(
	asset: Asset,
	values: Map<string, number>,
	sampledAt: number
): ColorScopes {
	return colorScopesSchema.parse({
		assetId: asset.id,
		chroma: {
			u: channel(values.get("UAVG")),
			v: channel(values.get("VAVG")),
		},
		clipping: {
			black: (values.get("YMIN") ?? 255) <= 16,
			white: (values.get("YMAX") ?? 0) >= 235,
		},
		hueDegrees: Number(
			Math.max(0, Math.min(360, values.get("HUEAVG") ?? 0)).toFixed(3)
		),
		luma: {
			average: channel(values.get("YAVG")),
			max: channel(values.get("YMAX")),
			min: channel(values.get("YMIN")),
		},
		sampledAt,
		saturation: {
			average: channel(values.get("SATAVG")),
			max: channel(values.get("SATMAX")),
			min: channel(values.get("SATMIN")),
		},
	});
}

/**
 * Decode one frame of `inputArgs` into downscaled packed RGB and measure its
 * scope arrays. The raw frame goes through a private file in the store for
 * the same stdout reason as the signalstats metadata.
 */
async function sampleScopeWaveforms(
	store: StudioStore,
	inputArgs: string[],
	size: { height: number; width: number },
	columns: number,
	operation: MediaOperation
): Promise<ScopeWaveforms> {
	const rawFile = `.ryu-scopes-${crypto.randomUUID()}.rgb`;
	const rawPath = join(store.directory, rawFile);
	const expected = size.width * size.height * 3;
	try {
		await runMedia(
			[
				"-hide_banner",
				"-loglevel",
				"error",
				"-nostdin",
				"-y",
				...inputArgs,
				"-frames:v",
				"1",
				"-vf",
				`scale=${size.width}:${size.height}:flags=area,format=rgb24`,
				"-f",
				"rawvideo",
				"-pix_fmt",
				"rgb24",
				rawFile,
			],
			{
				cwd: store.directory,
				signal: operation.signal,
				timeoutMs: operation.remainingMs(),
				outputPath: rawPath,
				maxOutputBytes: expected,
			}
		);
		operation.check();
		const rgb = new Uint8Array(await Bun.file(rawPath).arrayBuffer());
		if (rgb.byteLength !== expected) {
			throw new Error(NO_FRAME_MESSAGE);
		}
		return computeScopeWaveforms(rgb, size.width, size.height, columns);
	} finally {
		await rm(rawPath, { force: true });
	}
}

/** Signal statistics for one sampled frame of an image or video asset. */
export async function inspectColorAsset(
	store: StudioStore,
	asset: Asset,
	sampledAt: number,
	options: ScopeOptions = {}
): Promise<ColorScopes> {
	requireVisual(asset);
	return await withMediaOperation(60_000, options, (operation) =>
		measureSignalStats(store, asset, sampledAt, operation)
	);
}

/**
 * Signal statistics plus histogram, RGB parade, and vectorscope arrays for
 * one sampled frame of an image or video asset, under one media admission.
 */
export async function inspectColorAssetDetail(
	store: StudioStore,
	asset: Asset,
	sampledAt: number,
	columns = DEFAULT_SCOPE_COLUMNS,
	options: ScopeOptions = {}
): Promise<ColorScopesDetail> {
	requireVisual(asset);
	return await withMediaOperation(60_000, options, async (operation) => {
		const summary = await measureSignalStats(
			store,
			asset,
			sampledAt,
			operation
		);
		const waveforms = await sampleScopeWaveforms(
			store,
			[
				"-ss",
				// The summary already found a decodable frame; sample the same one.
				String(asset.kind === "image" ? 0 : summary.sampledAt),
				"-i",
				store.mediaPath(asset.id),
			],
			scopeSampleSize(asset.width, asset.height),
			columns,
			operation
		);
		return colorScopesDetailSchema.parse({ ...summary, waveforms });
	});
}

/**
 * Scope arrays for the composited timeline frame at `time`, computed from
 * the same render `inspect-frame` returns.
 */
export async function inspectTimelineScopes(
	store: StudioStore,
	project: Project,
	time: number,
	columns = DEFAULT_SCOPE_COLUMNS,
	options: ScopeOptions = {}
): Promise<TimelineScopes> {
	return await withMediaOperation(60_000, options, async (operation) => {
		const frame = await renderTimelineFrame(store, project, time, {
			operation,
		});
		const pngFile = `.ryu-scopes-${crypto.randomUUID()}.png`;
		const pngPath = join(store.directory, pngFile);
		try {
			await Bun.write(pngPath, frame);
			const waveforms = await sampleScopeWaveforms(
				store,
				["-i", pngFile],
				scopeSampleSize(project.width, project.height),
				columns,
				operation
			);
			return timelineScopesSchema.parse({
				projectId: project.id,
				revision: project.revision,
				time,
				waveforms,
			});
		} finally {
			await rm(pngPath, { force: true });
		}
	});
}
