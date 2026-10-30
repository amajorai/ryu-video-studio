import { ffmpegFrameRate } from "../../shared/frame-rate.ts";
import type { Project } from "../../shared/project.ts";
import {
	type RenderOptions,
	type RenderPlan,
	rateControlArgs,
	resolveRenderPlan,
} from "../../shared/render-options.ts";

/**
 * Output options for one render. An empty object is the default export: the
 * whole timeline with audio, encoded with the project codec and preset.
 * `plan` is the resolved plan when the caller already has one (the
 * orchestrator resolves it once with the source color transfers).
 */
export interface RenderBuildOptions extends RenderOptions {
	plan?: RenderPlan;
}

export interface EncodeGraph {
	/** Label of the mixed audio, without brackets, when any clip is audible. */
	audio?: string;
	/** Timeline duration in seconds. */
	duration: number;
	/** Set for single-frame PNG renders. */
	frameTime?: number;
	/** Label of the final video composite, without brackets. */
	video: string;
}

/** The plan for `options`, resolving it from the project when not given. */
export function planFor(
	p: Project,
	options: RenderBuildOptions,
	duration: number
): RenderPlan {
	const { plan, ...request } = options;
	return plan ?? resolveRenderPlan(p, request, { timelineDuration: duration });
}

/** `-crf` or the CBR/VBR bitrate arguments. */
function rateArgs(plan: RenderPlan): string[] {
	const { rateControl } = plan.settings;
	if (rateControl === "crf" || plan.bitrateKbps === undefined) {
		return ["-crf", String(plan.settings.crf ?? 23)];
	}
	return rateControlArgs(rateControl, plan.bitrateKbps);
}

/** libvpx-vp9 speed for an x264-style preset name (0 slowest, 5 fastest). */
const vp9CpuUsed: Record<
	NonNullable<RenderPlan["settings"]["encoderPreset"]>,
	string
> = {
	ultrafast: "5",
	superfast: "5",
	veryfast: "4",
	faster: "4",
	fast: "3",
	medium: "2",
	slow: "1",
	slower: "0",
	veryslow: "0",
};

function hdrArgs(plan: RenderPlan): string[] {
	if (!plan.hdr) {
		return [];
	}
	return [
		"-x265-params",
		`colorprim=bt2020:transfer=${plan.hdr}:colormatrix=bt2020nc`,
		"-color_primaries",
		"bt2020",
		"-color_trc",
		plan.hdr,
		"-colorspace",
		"bt2020nc",
	];
}

function videoCodecArgs(plan: RenderPlan): string[] {
	const codec = plan.videoCodec ?? "h264";
	if (codec === "prores" || codec === "prores-4444") {
		const fourFourFour = codec === "prores-4444";
		return [
			"-c:v",
			"prores_ks",
			"-profile:v",
			fourFourFour ? "4" : "3",
			"-pix_fmt",
			fourFourFour
				? plan.alpha
					? "yuva444p10le"
					: "yuv444p10le"
				: "yuv422p10le",
			"-threads",
			"2",
		];
	}
	const preset = plan.settings.encoderPreset ?? "medium";
	if (codec === "vp9") {
		return [
			"-c:v",
			"libvpx-vp9",
			...rateArgs(plan),
			...(plan.settings.rateControl === "crf" ? ["-b:v", "0"] : []),
			"-row-mt",
			"1",
			"-deadline",
			"good",
			"-cpu-used",
			vp9CpuUsed[preset],
			"-pix_fmt",
			plan.alpha ? "yuva420p" : "yuv420p",
			...(plan.alpha ? ["-auto-alt-ref", "0"] : []),
			"-threads",
			"2",
		];
	}
	const h265 = codec === "h265" || codec === "h265-10bit";
	return [
		"-c:v",
		h265 ? "libx265" : "libx264",
		"-preset",
		preset,
		...rateArgs(plan),
		"-pix_fmt",
		codec === "h265-10bit" ? "yuv420p10le" : "yuv420p",
		...hdrArgs(plan),
		...(h265 ? ["-tag:v", "hvc1"] : []),
		"-movflags",
		"+faststart",
		"-threads",
		"2",
	];
}

function audioCodecArgs(plan: RenderPlan): string[] {
	const bitrate = `${plan.settings.audioBitrateKbps}k`;
	switch (plan.container) {
		case "wav":
			return ["-c:a", "pcm_s16le"];
		case "mp3":
			return ["-c:a", "libmp3lame", "-q:a", "2"];
		case "aac":
			return ["-c:a", "aac", "-b:a", bitrate, "-movflags", "+faststart"];
		case "webm":
			return ["-c:a", "libopus", "-b:a", bitrate, "-ar", "48000"];
		default:
			return ["-c:a", "aac", "-b:a", bitrate];
	}
}

/** `-ss` (only for a range) and `-t` output options. */
function spanArgs(plan: RenderPlan): string[] {
	return [
		...(plan.range ? ["-ss", String(plan.start)] : []),
		"-t",
		String(plan.duration),
	];
}

function frameArgs(video: string): string[] {
	return [
		"-map",
		`[${video}]`,
		"-frames:v",
		"1",
		"-an",
		"-c:v",
		"png",
		"-pix_fmt",
		"rgba",
		"-fps_mode",
		"passthrough",
		"-threads",
		"2",
	];
}

/**
 * Stream maps and encoder arguments that follow `-filter_complex`. A frame
 * render is one RGBA PNG. Exports map the video composite (or, for
 * audio-only files, only the mix) and encode with the plan's container and
 * codec; a range is cut on the output side with `-ss`/`-t`, so caption and
 * keyframe times stay on the timeline clock.
 */
export function encodeArgs(
	p: Project,
	options: RenderBuildOptions,
	graph: EncodeGraph
): string[] {
	if (graph.frameTime !== undefined) {
		return frameArgs(graph.video);
	}
	const plan = planFor(p, options, graph.duration);
	if (plan.kind === "audio") {
		if (!graph.audio) {
			throw new Error("Nothing on the timeline is audible to export.");
		}
		return [
			"-map",
			`[${graph.audio}]`,
			"-vn",
			...spanArgs(plan),
			...audioCodecArgs(plan),
		];
	}
	const args = ["-map", `[${graph.video}]`];
	if (plan.kind === "gif") {
		args.push("-an", "-c:v", "gif", "-loop", "0");
		return args;
	}
	if (plan.kind === "sequence") {
		const png = plan.container === "png-sequence";
		args.push(
			"-an",
			...spanArgs(plan),
			"-r",
			ffmpegFrameRate(p.fps),
			"-c:v",
			png ? "png" : "mjpeg",
			...(png
				? ["-pix_fmt", plan.alpha ? "rgba" : "rgb24"]
				: ["-q:v", "2", "-pix_fmt", "yuvj444p"]),
			"-f",
			"image2"
		);
		return args;
	}
	if (!plan.includeAudio) {
		args.push("-an");
	} else if (graph.audio) {
		args.push("-map", `[${graph.audio}]`, ...audioCodecArgs(plan));
	}
	args.push(...spanArgs(plan), "-r", ffmpegFrameRate(p.fps));
	args.push(...videoCodecArgs(plan));
	return args;
}
