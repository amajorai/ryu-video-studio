/**
 * Apply an AI subject matte (G46) to library media with FFmpeg `alphamerge`.
 * Stills become a PNG with alpha; clips become ProRes 4444 with alpha, the
 * same transparent derivative format the static-background cutout writes
 * (`cutout.ts`), so the renderer and exports decode both the same way. A
 * matted clip also gets a VP9 alpha preview copy (`alpha-preview.ts`), since
 * browsers cannot decode ProRes.
 */
import { mkdir, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
	type AiMatteInput,
	aiMatteFilterGraph,
	aiMatteRequestSchema,
	assertAiMattePair,
	type MatteSource,
	pixelFormatHasAlpha,
} from "../../shared/ai-matte.ts";
import {
	CUTOUT_PEAK_BYTES,
	cutoutCodecFor,
	cutoutMaxSeconds,
	cutoutOutputBytes,
} from "../../shared/keying.ts";
import { type Asset, assetSchema } from "../../shared/project.ts";
import { encodeAlphaPreview } from "./alpha-preview.ts";
import { ffmpegCapabilities } from "./ffmpeg-capabilities.ts";
import { MEDIA_FORMATS, probe, runMedia, thumbnail } from "./media.ts";
import { type MediaOperation, withMediaOperation } from "./media-operation.ts";
import type { StudioStore } from "./store.ts";

const OPERATION_TIMEOUT_MS = 20 * 60_000;
const MAX_STILL_BYTES = 256 * 1024 * 1024;
const RESERVATION_SLACK_BYTES = 64 * 1024 * 1024;
const DURATION_TOLERANCE = 0.25;

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

interface AiMatteOptions {
	encoders?: Readonly<Partial<Record<string, boolean>>>;
	operation?: MediaOperation;
	signal?: AbortSignal;
}

/** The first video stream's pixel format, as ffprobe names it. */
export async function probePixelFormat(
	path: string,
	signal?: AbortSignal
): Promise<string> {
	const output = join(dirname(path), `.ryu-pixfmt-${crypto.randomUUID()}.txt`);
	try {
		await runMedia(
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
				"stream=pix_fmt",
				"-of",
				"csv=p=0",
				"-o",
				output,
				path,
			],
			{ probe: true, signal }
		);
		return (await Bun.file(output).text()).trim();
	} finally {
		await rm(output, { force: true });
	}
}

/** FFmpeg arguments for a matted still or clip (output path appended). */
export function aiMatteArgs(input: {
	matte: string;
	range: { end: number; start: number };
	source: string;
	sourceAsset: Pick<Asset, "hasAudio" | "height" | "kind" | "width">;
	matteSource: MatteSource;
	invert: boolean;
}): string[] {
	const video = input.sourceAsset.kind === "video";
	const graph = aiMatteFilterGraph({
		height: input.sourceAsset.height,
		invert: input.invert,
		source: input.matteSource,
		video,
		width: input.sourceAsset.width,
	});
	if (!video) {
		return [
			...baseArgs,
			"-i",
			input.source,
			"-i",
			input.matte,
			"-filter_complex",
			graph,
			"-map",
			"[out]",
			"-frames:v",
			"1",
			"-c:v",
			"png",
			"-f",
			"image2",
		];
	}
	const length = (input.range.end - input.range.start).toFixed(6);
	const audio = input.sourceAsset.hasAudio
		? ["-map", "0:a:0?", "-c:a", "aac", "-b:a", "192k"]
		: ["-an"];
	return [
		...baseArgs,
		"-ss",
		input.range.start.toFixed(6),
		"-t",
		length,
		"-i",
		input.source,
		"-t",
		length,
		"-i",
		input.matte,
		"-filter_complex",
		graph,
		"-map",
		"[out]",
		...audio,
		"-sn",
		"-dn",
		"-t",
		length,
		"-c:v",
		"prores_ks",
		"-profile:v",
		"4444",
		"-pix_fmt",
		"yuva444p10le",
		"-f",
		"mov",
	];
}

/**
 * Create a transparent derivative of `asset` from the matte asset named in
 * the request. The source and the matte are never modified.
 */
export async function aiMatteAsset(
	store: StudioStore,
	asset: Asset,
	input: AiMatteInput,
	options: AiMatteOptions = {}
): Promise<Asset> {
	const request = aiMatteRequestSchema.parse(input);
	const matte = store.assets().find((item) => item.id === request.matteAssetId);
	if (!matte) {
		throw new Error("The matte is no longer in the library.");
	}
	const range = assertAiMattePair(asset, matte, request);
	let encoders: Readonly<Partial<Record<string, boolean>>> = {};
	if (asset.kind === "video") {
		const maxSeconds = cutoutMaxSeconds(asset);
		if (range.end - range.start > maxSeconds) {
			throw new Error(
				`Matted ${asset.width}×${asset.height} clips are limited to ${maxSeconds} s (the transparent ProRes 4444 copy is large).`
			);
		}
		encoders = options.encoders ?? (await ffmpegCapabilities()).encoders;
		cutoutCodecFor(encoders);
	}
	return await withMediaOperation(
		OPERATION_TIMEOUT_MS,
		options,
		async (operation) => {
			const video = asset.kind === "video";
			const outputBytes = video
				? Math.min(
						CUTOUT_PEAK_BYTES / 2,
						cutoutOutputBytes({ ...asset, duration: range.end - range.start })
					)
				: MAX_STILL_BYTES;
			const reservation = store.reserveMediaStorage(
				outputBytes + RESERVATION_SLACK_BYTES
			);
			const id = crypto.randomUUID();
			const work = join(store.directory, "media", `.ai-matte-${id}`);
			const output = join(work, video ? "out.mov" : "out.png");
			try {
				await mkdir(work, { recursive: true, mode: 0o700 });
				const mattePath = store.mediaPath(matte.id);
				const matteSource: MatteSource = pixelFormatHasAlpha(
					await probePixelFormat(mattePath, operation.signal)
				)
					? "alpha"
					: "luma";
				operation.check();
				await runMedia(
					[
						...aiMatteArgs({
							invert: request.invert,
							matte: mattePath,
							matteSource,
							range,
							source: store.mediaPath(asset.id),
							sourceAsset: asset,
						}),
						output,
					],
					{
						cwd: work,
						maxOutputBytes: outputBytes,
						outputPath: output,
						signal: operation.signal,
						timeoutMs: operation.remainingMs(),
					}
				);
				operation.check();
				const info = await probe(output, operation.signal);
				operation.check();
				if (info.kind !== asset.kind) {
					throw new Error("The matted copy lost its picture.");
				}
				if (
					video &&
					Math.abs(info.duration - (range.end - range.start)) >
						DURATION_TOLERANCE
				) {
					throw new Error("The matted copy does not match the matte's length.");
				}
				const suffix = request.invert ? "background" : "subject";
				const nextInput = {
					...info,
					...(video ? {} : { duration: asset.duration }),
					createdAt: new Date().toISOString(),
					derivation: "ai-matte",
					derivedFromAssetId: asset.id,
					id,
					name:
						request.name ?? `${asset.name.slice(0, 180)} · AI ${suffix} matte`,
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
				await thumbnail(
					store.mediaPath(next.id),
					join(store.directory, "media"),
					next.id,
					operation.signal
				).catch(() => undefined);
				reservation.commit();
				if (video) {
					// Browsers cannot decode the ProRes master: give the preview a
					// VP9 copy that keeps the alpha.
					await encodeAlphaPreview(store, next, {
						encoders,
						operation,
						workDirectory: work,
					});
				}
				return next;
			} finally {
				await rm(work, { force: true, recursive: true });
				reservation.release();
			}
		}
	);
}
