import { mkdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { type Asset, assetSchema } from "../../shared/project.ts";
import { REVERSE_DURATION_TOLERANCE } from "../../shared/reverse.ts";
import { MEDIA_FORMATS, probe, runMedia, thumbnail } from "./media.ts";
import { type MediaOperation, withMediaOperation } from "./media-operation.ts";
import type { StudioStore } from "./store.ts";

/** Longest source that may be reversed; reversal buffers decoded frames. */
export const MAX_REVERSE_SECONDS = 600;
/** Each FFmpeg `reverse` pass buffers at most this many seconds of frames. */
const CHUNK_SECONDS = 10;
/** Reversed derivatives a single request may render. */
export const MAX_REVERSE_RENDERS = 4;
const OPERATION_TIMEOUT_MS = 30 * 60_000;
const MAX_OUTPUT_BYTES = 10 * 1024 * 1024 * 1024;
const CHUNK_FORMATS = `${MEDIA_FORMATS},concat`;

interface ReverseOptions {
	operation?: MediaOperation;
	signal?: AbortSignal;
}

/**
 * The app-owned reversed derivative already rendered for an asset. A
 * derivative whose duration drifted from its source (an older render that
 * kept decoder padding differences) is ignored so it is rendered again
 * instead of blocking the clip forever.
 */
export function reversedAssetFor(
	assets: readonly Asset[],
	assetId: string
): Asset | undefined {
	const source = assets.find((asset) => asset.id === assetId);
	return assets.find(
		(asset) =>
			asset.derivation === "reverse" &&
			asset.derivedFromAssetId === assetId &&
			(!source ||
				Math.abs(asset.duration - source.duration) <=
					REVERSE_DURATION_TOLERANCE)
	);
}

/** Refuse media that cannot be reversed, before any render starts. */
export function assertReversible(asset: Asset) {
	if (asset.kind === "image") {
		throw new Error("Still images cannot be reversed.");
	}
	if (asset.sequenceProjectId) {
		throw new Error("Refresh nested sequences as media before reversing them.");
	}
	if (asset.derivation === "reverse") {
		throw new Error("This media is already a reversal.");
	}
	if (!(asset.duration > 0) || asset.duration > MAX_REVERSE_SECONDS) {
		throw new Error(
			`Reverse supports media up to ${MAX_REVERSE_SECONDS / 60} minutes long.`
		);
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
];

/** Source byte size bounds the temporary chunks plus the final derivative. */
async function reservationBytes(path: string, duration: number) {
	const size = await stat(path).then(
		(metadata) => metadata.size,
		() => 0
	);
	// PCM audio in chunks dominates for audio sources; video re-encodes near source size.
	const pcm = Math.ceil(duration * 48_000 * 2 * 2);
	return Math.min(MAX_OUTPUT_BYTES, size * 3 + pcm * 2 + 64 * 1024 * 1024);
}

/**
 * Render the whole asset backwards so source time `t` maps to `duration - t`.
 * Work is bounded: FFmpeg reverses at most ten seconds per pass, and the
 * reversed chunks are concatenated last-first into one app-owned derivative.
 * An existing derivative is reused.
 */
export async function reverseAsset(
	store: StudioStore,
	asset: Asset,
	options: ReverseOptions = {}
): Promise<{ asset: Asset; created: boolean }> {
	assertReversible(asset);
	const existing = reversedAssetFor(store.assets(), asset.id);
	if (existing) {
		return { asset: existing, created: false };
	}
	const reversed = await withMediaOperation(
		OPERATION_TIMEOUT_MS,
		options,
		async (operation) => await render(store, asset, operation)
	);
	return { asset: reversed, created: true };
}

function chunkArgs(
	asset: Asset,
	start: number,
	length: number,
	source: string
) {
	const args = [
		...baseArgs,
		"-format_whitelist",
		MEDIA_FORMATS,
		"-ss",
		start.toFixed(6),
		"-t",
		length.toFixed(6),
		"-i",
		source,
	];
	if (asset.kind === "audio") {
		return [
			...args,
			"-vn",
			"-map",
			"0:a:0",
			"-af",
			"areverse",
			"-c:a",
			"pcm_s16le",
			"-ar",
			"48000",
			"-ac",
			"2",
			"-f",
			"wav",
		];
	}
	const audio = asset.hasAudio
		? [
				"-map",
				"0:a:0",
				"-af",
				"areverse",
				"-c:a",
				"pcm_s16le",
				"-ar",
				"48000",
				"-ac",
				"2",
			]
		: ["-an"];
	return [
		...args,
		"-map",
		"0:v:0",
		"-vf",
		"reverse",
		"-c:v",
		"libx264",
		"-preset",
		"veryfast",
		"-crf",
		"18",
		"-pix_fmt",
		"yuv420p",
		...audio,
		"-sn",
		"-dn",
		"-f",
		"matroska",
	];
}

async function render(
	store: StudioStore,
	asset: Asset,
	operation: MediaOperation
): Promise<Asset> {
	const source = store.mediaPath(asset.id);
	const reservation = store.reserveMediaStorage(
		await reservationBytes(source, asset.duration)
	);
	const id = crypto.randomUUID();
	const work = join(store.directory, "media", `.reverse-${id}`);
	const extension = asset.kind === "audio" ? "wav" : "mkv";
	const output = join(work, asset.kind === "audio" ? "out.wav" : "out.mp4");
	try {
		await mkdir(work, { recursive: true, mode: 0o700 });
		const count = Math.ceil(asset.duration / CHUNK_SECONDS - 1e-9);
		const names: string[] = [];
		for (let index = 0; index < count; index++) {
			operation.check();
			const start = index * CHUNK_SECONDS;
			const length = Math.min(CHUNK_SECONDS, asset.duration - start);
			const name = `chunk-${String(index).padStart(3, "0")}.${extension}`;
			const path = join(work, name);
			await runMedia([...chunkArgs(asset, start, length, source), path], {
				cwd: work,
				signal: operation.signal,
				timeoutMs: operation.remainingMs(),
				outputPath: path,
				maxOutputBytes: MAX_OUTPUT_BYTES,
			});
			names.push(name);
		}
		operation.check();
		// Last source chunk plays first: concatenation completes the mirror.
		await Bun.write(
			join(work, "chunks.txt"),
			`${names
				.reverse()
				.map((name) => `file '${name}'`)
				.join("\n")}\n`
		);
		// Decoding drops encoder padding (MP3/AAC priming), so the reversed
		// audio can run short of the probed source. Pad it with silence and
		// trim the whole output to the source duration so source time `t`
		// maps exactly to `duration - t`.
		const duration = asset.duration.toFixed(6);
		const padAudio = ["-af", `apad=whole_dur=${duration}`];
		const encode =
			asset.kind === "audio"
				? ["-map", "0:a:0", ...padAudio, "-c:a", "pcm_s16le", "-f", "wav"]
				: [
						"-map",
						"0:v:0",
						...(asset.hasAudio
							? ["-map", "0:a:0", ...padAudio, "-c:a", "aac", "-b:a", "192k"]
							: []),
						"-c:v",
						"copy",
						"-movflags",
						"+faststart",
						"-f",
						"mp4",
					];
		await runMedia(
			[
				...baseArgs,
				"-format_whitelist",
				CHUNK_FORMATS,
				"-f",
				"concat",
				"-i",
				"chunks.txt",
				...encode,
				"-t",
				duration,
				output,
			],
			{
				cwd: work,
				signal: operation.signal,
				timeoutMs: operation.remainingMs(),
				outputPath: output,
				maxOutputBytes: MAX_OUTPUT_BYTES,
			}
		);
		operation.check();
		const info = await probe(output, operation.signal);
		operation.check();
		if (info.kind !== asset.kind) {
			throw new Error("The reversed media lost its picture or sound.");
		}
		if (Math.abs(info.duration - asset.duration) > REVERSE_DURATION_TOLERANCE) {
			throw new Error("The reversed media does not match its source duration.");
		}
		const existing = reversedAssetFor(store.assets(), asset.id);
		if (existing) {
			return existing;
		}
		const nextInput = {
			...info,
			createdAt: new Date().toISOString(),
			derivation: "reverse",
			derivedFromAssetId: asset.id,
			id,
			name: `${asset.name.slice(0, 188)} · reversed`,
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
		if (next.kind === "video") {
			await thumbnail(
				store.mediaPath(next.id),
				join(store.directory, "media"),
				next.id,
				operation.signal
			).catch(() => undefined);
		}
		reservation.commit();
		return next;
	} finally {
		await rm(work, { recursive: true, force: true });
		reservation.release();
	}
}
