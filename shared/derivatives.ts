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
import type { StabilizeLevel } from "./derivatives-stabilize.ts";
import { ffmpegFrameRate, fpsValue } from "./frame-rate.ts";
import {
	type Asset,
	type Project,
	type Segment,
	trackSettingFor,
	validateProject,
} from "./project.ts";
import type { AssetDerivation } from "./schema/asset.ts";

export type {
	GrayFrame,
	StabilizeLevel,
	StabilizeLevelSettings,
	StabilizeMethod,
	StabilizeRequest,
	Vector,
} from "./derivatives-stabilize.ts";
export {
	ANALYSIS_WIDTH,
	analysisSize,
	constantRateFilter,
	cumulativeTrajectory,
	displayedSize,
	downsampleFrame,
	estimateTranslation,
	STABILIZE_LEVELS,
	smoothTrajectory,
	stabilizeCorrections,
	stabilizeCropCommands,
	stabilizeCropWindow,
	stabilizeLevelSchema,
	stabilizeMethod,
	stabilizeRequestSchema,
	translateAnalysisFilter,
	translateApplyFilter,
	vidstabDetectFilter,
	vidstabTransformFilter,
} from "./derivatives-stabilize.ts";

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
