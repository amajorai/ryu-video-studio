import { mkdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import {
	backgroundKeyFilter,
	CUTOUT_PEAK_BYTES,
	type CutoutInput,
	type CutoutRequest,
	cutoutCodecFor,
	cutoutMaxSeconds,
	cutoutOutputBytes,
	cutoutRequestSchema,
} from "../../shared/keying.ts";
import { type Asset, assetSchema } from "../../shared/project.ts";
import { encodeAlphaPreview } from "./alpha-preview.ts";
import { ffmpegCapabilities } from "./ffmpeg-capabilities.ts";
import { MEDIA_FORMATS, probe, runMedia, thumbnail } from "./media.ts";
import { type MediaOperation, withMediaOperation } from "./media-operation.ts";
import type { StudioStore } from "./store.ts";

/**
 * Static-camera background removal (W2-V4). A clean-plate frame (the same
 * shot with nobody in it) is placed before each chunk of the clip, FFmpeg's
 * `backgroundkey` turns every pixel that still matches it transparent, and
 * the plate frame is trimmed off again. Work is bounded like `reverse.ts`:
 * at most ten seconds per FFmpeg pass, then the chunks are concatenated
 * without re-encoding into one app-owned derivative with
 * `derivation: "cutout"`. The derivative is ProRes 4444 (`yuva444p10le`),
 * whose alpha the renderer decodes; VP9 is refused because FFmpeg's default
 * VP9 decoder drops alpha. The longest accepted source depends on its
 * resolution and frame rate (`cutoutMaxSeconds`), so the chunks plus the
 * joined file fit `CUTOUT_PEAK_BYTES`.
 */

/** Seconds of source each FFmpeg pass keys. */
export const CUTOUT_CHUNK_SECONDS = 10;
const OPERATION_TIMEOUT_MS = 30 * 60_000;
/** Hard cap on any one output (each chunk, and the joined derivative). */
const MAX_OUTPUT_BYTES = CUTOUT_PEAK_BYTES / 2;
const RESERVATION_SLACK_BYTES = 64 * 1024 * 1024;
const CHUNK_FORMATS = `${MEDIA_FORMATS},concat`;
/** Seconds of tolerance between the derivative and its source duration. */
const DURATION_TOLERANCE = 0.25;

const baseArgs = [
	"-hide_banner",
	"-loglevel",
	"error",
	"-nostdin",
	"-y",
	"-protocol_whitelist",
	"file,pipe",
];

interface CutoutOptions {
	/** Encoders available on this node; probed when omitted. */
	encoders?: Readonly<Partial<Record<string, boolean>>>;
	operation?: MediaOperation;
	signal?: AbortSignal;
}

export interface CutoutChunk {
	length: number;
	start: number;
}

/** Contiguous chunks that cover `duration` seconds. */
export function cutoutChunks(
	duration: number,
	chunkSeconds = CUTOUT_CHUNK_SECONDS
): CutoutChunk[] {
	const count = Math.max(1, Math.ceil(duration / chunkSeconds - 1e-9));
	const chunks: CutoutChunk[] = [];
	for (let index = 0; index < count; index++) {
		const start = index * chunkSeconds;
		chunks.push({ length: Math.min(chunkSeconds, duration - start), start });
	}
	return chunks;
}

/** Refuse media that cannot be cut out, before any render starts. */
export function assertCutoutSource(asset: Asset, request: CutoutRequest) {
	if (asset.kind !== "video") {
		throw new Error("Background cutout needs a video clip.");
	}
	if (asset.sequenceProjectId) {
		throw new Error(
			"Refresh nested sequences as media before cutting them out."
		);
	}
	if (asset.derivation === "cutout") {
		throw new Error("This media is already a cutout.");
	}
	const maxSeconds = cutoutMaxSeconds(asset);
	if (!(asset.duration > 0) || asset.duration > maxSeconds) {
		throw new Error(
			`Background cutout supports ${asset.width}×${asset.height} media up to ${formatSeconds(maxSeconds)} long (its transparent ProRes 4444 copy is large); trim or split the clip first.`
		);
	}
	if (request.cleanPlateTime >= asset.duration) {
		throw new Error("Choose a clean plate time inside the media.");
	}
}

/** Whole minutes and seconds, for the length limit message. */
function formatSeconds(seconds: number): string {
	const minutes = Math.floor(seconds / 60);
	const rest = seconds % 60;
	if (minutes === 0) {
		return `${rest} seconds`;
	}
	return rest === 0 ? `${minutes} min` : `${minutes} min ${rest} s`;
}

const codecArgs = [
	"-c:v",
	"prores_ks",
	"-profile:v",
	"4444",
	"-pix_fmt",
	"yuva444p10le",
	"-f",
	"mov",
];

/** The filtergraph keying one chunk against the clean-plate frame. */
export function cutoutFilterGraph(request: CutoutRequest): string {
	return [
		"[0:v]trim=end_frame=1,setpts=PTS-STARTPTS,setsar=1,format=yuva444p[plate]",
		"[1:v]setpts=PTS-STARTPTS,setsar=1,format=yuva444p[clip]",
		`[plate][clip]concat=n=2:v=1:a=0,${backgroundKeyFilter(request)},trim=start_frame=1,setpts=PTS-STARTPTS[cutout]`,
	].join(";");
}

/** FFmpeg arguments for one keyed chunk (the output path is appended). */
export function cutoutChunkArgs(
	source: string,
	request: CutoutRequest,
	chunk: CutoutChunk
): string[] {
	return [
		...baseArgs,
		"-format_whitelist",
		MEDIA_FORMATS,
		"-ss",
		request.cleanPlateTime.toFixed(6),
		"-i",
		source,
		"-ss",
		chunk.start.toFixed(6),
		"-t",
		chunk.length.toFixed(6),
		"-i",
		source,
		"-filter_complex",
		cutoutFilterGraph(request),
		"-map",
		"[cutout]",
		"-an",
		"-sn",
		"-dn",
		...codecArgs,
	];
}

/**
 * FFmpeg arguments that join the keyed chunks (listed in `chunks.txt`) and
 * carry the source's first audio stream as AAC, when it has one.
 */
export function cutoutConcatArgs(
	source: string,
	asset: Pick<Asset, "duration" | "hasAudio">
): string[] {
	const audio = asset.hasAudio
		? ["-map", "1:a:0", "-c:a", "aac", "-b:a", "192k"]
		: [];
	return [
		...baseArgs,
		"-format_whitelist",
		CHUNK_FORMATS,
		"-f",
		"concat",
		"-i",
		"chunks.txt",
		...(audio.length > 0 ? ["-i", source] : []),
		"-map",
		"0:v:0",
		...audio,
		"-c:v",
		"copy",
		"-t",
		asset.duration.toFixed(6),
		"-movflags",
		"+faststart",
		"-f",
		"mov",
	];
}

/**
 * Bytes to reserve for the run's peak: every chunk plus the joined file
 * (about twice the derivative), with slack for audio and container overhead.
 * `assertCutoutSource` keeps this within `CUTOUT_PEAK_BYTES`; it is not
 * clamped, so an oversized request fails admission instead of the disk.
 */
export function cutoutReservationBytes(
	asset: Pick<
		Asset,
		"duration" | "frameRate" | "height" | "timecodeFrameRate" | "width"
	>
): number {
	return 2 * cutoutOutputBytes(asset) + RESERVATION_SLACK_BYTES;
}

/**
 * Create an app-owned cutout derivative of a static-camera video. The source
 * asset is never modified; swap a clip onto the result with
 * `swap-clip-media`.
 */
export async function cutoutAsset(
	store: StudioStore,
	asset: Asset,
	input: CutoutInput,
	options: CutoutOptions = {}
): Promise<Asset> {
	const request = cutoutRequestSchema.parse(input);
	assertCutoutSource(asset, request);
	const encoders = options.encoders ?? (await ffmpegCapabilities()).encoders;
	cutoutCodecFor(encoders);
	return await withMediaOperation(
		OPERATION_TIMEOUT_MS,
		options,
		async (operation) =>
			await render(store, asset, request, operation, encoders)
	);
}

async function render(
	store: StudioStore,
	asset: Asset,
	request: CutoutRequest,
	operation: MediaOperation,
	encoders: Readonly<Partial<Record<string, boolean>>>
): Promise<Asset> {
	const source = store.mediaPath(asset.id);
	const reservation = store.reserveMediaStorage(cutoutReservationBytes(asset));
	const id = crypto.randomUUID();
	const work = join(store.directory, "media", `.cutout-${id}`);
	const output = join(work, "out.mov");
	try {
		await mkdir(work, { recursive: true, mode: 0o700 });
		const names: string[] = [];
		for (const [index, chunk] of cutoutChunks(asset.duration).entries()) {
			operation.check();
			const name = `chunk-${String(index).padStart(3, "0")}.mov`;
			const path = join(work, name);
			await runMedia([...cutoutChunkArgs(source, request, chunk), path], {
				cwd: work,
				maxOutputBytes: MAX_OUTPUT_BYTES,
				outputPath: path,
				signal: operation.signal,
				timeoutMs: operation.remainingMs(),
			});
			names.push(name);
		}
		operation.check();
		await Bun.write(
			join(work, "chunks.txt"),
			`${names.map((name) => `file '${name}'`).join("\n")}\n`
		);
		await runMedia([...cutoutConcatArgs(source, asset), output], {
			cwd: work,
			maxOutputBytes: MAX_OUTPUT_BYTES,
			outputPath: output,
			signal: operation.signal,
			timeoutMs: operation.remainingMs(),
		});
		// The joined file is all that is kept; free the chunks before probing.
		await Promise.all(
			names.map((name) => rm(join(work, name), { force: true }))
		);
		operation.check();
		const info = await probe(output, operation.signal);
		operation.check();
		if (info.kind !== "video") {
			throw new Error("The cutout lost its picture.");
		}
		if (Math.abs(info.duration - asset.duration) > DURATION_TOLERANCE) {
			throw new Error("The cutout does not match its source duration.");
		}
		const nextInput = {
			...info,
			createdAt: new Date().toISOString(),
			derivation: "cutout",
			derivedFromAssetId: asset.id,
			id,
			name: request.name ?? `${asset.name.slice(0, 190)} · cutout`,
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
		// Browsers cannot decode the ProRes master: give the preview a VP9 copy
		// that keeps the alpha.
		await encodeAlphaPreview(store, next, {
			encoders,
			operation,
			workDirectory: work,
		});
		return next;
	} finally {
		await rm(work, { force: true, recursive: true });
		reservation.release();
	}
}
