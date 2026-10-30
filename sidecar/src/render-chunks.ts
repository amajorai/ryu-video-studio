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
import { CHUNK_MAX_SEGMENTS, CHUNK_MIN_SEGMENTS } from "./render-program.ts";
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
 * and `runRenderProgram` runs them. Window clip scoping and seeking live in
 * `render-chunk-windows.ts`, the steps and their runner in
 * `render-program.ts`; both are re-exported here.
 */

/** Exports longer than this (seconds) render in chunks. */
export const CHUNK_MIN_SECONDS = 30 * 60;
/** Target window length in seconds. */
export const CHUNK_WINDOW_SECONDS = 60;

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

export {
	CHUNK_SEEK_PREROLL,
	segmentInWindow,
	type WindowSeek,
	windowedProject,
	windowSeconds,
	windowSeek,
	windowSkip,
} from "./render-chunk-windows.ts";
export {
	AUDIO_GROUP_CLIPS,
	audioGroupFileName,
	CHUNK_AUDIO_FILE,
	CHUNK_LIST_FILE,
	CHUNK_MAX_SEGMENTS,
	CHUNK_MIN_SEGMENTS,
	chunkEncodeArgs,
	chunkFileName,
	concatList,
	graphFileName,
	INLINE_GRAPH_LIMIT,
	intermediatePixelFormat,
	MAX_ARG_BYTES,
	type RenderArgvLimits,
	type RenderProgram,
	type RenderProgramRunner,
	type RenderStep,
	renderArgvLimits,
	restampFilter,
	runRenderProgram,
	setRenderArgvLimits,
	withFilterScript,
} from "./render-program.ts";
