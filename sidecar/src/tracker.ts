/**
 * Motion tracker (W4-M4): normalized cross-correlation template matching on
 * grayscale frames that FFmpeg decodes at analysis resolution (≤640 px).
 *
 * The template is the region drawn on the start frame, sampled on a grid of
 * at most `MAX_TEMPLATE_SIDE` points per side. Each frame is searched
 * coarse-to-fine on an image pyramid: an exhaustive search around the
 * constant-velocity prediction at the top level, ±1 refinements below, a
 * scale search (±10%) at the base level, and a parabolic sub-pixel fit. The
 * template adapts slowly to appearance changes, but only while the match
 * still resembles the original region (drift guard); a weak match retries
 * with the original template over a wider window, and a lost subject holds
 * its last position.
 *
 * Pixel coordinates put pixel centers on integers. Pyramid level `L` halves
 * the image `L` times, so a full-resolution coordinate `X` is
 * `(X + 0.5) / 2^L - 0.5` there.
 */
import { spawn } from "node:child_process";
import type { Asset, Project, Segment } from "../../shared/project.ts";
import {
	canvasFrame,
	canvasRegionToSource,
	clipContent,
	clipTimelineTime,
	type TrackRegion,
	type TrackRequest,
	type TrackSample,
	type TrackWindow,
	trackWindow,
} from "../../shared/tracking.ts";
import { MEDIA_FORMATS, mediaBinary, mediaFailureMessage } from "./media.ts";
import { withMediaOperation } from "./media-operation.ts";
import type { StudioStore } from "./store.ts";

/** Longest side of the decoded analysis frames. */
export const MAX_ANALYSIS_SIDE = 640;
/** Template grid points per side, at most. */
export const MAX_TEMPLATE_SIDE = 32;
/** Highest analysis frame rate. */
export const MAX_ANALYSIS_FPS = 30;
/** Frames one request analyses at most (the frame rate drops to fit). */
export const MAX_TRACK_FRAMES = 3600;
/** Smallest region side in analysis pixels. */
export const MIN_REGION_PX = 6;
/** Below this score the subject counts as lost and its position is held. */
export const LOST_CONFIDENCE = 0.45;
/** Scale factors tried each frame, relative to the current scale. */
export const SCALE_STEPS = [0.9, 0.95, 1, 1.05, 1.1] as const;

const OPERATION_TIMEOUT_MS = 10 * 60_000;
/** A match this good may adapt the template. */
const UPDATE_CONFIDENCE = 0.8;
/** The adapted template must still match the original this well. */
const DRIFT_GUARD = 0.6;
/** Weight of a new appearance in the adapted template. */
const UPDATE_RATE = 0.15;
/** A scale change must beat the unchanged scale by this much. */
const SCALE_HYSTERESIS = 0.004;
const MIN_SCALE = 0.2;
const MAX_SCALE = 5;
const MAX_LEVELS = 4;
const MIN_LEVEL_GRID = 6;
const MAX_TOP_RADIUS = 10;

export interface GrayImage {
	data: Float32Array | Uint8Array;
	height: number;
	width: number;
}

/** A region in analysis pixels: center plus size. */
export interface PixelRegion {
	cx: number;
	cy: number;
	height: number;
	width: number;
}

export interface TrackerPoint {
	confidence: number;
	cx: number;
	cy: number;
	lost: boolean;
	scale: number;
}

/** Halve an image with a 2x2 box filter (an odd last row/column is dropped). */
export function downsample(image: GrayImage): GrayImage {
	const width = Math.max(1, Math.floor(image.width / 2));
	const height = Math.max(1, Math.floor(image.height / 2));
	const data = new Float32Array(width * height);
	const source = image.data;
	const stride = image.width;
	for (let y = 0; y < height; y++) {
		const top = 2 * y * stride;
		const bottom = Math.min(2 * y + 1, image.height - 1) * stride;
		for (let x = 0; x < width; x++) {
			const left = 2 * x;
			const right = Math.min(left + 1, image.width - 1);
			data[y * width + x] =
				((source[top + left] ?? 0) +
					(source[top + right] ?? 0) +
					(source[bottom + left] ?? 0) +
					(source[bottom + right] ?? 0)) *
				0.25;
		}
	}
	return { data, height, width };
}

/** `count` levels: the image itself, then successive halvings. */
export function buildPyramid(image: GrayImage, count: number): GrayImage[] {
	const levels = [image];
	for (let level = 1; level < count; level++) {
		const previous = levels[level - 1];
		if (!previous) {
			break;
		}
		levels.push(downsample(previous));
	}
	return levels;
}

/** A full-resolution coordinate at pyramid level `level`. */
export const toLevel = (value: number, level: number) =>
	(value + 0.5) / 2 ** level - 0.5;
/** A pyramid level coordinate at full resolution. */
export const fromLevel = (value: number, level: number) =>
	(value + 0.5) * 2 ** level - 0.5;

/**
 * Bilinear samples on a `cols`×`rows` grid with `spacing` pixels between
 * points, centered on (`cx`, `cy`). Edges are clamped.
 */
export function samplePatch(
	image: GrayImage,
	cx: number,
	cy: number,
	cols: number,
	rows: number,
	spacing: number,
	out: Float32Array<ArrayBufferLike> = new Float32Array(cols * rows)
): Float32Array {
	const { data, height, width } = image;
	const x0 = cx - ((cols - 1) / 2) * spacing;
	const y0 = cy - ((rows - 1) / 2) * spacing;
	const maxX = width - 1;
	const maxY = height - 1;
	let index = 0;
	for (let row = 0; row < rows; row++) {
		let y = y0 + row * spacing;
		y = y < 0 ? 0 : y > maxY ? maxY : y;
		const yi = Math.min(Math.floor(y), maxY - 1 < 0 ? 0 : maxY - 1);
		const fy = maxY > 0 ? y - yi : 0;
		const top = yi * width;
		const bottom = Math.min(yi + 1, maxY) * width;
		for (let col = 0; col < cols; col++) {
			let x = x0 + col * spacing;
			x = x < 0 ? 0 : x > maxX ? maxX : x;
			const xi = Math.min(Math.floor(x), maxX - 1 < 0 ? 0 : maxX - 1);
			const fx = maxX > 0 ? x - xi : 0;
			const xr = Math.min(xi + 1, maxX);
			const a = data[top + xi] ?? 0;
			const b = data[top + xr] ?? 0;
			const c = data[bottom + xi] ?? 0;
			const d = data[bottom + xr] ?? 0;
			const upper = a + (b - a) * fx;
			const lower = c + (d - c) * fx;
			out[index++] = upper + (lower - upper) * fy;
		}
	}
	return out;
}

/**
 * The patch as a zero-mean, unit-norm vector, or null when it is flat (no
 * texture to correlate).
 */
export function normalizePatch(patch: Float32Array): Float32Array | null {
	let sum = 0;
	for (const value of patch) {
		sum += value;
	}
	const mean = sum / patch.length;
	let energy = 0;
	const out = new Float32Array(patch.length);
	for (let index = 0; index < patch.length; index++) {
		const centered = (patch[index] ?? 0) - mean;
		out[index] = centered;
		energy += centered * centered;
	}
	if (energy < 1e-6 * patch.length) {
		return null;
	}
	const norm = 1 / Math.sqrt(energy);
	for (let index = 0; index < out.length; index++) {
		out[index] = (out[index] ?? 0) * norm;
	}
	return out;
}

/**
 * Normalized cross-correlation of a patch against a normalized template
 * (`normalizePatch`). A flat patch scores 0.
 */
export function ncc(template: Float32Array, patch: Float32Array): number {
	let dot = 0;
	let sum = 0;
	let squares = 0;
	for (let index = 0; index < patch.length; index++) {
		const value = patch[index] ?? 0;
		dot += (template[index] ?? 0) * value;
		sum += value;
		squares += value * value;
	}
	const variance = squares - (sum * sum) / patch.length;
	return variance > 1e-6 * patch.length ? dot / Math.sqrt(variance) : 0;
}

/** Vertex offset of the parabola through three samples, in `-0.5..0.5`. */
function parabolaPeak(left: number, center: number, right: number): number {
	const curvature = left - 2 * center + right;
	if (curvature >= 0) {
		return 0;
	}
	const offset = (0.5 * (left - right)) / curvature;
	return Math.max(-0.5, Math.min(0.5, offset));
}

interface Level {
	cols: number;
	rows: number;
}

interface Match {
	cx: number;
	cy: number;
	scale: number;
	score: number;
}

/** Template grids for one pyramid level: original, adapted and normalized. */
interface LevelTemplates {
	adapted: Float32Array;
	adaptedNorm: Float32Array;
	original: Float32Array;
}

/**
 * Tracks one region through successive frames. Construct it on the start
 * frame, then call `update` once per following frame, in order.
 */
export class TemplateTracker {
	readonly base: number;
	readonly spacing: number;
	private readonly grids: Level[];
	private readonly templates: LevelTemplates[];
	private readonly regionWidth: number;
	private readonly regionHeight: number;
	private readonly buffers: Float32Array[];
	private cx: number;
	private cy: number;
	private scale = 1;
	private vx = 0;
	private vy = 0;

	constructor(first: GrayImage, region: PixelRegion) {
		if (region.width < MIN_REGION_PX || region.height < MIN_REGION_PX) {
			throw new Error(
				"The tracking region is too small to follow. Draw a larger region."
			);
		}
		const step = Math.max(
			1,
			Math.max(region.width, region.height) / MAX_TEMPLATE_SIDE
		);
		this.base = Math.floor(Math.log2(step));
		this.spacing = step / 2 ** this.base;
		const cols = Math.max(3, Math.round(region.width / step));
		const rows = Math.max(3, Math.round(region.height / step));
		const grids: Level[] = [{ cols, rows }];
		const smallest = Math.min(first.width, first.height);
		for (let k = 1; k < MAX_LEVELS; k++) {
			const levelCols = Math.round(cols / 2 ** k);
			const levelRows = Math.round(rows / 2 ** k);
			if (
				Math.min(levelCols, levelRows) < MIN_LEVEL_GRID ||
				smallest / 2 ** (this.base + k) < 16
			) {
				break;
			}
			grids.push({ cols: levelCols, rows: levelRows });
		}
		this.grids = grids;
		this.buffers = grids.map((grid) => new Float32Array(grid.cols * grid.rows));
		this.regionWidth = region.width;
		this.regionHeight = region.height;
		this.cx = region.cx;
		this.cy = region.cy;
		const pyramid = this.pyramid(first);
		this.templates = grids.map((_, k) => {
			const patch = this.patch(pyramid, k, region.cx, region.cy, 1);
			const normalized = normalizePatch(patch);
			if (!normalized) {
				throw new Error(
					"The tracking region has no visible texture. Pick a region with detail."
				);
			}
			return {
				adapted: patch.slice(),
				adaptedNorm: normalized,
				original: normalized.slice(),
			};
		});
	}

	/** Number of pyramid levels the search uses. */
	get levelCount(): number {
		return this.grids.length;
	}

	private pyramid(frame: GrayImage): GrayImage[] {
		return buildPyramid(frame, this.base + this.grids.length);
	}

	/** The template-sized patch at full-resolution center (`cx`, `cy`). */
	private patch(
		pyramid: GrayImage[],
		k: number,
		cx: number,
		cy: number,
		scale: number,
		out?: Float32Array
	): Float32Array {
		const level = this.base + k;
		const grid = this.grids[k] ?? { cols: 3, rows: 3 };
		const image = pyramid[level] ?? pyramid[0];
		if (!image) {
			throw new Error("Missing tracking frame.");
		}
		const spacing =
			this.spacing *
			scale *
			(k === 0 ? 1 : this.levelStretch(k, grid.cols, grid.rows));
		return samplePatch(
			image,
			toLevel(cx, level),
			toLevel(cy, level),
			grid.cols,
			grid.rows,
			spacing,
			out
		);
	}

	/**
	 * Spacing correction at a coarse level whose grid count was rounded, so
	 * every level spans the same region extent as the base grid.
	 */
	private levelStretch(k: number, cols: number, rows: number): number {
		const base = this.grids[0] ?? { cols, rows };
		const wide = Math.max(base.cols, base.rows);
		const coarse = Math.max(cols, rows);
		return wide > 1 && coarse > 1 ? (wide - 1) / 2 ** k / (coarse - 1) : 1;
	}

	private score(
		pyramid: GrayImage[],
		k: number,
		cx: number,
		cy: number,
		scale: number,
		template: "adapted" | "original"
	): number {
		const templates = this.templates[k];
		if (!templates) {
			return 0;
		}
		const patch = this.patch(pyramid, k, cx, cy, scale, this.buffers[k]);
		return ncc(
			template === "adapted" ? templates.adaptedNorm : templates.original,
			patch
		);
	}

	/** Coarse-to-fine search around (`px`, `py`) within `radius` pixels. */
	private search(
		pyramid: GrayImage[],
		px: number,
		py: number,
		radius: number,
		template: "adapted" | "original"
	): Match {
		const top = this.grids.length - 1;
		const topLevel = this.base + top;
		const topRadius = Math.max(
			2,
			Math.min(MAX_TOP_RADIUS, Math.ceil(radius / 2 ** topLevel))
		);
		const unit = 2 ** topLevel;
		let best: Match = { cx: px, cy: py, scale: this.scale, score: -2 };
		for (let dy = -topRadius; dy <= topRadius; dy++) {
			for (let dx = -topRadius; dx <= topRadius; dx++) {
				const cx = px + dx * unit;
				const cy = py + dy * unit;
				const score = this.score(pyramid, top, cx, cy, this.scale, template);
				if (score > best.score) {
					best = { cx, cy, scale: this.scale, score };
				}
			}
		}
		for (let k = top - 1; k >= 1; k--) {
			best = this.refine(pyramid, k, best, [best.scale], template);
		}
		const scales = SCALE_STEPS.map((factor) =>
			Math.max(MIN_SCALE, Math.min(MAX_SCALE, this.scale * factor))
		);
		return this.refine(pyramid, 0, best, scales, template, true);
	}

	/** ±1 level-pixel refinement over `scales`, with a sub-pixel fit at k=0. */
	private refine(
		pyramid: GrayImage[],
		k: number,
		start: Match,
		scales: readonly number[],
		template: "adapted" | "original",
		subPixel = false
	): Match {
		const unit = 2 ** (this.base + k);
		let best: Match = { ...start, score: -2 };
		let unchanged = -2;
		for (const scale of scales) {
			for (let dy = -1; dy <= 1; dy++) {
				for (let dx = -1; dx <= 1; dx++) {
					const cx = start.cx + dx * unit;
					const cy = start.cy + dy * unit;
					const score = this.score(pyramid, k, cx, cy, scale, template);
					if (scale === start.scale && score > unchanged) {
						unchanged = score;
					}
					if (score > best.score) {
						best = { cx, cy, scale, score };
					}
				}
			}
		}
		if (
			best.scale !== start.scale &&
			best.score < unchanged + SCALE_HYSTERESIS
		) {
			// Keep the scale unless another one is clearly better.
			best = this.refine(pyramid, k, start, [start.scale], template);
			if (!subPixel) {
				return best;
			}
		}
		if (!subPixel) {
			return best;
		}
		const at = (dx: number, dy: number) =>
			this.score(
				pyramid,
				k,
				best.cx + dx * unit,
				best.cy + dy * unit,
				best.scale,
				template
			);
		const offsetX = parabolaPeak(at(-1, 0), best.score, at(1, 0));
		const offsetY = parabolaPeak(at(0, -1), best.score, at(0, 1));
		return {
			...best,
			cx: best.cx + offsetX * unit,
			cy: best.cy + offsetY * unit,
		};
	}

	/** Blend the matched appearance into the adapted template (drift-guarded). */
	private adapt(pyramid: GrayImage[], match: Match) {
		const patches = this.grids.map((_, k) =>
			this.patch(pyramid, k, match.cx, match.cy, match.scale)
		);
		const base = patches[0];
		const original = this.templates[0]?.original;
		if (!(base && original) || ncc(original, base) < DRIFT_GUARD) {
			return;
		}
		patches.forEach((patch, k) => {
			const templates = this.templates[k];
			if (!templates) {
				return;
			}
			const adapted = templates.adapted;
			for (let index = 0; index < adapted.length; index++) {
				adapted[index] =
					(adapted[index] ?? 0) * (1 - UPDATE_RATE) +
					(patch[index] ?? 0) * UPDATE_RATE;
			}
			const normalized = normalizePatch(adapted);
			if (normalized) {
				templates.adaptedNorm = normalized;
			}
		});
	}

	/** Track the region into the next frame. */
	update(frame: GrayImage): TrackerPoint {
		const pyramid = this.pyramid(frame);
		const px = this.cx + this.vx;
		const py = this.cy + this.vy;
		const speed = Math.hypot(this.vx, this.vy);
		const radius =
			Math.max(
				6,
				Math.min(64, 0.3 * Math.max(this.regionWidth, this.regionHeight))
			) *
				Math.max(1, this.scale) +
			0.5 * speed;
		let match = this.search(pyramid, px, py, radius, "adapted");
		if (match.score < UPDATE_CONFIDENCE) {
			// Re-detect with the original appearance over a wider window.
			const retry = this.search(pyramid, px, py, radius * 2, "original");
			if (retry.score > match.score) {
				match = retry;
			}
		}
		const confidence = Math.max(0, Math.min(1, match.score));
		if (confidence < LOST_CONFIDENCE) {
			this.vx *= 0.5;
			this.vy *= 0.5;
			return {
				confidence,
				cx: this.cx,
				cy: this.cy,
				lost: true,
				scale: this.scale,
			};
		}
		this.vx = 0.5 * this.vx + 0.5 * (match.cx - this.cx);
		this.vy = 0.5 * this.vy + 0.5 * (match.cy - this.cy);
		this.cx = match.cx;
		this.cy = match.cy;
		this.scale = match.scale;
		if (confidence >= UPDATE_CONFIDENCE) {
			this.adapt(pyramid, match);
		}
		return {
			confidence,
			cx: this.cx,
			cy: this.cy,
			lost: false,
			scale: this.scale,
		};
	}
}

/** Track a region through in-memory frames (the first frame holds the region). */
export function trackFrames(
	frames: Iterable<GrayImage>,
	region: PixelRegion
): TrackerPoint[] {
	let tracker: TemplateTracker | undefined;
	const points: TrackerPoint[] = [];
	for (const frame of frames) {
		if (tracker) {
			points.push(tracker.update(frame));
		} else {
			tracker = new TemplateTracker(frame, region);
			points.push({
				confidence: 1,
				cx: region.cx,
				cy: region.cy,
				lost: false,
				scale: 1,
			});
		}
	}
	return points;
}

/** Even analysis size with the source aspect, never upscaled. */
export function analysisSize(
	width: number,
	height: number
): { height: number; width: number } {
	const factor = Math.min(1, MAX_ANALYSIS_SIDE / Math.max(width, height, 1));
	const even = (value: number) => Math.max(16, 2 * Math.round(value / 2));
	return { height: even(height * factor), width: even(width * factor) };
}

/** Analysis frame rate for a source span, lowered to fit the frame budget. */
export function analysisFps(
	sourceSeconds: number,
	frameRate: number | undefined
): number {
	const native = Math.min(MAX_ANALYSIS_FPS, frameRate ?? MAX_ANALYSIS_FPS);
	const budget = MAX_TRACK_FRAMES / Math.max(sourceSeconds, 1e-3);
	return Math.max(1, Math.min(native, budget));
}

/** A source-fraction region as an analysis-pixel center and size. */
export function regionToPixels(
	region: TrackRegion,
	size: { height: number; width: number }
): PixelRegion {
	return {
		cx: (region.x + region.width / 2) * size.width - 0.5,
		cy: (region.y + region.height / 2) * size.height - 0.5,
		height: region.height * size.height,
		width: region.width * size.width,
	};
}

export interface DecodeOptions {
	fps: number;
	height: number;
	/** Source seconds to decode. */
	seconds: number;
	signal: AbortSignal;
	/** Source time of the first frame. */
	start: number;
	timeoutMs: number;
	width: number;
}

/**
 * Stream grayscale frames of the first video stream to `onFrame`, one at a
 * time, so memory stays at one frame however long the span is.
 */
export async function streamGrayFrames(
	path: string,
	options: DecodeOptions,
	onFrame: (frame: GrayImage, index: number) => void
): Promise<number> {
	const frameBytes = options.width * options.height;
	const args = [
		"-hide_banner",
		"-loglevel",
		"error",
		"-nostdin",
		"-protocol_whitelist",
		"file,pipe",
		"-format_whitelist",
		MEDIA_FORMATS,
		"-ss",
		options.start.toFixed(6),
		"-i",
		path,
		"-t",
		options.seconds.toFixed(6),
		"-map",
		"0:v:0",
		"-an",
		"-sn",
		"-dn",
		"-vf",
		`fps=${options.fps.toFixed(6)},scale=${options.width}:${options.height}:flags=area,format=gray`,
		"-f",
		"rawvideo",
		"pipe:1",
	];
	return await new Promise<number>((resolve, reject) => {
		options.signal.throwIfAborted();
		const child = spawn(mediaBinary("ffmpeg"), args, {
			stdio: ["ignore", "pipe", "pipe"],
		});
		let pending: Buffer<ArrayBufferLike> = Buffer.alloc(0);
		let count = 0;
		let stderr = "";
		let failure: Error | undefined;
		let spawnFailed = false;
		const abort = () => child.kill("SIGKILL");
		const timer = setTimeout(() => {
			failure ??= new Error("Motion tracking timed out.");
			abort();
		}, options.timeoutMs);
		options.signal.addEventListener("abort", abort, { once: true });
		child.stdout.on("data", (chunk: Buffer) => {
			if (failure) {
				return;
			}
			pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
			let offset = 0;
			try {
				while (pending.length - offset >= frameBytes) {
					const data = new Uint8Array(frameBytes);
					data.set(pending.subarray(offset, offset + frameBytes));
					offset += frameBytes;
					onFrame(
						{ data, height: options.height, width: options.width },
						count++
					);
				}
			} catch (error) {
				failure = error instanceof Error ? error : new Error(String(error));
				abort();
			}
			pending = pending.subarray(offset);
		});
		child.stderr.on("data", (bytes: Buffer) => {
			stderr = (stderr + bytes.toString()).slice(-8000);
		});
		child.on("error", () => {
			if (child.pid === undefined) {
				spawnFailed = true;
				clearTimeout(timer);
				options.signal.removeEventListener("abort", abort);
				reject(
					new Error(
						"The media renderer is unavailable. Install FFmpeg and ffprobe on the node."
					)
				);
			}
		});
		child.once("close", (code) => {
			clearTimeout(timer);
			options.signal.removeEventListener("abort", abort);
			if (spawnFailed) {
				return;
			}
			if (options.signal.aborted) {
				reject(new Error("Operation canceled."));
			} else if (failure) {
				reject(failure);
			} else if (code === 0) {
				resolve(count);
			} else {
				reject(new Error(mediaFailureMessage(stderr)));
			}
		});
	});
}

/** A tracking run: the samples plus where the region started. */
export interface TrackRun {
	analysis: { fps: number; height: number; width: number };
	samples: TrackSample[];
	/** The start region as fractions of the source frame. */
	sourceRegion: TrackRegion;
	window: TrackWindow;
}

/** Resolve the tracked clip and its media; fails for non-video clips. */
export function trackedClip(
	project: Project,
	assets: readonly Asset[],
	clipId: string
): { asset: Asset; segment: Segment } {
	const segment = project.segments.find((item) => item.id === clipId);
	if (!segment) {
		throw new Error("The clip to track was not found.");
	}
	const asset = assets.find((item) => item.id === segment.assetId);
	if (asset?.kind !== "video") {
		throw new Error("Motion tracking follows subjects in video clips only.");
	}
	return { asset, segment };
}

/** The request's start region as fractions of the clip's source frame. */
export function requestSourceRegion(
	project: Project,
	segment: Segment,
	asset: Asset,
	request: Pick<TrackRequest, "roi" | "roiSpace" | "time">
): TrackRegion {
	if (request.roiSpace === "source") {
		return request.roi;
	}
	const canvas = canvasFrame(project);
	return canvasRegionToSource(
		segment,
		clipContent(asset, canvas),
		canvas,
		request.roi,
		request.time - segment.start
	);
}

/**
 * Decode the clip from the request time and track the region through it.
 * Takes one media admission slot.
 */
export async function trackClip(
	store: StudioStore,
	project: Project,
	request: Pick<
		TrackRequest,
		"clipId" | "duration" | "roi" | "roiSpace" | "time"
	>,
	signal: AbortSignal
): Promise<TrackRun> {
	const { asset, segment } = trackedClip(
		project,
		store.assets(),
		request.clipId
	);
	const window = trackWindow(segment, request.time, request.duration);
	const sourceRegion = requestSourceRegion(project, segment, asset, request);
	const sourceStart = Math.max(0, window.sourceStart);
	const sourceEnd = Math.min(asset.duration, window.sourceEnd);
	const seconds = sourceEnd - sourceStart;
	if (seconds <= 0) {
		throw new Error("The clip has no source frames to track at this time.");
	}
	const size = analysisSize(asset.width, asset.height);
	const fps = analysisFps(seconds, asset.frameRate);
	const region = regionToPixels(sourceRegion, size);
	const samples: TrackSample[] = [];
	await withMediaOperation(
		OPERATION_TIMEOUT_MS,
		{ signal },
		async (operation) => {
			let tracker: TemplateTracker | undefined;
			await streamGrayFrames(
				store.mediaPath(asset.id),
				{
					fps,
					height: size.height,
					seconds,
					signal: operation.signal,
					start: sourceStart,
					timeoutMs: operation.remainingMs(),
					width: size.width,
				},
				(frame, index) => {
					const time = clipTimelineTime(segment, sourceStart + index / fps);
					if (time > window.end + 1e-6) {
						return;
					}
					let point: TrackerPoint;
					if (tracker) {
						point = tracker.update(frame);
					} else {
						tracker = new TemplateTracker(frame, region);
						point = {
							confidence: 1,
							cx: region.cx,
							cy: region.cy,
							lost: false,
							scale: 1,
						};
					}
					samples.push({
						confidence: Math.round(point.confidence * 1000) / 1000,
						scale: point.scale,
						time: Math.min(window.end, time),
						x: (point.cx + 0.5) / size.width,
						y: (point.cy + 0.5) / size.height,
					});
				}
			);
		}
	);
	if (samples.length < 2) {
		throw new Error(
			"Too few frames to track. Track from earlier in the clip or a longer clip."
		);
	}
	return {
		analysis: { fps, ...size },
		samples,
		sourceRegion,
		window,
	};
}
