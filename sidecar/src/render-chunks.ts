import {
	fpsRational,
	framesToTime,
	timeToFrames,
} from "../../shared/frame-rate.ts";
import {
	type Asset,
	type Project,
	type Segment,
	segmentDuration,
} from "../../shared/project.ts";
import type { RenderPlan } from "../../shared/render-options.ts";
import {
	clipSourceOffset,
	clipTimeAtSourceOffset,
	hasSpeedCurve,
} from "../../shared/speed-curve.ts";
import { segmentDrawsVideo } from "./render-stages/visibility.ts";

/**
 * Chunked rendering for long timelines (W4-Q1).
 *
 * One FFmpeg graph with thousands of inputs is slow to build and holds every
 * decoder open for the whole export. Past `CHUNK_MIN_SEGMENTS` clips or
 * `CHUNK_MIN_SECONDS` of output, the export is split into time windows of
 * about `CHUNK_WINDOW_SECONDS`, each rendered on the timeline clock with
 * only the clips and overlays active in it, into a lossless intermediate.
 * The intermediates are joined with the concat demuxer and encoded once with
 * the export's own settings. The audio has no seams: it is mixed over the
 * whole span, in sub-mixes of `AUDIO_GROUP_CLIPS` clips that one last pass
 * sums sample for sample, and every step reads its graph from a script file
 * so no argv string nears the 128 KiB limit.
 *
 * Window edges are whole frames and prefer cut points: a clip that crosses
 * an edge must be decoded in both windows, so the planner picks, near each
 * target, the cut that fewest drawn clips cross. The export's first frame is
 * the one the one-pass output `-ss` keeps (`ffmpegSpanFrame`), and a clip
 * that crosses a window start skips ahead only on its own source frame grid
 * (`windowSeek`), so every frame matches the one-pass render.
 *
 * Everything here is pure; `render.ts` builds the FFmpeg argv for each step
 * and `runRenderProgram` runs them.
 */

/** Exports with more clips than this render in chunks. */
export const CHUNK_MIN_SEGMENTS = 120;
/** Exports longer than this (seconds) render in chunks. */
export const CHUNK_MIN_SECONDS = 30 * 60;
/** Target window length in seconds. */
export const CHUNK_WINDOW_SECONDS = 60;
/**
 * Most clips that start in one window. A window's filter graph grows with
 * its clips, and one FFmpeg argument is capped at 128 KiB on Linux, so dense
 * timelines get shorter windows instead of longer graphs.
 */
export const CHUNK_MAX_SEGMENTS = 150;
/**
 * Source seconds a clip that crosses a window start is decoded before that
 * start, so seek accuracy and frame-rate rounding never touch the first
 * frame of the window.
 */
export const CHUNK_SEEK_PREROLL = 1;

/** A span of output frames on the timeline clock. */
export interface RenderWindow {
	/** Frames in the window. */
	frames: number;
	/** First frame index (timeline frame grid of the project rate). */
	startFrame: number;
}

/** One planned chunk: its frames and the clips it draws. */
export interface RenderChunk extends RenderWindow {
	/** Timeline seconds after the last frame. */
	end: number;
	index: number;
	/** Drawn clips active in the window, in track then start order. */
	segmentIds: string[];
	/** Drawn clips that start before the window and run into it. */
	spanningIds: string[];
	/** Timeline seconds of the first frame. */
	start: number;
}

export interface ChunkPlan {
	chunks: RenderChunk[];
	/** First frame of the export. */
	startFrame: number;
	/** Frames in the export. */
	totalFrames: number;
}

export interface ChunkPlanOptions {
	/** Most clips starting in one window (default `CHUNK_MAX_SEGMENTS`). */
	maxSegments?: number;
	/** Target window length in seconds (default `CHUNK_WINDOW_SECONDS`). */
	windowSeconds?: number;
}

/** The output span of a plan: the range, or the whole timeline. */
export interface RenderSpan {
	duration: number;
	start: number;
}

/**
 * Whether an export renders in chunks: video containers without alpha,
 * past the clip or length threshold. GIFs, frame sequences, audio files and
 * transparent exports always render in one pass.
 */
export function shouldChunkRender(
	project: Pick<Project, "segments">,
	plan: Pick<RenderPlan, "alpha" | "duration" | "kind">
): boolean {
	if (plan.kind !== "video" || plan.alpha) {
		return false;
	}
	return (
		project.segments.length > CHUNK_MIN_SEGMENTS ||
		plan.duration > CHUNK_MIN_SECONDS
	);
}

/**
 * The output frame FFmpeg's output-side `-ss`/`-t` lands on for `seconds`:
 * the option is parsed to whole microseconds and rescaled to the export's
 * `1/fps` timebase rounding half away from zero (the `trim` that FFmpeg
 * inserts keeps frames at or after that tick). Chunk windows use the same
 * rule so a chunked export starts on the frame a one-pass export keeps.
 */
export function ffmpegSpanFrame(seconds: number, fps: number): number {
	const { den, num } = fpsRational(fps);
	const micros = BigInt(Math.round(Math.max(0, seconds) * 1_000_000));
	const scale = BigInt(den) * 1_000_000n;
	return Number((2n * micros * BigInt(num) + scale) / (2n * scale));
}

/**
 * First and one-past-last output frame of a span on the project grid, as
 * the one-pass export's `-ss start -t duration` picks them.
 */
export function spanFrames(
	span: RenderSpan,
	fps: number
): { endFrame: number; startFrame: number } {
	const startFrame = ffmpegSpanFrame(span.start, fps);
	const endFrame =
		startFrame + Math.max(1, ffmpegSpanFrame(span.duration, fps));
	return { endFrame, startFrame };
}

interface DrawnInterval {
	endFrame: number;
	id: string;
	segment: Segment;
	startFrame: number;
}

/** Index of the first element of sorted `values` that is ≥ `target`. */
function lowerBound(values: readonly number[], target: number): number {
	let low = 0;
	let high = values.length;
	while (low < high) {
		const middle = (low + high) >>> 1;
		if ((values[middle] ?? 0) < target) {
			low = middle + 1;
		} else {
			high = middle;
		}
	}
	return low;
}

/** Index of the first element of sorted `values` that is > `target`. */
function upperBound(values: readonly number[], target: number): number {
	let low = 0;
	let high = values.length;
	while (low < high) {
		const middle = (low + high) >>> 1;
		if ((values[middle] ?? 0) <= target) {
			low = middle + 1;
		} else {
			high = middle;
		}
	}
	return low;
}

function drawnIntervals(
	project: Project,
	assets: readonly Asset[],
	fps: number
): DrawnInterval[] {
	const assetById = new Map(assets.map((asset) => [asset.id, asset]));
	const intervals: DrawnInterval[] = [];
	for (const segment of project.segments) {
		if (!segmentDrawsVideo(project, segment, assetById.get(segment.assetId))) {
			continue;
		}
		const startFrame = timeToFrames(segment.start, fps, "floor");
		const endFrame = Math.max(
			startFrame + 1,
			timeToFrames(segment.start + segmentDuration(segment), fps, "ceil")
		);
		intervals.push({ endFrame, id: segment.id, segment, startFrame });
	}
	return intervals;
}

/**
 * Window edges between `startFrame` and `endFrame`: about one window apart,
 * each at the cut (a drawn clip's first or last frame) within half a window
 * of its target that the fewest drawn clips cross, then nearest the target,
 * then earliest. Without a cut nearby the edge is the target itself. The
 * last window absorbs a remainder shorter than half a window. A window ends
 * no later than the start of its `maxSegments + 1`-th clip.
 */
export function chunkBoundaries(
	intervals: readonly Pick<DrawnInterval, "endFrame" | "startFrame">[],
	startFrame: number,
	endFrame: number,
	windowFrames: number,
	maxSegments = CHUNK_MAX_SEGMENTS
): number[] {
	const starts = intervals.map((interval) => interval.startFrame).sort(sortUp);
	const ends = intervals.map((interval) => interval.endFrame).sort(sortUp);
	const cuts = [...new Set([...starts, ...ends])].sort(sortUp);
	/** Drawn clips with a frame on both sides of `frame`. */
	const crossing = (frame: number) =>
		lowerBound(starts, frame) - upperBound(ends, frame);
	const half = Math.max(1, Math.floor(windowFrames / 2));
	const most = Math.max(1, Math.floor(maxSegments));
	/** The start of the clip that would overfill a window from `frame`. */
	const capFrom = (frame: number) => {
		const overflow = starts[lowerBound(starts, frame) + most];
		return overflow === undefined || overflow >= endFrame
			? Number.POSITIVE_INFINITY
			: Math.max(frame + 1, overflow);
	};
	const edges = [startFrame];
	let current = startFrame;
	for (;;) {
		const cap = capFrom(current);
		if (
			endFrame - current <= windowFrames + half &&
			cap === Number.POSITIVE_INFINITY
		) {
			break;
		}
		const target = Math.min(current + windowFrames, cap);
		const low = Math.max(current + 1, target - half);
		const high =
			cap === Number.POSITIVE_INFINITY
				? Math.min(endFrame - half, target + half)
				: Math.min(endFrame - 1, target + half, cap);
		let best = target;
		let bestCost = crossing(target);
		for (
			let index = lowerBound(cuts, low);
			index < cuts.length && (cuts[index] ?? high + 1) <= high;
			index++
		) {
			const cut = cuts[index] ?? target;
			const cost = crossing(cut);
			const closer = Math.abs(cut - target) < Math.abs(best - target);
			const tie = Math.abs(cut - target) === Math.abs(best - target);
			if (
				cost < bestCost ||
				(cost === bestCost && (closer || (tie && cut < best)))
			) {
				best = cut;
				bestCost = cost;
			}
		}
		edges.push(best);
		current = best;
	}
	edges.push(endFrame);
	return edges;
}

function sortUp(a: number, b: number): number {
	return a - b;
}

/**
 * Split an export span into chunks. Deterministic: the same project, assets
 * and span always give the same windows and clip lists.
 */
export function planRenderChunks(
	project: Project,
	assets: readonly Asset[],
	span: RenderSpan,
	options: ChunkPlanOptions = {}
): ChunkPlan {
	const fps = project.fps;
	const { endFrame, startFrame } = spanFrames(span, fps);
	const windowFrames = Math.max(
		1,
		timeToFrames(options.windowSeconds ?? CHUNK_WINDOW_SECONDS, fps)
	);
	const intervals = drawnIntervals(project, assets, fps).sort(
		(a, b) =>
			a.segment.track - b.segment.track ||
			a.segment.start - b.segment.start ||
			a.id.localeCompare(b.id)
	);
	const edges = chunkBoundaries(
		intervals,
		startFrame,
		endFrame,
		windowFrames,
		options.maxSegments
	);
	const byStart = [...intervals].sort(
		(a, b) => a.startFrame - b.startFrame || a.id.localeCompare(b.id)
	);
	const order = new Map(
		intervals.map((interval, index) => [interval.id, index])
	);
	// Running maximum of last frames, so the scan can skip the prefix of
	// clips that all end before a window.
	const reach: number[] = [];
	for (const interval of byStart) {
		reach.push(Math.max(reach.at(-1) ?? 0, interval.endFrame));
	}
	const chunks: RenderChunk[] = [];
	let firstOpen = 0;
	for (let index = 0; index + 1 < edges.length; index++) {
		const chunkStart = edges[index] ?? startFrame;
		const chunkEnd = edges[index + 1] ?? endFrame;
		while (firstOpen < byStart.length && (reach[firstOpen] ?? 0) < chunkStart) {
			firstOpen++;
		}
		const active: DrawnInterval[] = [];
		for (let cursor = firstOpen; cursor < byStart.length; cursor++) {
			const interval = byStart[cursor];
			if (!interval || interval.startFrame > chunkEnd) {
				break;
			}
			// Inclusive on both edges: a clip that ends exactly on the first
			// frame still takes part, as `between(t, start, end)` does.
			if (interval.endFrame >= chunkStart) {
				active.push(interval);
			}
		}
		active.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
		chunks.push({
			end: framesToTime(chunkEnd, fps),
			frames: chunkEnd - chunkStart,
			index,
			segmentIds: active.map((interval) => interval.id),
			spanningIds: active
				.filter(
					(interval) =>
						interval.startFrame < chunkStart && interval.endFrame > chunkStart
				)
				.map((interval) => interval.id),
			start: framesToTime(chunkStart, fps),
			startFrame: chunkStart,
		});
	}
	return { chunks, startFrame, totalFrames: endFrame - startFrame };
}

interface Timed {
	end: number;
	start: number;
}

function overlaps(item: Timed, start: number, end: number): boolean {
	return item.start <= end && item.end >= start;
}

/**
 * The project as a window's overlay stages see it: titles, graphics,
 * avatars, stage objects and adjustment layers outside the window (with one
 * frame of slack on each side) are left out. Clips stay, because the reveal
 * stage reads each clip's predecessor; the orchestrator filters the clips it
 * draws itself.
 */
export function windowedProject(
	project: Project,
	window: RenderWindow
): Project {
	const slack = 1 / Math.max(1, project.fps);
	const start = framesToTime(window.startFrame, project.fps) - slack;
	const end =
		framesToTime(window.startFrame + window.frames, project.fps) + slack;
	const keep = <Item extends Timed>(items: readonly Item[]) =>
		items.filter((item) => overlaps(item, start, end));
	const scoped: Project = {
		...project,
		avatars: keep(project.avatars),
		graphics: keep(project.graphics),
		spatialObjects: keep(project.spatialObjects),
		titles: keep(project.titles),
	};
	if (project.adjustmentLayers) {
		scoped.adjustmentLayers = keep(project.adjustmentLayers);
	}
	return scoped;
}

/** Window seconds as `{ start, end }` on the timeline clock. */
export function windowSeconds(
	window: RenderWindow,
	fps: number
): { end: number; start: number } {
	return {
		end: framesToTime(window.startFrame + window.frames, fps),
		start: framesToTime(window.startFrame, fps),
	};
}

/** Whether a clip has any frame inside the window (inclusive edges). */
export function segmentInWindow(
	segment: Segment,
	window: RenderWindow,
	fps: number
): boolean {
	const { end, start } = windowSeconds(window, fps);
	const slack = 1 / Math.max(1, fps) / 2;
	return (
		segment.start <= end + slack &&
		segment.start + segmentDuration(segment) >= start - slack
	);
}

/**
 * Timeline seconds a clip's decode may skip at a window start: everything
 * before the window except `CHUNK_SEEK_PREROLL` source seconds. Zero for
 * clips that start inside the window or within the preroll of its start.
 */
export function windowSkip(
	segment: Segment,
	window: RenderWindow,
	fps: number
): number {
	const { start } = windowSeconds(window, fps);
	const before = start - segment.start;
	const skip = before - CHUNK_SEEK_PREROLL / segment.speed;
	return skip > 0 ? Number(skip.toFixed(6)) : 0;
}

/** `sourceIn` this close to a source frame (seconds) counts as on it. */
const SOURCE_GRID_EXACT = 2e-6;
/**
 * `sourceIn` closer than this to a source frame (but not on it) leaves the
 * first decoded frame to timestamp rounding, so the clip is not skipped.
 */
const SOURCE_GRID_AMBIGUOUS = 0.0015;

/** How a window render opens a clip that crosses its start. */
export interface WindowSeek {
	/** Input `-ss` in source seconds: half a source frame before `frame`. */
	seek: number;
	/**
	 * Clip seconds of the first decoded frame (source frames past the clip's
	 * first frame, over the speed). Never more than `windowSkip`.
	 */
	skip: number;
	/**
	 * `setpts` term that adds back the skipped source frames in the stream
	 * timebase, rounded per frame the way a muxer stamps them, so
	 * `(PTS-STARTPTS+ticks)/speed` equals the one-pass `(PTS-STARTPTS)/speed`
	 * frame for frame.
	 */
	ticks: string;
}

/**
 * Where a window render may start decoding a clip that crosses its start,
 * keeping the one-pass frame phase. The one-pass render places the first
 * source frame at or after `sourceIn` at clip time 0; the window seeks half a
 * source frame before a later source frame, so that frame is the first one
 * decoded whatever the seek rounding, and shifts it by the exact number of
 * source frames between the two. That needs the source frame grid: assets
 * without a probed frame rate, with an irregular rate (a variable-rate
 * average), or whose `sourceIn` sits within rounding of a source frame are
 * not skipped (`undefined`), and decode from the clip start instead. A
 * speed-curved clip skips to the curve-mapped source moment of the window
 * start (`clipSourceOffset`), and its first decoded frame lands at the clip
 * time the curve gives the skipped source.
 */
export function windowSeek(
	segment: Segment,
	asset: Pick<Asset, "frameRate" | "kind"> | undefined,
	window: RenderWindow,
	fps: number
): WindowSeek | undefined {
	if (asset?.kind !== "video" || asset.frameRate === undefined) {
		return;
	}
	const curved = hasSpeedCurve(segment);
	// Source seconds past `sourceIn` the decode may skip: the curve-mapped
	// source moment of the window start, less the preroll.
	const sourceTarget = curved
		? clipSourceOffset(
				segment,
				windowSeconds(window, fps).start - segment.start
			) - CHUNK_SEEK_PREROLL
		: windowSkip(segment, window, fps) * segment.speed;
	if (sourceTarget <= 0) {
		return;
	}
	const rate = fpsRational(asset.frameRate);
	if (!(rate.ntsc || rate.den <= 2)) {
		return;
	}
	const perSecond = rate.num / rate.den;
	const inFrames = segment.sourceIn * perSecond;
	const nearest = Math.round(inFrames);
	const offGrid = Math.abs(inFrames - nearest) / perSecond;
	if (offGrid > SOURCE_GRID_EXACT && offGrid < SOURCE_GRID_AMBIGUOUS) {
		return;
	}
	const first = offGrid <= SOURCE_GRID_EXACT ? nearest : Math.ceil(inFrames);
	const frame = Math.floor((segment.sourceIn + sourceTarget) * perSecond);
	const skipped = frame - first;
	if (skipped <= 0) {
		return;
	}
	const skippedSource = (skipped * rate.den) / rate.num;
	const at = (index: number) => `round(${index}*${rate.den}/(${rate.num}*TB))`;
	return {
		seek: Number((((frame - 0.5) * rate.den) / rate.num).toFixed(6)),
		// The curve's remap reads source seconds from the first decoded frame,
		// so the skipped frames land where the one-pass mapping puts them.
		skip: curved
			? clipTimeAtSourceOffset(segment, skippedSource)
			: skippedSource / segment.speed,
		ticks: `${at(frame)}-${at(first)}`,
	};
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

/**
 * Most clips one audio sub-mix opens. The chunked audio is mixed in groups
 * of this many clips (each its own FFmpeg run into a float WAV), then the
 * groups are summed, ducked and limited in one last pass, so no run opens
 * thousands of inputs or carries a graph near the argv limit.
 */
export const AUDIO_GROUP_CLIPS = 100;

/** File name of audio sub-mix `index` inside the render work folder. */
export function audioGroupFileName(index: number): string {
	return `audio-group-${String(index).padStart(4, "0")}.wav`;
}

/**
 * Filter graphs longer than this (bytes) go to a script file even for a
 * one-pass step; Linux caps one argv string at 128 KiB (MAX_ARG_STRLEN).
 */
export const INLINE_GRAPH_LIMIT = 64 * 1024;

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
