/**
 * Media derivatives (G53, G56, G57): stabilization, frame interpolation and
 * smooth slow motion. Everything here is pure and deterministic; the sidecar
 * runs FFmpeg with the filter strings and plans built from these helpers.
 *
 * A derivative is a new app-owned asset linked to its source by
 * `derivedFromAssetId` and tagged with `derivation`. Stabilized and
 * interpolated derivatives keep the source timebase (same duration, same
 * source time), so a clip swapped onto one keeps its `sourceIn`/`sourceOut`.
 */
import { z } from "zod";
import { ffmpegFrameRate, fpsValue } from "./frame-rate.ts";
import {
	type Asset,
	type Project,
	type Segment,
	trackSettingFor,
	validateProject,
} from "./project.ts";
import type { AssetDerivation } from "./schema/asset.ts";

/** Highest frame rate a derivative may target (the asset schema bound). */
export const MAX_DERIVATIVE_FPS = 240;
/** Longest source a stabilize or interpolate derivative accepts. */
export const MAX_DERIVATIVE_SECONDS = 600;
/** Output frames an interpolation may synthesize (10 minutes at 120 fps). */
export const MAX_INTERPOLATED_FRAMES = 72_000;

/** Optional FFmpeg filters the derivative builders choose between. */
export interface DerivativeFilterSupport {
	/** Contrast-adaptive sharpening (FFmpeg 4.3+). */
	cas: boolean;
	/** Motion-compensated interpolation (optical flow). */
	minterpolate: boolean;
	/** Non-local means denoiser. */
	nlmeans: boolean;
	/** `vidstabdetect` and `vidstabtransform` (libvidstab). */
	vidstab: boolean;
}

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

/* ------------------------------------------------------------------ */
/* Interpolate and smooth slow motion                                  */
/* ------------------------------------------------------------------ */

export const interpolateModeSchema = z.enum(["blend", "optical-flow"]);
export type InterpolateMode = z.infer<typeof interpolateModeSchema>;

export const interpolateRequestSchema = z
	.object({
		fps: z.number().finite().min(1).max(MAX_DERIVATIVE_FPS),
		mode: interpolateModeSchema.optional(),
		name: z.string().trim().min(1).max(200).optional(),
	})
	.strict();
export type InterpolateRequest = z.infer<typeof interpolateRequestSchema>;

export type InterpolateMethod = "minterpolate" | "framerate";

/** Optical flow uses `minterpolate`; without it (or for blend) `framerate`. */
export function interpolateFilter(
	fps: number,
	mode: InterpolateMode,
	support: Pick<DerivativeFilterSupport, "minterpolate">
): { filter: string; method: InterpolateMethod; mode: InterpolateMode } {
	const rate = ffmpegFrameRate(fps);
	if (mode === "optical-flow" && support.minterpolate) {
		return {
			filter: `minterpolate=fps=${rate}:mi_mode=mci:mc_mode=aobmc:vsbmc=1`,
			method: "minterpolate",
			mode,
		};
	}
	return {
		filter: `framerate=fps=${rate}`,
		method: "framerate",
		mode: "blend",
	};
}

/**
 * Wrap an interpolation filter so the output video keeps the source video
 * duration. `minterpolate` (and `framerate`) stop at the last source frame,
 * dropping its interval; cloning two frames onto the tail lets them
 * synthesize it, and `trim` cuts the result back to the source length.
 */
export function boundedInterpolationFilter(
	filter: string,
	source: { duration: number; fps: number }
): string {
	if (!(source.duration > 0)) {
		throw new Error("Interpolation needs a measured video duration.");
	}
	const pad = 2 / Math.max(1, source.fps);
	return [
		`tpad=stop_mode=clone:stop_duration=${pad.toFixed(6)}`,
		filter,
		`trim=duration=${source.duration.toFixed(6)}`,
	].join(",");
}

/** Default mode: optical flow when available, otherwise frame blending. */
export function defaultInterpolateMode(
	support: Pick<DerivativeFilterSupport, "minterpolate">
): InterpolateMode {
	return support.minterpolate ? "optical-flow" : "blend";
}

/** Refuse interpolation that would synthesize an unbounded number of frames. */
export function assertInterpolationBounds(duration: number, fps: number) {
	if (!(duration > 0) || duration > MAX_DERIVATIVE_SECONDS) {
		throw new Error(
			`Frame interpolation supports media up to ${MAX_DERIVATIVE_SECONDS / 60} minutes long.`
		);
	}
	if (duration * fps > MAX_INTERPOLATED_FRAMES) {
		throw new Error(
			`Frame interpolation creates at most ${MAX_INTERPOLATED_FRAMES} frames. Choose a lower frame rate or a shorter clip.`
		);
	}
}

export const smoothSlowMotionRequestSchema = z
	.object({
		clipId: z.uuid(),
		mode: interpolateModeSchema.optional(),
		revision: z.number().int().nonnegative(),
	})
	.strict();
export type SmoothSlowMotionRequest = z.infer<
	typeof smoothSlowMotionRequestSchema
>;

/**
 * Source frame rate that keeps every output frame unique when a clip plays
 * at `speed` in a `projectFps` timeline: `projectFps / speed`, rounded up to
 * a whole rate and capped at 240.
 */
export function smoothSlowMotionFps(projectFps: number, speed: number): number {
	if (!(speed > 0 && projectFps > 0)) {
		throw new Error(
			"Smooth slow motion needs a positive speed and frame rate."
		);
	}
	return Math.min(
		MAX_DERIVATIVE_FPS,
		Math.ceil(fpsValue(projectFps) / speed - 1e-6)
	);
}

/** The original media of an interpolated derivative (or the asset itself). */
export function interpolationRoot(
	asset: Asset,
	assets: readonly Asset[]
): Asset {
	if (asset.derivation === "interpolate" && asset.derivedFromAssetId) {
		return (
			assets.find((candidate) => candidate.id === asset.derivedFromAssetId) ??
			asset
		);
	}
	return asset;
}

export interface SmoothSlowMotionPlan {
	clip: Segment;
	fps: number;
	mode: InterpolateMode;
	source: Asset;
}

function findClip(project: Project, clipId: string): Segment {
	const clip = project.segments.find((segment) => segment.id === clipId);
	if (!clip) {
		throw new Error("Clip not found on this timeline.");
	}
	return clip;
}

function assertClipEditable(project: Project, clip: Segment) {
	if (trackSettingFor(project, clip.track).locked) {
		throw new Error("Unlock the clip track before editing its media.");
	}
	if (clip.multicamGroupId) {
		throw new Error("Ungroup the multicam session before swapping its media.");
	}
}

/**
 * What smooth slow motion renders for a clip: the original source, the mode
 * (the request's, else the clip's `frameInterpolation`) and the target rate.
 */
export function planSmoothSlowMotion(
	project: Project,
	assets: readonly Asset[],
	input: { clipId: string; mode?: InterpolateMode | undefined }
): SmoothSlowMotionPlan {
	const clip = findClip(project, input.clipId);
	assertClipEditable(project, clip);
	const asset = assets.find((candidate) => candidate.id === clip.assetId);
	if (asset?.kind !== "video") {
		throw new Error("Smooth slow motion applies to video clips.");
	}
	if (!(clip.speed < 1)) {
		throw new Error("Smooth slow motion applies to clips slower than 1x.");
	}
	const requested = input.mode ?? clip.frameInterpolation;
	if (!requested || requested === "none") {
		throw new Error(
			"Choose blend or optical-flow frame interpolation for this clip first."
		);
	}
	const source = interpolationRoot(asset, assets);
	const fps = smoothSlowMotionFps(project.fps, clip.speed);
	if (source.frameRate !== undefined && source.frameRate >= fps - 0.01) {
		throw new Error(
			`This media already has ${Math.round(source.frameRate)} fps, enough for ${clip.speed}x without interpolation.`
		);
	}
	assertInterpolationBounds(source.duration, fps);
	return { clip, fps, mode: requested, source };
}

/**
 * Swap a clip onto its interpolated derivative. The derivative shares the
 * source timebase, so `sourceIn`/`sourceOut` and `speed` are preserved
 * (clamped only by a derivative that ends a frame early).
 */
export function applySmoothSlowMotion(
	project: Project,
	assets: readonly Asset[],
	input: { assetId: string; clipId: string; mode: InterpolateMode }
): Project {
	const clip = findClip(project, input.clipId);
	assertClipEditable(project, clip);
	const derivative = assets.find((asset) => asset.id === input.assetId);
	const current = assets.find((asset) => asset.id === clip.assetId);
	if (!(derivative && current)) {
		throw new Error("Interpolated media is unavailable.");
	}
	const root = interpolationRoot(current, assets);
	if (
		derivative.derivation !== "interpolate" ||
		derivative.derivedFromAssetId !== root.id
	) {
		throw new Error("The interpolated media does not belong to this clip.");
	}
	const sourceOut = Math.min(clip.sourceOut, derivative.duration);
	const sourceIn = Math.min(clip.sourceIn, Math.max(0, sourceOut - 0.04));
	if (sourceOut - sourceIn < 0.04) {
		throw new Error("The interpolated media is too short for this clip.");
	}
	return validateProject(
		{
			...project,
			segments: project.segments.map((segment) =>
				segment.id === clip.id
					? {
							...segment,
							assetId: derivative.id,
							frameInterpolation: input.mode,
							sourceIn,
							sourceOut,
						}
					: segment
			),
		},
		[...assets]
	);
}

/* ------------------------------------------------------------------ */
/* Enhance (upscale)                                                   */
/* ------------------------------------------------------------------ */

/**
 * Denoise, Lanczos resize, then sharpen. Stills use `nlmeans` when present
 * (too slow for video, which uses `hqdn3d`); sharpening is `cas` or, on older
 * builds, `unsharp`.
 */
export function enhanceUpscaleFilter(
	size: { height: number; width: number },
	kind: "image" | "video",
	support: Pick<DerivativeFilterSupport, "cas" | "nlmeans">
): string {
	const denoise =
		kind === "image" && support.nlmeans
			? "nlmeans=s=1.5:p=7:r=9"
			: "hqdn3d=2:1.5:4:3";
	const sharpen = support.cas ? "cas=strength=0.5" : "unsharp=5:5:0.8:5:5:0.0";
	return [
		denoise,
		`scale=${size.width}:${size.height}:flags=lanczos`,
		sharpen,
	].join(",");
}

/* ------------------------------------------------------------------ */
/* Derivative metadata                                                 */
/* ------------------------------------------------------------------ */

export type DerivativeSpec =
	| { kind: "stabilize"; level: StabilizeLevel }
	| { fps: number; kind: "interpolate"; mode: InterpolateMode }
	| { factor: number; kind: "enhance" };

const DERIVATION_OF: Record<DerivativeSpec["kind"], AssetDerivation> = {
	enhance: "enhance",
	interpolate: "interpolate",
	stabilize: "stabilize",
};

export function derivationOf(spec: DerivativeSpec): AssetDerivation {
	return DERIVATION_OF[spec.kind];
}

/** Human-readable suffix that also identifies a derivative for reuse. */
export function derivativeLabel(spec: DerivativeSpec): string {
	if (spec.kind === "stabilize") {
		return `stabilized (${spec.level})`;
	}
	if (spec.kind === "interpolate") {
		const rate = Number(spec.fps.toFixed(3));
		return `${rate} fps ${spec.mode === "optical-flow" ? "optical flow" : "blend"}`;
	}
	return `${spec.factor}× enhanced upscale`;
}

/** Derivative asset name: the source name (shortened to fit) and the label. */
export function derivativeName(sourceName: string, spec: DerivativeSpec) {
	const label = derivativeLabel(spec);
	return `${sourceName.slice(0, Math.max(1, 197 - label.length))} · ${label}`;
}

/** An existing derivative of `sourceId` made with the same settings. */
export function findDerivative(
	assets: readonly Asset[],
	sourceId: string,
	spec: DerivativeSpec
): Asset | undefined {
	const derivation = derivationOf(spec);
	const suffix = ` · ${derivativeLabel(spec)}`;
	return assets.find(
		(asset) =>
			asset.derivation === derivation &&
			asset.derivedFromAssetId === sourceId &&
			asset.name.endsWith(suffix)
	);
}

/** Media a derivative may be made from (no audio, no nested sequences). */
export function assertDerivableVideo(asset: Asset, action: string) {
	if (asset.kind !== "video") {
		throw new Error(`Only video media can be ${action}.`);
	}
	if (asset.sequenceProjectId) {
		throw new Error(
			`Refresh nested sequences as media before they are ${action}.`
		);
	}
	if (asset.derivation === "proxy") {
		throw new Error(
			`Preview proxies cannot be ${action}; use the original media.`
		);
	}
	if (!(asset.duration > 0) || asset.duration > MAX_DERIVATIVE_SECONDS) {
		throw new Error(
			`Media up to ${MAX_DERIVATIVE_SECONDS / 60} minutes long can be ${action}.`
		);
	}
}

function evenFloor(value: number): number {
	return Math.max(2, Math.floor(value / 2) * 2);
}

function clampInteger(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, value));
}
