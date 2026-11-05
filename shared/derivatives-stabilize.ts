/**
 * Stabilize derivatives (G53): FFmpeg filter strings for `vidstab` and the
 * built-in translation tracker that replaces it on builds without libvidstab.
 * Re-exported from `./derivatives.ts`.
 */
import { z } from "zod";
import type { DerivativeFilterSupport } from "./derivatives.ts";
import { ffmpegFrameRate, fpsValue } from "./frame-rate.ts";

/* ------------------------------------------------------------------ */
/* Stabilize                                                           */
/* ------------------------------------------------------------------ */

export const stabilizeLevelSchema = z.enum(["low", "medium", "high"]);
export type StabilizeLevel = z.infer<typeof stabilizeLevelSchema>;

export const stabilizeRequestSchema = z
	.object({
		level: stabilizeLevelSchema.default("medium"),
		name: z.string().trim().min(1).max(200).optional(),
	})
	.strict();
export type StabilizeRequest = z.infer<typeof stabilizeRequestSchema>;

export interface StabilizeLevelSettings {
	/** Fraction of each edge the frame may move into (zoom margin). */
	margin: number;
	/** `vidstabdetect` shakiness (1-10). */
	shakiness: number;
	/** Trajectory smoothing radius in frames (`vidstabtransform` smoothing). */
	smoothing: number;
}

export const STABILIZE_LEVELS: Record<StabilizeLevel, StabilizeLevelSettings> =
	{
		low: { margin: 0.04, shakiness: 4, smoothing: 10 },
		medium: { margin: 0.06, shakiness: 6, smoothing: 20 },
		high: { margin: 0.08, shakiness: 8, smoothing: 30 },
	};

/** `vidstab` when the build has libvidstab; otherwise the built-in tracker. */
export type StabilizeMethod = "vidstab" | "translate";

export function stabilizeMethod(
	support: Pick<DerivativeFilterSupport, "vidstab">
): StabilizeMethod {
	return support.vidstab ? "vidstab" : "translate";
}

/** Pass 1 of the libvidstab path; writes `transforms.trf` in the work directory. */
export function vidstabDetectFilter(level: StabilizeLevel): string {
	const { shakiness } = STABILIZE_LEVELS[level];
	return `vidstabdetect=shakiness=${shakiness}:accuracy=15:result=transforms.trf`;
}

/** Pass 2 of the libvidstab path. The zoom hides the moving frame edges. */
export function vidstabTransformFilter(level: StabilizeLevel): string {
	const { margin, smoothing } = STABILIZE_LEVELS[level];
	const zoom = Number((margin * 200).toFixed(2));
	return `vidstabtransform=input=transforms.trf:smoothing=${smoothing}:zoom=${zoom}:optzoom=0:interpol=bicubic`;
}

/** Width of the grayscale frames the built-in tracker analyses. */
export const ANALYSIS_WIDTH = 160;

/** Even analysis dimensions for a source, never wider than the source. */
export function analysisSize(width: number, height: number) {
	if (width < 2 || height < 2) {
		throw new Error("Stabilize requires video with measured dimensions.");
	}
	const analysisWidth = Math.min(ANALYSIS_WIDTH, evenFloor(width));
	const analysisHeight = Math.max(
		2,
		evenFloor((height * analysisWidth) / width)
	);
	return { height: analysisHeight, width: analysisWidth };
}

/**
 * Frame size as FFmpeg decodes it after autorotation: a display rotation of
 * an odd number of quarter turns swaps the coded width and height.
 */
export function displayedSize(
	width: number,
	height: number,
	rotation = 0
): { height: number; width: number } {
	const quarterTurns = Number.isFinite(rotation)
		? Math.round(rotation / 90)
		: 0;
	return Math.abs(quarterTurns) % 2 === 1
		? { height: width, width: height }
		: { height, width };
}

/** One grayscale frame (row-major luma, one byte per pixel). */
export interface GrayFrame {
	data: Uint8Array;
	height: number;
	width: number;
}

export interface Vector {
	x: number;
	y: number;
}

/** Half-resolution copy with 2×2 box averaging. */
export function downsampleFrame(frame: GrayFrame): GrayFrame {
	const width = Math.floor(frame.width / 2);
	const height = Math.floor(frame.height / 2);
	const data = new Uint8Array(width * height);
	for (let y = 0; y < height; y++) {
		const top = 2 * y * frame.width;
		const bottom = top + frame.width;
		for (let x = 0; x < width; x++) {
			const left = 2 * x;
			data[y * width + x] =
				((frame.data[top + left] ?? 0) +
					(frame.data[top + left + 1] ?? 0) +
					(frame.data[bottom + left] ?? 0) +
					(frame.data[bottom + left + 1] ?? 0) +
					2) >>
				2;
		}
	}
	return { data, height, width };
}

/**
 * Mean absolute difference between `next(x, y)` and `prev(x - dx, y - dy)`
 * over the region both frames cover, `margin` pixels in from every edge.
 */
function meanDifference(
	prev: GrayFrame,
	next: GrayFrame,
	dx: number,
	dy: number,
	margin: number
): number {
	const { width, height } = next;
	let total = 0;
	let count = 0;
	for (let y = margin; y < height - margin; y++) {
		const sourceRow = (y - dy) * width;
		const row = y * width;
		for (let x = margin; x < width - margin; x++) {
			total += Math.abs(
				(next.data[row + x] ?? 0) - (prev.data[sourceRow + x - dx] ?? 0)
			);
			count++;
		}
	}
	return count ? total / count : Number.POSITIVE_INFINITY;
}

interface SearchResult {
	cost: number;
	x: number;
	y: number;
}

function searchAround(
	prev: GrayFrame,
	next: GrayFrame,
	center: Vector,
	radius: number,
	limit: number
): SearchResult {
	const margin = limit + 1;
	let best: SearchResult = {
		cost: Number.POSITIVE_INFINITY,
		x: 0,
		y: 0,
	};
	for (let dy = center.y - radius; dy <= center.y + radius; dy++) {
		for (let dx = center.x - radius; dx <= center.x + radius; dx++) {
			if (Math.abs(dx) > limit || Math.abs(dy) > limit) {
				continue;
			}
			const cost = meanDifference(prev, next, dx, dy, margin);
			// Ties prefer the smaller shift, so flat frames read as still.
			if (
				cost < best.cost - 1e-9 ||
				(Math.abs(cost - best.cost) <= 1e-9 &&
					Math.abs(dx) + Math.abs(dy) < Math.abs(best.x) + Math.abs(best.y))
			) {
				best = { cost, x: dx, y: dy };
			}
		}
	}
	return best;
}

/** Parabolic sub-pixel offset of a minimum, within ±0.5. */
function parabolicOffset(before: number, at: number, after: number): number {
	const curvature = before - 2 * at + after;
	if (!(curvature > 1e-9)) {
		return 0;
	}
	return Math.max(-0.5, Math.min(0.5, (before - after) / (2 * curvature)));
}

/**
 * Global translation of `next` relative to `prev`: content at `(x, y)` in
 * `prev` appears near `(x + dx, y + dy)` in `next`. Coarse-to-fine block
 * matching over a pyramid, refined to sub-pixel precision with a parabola.
 * `maxShift` is the largest shift searched, in pixels of these frames.
 */
export function estimateTranslation(
	prev: GrayFrame,
	next: GrayFrame,
	maxShift: number
): Vector {
	if (prev.width !== next.width || prev.height !== next.height) {
		throw new Error("Frames must share dimensions.");
	}
	const levels: [GrayFrame, GrayFrame][] = [[prev, next]];
	let top = levels[0] as [GrayFrame, GrayFrame];
	while (levels.length < 4 && top[0].width >= 64 && top[0].height >= 32) {
		top = [downsampleFrame(top[0]), downsampleFrame(top[1])];
		levels.push(top);
	}
	let estimate: Vector = { x: 0, y: 0 };
	for (let level = levels.length - 1; level >= 0; level--) {
		const [a, b] = levels[level] as [GrayFrame, GrayFrame];
		const scale = 2 ** level;
		const limit = Math.max(
			1,
			Math.min(
				Math.ceil(maxShift / scale),
				Math.floor(Math.min(a.width, a.height) / 4)
			)
		);
		const radius = level === levels.length - 1 ? limit : 2;
		const found = searchAround(a, b, estimate, radius, limit);
		estimate = { x: found.x, y: found.y };
		if (level > 0) {
			estimate = { x: estimate.x * 2, y: estimate.y * 2 };
		}
	}
	const limit = Math.max(
		1,
		Math.min(
			Math.ceil(maxShift),
			Math.floor(Math.min(prev.width, prev.height) / 4)
		)
	);
	const margin = limit + 2;
	const cost = (dx: number, dy: number) =>
		Math.abs(dx) > limit + 1 || Math.abs(dy) > limit + 1
			? Number.POSITIVE_INFINITY
			: meanDifference(prev, next, dx, dy, margin);
	const center = cost(estimate.x, estimate.y);
	const refine = (before: number, after: number) =>
		Number.isFinite(before) && Number.isFinite(after)
			? parabolicOffset(before, center, after)
			: 0;
	return {
		x:
			estimate.x +
			refine(
				cost(estimate.x - 1, estimate.y),
				cost(estimate.x + 1, estimate.y)
			),
		y:
			estimate.y +
			refine(
				cost(estimate.x, estimate.y - 1),
				cost(estimate.x, estimate.y + 1)
			),
	};
}

/** Cumulative content position per frame from frame-to-frame motion. */
export function cumulativeTrajectory(motions: readonly Vector[]): Vector[] {
	const path: Vector[] = [];
	let x = 0;
	let y = 0;
	for (const [index, motion] of motions.entries()) {
		if (index > 0) {
			x += motion.x;
			y += motion.y;
		}
		path.push({ x, y });
	}
	return path;
}

/** Centered moving average with replicated end points. */
export function smoothTrajectory(
	path: readonly Vector[],
	radius: number
): Vector[] {
	const last = path.length - 1;
	const window = 2 * radius + 1;
	return path.map((_point, index) => {
		let x = 0;
		let y = 0;
		for (let offset = -radius; offset <= radius; offset++) {
			const sample = path[Math.max(0, Math.min(last, index + offset))] ?? {
				x: 0,
				y: 0,
			};
			x += sample.x;
			y += sample.y;
		}
		return { x: x / window, y: y / window };
	});
}

/**
 * Per-frame shift that moves each frame's content from its measured path
 * onto the smoothed path, clamped to the zoom margin. `motions[i]` is the
 * motion from frame `i - 1` to frame `i` (`motions[0]` is ignored).
 */
export function stabilizeCorrections(
	motions: readonly Vector[],
	smoothing: number,
	maxCorrection: Vector
): Vector[] {
	const path = cumulativeTrajectory(motions);
	const smooth = smoothTrajectory(path, smoothing);
	const clamp = (value: number, limit: number) =>
		Math.max(-limit, Math.min(limit, value));
	return path.map((point, index) => {
		const target = smooth[index] ?? point;
		return {
			x: clamp(target.x - point.x, maxCorrection.x),
			y: clamp(target.y - point.y, maxCorrection.y),
		};
	});
}

/** Crop window that zooms by the level margin, in source pixels (even). */
export function stabilizeCropWindow(
	width: number,
	height: number,
	level: StabilizeLevel
) {
	const { margin } = STABILIZE_LEVELS[level];
	const marginX = Math.max(1, Math.floor(width * margin));
	const marginY = Math.max(1, Math.floor(height * margin));
	return {
		height: evenFloor(height - 2 * marginY),
		marginX,
		marginY,
		width: evenFloor(width - 2 * marginX),
	};
}

/**
 * FFmpeg `sendcmd` script that moves the stabilizing crop per frame.
 * Corrections are in analysis pixels; `scale` converts them to source
 * pixels. Frame `i` starts at `i / fps` (the pass runs after `fps=`), and each
 * command fires a quarter frame early so rounding never skips one.
 */
export function stabilizeCropCommands(
	corrections: readonly Vector[],
	options: {
		fps: number;
		marginX: number;
		marginY: number;
		scale: number;
	}
): string {
	const rate = fpsValue(options.fps);
	const lines: string[] = [];
	let previous = "";
	for (const [index, correction] of corrections.entries()) {
		const x = clampInteger(
			Math.round(options.marginX - correction.x * options.scale),
			0,
			2 * options.marginX
		);
		const y = clampInteger(
			Math.round(options.marginY - correction.y * options.scale),
			0,
			2 * options.marginY
		);
		const key = `${x}:${y}`;
		if (key === previous) {
			continue;
		}
		previous = key;
		const at = Math.max(0, (index - 0.25) / rate);
		lines.push(`${at.toFixed(6)} crop x ${x}, crop y ${y};`);
	}
	return `${lines.join("\n")}\n`;
}

/** Shared head of both tracker passes: constant frame rate from zero. */
export function constantRateFilter(fps: number): string {
	return `setpts=PTS-STARTPTS,fps=${ffmpegFrameRate(fps)}`;
}

/** Pass 1 of the built-in tracker: small grayscale frames for analysis. */
export function translateAnalysisFilter(
	fps: number,
	size: { height: number; width: number }
): string {
	return `${constantRateFilter(fps)},scale=${size.width}:${size.height}:flags=area,format=gray`;
}

/** Pass 2 of the built-in tracker: per-frame crop, then scale back. */
export function translateApplyFilter(options: {
	fps: number;
	height: number;
	level: StabilizeLevel;
	width: number;
}): string {
	const crop = stabilizeCropWindow(
		options.width,
		options.height,
		options.level
	);
	const outWidth = evenFloor(options.width);
	const outHeight = evenFloor(options.height);
	return [
		constantRateFilter(options.fps),
		"format=yuv444p",
		"sendcmd=f=crop.cmd",
		`crop=w=${crop.width}:h=${crop.height}:x=${crop.marginX}:y=${crop.marginY}:exact=1`,
		`scale=${outWidth}:${outHeight}:flags=lanczos`,
		"format=yuv420p",
	].join(",");
}

function evenFloor(value: number): number {
	return Math.max(2, Math.floor(value / 2) * 2);
}

function clampInteger(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, value));
}
