import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { type Asset, assetTimecodeSchema } from "../../shared/project.ts";

// Explicit paths are deployment wiring. Inputs can never select a program or command.
export const MEDIA_FORMATS =
	"mov,matroska,webm,mp3,wav,flac,ogg,aac,png_pipe,jpeg_pipe,webp_pipe,bmp_pipe";

export function mediaBinary(name: "ffmpeg" | "ffprobe"): string {
	return process.env[`RYU_VIDEO_STUDIO_${name.toUpperCase()}`] || name;
}
export async function runMedia(
	args: string[],
	options: {
		probe?: boolean;
		cwd?: string;
		signal?: AbortSignal;
		timeoutMs?: number;
	} = {}
): Promise<string> {
	return await new Promise<string>((resolve, reject) => {
		if (options.signal?.aborted) {
			reject(new Error("Operation canceled."));
			return;
		}
		const child = spawn(
			mediaBinary(options.probe ? "ffprobe" : "ffmpeg"),
			args,
			{ cwd: options.cwd, stdio: ["ignore", "pipe", "pipe"] }
		);
		let stdout = "";
		let stderr = "";
		let exceeded = false;
		let timedOut = false;
		const abort = () => child.kill("SIGKILL");
		options.signal?.addEventListener("abort", abort, { once: true });
		const timer = setTimeout(
			() => {
				timedOut = true;
				abort();
			},
			options.timeoutMs ?? (options.probe ? 30_000 : 30 * 60_000)
		);
		child.stdout.on("data", (bytes: Buffer) => {
			if (stdout.length + bytes.length > 8_000_000) {
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
			options.signal?.removeEventListener("abort", abort);
		};
		child.once("error", () => {
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
				reject(new Error("Media analysis exceeded its output limit."));
			} else if (code === 0) {
				resolve(stdout);
			} else {
				const detail = stderr.trim().slice(-1200);
				reject(
					new Error(
						stderr.includes("No such filter")
							? "This FFmpeg installation lacks a required video filter. Install the full build."
							: `The media operation failed. Check that this format is supported and the renderer is installed.${detail ? ` ${detail}` : ""}`
					)
				);
			}
		});
	});
}

export function parseProbeOutput(
	probeOutput: string
): Omit<Asset, "id" | "name" | "createdAt"> {
	if (!probeOutput.trim()) {
		throw new Error("Media probe returned no metadata.");
	}
	const raw: unknown = JSON.parse(probeOutput);
	const data = raw as {
		format?: {
			duration?: string;
			tags?: Record<string, string>;
		};
		streams?: {
			codec_type?: string;
			width?: number;
			height?: number;
			duration?: string;
			codec_name?: string;
			avg_frame_rate?: string;
			tags?: Record<string, string>;
		}[];
	};
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
	return {
		kind: still ? "image" : video ? "video" : "audio",
		duration: still ? 5 : duration,
		width: video?.width ?? 0,
		height: video?.height ?? 0,
		hasAudio,
		...(timecodeStart && parsedFrameRate && parsedFrameRate > 0
			? {
					timecodeFrameRate: Number(parsedFrameRate.toFixed(6)),
					timecodeStart,
				}
			: {}),
	};
}

export async function probe(
	path: string
): Promise<Omit<Asset, "id" | "name" | "createdAt">> {
	await access(path);
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
			"-of",
			"json",
			path,
		],
		{ probe: true }
	);
	return parseProbeOutput(probeOutput);
}

export async function thumbnail(
	path: string,
	outputDirectory: string,
	id: string
) {
	await runMedia([
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
		join(outputDirectory, `${id}.jpg`),
	]);
}
