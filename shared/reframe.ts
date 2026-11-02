/**
 * Auto reframe (W4-AI1): re-fit clips to another canvas aspect.
 *
 * Three modes:
 *
 * - `track`: a saliency path (frame-difference motion plus Sobel edge
 *   density, weighted by a mild center prior) is measured per clip by the
 *   sidecar (`sidecar/src/saliency.ts`) at `REFRAME_SAMPLE_FPS` on frames
 *   `REFRAME_FRAME_WIDTH` pixels wide. Per shot it is smoothed (a local
 *   quadratic fit, the Savitzky-Golay idea, plus a dead zone so the virtual
 *   camera holds still for small motion) and becomes `x` (or `y`) keyframes
 *   that pan a `fill` box across a statically cropped band of the source.
 * - `center`: a centred cover crop (`fit: "fill"` at scale 1).
 * - `blur-fill`: the whole picture fitted, with the project canvas set to a
 *   blur fill (clips off the base track get their own blur fill).
 *
 * Geometry (see `shared/transform.ts`): a clip's box is the canvas times
 * `scale`, `scaleX` and `scaleY`; `x` moves it by `x * canvasWidth / 2`.
 * Panning needs a box wider than the canvas, and `x` is bounded to
 * ±`MAX_CLIP_OFFSET` (3), so the box may be at most four canvas widths. That
 * covers the whole source for every target here (16:9 into 9:16 needs 3.16),
 * so a subject at the frame edge can be followed. A source that would need a
 * wider box is first cropped to a band that holds the subject's path, at most
 * `MAX_PAN_BOX / coverRatio` of its width.
 *
 * Generative outpainting is out of scope; `blur-fill` is the local
 * equivalent. Every function here is pure and deterministic.
 */
import { z } from "zod";
import { BASE_TRACK, DEFAULT_BLUR } from "./background.ts";
import { stabilizeLevelSchema } from "./derivatives.ts";
import { MAX_CANVAS, MAX_CLIP_OFFSET } from "./limits.ts";
import {
	type Asset,
	type Keyframe,
	type Project,
	type Segment,
	trackSettingFor,
	validateProject,
} from "./project.ts";
import { scaleXOf, scaleYOf } from "./schema/defaults.ts";
import { idSchema } from "./schema/primitives.ts";

/** Frames per second of source the saliency tracker samples. */
export const REFRAME_SAMPLE_FPS = 4;
/** Width, in pixels, of the luma frames the tracker analyses. */
export const REFRAME_FRAME_WIDTH = 160;
/** Most samples one clip is tracked over; longer clips sample more sparsely. */
export const REFRAME_MAX_SAMPLES = 2400;
/** Most pan keyframes one reframed clip receives. */
export const REFRAME_MAX_PATH_KEYFRAMES = 60;
/** Default smoothing strength when the request leaves it out. */
export const DEFAULT_REFRAME_SMOOTHING = 0.5;
/** Longest one-sided smoothing window, in seconds, at smoothing 1. */
const MAX_SMOOTHING_SECONDS = 1.5;
/** Dead zone, as a share of the source axis, at smoothing 1. */
const MAX_DEAD_ZONE = 0.06;
/**
 * Widest box, in canvas widths, that `x`/`y` within ±`MAX_CLIP_OFFSET` can
 * still pan, also bounded by the clip scale limit (4).
 */
const MAX_PAN_BOX = Math.min(4, MAX_CLIP_OFFSET + 1);
/** Schema bound of one crop edge. */
const MAX_CROP_EDGE = 0.9;
/** Smallest band share of the source a pan may use. */
const MIN_BAND = 0.02;
/** Ratio within which the source already matches the target aspect. */
const SAME_ASPECT = 0.005;

export const reframeAspects = [
	"9:16",
	"1:1",
	"4:5",
	"16:9",
	"4:3",
	"3:4",
	"2.35:1",
	"21:9",
] as const;
export const reframeAspectSchema = z.enum(reframeAspects);
export type ReframeAspect = z.infer<typeof reframeAspectSchema>;

export const reframeModes = ["track", "center", "blur-fill"] as const;
export const reframeModeSchema = z.enum(reframeModes);
export type ReframeMode = z.infer<typeof reframeModeSchema>;

export const reframeModeLabels: Record<ReframeMode, string> = {
	"blur-fill": "Fit with blur fill",
	center: "Center crop",
	track: "Track subject",
};

export const reframeRequestSchema = z
	.object({
		aspect: reframeAspectSchema,
		mode: reframeModeSchema,
		clipIds: z.array(idSchema).min(1).max(500).optional(),
		smoothing: z.number().finite().min(0).max(1).optional(),
		/**
		 * Stabilize each target video first (low, medium or high, as the
		 * stabilize derivative), so tracking and the crop run on the steadied
		 * picture. See `shared/reframe-stabilize.ts`.
		 */
		stabilize: stabilizeLevelSchema.optional(),
		revision: z.number().int().nonnegative(),
	})
	.strict();
export type ReframeRequest = z.infer<typeof reframeRequestSchema>;

const aspectRatios: Record<ReframeAspect, number> = {
	"16:9": 16 / 9,
	"1:1": 1,
	"2.35:1": 2.35,
	"21:9": 21 / 9,
	"3:4": 3 / 4,
	"4:3": 4 / 3,
	"4:5": 4 / 5,
	"9:16": 9 / 16,
};

/** Width over height of a reframe target. */
export const reframeAspectRatio = (aspect: ReframeAspect): number =>
	aspectRatios[aspect];

const round = (value: number, digits = 6) => Number(value.toFixed(digits));
const clamp = (value: number, min: number, max: number) =>
	Math.min(max, Math.max(min, value));
const evenEdge = (value: number) =>
	Math.max(128, Math.min(MAX_CANVAS, Math.round(value / 2) * 2));

/**
 * The canvas for a target aspect, like `POST /settings` with an aspect
 * ratio: the project's short edge is kept, the long edge follows the aspect,
 * and both edges are even and inside the canvas bounds.
 */
export function reframeCanvas(
	project: Pick<Project, "height" | "width">,
	aspect: ReframeAspect
): { height: number; width: number } {
	const ratio = reframeAspectRatio(aspect);
	const shortEdge = Math.min(project.width, project.height);
	const width = ratio >= 1 ? shortEdge * ratio : shortEdge;
	const height = ratio >= 1 ? shortEdge : shortEdge / ratio;
	const fit = Math.min(1, MAX_CANVAS / width, MAX_CANVAS / height);
	return { height: evenEdge(height * fit), width: evenEdge(width * fit) };
}

/** Whether a clip shows a picture that can be reframed. */
export function isReframeableClip(
	segment: Segment,
	asset: Asset | undefined
): boolean {
	return (
		asset !== undefined &&
		asset.kind !== "audio" &&
		asset.width > 0 &&
		asset.height > 0 &&
		segment.visualization !== "waveform"
	);
}

/** Slack, in canvas half-widths, when deciding that a box covers the canvas. */
const COVER_SLACK = 0.01;

/**
 * Whether a clip's static box covers the whole canvas on both axes. The box
 * spans `x ± scale * scaleX` (and `y ± scale * scaleY`) in canvas
 * half-widths, so split-screen cells (`scaleX` 0.5 moved off centre) and
 * picture-in-picture insets do not count.
 */
export function coversCanvas(
	segment: Pick<Segment, "scale" | "scaleX" | "scaleY" | "x" | "y">
): boolean {
	const halfWidth = segment.scale * scaleXOf(segment);
	const halfHeight = segment.scale * scaleYOf(segment);
	return (
		segment.x - halfWidth <= -1 + COVER_SLACK &&
		segment.x + halfWidth >= 1 - COVER_SLACK &&
		segment.y - halfHeight <= -1 + COVER_SLACK &&
		segment.y + halfHeight >= 1 - COVER_SLACK
	);
}

/**
 * The clips a reframe changes: the named clips (each must show video or an
 * image and sit on an unlocked track), or by default every visual clip on an
 * unlocked track whose box covers the canvas, which leaves picture-in-picture
 * insets and split-screen cells alone.
 */
export function reframeTargets(
	project: Project,
	assets: readonly Asset[],
	clipIds?: readonly string[]
): Segment[] {
	const byId = new Map(assets.map((asset) => [asset.id, asset]));
	if (clipIds) {
		const wanted = new Set(clipIds);
		const found = project.segments.filter((segment) => wanted.has(segment.id));
		if (found.length !== wanted.size) {
			throw new Error("A clip to reframe is not on the timeline.");
		}
		if (
			found.some(
				(segment) => !isReframeableClip(segment, byId.get(segment.assetId))
			)
		) {
			throw new Error("Only video and image clips can be reframed.");
		}
		if (
			found.some((segment) => trackSettingFor(project, segment.track).locked)
		) {
			throw new Error("Unlock every clip's track before reframing it.");
		}
		return found;
	}
	return project.segments.filter(
		(segment) =>
			!trackSettingFor(project, segment.track).locked &&
			coversCanvas(segment) &&
			isReframeableClip(segment, byId.get(segment.assetId))
	);
}

// ---------------------------------------------------------------------------
// Saliency
// ---------------------------------------------------------------------------

/** One 8-bit luma frame, row-major. */
export interface LumaFrame {
	data: Uint8Array;
	height: number;
	width: number;
}

/** Weight of frame-difference motion in the saliency map. */
const MOTION_WEIGHT = 0.6;
/** Weight of Sobel edge density in the saliency map. */
const EDGE_WEIGHT = 0.4;
/** How much the center prior lowers saliency at the frame corners. */
const CENTER_PRIOR_DROP = 0.35;
/** Total saliency below which a frame has no usable subject. */
const MIN_SALIENCY_WEIGHT = 1e-4;

/** Sobel gradient magnitude per pixel, normalized to 0..1 (border pixels 0). */
export function sobelMagnitude(frame: LumaFrame): Float32Array {
	const { data, height, width } = frame;
	const out = new Float32Array(width * height);
	for (let y = 1; y < height - 1; y++) {
		for (let x = 1; x < width - 1; x++) {
			const at = (dx: number, dy: number) =>
				data[(y + dy) * width + x + dx] ?? 0;
			const gx =
				at(1, -1) +
				2 * at(1, 0) +
				at(1, 1) -
				at(-1, -1) -
				2 * at(-1, 0) -
				at(-1, 1);
			const gy =
				at(-1, 1) +
				2 * at(0, 1) +
				at(1, 1) -
				at(-1, -1) -
				2 * at(0, -1) -
				at(1, -1);
			out[y * width + x] = Math.min(1, (Math.abs(gx) + Math.abs(gy)) / 2040);
		}
	}
	return out;
}

/** Center prior: 1 at the frame center, falling to `1 - CENTER_PRIOR_DROP` at the corners. */
function centerPrior(x: number, y: number, width: number, height: number) {
	const dx = ((x + 0.5) / width - 0.5) * 2;
	const dy = ((y + 0.5) / height - 0.5) * 2;
	return 1 - (CENTER_PRIOR_DROP * (dx * dx + dy * dy)) / 2;
}

/**
 * Saliency of one frame: motion against the previous frame plus edge
 * density, with the frame mean subtracted (so uniform texture and global
 * flicker cancel), squared to favour peaks, and weighted by the center prior.
 */
export function saliencyMap(
	frame: LumaFrame,
	previous?: LumaFrame
): Float32Array {
	const { data, height, width } = frame;
	const edges = sobelMagnitude(frame);
	const sameSize =
		previous !== undefined &&
		previous.width === width &&
		previous.height === height;
	const combined = new Float32Array(width * height);
	let sum = 0;
	for (let index = 0; index < combined.length; index++) {
		const motion = sameSize
			? Math.abs((data[index] ?? 0) - (previous.data[index] ?? 0)) / 255
			: 0;
		const value = MOTION_WEIGHT * motion + EDGE_WEIGHT * (edges[index] ?? 0);
		combined[index] = value;
		sum += value;
	}
	const mean = combined.length > 0 ? sum / combined.length : 0;
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const index = y * width + x;
			const lifted = Math.max(0, (combined[index] ?? 0) - mean);
			combined[index] = lifted * lifted * centerPrior(x, y, width, height);
		}
	}
	return combined;
}

/** A tracked subject position, normalized to the source frame (0..1). */
export interface SaliencyPoint {
	/** Total saliency behind the point; 0 means the frame had no subject. */
	weight: number;
	x: number;
	y: number;
}

/** Saliency-weighted centroid of a map; the frame center when it is empty. */
export function saliencyCentroid(
	map: Float32Array,
	width: number,
	height: number
): SaliencyPoint {
	let total = 0;
	let sumX = 0;
	let sumY = 0;
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const value = map[y * width + x] ?? 0;
			total += value;
			sumX += value * (x + 0.5);
			sumY += value * (y + 0.5);
		}
	}
	if (!(total > MIN_SALIENCY_WEIGHT)) {
		return { weight: 0, x: 0.5, y: 0.5 };
	}
	return {
		weight: round(total),
		x: round(sumX / total / width),
		y: round(sumY / total / height),
	};
}

/** Mean absolute luma difference of two frames of equal size (0..255). */
export function frameDifference(a: LumaFrame, b: LumaFrame): number {
	if (a.width !== b.width || a.height !== b.height || a.data.length === 0) {
		return 0;
	}
	let sum = 0;
	for (let index = 0; index < a.data.length; index++) {
		sum += Math.abs((a.data[index] ?? 0) - (b.data[index] ?? 0));
	}
	return sum / a.data.length;
}

/** Smallest mean luma change (0..255) that counts as a cut. */
const MIN_CUT_DIFFERENCE = 30;
/** A cut also differs this many times more than the median frame change. */
const CUT_MEDIAN_FACTOR = 4;

/**
 * Sample indices where a new shot starts, found from frame differences when
 * the source has no scene analysis: the change must be large in absolute
 * terms and stand out from the clip's typical motion.
 */
export function detectCutIndices(frames: readonly LumaFrame[]): number[] {
	const differences: number[] = [];
	for (let index = 1; index < frames.length; index++) {
		const a = frames[index - 1];
		const b = frames[index];
		differences.push(a && b ? frameDifference(a, b) : 0);
	}
	const sorted = [...differences].sort((a, b) => a - b);
	const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
	const cuts: number[] = [];
	for (const [offset, difference] of differences.entries()) {
		if (
			difference >= MIN_CUT_DIFFERENCE &&
			difference >= median * CUT_MEDIAN_FACTOR
		) {
			cuts.push(offset + 1);
		}
	}
	return cuts;
}

/**
 * Subject positions for a run of frames. Motion is measured against the
 * previous frame of the same shot, so a cut never reads as motion.
 */
export function saliencyPath(
	frames: readonly LumaFrame[],
	cuts: readonly number[]
): SaliencyPoint[] {
	const starts = new Set(cuts);
	return frames.map((frame, index) => {
		const previous =
			index > 0 && !starts.has(index) ? frames[index - 1] : undefined;
		return saliencyCentroid(
			saliencyMap(frame, previous),
			frame.width,
			frame.height
		);
	});
}

// ---------------------------------------------------------------------------
// Smoothing
// ---------------------------------------------------------------------------

/**
 * Local quadratic least-squares fit evaluated at each sample (the
 * Savitzky-Golay idea, with windows that shrink at the ends instead of
 * padding). `radius` 0 returns the input.
 */
export function savitzkyGolay(
	values: readonly number[],
	radius: number
): number[] {
	if (radius <= 0 || values.length < 3) {
		return [...values];
	}
	return values.map((value, center) => {
		const from = Math.max(0, center - radius);
		const to = Math.min(values.length - 1, center + radius);
		// Normal equations for value ≈ a + b*t + c*t² with t = j - center.
		let s0 = 0;
		let s1 = 0;
		let s2 = 0;
		let s3 = 0;
		let s4 = 0;
		let v0 = 0;
		let v1 = 0;
		let v2 = 0;
		for (let index = from; index <= to; index++) {
			const t = index - center;
			const sample = values[index] ?? value;
			s0 += 1;
			s1 += t;
			s2 += t * t;
			s3 += t * t * t;
			s4 += t * t * t * t;
			v0 += sample;
			v1 += sample * t;
			v2 += sample * t * t;
		}
		const det =
			s0 * (s2 * s4 - s3 * s3) -
			s1 * (s1 * s4 - s3 * s2) +
			s2 * (s1 * s3 - s2 * s2);
		if (Math.abs(det) < 1e-9) {
			return v0 / s0;
		}
		// Cramer's rule for `a`, the fitted value at t = 0.
		const detA =
			v0 * (s2 * s4 - s3 * s3) -
			s1 * (v1 * s4 - s3 * v2) +
			s2 * (v1 * s3 - s2 * v2);
		return detA / det;
	});
}

/**
 * A virtual camera that holds still while the target stays within
 * `deadZone` of it and otherwise trails the target at that distance.
 */
export function applyDeadZone(
	values: readonly number[],
	deadZone: number
): number[] {
	const first = values[0];
	if (first === undefined || deadZone <= 0) {
		return [...values];
	}
	let camera = first;
	return values.map((target) => {
		if (target - camera > deadZone) {
			camera = target - deadZone;
		} else if (camera - target > deadZone) {
			camera = target + deadZone;
		}
		return camera;
	});
}

/** Centred moving average with shrinking windows at the ends. */
function movingAverage(values: readonly number[], radius: number): number[] {
	if (radius <= 0) {
		return [...values];
	}
	return values.map((_, center) => {
		const from = Math.max(0, center - radius);
		const to = Math.min(values.length - 1, center + radius);
		let sum = 0;
		for (let index = from; index <= to; index++) {
			sum += values[index] ?? 0;
		}
		return sum / (to - from + 1);
	});
}

/**
 * Smooth one shot's subject positions. `smoothing` 0 keeps the raw path;
 * 1 uses a ±1.5 s quadratic window and a 6% dead zone. The result never
 * leaves the input's range, so smoothing cannot push the frame past where
 * the subject went.
 */
export function smoothShotPath(
	values: readonly number[],
	smoothing: number,
	sampleRate: number
): number[] {
	if (values.length === 0) {
		return [];
	}
	const strength = clamp(smoothing, 0, 1);
	const radius = Math.round(strength * MAX_SMOOTHING_SECONDS * sampleRate);
	const fitted = savitzkyGolay(values, radius);
	const held = applyDeadZone(fitted, strength * MAX_DEAD_ZONE);
	const softened = movingAverage(held, Math.ceil(radius / 3));
	const low = Math.min(...values);
	const high = Math.max(...values);
	return softened.map((value) => round(clamp(value, low, high)));
}

/** Fill frames without a subject from their nearest subject frame (or the center). */
function filledAxis(
	points: readonly SaliencyPoint[],
	axis: "x" | "y"
): number[] {
	const known = points.flatMap((point, index) =>
		point.weight > 0 ? [index] : []
	);
	if (known.length === 0) {
		return points.map(() => 0.5);
	}
	return points.map((point, index) => {
		if (point.weight > 0) {
			return point[axis];
		}
		let nearest = known[0] ?? 0;
		for (const candidate of known) {
			if (Math.abs(candidate - index) < Math.abs(nearest - index)) {
				nearest = candidate;
			}
		}
		return points[nearest]?.[axis] ?? 0.5;
	});
}

/** `[start, end)` sample ranges of each shot. */
export function shotRanges(
	count: number,
	cuts: readonly number[]
): [number, number][] {
	const bounds = [...new Set(cuts)]
		.filter((cut) => cut > 0 && cut < count)
		.sort((a, b) => a - b);
	const ranges: [number, number][] = [];
	let start = 0;
	for (const cut of [...bounds, count]) {
		if (cut > start) {
			ranges.push([start, cut]);
		}
		start = cut;
	}
	return ranges;
}

// ---------------------------------------------------------------------------
// Framing
// ---------------------------------------------------------------------------

/** A tracked clip: positions at `sampleRate` per source second from `sourceIn`. */
export interface SubjectTrack {
	/** Sample indices where a new shot starts (the first sample after the cut). */
	cuts: number[];
	/**
	 * Exact cut times, in source seconds from `sourceIn`, parallel to `cuts`,
	 * when they are known from scene analysis. The new shot's framing starts
	 * at that time instead of at its first sample.
	 */
	cutTimes?: number[];
	points: SaliencyPoint[];
	sampleRate: number;
}

/** How a source fits a target canvas. */
export interface ReframeGeometry {
	/** The axis the window pans along, or null when the aspects match. */
	axis: "x" | "y" | null;
	/**
	 * Source aspect over target aspect along the pan axis (≥ 1): how many
	 * target widths (or heights) the whole source spans when it covers.
	 */
	coverRatio: number;
}

export function reframeGeometry(
	source: { height: number; width: number },
	target: { height: number; width: number }
): ReframeGeometry {
	const ratio = source.width / source.height / (target.width / target.height);
	if (Math.abs(ratio - 1) <= SAME_ASPECT) {
		return { axis: null, coverRatio: 1 };
	}
	return ratio > 1
		? { axis: "x", coverRatio: ratio }
		: { axis: "y", coverRatio: 1 / ratio };
}

/** A pan plan for one clip in `track` mode. */
export interface PanPlan {
	axis: "x" | "y";
	/** Width of the source band, as a share of the pan axis. */
	bandSize: number;
	/** Start of the source band, as a share of the pan axis. */
	bandStart: number;
	/** Box size along the pan axis, in canvas widths or heights. */
	boxScale: number;
	/** Clip-relative timeline seconds and the `x`/`y` value at each. */
	samples: { time: number; value: number }[];
	/** Sample indices (into `samples`) where a new shot starts. */
	shotStarts: number[];
}

/**
 * Turn smoothed window centres (source shares along the pan axis) into a
 * band and box: the band holds every centre's window if the box stays
 * pannable, otherwise it is centred on the path and centres are clamped.
 */
export function panPlan(
	centers: readonly number[],
	geometry: { axis: "x" | "y"; coverRatio: number }
): Omit<PanPlan, "samples" | "shotStarts"> & { values: number[] } {
	const visible = 1 / geometry.coverRatio;
	const half = visible / 2;
	const clamped = centers.map((center) => clamp(center, half, 1 - half));
	const pathLow = clamped.length > 0 ? Math.min(...clamped) : 0.5;
	const pathHigh = clamped.length > 0 ? Math.max(...clamped) : 0.5;
	const maxBand = Math.min(1, MAX_PAN_BOX / geometry.coverRatio);
	const bandSize = round(
		clamp(pathHigh - pathLow + visible, Math.max(visible, MIN_BAND), maxBand)
	);
	// Each crop edge stays within the schema bound (0..0.9).
	const bandStart = round(
		clamp(
			(pathLow + pathHigh) / 2 - bandSize / 2,
			Math.max(0, 1 - MAX_CROP_EDGE - bandSize),
			Math.min(MAX_CROP_EDGE, 1 - bandSize)
		)
	);
	const boxScale = Math.min(MAX_PAN_BOX, round(bandSize * geometry.coverRatio));
	// Window centre u within the band (0..1) maps to offset (1 - 2u) * boxScale.
	const reach = clamp(boxScale - 1, 0, MAX_CLIP_OFFSET);
	const values = clamped.map((center) => {
		const within = (center - bandStart) / bandSize;
		return round(clamp((1 - 2 * within) * boxScale, -reach, reach), 4);
	});
	return { axis: geometry.axis, bandSize, bandStart, boxScale, values };
}

/** Clip-relative timeline seconds of sample `index`. */
const sampleTime = (segment: Segment, track: SubjectTrack, index: number) =>
	round(index / track.sampleRate / segment.speed, 4);

/** Clip length on the timeline. */
const clipLength = (segment: Segment) =>
	(segment.sourceOut - segment.sourceIn) / segment.speed;

/** Smoothed pan values and band for a tracked clip. */
export function trackedPanPlan(
	segment: Segment,
	track: SubjectTrack,
	geometry: { axis: "x" | "y"; coverRatio: number },
	smoothing: number
): PanPlan {
	const raw = filledAxis(track.points, geometry.axis);
	const ranges = shotRanges(raw.length, track.cuts);
	const smoothed: number[] = [];
	for (const [start, end] of ranges) {
		smoothed.push(
			...smoothShotPath(raw.slice(start, end), smoothing, track.sampleRate)
		);
	}
	const plan = panPlan(smoothed, geometry);
	const length = clipLength(segment);
	// A mirrored clip shows the band flipped inside its box, so the offset
	// that frames band position u is the negated unflipped one.
	const mirrored = geometry.axis === "x" ? segment.flipH : segment.flipV;
	const cutTimes = new Map<number, number>();
	for (const [order, cut] of track.cuts.entries()) {
		const time = track.cutTimes?.[order];
		if (time !== undefined && Number.isFinite(time)) {
			cutTimes.set(cut, round(time / segment.speed, 4));
		}
	}
	const samples = plan.values.flatMap((value, index) => {
		const sampled = sampleTime(segment, track, index);
		const previous =
			index > 0
				? sampleTime(segment, track, index - 1)
				: Number.NEGATIVE_INFINITY;
		// A shot's first keyframe sits at its known cut time, after the
		// previous shot's last sample and no later than its own.
		const cutTime = cutTimes.get(index);
		const time =
			cutTime !== undefined && cutTime > previous && cutTime <= sampled
				? cutTime
				: sampled;
		const shown = mirrored ? round(-value, 4) || 0 : value;
		return time <= length ? [{ time, value: shown }] : [];
	});
	return {
		axis: plan.axis,
		bandSize: plan.bandSize,
		bandStart: plan.bandStart,
		boxScale: plan.boxScale,
		samples,
		shotStarts: ranges
			.map(([start]) => start)
			.filter((start) => start < samples.length),
	};
}

/** Perpendicular distance of `point` from the line through `a` and `b`, in value units. */
function deviation(
	a: { time: number; value: number },
	b: { time: number; value: number },
	point: { time: number; value: number }
): number {
	const span = b.time - a.time;
	if (span <= 0) {
		return Math.abs(point.value - a.value);
	}
	const expected =
		a.value + ((b.value - a.value) * (point.time - a.time)) / span;
	return Math.abs(point.value - expected);
}

/**
 * Ramer-Douglas-Peucker on a time series: keep the samples needed for
 * linear interpolation to stay within `tolerance` of every sample.
 */
export function simplifyPath(
	samples: readonly { time: number; value: number }[],
	tolerance: number
): { time: number; value: number }[] {
	if (samples.length <= 2) {
		return [...samples];
	}
	const keep = new Array<boolean>(samples.length).fill(false);
	keep[0] = true;
	keep[samples.length - 1] = true;
	const stack: [number, number][] = [[0, samples.length - 1]];
	while (stack.length > 0) {
		const [from, to] = stack.pop() ?? [0, 0];
		const a = samples[from];
		const b = samples[to];
		if (!(a && b) || to - from < 2) {
			continue;
		}
		let worst = -1;
		let worstIndex = -1;
		for (let index = from + 1; index < to; index++) {
			const point = samples[index];
			const distance = point ? deviation(a, b, point) : 0;
			if (distance > worst) {
				worst = distance;
				worstIndex = index;
			}
		}
		if (worst > tolerance && worstIndex > 0) {
			keep[worstIndex] = true;
			stack.push([from, worstIndex], [worstIndex, to]);
		}
	}
	return samples.filter((_, index) => keep[index]);
}

/** Starting tolerance (in `x`/`y` units) for keyframe simplification. */
const PATH_TOLERANCE = 0.01;

/**
 * Pan keyframes for a plan: each shot is simplified on its own, the last
 * keyframe of a shot holds until the next shot starts, so the frame jumps
 * at the cut instead of drifting across it. The tolerance grows until the
 * keyframes fit `budget`. A path that never moves returns no keyframes and
 * its single value.
 */
export function panKeyframes(
	plan: PanPlan,
	budget: number,
	createId: () => string
): { keyframes: Keyframe[]; value: number } {
	const first = plan.samples[0]?.value ?? 0;
	const shots = shotRanges(plan.samples.length, plan.shotStarts).map(
		([start, end]) => plan.samples.slice(start, end)
	);
	const limit = Math.max(0, Math.min(budget, REFRAME_MAX_PATH_KEYFRAMES));
	let tolerance = PATH_TOLERANCE;
	let kept: { hold: boolean; time: number; value: number }[] = [];
	for (let attempt = 0; attempt < 40; attempt++) {
		kept = shots.flatMap((shot, shotIndex) => {
			const simple = simplifyPath(shot, tolerance);
			const isLastShot = shotIndex === shots.length - 1;
			return simple.map((sample, index) => ({
				...sample,
				hold: !isLastShot && index === simple.length - 1,
			}));
		});
		if (kept.length <= limit) {
			break;
		}
		tolerance *= 1.5;
	}
	const moves = plan.samples.some(
		(sample) => Math.abs(sample.value - first) > 1e-4
	);
	if (!moves || limit < 2 || kept.length > limit) {
		const values = plan.samples.map((sample) => sample.value);
		const middle =
			values.length > 0 ? (Math.min(...values) + Math.max(...values)) / 2 : 0;
		return { keyframes: [], value: round(moves ? middle : first, 4) };
	}
	const keyframes: Keyframe[] = kept.map((sample) => ({
		id: createId(),
		property: plan.axis,
		time: sample.time,
		value: sample.value,
		...(sample.hold ? { interpolation: "hold" as const } : {}),
	}));
	return { keyframes, value: kept[0]?.value ?? first };
}

/** Keyframe channels a reframe owns and replaces. */
const FRAMING_PROPERTIES: ReadonlySet<Keyframe["property"]> = new Set([
	"x",
	"y",
	"scale",
	"scaleX",
	"scaleY",
	"cropLeft",
	"cropRight",
	"cropTop",
	"cropBottom",
]);

/**
 * Whether a clip carries framing of its own: a crop, or keyframes on a
 * framing channel (a push-in zoom, a pan). Following a subject replaces that
 * framing, so `reframeToSubjects` leaves such clips on their centred crop.
 */
export function hasOwnFraming(segment: Pick<Segment, "crop" | "keyframes">) {
	const { bottom, left, right, top } = segment.crop;
	return (
		bottom > 0 ||
		left > 0 ||
		right > 0 ||
		top > 0 ||
		segment.keyframes.some((frame) => FRAMING_PROPERTIES.has(frame.property))
	);
}

/** The clip with framing reset: centred, uncropped, scale 1, no framing keyframes. */
function resetFraming(segment: Segment): Segment {
	const { scaleX: _scaleX, scaleY: _scaleY, ...rest } = segment;
	return {
		...rest,
		crop: { bottom: 0, left: 0, right: 0, top: 0 },
		keyframes: segment.keyframes.filter(
			(frame) => !FRAMING_PROPERTIES.has(frame.property)
		),
		scale: 1,
		x: 0,
		y: 0,
	};
}

/** What a reframe did to one clip. */
export interface ReframeClipResult {
	axis: "x" | "y" | null;
	clipId: string;
	/** Pan keyframes written (0 for a static frame). */
	keyframes: number;
	mode: ReframeMode;
	/** Why a `track` request fell back to a centred crop. */
	note?: string;
}

/** Reframe one clip in `center` or `blur-fill` mode. */
export function staticReframe(
	segment: Segment,
	mode: "blur-fill" | "center"
): Segment {
	const reset = resetFraming(segment);
	if (mode === "center") {
		return { ...reset, fit: "fill" };
	}
	const { fit: _fit, ...fitted } = reset;
	const blurred =
		segment.track === BASE_TRACK
			? fitted
			: { ...fitted, background: { type: "blur" as const, ...DEFAULT_BLUR } };
	return blurred;
}

/**
 * Reframe one clip to follow its tracked subject on a canvas of `canvas`
 * size. `asset` gives the source frame size.
 */
export function trackedReframe(
	segment: Segment,
	asset: Pick<Asset, "height" | "width">,
	canvas: { height: number; width: number },
	track: SubjectTrack,
	smoothing: number,
	createId: () => string
): { keyframes: number; segment: Segment; axis: "x" | "y" | null } {
	const reset = { ...resetFraming(segment), fit: "fill" as const };
	const geometry = reframeGeometry(asset, canvas);
	if (geometry.axis === null || track.points.length === 0) {
		return { axis: geometry.axis, keyframes: 0, segment: reset };
	}
	const plan = trackedPanPlan(
		segment,
		track,
		{ axis: geometry.axis, coverRatio: geometry.coverRatio },
		smoothing
	);
	const budget = 200 - reset.keyframes.length;
	const pan = panKeyframes(plan, budget, createId);
	const bandEnd = round(1 - plan.bandStart - plan.bandSize);
	const horizontal = plan.axis === "x";
	const crop = horizontal
		? { bottom: 0, left: plan.bandStart, right: Math.max(0, bandEnd), top: 0 }
		: { bottom: Math.max(0, bandEnd), left: 0, right: 0, top: plan.bandStart };
	const next: Segment = {
		...reset,
		crop,
		keyframes: [...reset.keyframes, ...pan.keyframes].sort(
			(a, b) => a.time - b.time || a.property.localeCompare(b.property)
		),
		...(plan.boxScale > 1.0005
			? horizontal
				? { scaleX: plan.boxScale }
				: { scaleY: plan.boxScale }
			: {}),
		[plan.axis]: pan.value,
	};
	return { axis: plan.axis, keyframes: pan.keyframes.length, segment: next };
}

/**
 * Apply a reframe request: change the canvas to the target aspect and
 * re-fit the target clips. `tracks` holds the subject tracks of `track`
 * mode by clip id; a clip without one falls back to a centred crop.
 */
export function applyReframe(
	project: Project,
	assets: readonly Asset[],
	input: ReframeRequest,
	tracks: ReadonlyMap<string, SubjectTrack>,
	createId: () => string = () => crypto.randomUUID()
): { clips: ReframeClipResult[]; project: Project } {
	const request = reframeRequestSchema.parse(input);
	const canvas = reframeCanvas(project, request.aspect);
	const targets = reframeTargets(project, assets, request.clipIds);
	const targetIds = new Set(targets.map((segment) => segment.id));
	const byId = new Map(assets.map((asset) => [asset.id, asset]));
	const smoothing = request.smoothing ?? DEFAULT_REFRAME_SMOOTHING;
	const clips: ReframeClipResult[] = [];
	const segments = project.segments.map((segment) => {
		if (!targetIds.has(segment.id)) {
			return segment;
		}
		const asset = byId.get(segment.assetId);
		if (request.mode !== "track" || !asset) {
			const mode = request.mode === "track" ? "center" : request.mode;
			clips.push({
				axis: asset ? reframeGeometry(asset, canvas).axis : null,
				clipId: segment.id,
				keyframes: 0,
				mode,
			});
			return staticReframe(segment, mode);
		}
		const track = tracks.get(segment.id);
		if (!track) {
			clips.push({
				axis: reframeGeometry(asset, canvas).axis,
				clipId: segment.id,
				keyframes: 0,
				mode: "center",
				note: "No subject track was measured; used a centred crop.",
			});
			return staticReframe(segment, "center");
		}
		const result = trackedReframe(
			segment,
			asset,
			canvas,
			track,
			smoothing,
			createId
		);
		clips.push({
			axis: result.axis,
			clipId: segment.id,
			keyframes: result.keyframes,
			mode: "track",
		});
		return result.segment;
	});
	const next: Project = { ...project, ...canvas, segments };
	if (request.mode === "blur-fill") {
		next.background = { type: "blur", ...DEFAULT_BLUR };
	}
	return { clips, project: validateProject(next, [...assets]) };
}

/**
 * Re-frame clips of a project that already sits on its new canvas (AutoCut
 * and shorts place their clips with a centred crop first) to follow their
 * measured subjects, as `track` mode does. A clip without a track, or with
 * its own crop or framing keyframes (`hasOwnFraming`), keeps its current
 * framing and its result says so. Track locks are not checked here:
 * the caller decides which clips it built and may reframe.
 */
export function reframeToSubjects(
	project: Project,
	assets: readonly Asset[],
	clipIds: readonly string[],
	tracks: ReadonlyMap<string, SubjectTrack>,
	options: { createId?: () => string; smoothing?: number } = {}
): { clips: ReframeClipResult[]; project: Project } {
	const canvas = { height: project.height, width: project.width };
	const wanted = new Set(clipIds);
	const byId = new Map(assets.map((asset) => [asset.id, asset]));
	const smoothing = options.smoothing ?? DEFAULT_REFRAME_SMOOTHING;
	const createId = options.createId ?? (() => crypto.randomUUID());
	const clips: ReframeClipResult[] = [];
	const segments = project.segments.map((segment) => {
		if (!wanted.has(segment.id)) {
			return segment;
		}
		const asset = byId.get(segment.assetId);
		if (hasOwnFraming(segment)) {
			clips.push({
				axis: asset ? reframeGeometry(asset, canvas).axis : null,
				clipId: segment.id,
				keyframes: 0,
				mode: "center",
				note: "The clip has its own crop or framing keyframes; kept them with a centred crop.",
			});
			return segment;
		}
		const track = tracks.get(segment.id);
		if (!(asset && track)) {
			clips.push({
				axis: asset ? reframeGeometry(asset, canvas).axis : null,
				clipId: segment.id,
				keyframes: 0,
				mode: "center",
				note: "No subject track was measured; kept the centred crop.",
			});
			return segment;
		}
		const result = trackedReframe(
			segment,
			asset,
			canvas,
			track,
			smoothing,
			createId
		);
		clips.push({
			axis: result.axis,
			clipId: segment.id,
			keyframes: result.keyframes,
			mode: "track",
		});
		return result.segment;
	});
	return {
		clips,
		project: validateProject({ ...project, segments }, [...assets]),
	};
}

/**
 * Window centre (source share along `axis`) a reframed clip shows at pan
 * `offset`. A mirrored axis (`flipH` for x, `flipV` for y) shows the band
 * flipped inside the box.
 */
export function reframedWindowCenter(
	segment: Pick<Segment, "crop" | "flipH" | "flipV" | "scaleX" | "scaleY">,
	axis: "x" | "y",
	offset: number
): number {
	const horizontal = axis === "x";
	const bandStart = horizontal ? segment.crop.left : segment.crop.top;
	const bandSize = horizontal
		? 1 - segment.crop.left - segment.crop.right
		: 1 - segment.crop.top - segment.crop.bottom;
	const boxScale = (horizontal ? segment.scaleX : segment.scaleY) ?? 1;
	const mirrored = horizontal ? segment.flipH : segment.flipV;
	const within = (1 + (mirrored ? offset : -offset) / boxScale) / 2;
	return bandStart + within * bandSize;
}
