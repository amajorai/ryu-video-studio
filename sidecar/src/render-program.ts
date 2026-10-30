/**
 * The FFmpeg steps of an export (`buildRenderProgram` in `render.ts`), the
 * helper files they read, how big each run may get, and the runner.
 */
import { fpsRational } from "../../shared/frame-rate.ts";
import type { RenderPlan } from "../../shared/render-options.ts";
import type { RenderChunk } from "./render-chunks.ts";

/** How much one FFmpeg run of an export may open or carry inline. */
export interface RenderArgvLimits {
	/** Most clips one audio sub-mix opens. */
	audioGroupClips: number;
	/** Most clips that start in one chunk window. */
	chunkMaxSegments: number;
	/** Exports with more clips than this render in chunks. */
	chunkMinSegments: number;
	/** Longest filter graph (bytes) a one-pass step keeps on its argv. */
	inlineGraphBytes: number;
}

/**
 * Per-platform run limits. Linux caps one argv string at 128 KiB
 * (MAX_ARG_STRLEN) and the whole argv far higher, so only the graph needs
 * care. Windows caps the whole command line at 32,767 characters, and every
 * clip input spends about 180 characters of per-input options plus its path
 * (up to 260) there, so a run opens at most 40 clips and keeps at most 8 KiB
 * of graph inline.
 */
export function renderArgvLimits(
	platform: NodeJS.Platform = process.platform
): RenderArgvLimits {
	if (platform === "win32") {
		return {
			audioGroupClips: 40,
			chunkMaxSegments: 40,
			chunkMinSegments: 40,
			inlineGraphBytes: 8 * 1024,
		};
	}
	return {
		audioGroupClips: 100,
		chunkMaxSegments: 150,
		chunkMinSegments: 120,
		inlineGraphBytes: 64 * 1024,
	};
}

const limits = renderArgvLimits();

/**
 * Exports with more clips than this render in chunks (fewer on Windows,
 * whose command line every input shares).
 */
export let CHUNK_MIN_SEGMENTS = limits.chunkMinSegments;
/**
 * Most clips that start in one window. A window's filter graph grows with
 * its clips, and one FFmpeg argument is capped at 128 KiB on Linux (the
 * whole command line at 32,767 characters on Windows), so dense timelines
 * get shorter windows instead of longer graphs.
 */
export let CHUNK_MAX_SEGMENTS = limits.chunkMaxSegments;
/**
 * Most clips one audio sub-mix opens. The chunked audio is mixed in groups
 * of this many clips (each its own FFmpeg run into a float WAV), then the
 * groups are summed, ducked and limited in one last pass, so no run opens
 * thousands of inputs or carries a graph near the argv limit.
 */
export let AUDIO_GROUP_CLIPS = limits.audioGroupClips;
/**
 * Filter graphs longer than this (bytes) go to a script file even for a
 * one-pass step, so the graph never meets the platform's argv limit.
 */
export let INLINE_GRAPH_LIMIT = limits.inlineGraphBytes;

/**
 * Plan exports with `platform`'s limits (tests pin one platform's sizes);
 * no argument restores this machine's.
 */
export function setRenderArgvLimits(
	platform: NodeJS.Platform = process.platform
): void {
	const next = renderArgvLimits(platform);
	CHUNK_MIN_SEGMENTS = next.chunkMinSegments;
	CHUNK_MAX_SEGMENTS = next.chunkMaxSegments;
	AUDIO_GROUP_CLIPS = next.audioGroupClips;
	INLINE_GRAPH_LIMIT = next.inlineGraphBytes;
}

/** The final encoder's pixel format, which the intermediates keep. */
export function intermediatePixelFormat(plan: Pick<RenderPlan, "videoCodec">) {
	switch (plan.videoCodec) {
		case "h265-10bit":
			return "yuv420p10le";
		case "prores":
			return "yuv422p10le";
		case "prores-4444":
			return "yuv444p10le";
		default:
			return "yuv420p";
	}
}

/**
 * Encoder arguments of one chunk intermediate (after `-filter_complex`):
 * lossless x264 for 8-bit 4:2:0, FFV1 for the 10-bit formats, both in NUT
 * so the timeline timestamps are kept exactly. No audio.
 */
export function chunkEncodeArgs(
	plan: Pick<RenderPlan, "videoCodec">,
	video: string,
	frames: number
): string[] {
	const pixelFormat = intermediatePixelFormat(plan);
	const codec =
		pixelFormat === "yuv420p"
			? ["-c:v", "libx264", "-preset", "ultrafast", "-qp", "0"]
			: ["-c:v", "ffv1", "-level", "3"];
	return [
		"-map",
		`[${video}]`,
		"-an",
		"-frames:v",
		String(frames),
		...codec,
		"-pix_fmt",
		pixelFormat,
		"-threads",
		"2",
		"-f",
		"nut",
	];
}

/** File name of chunk `index` inside the render work folder. */
export function chunkFileName(index: number): string {
	return `chunk-${String(index).padStart(4, "0")}.nut`;
}

/** File name of the finished audio mix inside the render work folder. */
export const CHUNK_AUDIO_FILE = "chunk-audio.wav";

/** File name of audio sub-mix `index` inside the render work folder. */
export function audioGroupFileName(index: number): string {
	return `audio-group-${String(index).padStart(4, "0")}.wav`;
}

/** One argv string past this (bytes) makes `spawn` fail with E2BIG. */
export const MAX_ARG_BYTES = 128 * 1024;

/**
 * Move a step's `-filter_complex` graph into the work-folder file `name`
 * (`-filter_complex_script`), so its length never meets the argv limit.
 * Returns the step's argv and the file to write; argv without a graph is
 * returned unchanged with no file.
 */
export function withFilterScript(
	args: readonly string[],
	name: string
): { args: string[]; file?: { content: string; name: string } } {
	const at = args.indexOf("-filter_complex");
	const graph = args[at + 1];
	if (at < 0 || graph === undefined) {
		return { args: [...args] };
	}
	const next = [...args];
	next.splice(at, 2, "-filter_complex_script", name);
	return { args: next, file: { content: graph, name } };
}

/** File name of a step's filter graph script inside the work folder. */
export function graphFileName(step: string): string {
	return `${step}.graph`;
}
/** File name of the concat demuxer list inside the render work folder. */
export const CHUNK_LIST_FILE = "chunks.txt";

/**
 * The concat demuxer list. File names are plain relative names, so the
 * demuxer's safe mode accepts them.
 */
export function concatList(names: readonly string[]): string {
	for (const name of names) {
		if (!/^[A-Za-z0-9._-]+$/.test(name)) {
			throw new Error(`Chunk file name ${name} is not a plain file name.`);
		}
	}
	return `ffconcat version 1.0\n${names.map((name) => `file ${name}`).join("\n")}\n`;
}

/**
 * `setpts` that restamps the joined chunks frame by frame on the project
 * grid (`N × den / num` seconds), so container timestamp rounding in the
 * intermediates can never drop or repeat a frame.
 */
export function restampFilter(fps: number): string {
	const { den, num } = fpsRational(fps);
	return `setpts=N*${den}/(${num}*TB)`;
}

/** One FFmpeg run of a render program. */
export interface RenderStep {
	/** FFmpeg argv without the output path. */
	args: string[];
	/**
	 * `audio` steps are sub-mixes of up to `AUDIO_GROUP_CLIPS` clips;
	 * `audio-mix` sums them into `CHUNK_AUDIO_FILE`.
	 */
	kind: "audio" | "audio-mix" | "chunk" | "final" | "single";
	/** Output path, relative to the work folder (or the caller's target). */
	output: string;
}

/** Steps (and helper files) that produce one export. */
export interface RenderProgram {
	/** Set when the export renders in chunks. */
	chunks?: RenderChunk[];
	/** Text files to write in the work folder before the first step. */
	files: { content: string; name: string }[];
	steps: RenderStep[];
}

export interface RenderProgramRunner {
	/** Called before each step; throw to stop (for example when canceled). */
	check?(): void;
	/** Called after each step with the finished fraction (0 to 1). */
	progress?(fraction: number): void;
	/** Run one FFmpeg step: `args` followed by `output`. */
	run(step: RenderStep): Promise<void>;
	/** Write a helper file into the work folder. */
	write(name: string, content: string): Promise<void>;
}

/** Run a render program's steps in order. */
export async function runRenderProgram(
	program: RenderProgram,
	runner: RenderProgramRunner
): Promise<void> {
	for (const file of program.files) {
		await runner.write(file.name, file.content);
	}
	for (const [index, step] of program.steps.entries()) {
		runner.check?.();
		await runner.run(step);
		runner.progress?.((index + 1) / program.steps.length);
	}
}
