/**
 * Prepare bounded reference inputs for generation models (clip, frame and
 * audio extracts) and serve them back in chunks. Extracts live in a private
 * work folder under the media directory, are never added to the library,
 * and are deleted once read to the end or after `GENERATION_INPUT_TTL_MS`.
 */
import { mkdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import {
	assetFrameCount,
	assetFrameRate,
	boundedClipRange,
	boundedClipSize,
	frameSeekTime,
	GENERATION_INPUT_TTL_MS,
	type GenerationInput,
	type GenerationInputRequest,
	type GenerationInputRequestInput,
	generationInputRequestSchema,
	generationInputSchema,
	INPUT_CLIP_CRF,
	KEYFRAME_EDGE,
	MAX_INPUT_AUDIO_BYTES,
	MAX_INPUT_AUDIO_SECONDS,
	MAX_INPUT_CLIP_BYTES,
	MAX_INPUT_FRAME_BYTES,
} from "../../shared/generation-inputs.ts";
import type { Asset } from "../../shared/project.ts";
import { MEDIA_FORMATS, runMedia } from "./media.ts";
import { type MediaOperation, withMediaOperation } from "./media-operation.ts";
import type { StudioStore } from "./store.ts";

const OPERATION_TIMEOUT_MS = 5 * 60_000;
/** Bytes per chunked read, matching the media read routes. */
export const GENERATION_INPUT_CHUNK = 512 * 1024;

interface StoredInput {
	createdAt: number;
	input: GenerationInput;
	path: string;
}

const prepared = new Map<string, StoredInput>();

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

function workFolder(store: StudioStore): string {
	return join(store.directory, "media", ".generation-inputs");
}

async function sweepExpired(now = Date.now()): Promise<void> {
	for (const [id, stored] of prepared) {
		if (now - stored.createdAt > GENERATION_INPUT_TTL_MS) {
			prepared.delete(id);
			await rm(stored.path, { force: true });
		}
	}
}

/** FFmpeg arguments for a bounded H.264 clip extract (output appended). */
export function clipInputArgs(
	source: string,
	range: { end: number; start: number },
	size: { height: number; width: number },
	audio: boolean
): string[] {
	return [
		...baseArgs,
		"-ss",
		range.start.toFixed(6),
		"-t",
		(range.end - range.start).toFixed(6),
		"-i",
		source,
		"-map",
		"0:v:0",
		...(audio
			? ["-map", "0:a:0?", "-c:a", "aac", "-b:a", "96k", "-ac", "2"]
			: ["-an"]),
		"-sn",
		"-dn",
		"-vf",
		`scale=${size.width}:${size.height}:flags=bicubic,setsar=1,format=yuv420p`,
		"-c:v",
		"libx264",
		"-preset",
		"veryfast",
		"-crf",
		String(INPUT_CLIP_CRF),
		"-movflags",
		"+faststart",
		"-f",
		"mp4",
	];
}

/**
 * FFmpeg arguments that write exactly frame `index` of `asset` (output
 * appended). Accurate input seeking drops every frame before the seek time,
 * and the seek lands a quarter frame before the wanted frame.
 */
export function frameInputArgs(
	source: string,
	asset: Pick<Asset, "frameRate" | "kind">,
	index: number,
	format: "png" | "jpeg",
	maxEdge?: number
): string[] {
	const seek =
		asset.kind === "video"
			? ["-ss", frameSeekTime(asset, index).toFixed(6)]
			: [];
	const scale = maxEdge
		? [
				"-vf",
				`scale=w='min(${maxEdge},iw)':h='min(${maxEdge},ih)':force_original_aspect_ratio=decrease`,
			]
		: [];
	return [
		...baseArgs,
		...seek,
		"-i",
		source,
		"-map",
		"0:v:0",
		"-frames:v",
		"1",
		...scale,
		...(format === "png"
			? ["-c:v", "png", "-f", "image2"]
			: ["-c:v", "mjpeg", "-q:v", "4", "-pix_fmt", "yuvj420p", "-f", "image2"]),
	];
}

/** FFmpeg arguments for an AAC-in-MP4 audio extract (output appended). */
export function audioInputArgs(
	source: string,
	range: { end: number; start: number }
): string[] {
	return [
		...baseArgs,
		"-ss",
		range.start.toFixed(6),
		"-t",
		(range.end - range.start).toFixed(6),
		"-i",
		source,
		"-map",
		"0:a:0",
		"-vn",
		"-c:a",
		"aac",
		"-b:a",
		"128k",
		"-ac",
		"2",
		"-ar",
		"48000",
		"-movflags",
		"+faststart",
		"-f",
		"mp4",
	];
}

interface PlannedInput {
	args: string[];
	end: number;
	extension: string;
	frame?: number;
	height?: number;
	maxBytes: number;
	mediaType: GenerationInput["mediaType"];
	start: number;
	width?: number;
}

/** Plan one extract for `asset`, refusing requests the media cannot serve. */
export function planGenerationInput(
	source: string,
	asset: Asset,
	request: GenerationInputRequest,
	options: { maxEdge?: number } = {}
): PlannedInput {
	if (asset.sequenceProjectId) {
		throw new Error(
			"Refresh nested sequences as media before sending them to a model."
		);
	}
	if (request.kind === "clip") {
		if (asset.kind !== "video") {
			throw new Error("Only video clips can be sent as a source clip.");
		}
		const range = boundedClipRange(asset, request.start, request.end);
		const size = boundedClipSize(asset.width, asset.height);
		return {
			args: clipInputArgs(source, range, size, request.audio && asset.hasAudio),
			end: range.end,
			extension: "mp4",
			height: size.height,
			maxBytes: MAX_INPUT_CLIP_BYTES,
			mediaType: "video/mp4",
			start: range.start,
			width: size.width,
		};
	}
	if (request.kind === "audio") {
		if (!(asset.kind === "audio" || asset.hasAudio)) {
			throw new Error("This media has no audio to send.");
		}
		const range = boundedClipRange(
			asset,
			request.start,
			request.end,
			MAX_INPUT_AUDIO_SECONDS
		);
		return {
			args: audioInputArgs(source, range),
			end: range.end,
			extension: "m4a",
			maxBytes: MAX_INPUT_AUDIO_BYTES,
			mediaType: "audio/mp4",
			start: range.start,
		};
	}
	if (asset.kind === "audio") {
		throw new Error("Audio has no picture frame to send.");
	}
	const frame =
		asset.kind === "video"
			? Math.min(request.frame, assetFrameCount(asset) - 1)
			: 0;
	const time = asset.kind === "video" ? frame / assetFrameRate(asset) : 0;
	return {
		args: frameInputArgs(source, asset, frame, request.format, options.maxEdge),
		end: time,
		extension: request.format === "png" ? "png" : "jpg",
		frame,
		maxBytes: MAX_INPUT_FRAME_BYTES,
		mediaType: request.format === "png" ? "image/png" : "image/jpeg",
		start: time,
	};
}

/**
 * Write one bounded extract of `asset` and register it for chunked reads.
 * An extract larger than its limit is deleted and refused with a reason.
 */
export async function prepareGenerationInput(
	store: StudioStore,
	asset: Asset,
	input: GenerationInputRequestInput,
	options: {
		maxEdge?: number;
		operation?: MediaOperation;
		signal?: AbortSignal;
	} = {}
): Promise<GenerationInput> {
	const request = generationInputRequestSchema.parse(input);
	await sweepExpired();
	const id = crypto.randomUUID();
	const plan = planGenerationInput(store.mediaPath(asset.id), asset, request, {
		maxEdge: options.maxEdge,
	});
	const folder = workFolder(store);
	const output = join(folder, `${id}.${plan.extension}`);
	return await withMediaOperation(
		OPERATION_TIMEOUT_MS,
		options,
		async (operation) => {
			await mkdir(folder, { recursive: true, mode: 0o700 });
			try {
				await runMedia([...plan.args, output], {
					cwd: folder,
					maxOutputBytes: plan.maxBytes,
					outputPath: output,
					signal: operation.signal,
					timeoutMs: operation.remainingMs(),
				});
			} catch (error) {
				await rm(output, { force: true });
				const message = error instanceof Error ? error.message : String(error);
				if (/output budget/i.test(message)) {
					throw new Error(
						`The extract is larger than the ${Math.round(plan.maxBytes / (1024 * 1024))} MiB a model request can carry. Send a shorter range.`
					);
				}
				throw error;
			}
			operation.check();
			const size = await stat(output).then(
				(metadata) => metadata.size,
				() => 0
			);
			if (!size) {
				await rm(output, { force: true });
				throw new Error("Nothing could be extracted from this media range.");
			}
			if (size > plan.maxBytes) {
				await rm(output, { force: true });
				throw new Error(
					`The extract is larger than the ${Math.round(plan.maxBytes / (1024 * 1024))} MiB a model request can carry. Send a shorter range.`
				);
			}
			const result: GenerationInput = {
				end: plan.end,
				id,
				mediaType: plan.mediaType,
				size,
				start: plan.start,
			};
			if (plan.width !== undefined && plan.height !== undefined) {
				result.width = plan.width;
				result.height = plan.height;
			}
			if (plan.frame !== undefined) {
				result.frame = plan.frame;
			}
			const parsed = generationInputSchema.parse(result);
			prepared.set(id, { createdAt: Date.now(), input: parsed, path: output });
			return parsed;
		}
	);
}

/** Exact frame `index` of `asset` as a small JPEG for vision models. */
export function prepareKeyframe(
	store: StudioStore,
	asset: Asset,
	index: number,
	options: { operation?: MediaOperation; signal?: AbortSignal } = {}
): Promise<GenerationInput> {
	return prepareGenerationInput(
		store,
		asset,
		{ format: "jpeg", frame: index, kind: "frame" },
		{ ...options, maxEdge: KEYFRAME_EDGE }
	);
}

/** Bytes of a prepared input, base64-encoded; deleted after the last chunk. */
export async function readGenerationInputChunk(
	id: string,
	offset: number
): Promise<{
	data: string;
	done: boolean;
	offset: number;
	size: number;
	mediaType: string;
}> {
	const stored = prepared.get(id);
	if (!stored) {
		throw new Error("This model input expired. Prepare it again.");
	}
	const file = Bun.file(stored.path);
	const size = file.size;
	if (offset > size) {
		throw new Error("Offset exceeds file size.");
	}
	const data = Buffer.from(
		await file.slice(offset, offset + GENERATION_INPUT_CHUNK).arrayBuffer()
	).toString("base64");
	const done = offset + GENERATION_INPUT_CHUNK >= size;
	if (done) {
		prepared.delete(id);
		await rm(stored.path, { force: true });
	}
	return { data, done, mediaType: stored.input.mediaType, offset, size };
}

/** Read a prepared input whole (sidecar-internal use, then discard it). */
export async function takeGenerationInput(id: string): Promise<Uint8Array> {
	const stored = prepared.get(id);
	if (!stored) {
		throw new Error("This model input expired. Prepare it again.");
	}
	prepared.delete(id);
	try {
		return new Uint8Array(await Bun.file(stored.path).arrayBuffer());
	} finally {
		await rm(stored.path, { force: true });
	}
}

/** Discard a prepared input. Returns whether it existed. */
export async function discardGenerationInput(id: string): Promise<boolean> {
	const stored = prepared.get(id);
	if (!stored) {
		return false;
	}
	prepared.delete(id);
	await rm(stored.path, { force: true });
	return true;
}
