import { spawn } from "node:child_process";
import { access, mkdir, open, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { parseProbeFrameRate } from "../../shared/frame-rate.ts";
import { type Asset, assetTimecodeSchema } from "../../shared/project.ts";
import {
	filterScriptArgs,
	killMediaProcess,
	LEGACY_FILTER_SCRIPT_OPTION,
} from "./media-process.ts";

// Explicit paths are deployment wiring. Inputs can never select a program or command.
export const MEDIA_FORMATS =
	"mov,matroska,webm,mp3,wav,flac,ogg,aac,png_pipe,jpeg_pipe,webp_pipe,bmp_pipe";
const MAX_PROBE_BYTES = 8_000_000;
export const MAX_THUMBNAIL_BYTES = 16 * 1024 * 1024;

const probeDurationSchema = z.union([z.string(), z.number()]);
const probeTagsSchema = z.record(z.string(), z.string());
const probeOutputSchema = z.object({
	format: z
		.object({
			duration: probeDurationSchema.optional(),
			tags: probeTagsSchema.optional(),
		})
		.optional(),
	streams: z
		.array(
			z.object({
				codec_type: z.string().optional(),
				width: z.number().optional(),
				height: z.number().optional(),
				duration: probeDurationSchema.optional(),
				codec_name: z.string().optional(),
				avg_frame_rate: z.string().optional(),
				r_frame_rate: z.string().optional(),
				color_transfer: z.string().optional(),
				tags: probeTagsSchema.optional(),
			})
		)
		.optional(),
});
/**
 * FFprobe `color_transfer` names grouped into the asset's transfer families.
 * SDR curves that share the BT.709 shape (including BT.601 and the BT.2020
 * SDR curves) are `bt709`; PQ and HLG mark HDR sources; anything else that
 * is reported but not recognised is `unknown`.
 */
const transferFamilies: Record<string, NonNullable<Asset["colorTransfer"]>> = {
	"arib-std-b67": "hlg",
	bt709: "bt709",
	"bt2020-10": "bt709",
	"bt2020-12": "bt709",
	smpte170m: "bt709",
	smpte2084: "pq",
};

/** Map a probed transfer name; absent or `unknown` probes leave it unset. */
export function probeColorTransfer(
	value: string | undefined
): Asset["colorTransfer"] {
	const name = value?.trim().toLowerCase();
	if (!name || name === "unknown") {
		return;
	}
	return transferFamilies[name] ?? "unknown";
}

/**
 * The stream's frame rate. `r_frame_rate` is the exact timebase rate
 * (30000/1001) and is preferred; `avg_frame_rate` stands in when the real
 * rate is missing, out of range, or more than 1 fps from the average (a
 * variable-rate stream whose timebase is not its playback rate).
 */
export function probeFrameRate(stream: {
	avg_frame_rate?: string;
	r_frame_rate?: string;
}): number | undefined {
	const real = parseProbeFrameRate(stream.r_frame_rate);
	const average = parseProbeFrameRate(stream.avg_frame_rate);
	if (real === undefined) {
		return average;
	}
	if (average !== undefined && Math.abs(real - average) > 1) {
		return average;
	}
	return real;
}

const filesystemErrorSchema = z.object({ code: z.string() });

export async function readProbeFile(path: string): Promise<string> {
	const file = await open(path, "r");
	try {
		const bytes = Buffer.alloc(MAX_PROBE_BYTES + 1);
		let total = 0;
		while (total < bytes.length) {
			const result = await file.read(bytes, total, bytes.length - total, null);
			if (result.bytesRead === 0) {
				break;
			}
			total += result.bytesRead;
		}
		if (total > MAX_PROBE_BYTES) {
			throw new Error("Media analysis exceeded its output limit.");
		}
		return bytes.subarray(0, total).toString();
	} finally {
		await file.close();
	}
}

// Where ffprobe writes its JSON result. The sidecar points this at its own
// plugin data `tmp/` at startup, so probing never writes beside a user's file.
let probeScratchDirectory = tmpdir();

/** Set the private directory ffprobe results are written to. */
export function setProbeScratchDirectory(directory: string): void {
	probeScratchDirectory = directory;
}

export function mediaBinary(name: "ffmpeg" | "ffprobe"): string {
	return process.env[`RYU_VIDEO_STUDIO_${name.toUpperCase()}`] || name;
}

export function mediaFailureMessage(stderr: string): string {
	const missingFilter = stderr
		.match(/No such filter:\s*['"]?([a-z0-9_]+)['"]?/i)?.[1]
		?.toLowerCase();
	if (missingFilter === "subtitles") {
		return "FFmpeg is missing the subtitles filter (libass), required to render titles and captions. Install a full build.";
	}
	if (missingFilter) {
		return "This FFmpeg installation lacks a required video filter. Install the full build.";
	}
	const detail = stderr.trim().slice(-1200);
	return `The media operation failed. Check that this format is supported and the renderer is installed.${detail ? ` ${detail}` : ""}`;
}

export async function runMedia(
	args: string[],
	options: {
		probe?: boolean;
		cwd?: string;
		signal?: AbortSignal;
		timeoutMs?: number;
		outputPath?: string;
		maxOutputBytes?: number;
	} = {}
): Promise<string> {
	const binary = mediaBinary(options.probe ? "ffprobe" : "ffmpeg");
	// A graph script is spelled the way the installed FFmpeg reads it (one
	// probe per binary); any other argv starts its process right away.
	const argv =
		!options.probe && args.includes(LEGACY_FILTER_SCRIPT_OPTION)
			? await filterScriptArgs(binary, args)
			: args;
	return await new Promise<string>((resolve, reject) => {
		if (options.signal?.aborted) {
			reject(new Error("Operation canceled."));
			return;
		}
		const child = spawn(binary, argv, {
			cwd: options.cwd,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		let exceeded = false;
		let timedOut = false;
		let processFailed = false;
		let stdoutBytes = 0;
		const abort = () => killMediaProcess(child);
		const outputMonitor = options.outputPath
			? setInterval(() => {
					void stat(options.outputPath!)
						.then((metadata) => {
							if (metadata.size > (options.maxOutputBytes ?? MAX_PROBE_BYTES)) {
								exceeded = true;
								abort();
							}
						})
						.catch((error) => {
							const parsed = filesystemErrorSchema.safeParse(error);
							if (!parsed.success || parsed.data.code !== "ENOENT") {
								processFailed = true;
								abort();
							}
						});
				}, 25)
			: undefined;
		options.signal?.addEventListener("abort", abort, { once: true });
		const timer = setTimeout(
			() => {
				timedOut = true;
				abort();
			},
			options.timeoutMs ?? (options.probe ? 30_000 : 30 * 60_000)
		);
		child.stdout.on("data", (bytes: Buffer) => {
			stdoutBytes += bytes.length;
			if (stdoutBytes > MAX_PROBE_BYTES) {
				exceeded = true;
				abort();
			} else {
				stdout += bytes.toString();
			}
		});
		child.stderr.on("data", (bytes: Buffer) => {
			stderr = (stderr + bytes.toString()).slice(-8000);
		});
		const clean = () => {
			clearTimeout(timer);
			clearInterval(outputMonitor);
			options.signal?.removeEventListener("abort", abort);
		};
		child.on("error", () => {
			processFailed = true;
			// A spawned child still owns resources until close, even after a kill
			// or runtime error. Only a failed spawn has no process to reap.
			if (child.pid !== undefined) {
				return;
			}
			clean();
			reject(
				new Error(
					"The media renderer is unavailable. Install FFmpeg and ffprobe on the node."
				)
			);
		});
		child.once("close", (code) => {
			clean();
			if (options.signal?.aborted) {
				reject(new Error("Operation canceled."));
			} else if (timedOut) {
				reject(new Error("Media operation timed out."));
			} else if (exceeded) {
				reject(
					new Error(
						options.maxOutputBytes
							? "Media operation exceeded its output budget."
							: "Media analysis exceeded its output limit."
					)
				);
			} else if (processFailed) {
				reject(
					new Error("The media process failed before completing its operation.")
				);
			} else if (code === 0) {
				resolve(stdout);
			} else {
				reject(new Error(mediaFailureMessage(stderr)));
			}
		});
	});
}

export function parseProbeOutput(
	probeOutput: string
): Omit<Asset, "id" | "name" | "createdAt"> {
	if (Buffer.byteLength(probeOutput) > MAX_PROBE_BYTES) {
		throw new Error("Media analysis exceeded its output limit.");
	}
	if (!probeOutput.trim()) {
		throw new Error("Media probe returned no metadata.");
	}
	const data = probeOutputSchema.parse(JSON.parse(probeOutput));
	const video = data.streams?.find((s) => s.codec_type === "video");
	const hasAudio = Boolean(data.streams?.some((s) => s.codec_type === "audio"));
	const duration = Number(data.format?.duration ?? video?.duration ?? 0);
	if (!(video || hasAudio)) {
		throw new Error("This file contains no supported media stream.");
	}
	if (!Number.isFinite(duration) || duration > 7200) {
		throw new Error("Media must be no longer than two hours.");
	}
	const still =
		video &&
		!hasAudio &&
		duration === 0 &&
		["png", "mjpeg", "webp", "bmp"].includes(video.codec_name ?? "");
	if (!still && duration <= 0) {
		throw new Error("Media duration could not be determined.");
	}
	const rawTimecode = video?.tags?.timecode ?? data.format?.tags?.timecode;
	const timecodeStart =
		rawTimecode && assetTimecodeSchema.safeParse(rawTimecode).success
			? rawTimecode
			: undefined;
	const frameRateParts = video?.avg_frame_rate?.split("/").map(Number) ?? [];
	const parsedFrameRate =
		frameRateParts.length === 2 &&
		Number.isFinite(frameRateParts[0]) &&
		Number.isFinite(frameRateParts[1]) &&
		(frameRateParts[1] ?? 0) > 0
			? (frameRateParts[0] ?? 0) / (frameRateParts[1] ?? 1)
			: undefined;
	const result: Omit<Asset, "id" | "name" | "createdAt"> = {
		kind: still ? "image" : video ? "video" : "audio",
		duration: still ? 5 : duration,
		width: video?.width ?? 0,
		height: video?.height ?? 0,
		hasAudio,
	};
	if (timecodeStart && parsedFrameRate && parsedFrameRate > 0) {
		result.timecodeFrameRate = Number(parsedFrameRate.toFixed(6));
		result.timecodeStart = timecodeStart;
	}
	if (result.kind === "video" && video) {
		const frameRate = probeFrameRate(video);
		if (frameRate !== undefined) {
			result.frameRate = frameRate;
		}
		const colorTransfer = probeColorTransfer(video.color_transfer);
		if (colorTransfer !== undefined) {
			result.colorTransfer = colorTransfer;
		}
	}
	return result;
}

export async function probe(
	path: string,
	signal?: AbortSignal
): Promise<Omit<Asset, "id" | "name" | "createdAt">> {
	await access(path);
	// Bun's test runner and some embedded Bun hosts do not expose stdout from
	// child processes reliably. Ask ffprobe to write its bounded JSON result to
	// a private file in the app's scratch dir (never beside the source), then
	// read it through Bun instead of treating a successful empty stdout stream as
	// valid metadata.
	await mkdir(probeScratchDirectory, { recursive: true, mode: 0o700 });
	const outputPath = join(
		probeScratchDirectory,
		`probe-${crypto.randomUUID()}.json`
	);
	try {
		const probeOutput = await runMedia(
			[
				"-v",
				"error",
				"-protocol_whitelist",
				"file,pipe",
				"-format_whitelist",
				MEDIA_FORMATS,
				"-show_format",
				"-show_streams",
				"-show_entries",
				"format=duration:format_tags=timecode:stream=codec_type,width,height,duration,codec_name,avg_frame_rate,r_frame_rate,color_transfer:stream_tags=timecode",
				"-of",
				"json",
				"-o",
				outputPath,
				path,
			],
			{ probe: true, outputPath, signal }
		);
		const fileOutput = await readProbeFile(outputPath);
		return parseProbeOutput(fileOutput || probeOutput);
	} finally {
		await rm(outputPath, { force: true });
	}
}

export async function thumbnail(
	path: string,
	outputDirectory: string,
	id: string,
	signal?: AbortSignal
) {
	const outputPath = join(outputDirectory, `${id}.jpg`);
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
				path,
				"-frames:v",
				"1",
				"-vf",
				"scale=480:-2",
				outputPath,
			],
			{ signal, outputPath, maxOutputBytes: MAX_THUMBNAIL_BYTES }
		);
		if ((await stat(outputPath)).size > MAX_THUMBNAIL_BYTES) {
			throw new Error("The thumbnail exceeded its output budget.");
		}
	} catch (error) {
		await rm(outputPath, { force: true });
		throw error;
	}
}
