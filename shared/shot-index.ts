/**
 * Visual shot index: per-shot color, brightness, motion and framing metadata.
 *
 * The sidecar decodes a source at a low frame rate into 32x18 RGB frames and
 * hands them to `shotStatsFromFrames` together with the shot ranges from the
 * completed scene analysis. Everything here is pure and deterministic: the
 * same frames always produce the same colors, labels and search ranking, so
 * the agent route and the panel agree on what "dark blue motion" means.
 */
import { z } from "zod";

export const SHOT_FRAME_WIDTH = 32;
export const SHOT_FRAME_HEIGHT = 18;
export const SHOT_FRAME_PIXELS = SHOT_FRAME_WIDTH * SHOT_FRAME_HEIGHT;
/** Bytes in one packed rgb24 analysis frame. */
export const SHOT_FRAME_BYTES = SHOT_FRAME_PIXELS * 3;
/** Preferred analysis frame rate; long sources sample more sparsely. */
export const SHOT_SAMPLE_RATE = 4;
/** Upper bound on decoded analysis frames per source. */
export const MAX_SHOT_FRAMES = 12_000;
/** Upper bound on indexed shots per source (one Spaces document each). */
export const MAX_SHOTS = 400;
/**
 * Upper bound on raw scene-cut ranges measured per source, before continuity
 * merging. Matches the analysis cap of 2000 scene cuts (2001 ranges).
 */
export const MAX_RAW_SHOT_RANGES = 2001;
/** Dominant colors computed per shot. */
export const SHOT_COLOR_CLUSTERS = 4;
/** Frames per shot fed to k-means; brightness and motion use every frame. */
const KMEANS_FRAMES = 6;
const KMEANS_ITERATIONS = 10;

/** Label thresholds. Exported so tests and docs cite one source of truth. */
export const SHOT_THRESHOLDS = {
	/** Mean Rec. 709 luma at or above which a shot is `bright`. */
	bright: 0.6,
	/** Mean luma at or below which a shot is `dark`. */
	dark: 0.3,
	/** Mean HSV saturation at or above which a shot is `vivid`. */
	vivid: 0.45,
	/** Mean HSV saturation at or below which a shot is `muted`. */
	muted: 0.12,
	/** Share of edge pixels below which a shot reads as a `close-up`. */
	closeUpEdges: 0.08,
	/** Share of edge pixels at or above which a shot reads as `wide`. */
	wideEdges: 0.22,
	/** Luma step between neighbors that counts as an edge. */
	edgeStep: 0.1,
	/** Mean absolute frame difference below which a shot is `static`. */
	static: 0.012,
	/** Mean absolute frame difference at or above which a shot has `motion`. */
	motion: 0.04,
	/** Shots shorter than this are `short`. */
	shortSeconds: 2,
	/** Shots at least this long are `long`. */
	longSeconds: 10,
	/** A dominant color needs this share of the shot's pixels to become a label. */
	colorLabelWeight: 0.15,
} as const;

export const SHOT_COLOR_NAMES = [
	"black",
	"white",
	"gray",
	"red",
	"orange",
	"brown",
	"yellow",
	"green",
	"teal",
	"blue",
	"purple",
	"pink",
] as const;
export type ShotColorName = (typeof SHOT_COLOR_NAMES)[number];

export const SHOT_DESCRIPTIVE_LABELS = [
	"bright",
	"dark",
	"vivid",
	"muted",
	"close-up",
	"wide",
	"static",
	"motion",
	"short",
	"long",
] as const;
export type ShotDescriptiveLabel = (typeof SHOT_DESCRIPTIVE_LABELS)[number];
export type ShotLabel = ShotDescriptiveLabel | ShotColorName;

const shotLabelSchema = z.enum([
	...SHOT_DESCRIPTIVE_LABELS,
	...SHOT_COLOR_NAMES,
]);
const unitSchema = z.number().finite().min(0).max(1);
const timeSchema = z.number().finite().min(0).max(7200);

/** Most tags a vision model may attach to one shot. */
export const MAX_SHOT_TAGS = 12;
export const shotCaptionSchema = z.string().trim().min(1).max(300);
export const shotTagSchema = z.string().trim().toLowerCase().min(1).max(40);

export const shotColorSchema = z
	.object({
		hex: z.string().regex(/^#[0-9a-f]{6}$/u),
		name: z.enum(SHOT_COLOR_NAMES),
		weight: unitSchema,
	})
	.strict();
export type ShotColor = z.infer<typeof shotColorSchema>;

export const shotStatsSchema = z
	.object({
		start: timeSchema,
		end: timeSchema,
		brightness: unitSchema,
		saturation: unitSchema,
		motion: unitSchema,
		edgeDensity: unitSchema,
		colors: z.array(shotColorSchema).max(SHOT_COLOR_CLUSTERS),
		labels: z.array(shotLabelSchema).max(24),
		/**
		 * Vision-model description (G76), optional: a one-sentence caption and
		 * short lowercase tags read from the shot's keyframe. Shots without
		 * them are searched by the measured metadata alone.
		 */
		caption: shotCaptionSchema.optional(),
		tags: z.array(shotTagSchema).max(MAX_SHOT_TAGS).optional(),
	})
	.strict();
export type ShotStats = z.infer<typeof shotStatsSchema>;

export const shotIndexSchema = z
	.object({
		format: z.literal("ryu.video-studio.shots.v1"),
		assetId: z.uuid(),
		/** `createdAt` of the scene analysis whose cuts defined the shots. */
		analysisCreatedAt: z.iso.datetime(),
		revision: z.number().int().nonnegative(),
		sampleRate: z.number().finite().positive().max(SHOT_SAMPLE_RATE),
		shots: z.array(shotStatsSchema).max(MAX_SHOTS),
		updatedAt: z.iso.datetime(),
		/** The vision model that wrote the captions and tags, when one did. */
		describedBy: z
			.object({
				provider: z.string().trim().max(200),
				model: z.string().trim().max(200),
				describedAt: z.iso.datetime(),
			})
			.strict()
			.optional(),
	})
	.strict();
export type ShotIndex = z.infer<typeof shotIndexSchema>;

export interface ShotRange {
	end: number;
	start: number;
}

/** Analysis frame rate for a source: `SHOT_SAMPLE_RATE`, thinned for long media. */
export function shotSampleRate(duration: number): number {
	if (!(Number.isFinite(duration) && duration > 0)) {
		return SHOT_SAMPLE_RATE;
	}
	const rate = Math.min(SHOT_SAMPLE_RATE, MAX_SHOT_FRAMES / duration);
	return Math.max(0.001, Math.floor(rate * 1000) / 1000);
}

/** Cuts closer than this to the previous boundary are merged into one shot. */
export const MIN_SHOT_SECONDS = 0.2;

/**
 * Shot ranges between consecutive scene cuts, covering `[0, duration)`.
 * Flicker cuts (closer than `MIN_SHOT_SECONDS` to the previous boundary or
 * to the end) are merged so every shot spans at least one analysis frame.
 * The `MAX_SHOTS` limit applies after continuity merging, in
 * `shotStatsFromFrames`; here only `MAX_RAW_SHOT_RANGES` bounds the work.
 */
export function shotRanges(
	sceneCuts: readonly number[],
	duration: number
): ShotRange[] {
	if (!(Number.isFinite(duration) && duration > 0)) {
		return [];
	}
	const cuts = [...new Set(sceneCuts)]
		.filter((cut) => Number.isFinite(cut) && cut > 0 && cut < duration)
		.sort((a, b) => a - b);
	const bounds = [0];
	for (const cut of cuts) {
		if (
			cut - (bounds.at(-1) ?? 0) >= MIN_SHOT_SECONDS &&
			duration - cut >= MIN_SHOT_SECONDS
		) {
			bounds.push(cut);
		}
	}
	bounds.push(duration);
	const ranges: ShotRange[] = [];
	for (let index = 1; index < bounds.length; index++) {
		ranges.push({
			start: bounds[index - 1] ?? 0,
			end: bounds[index] ?? duration,
		});
	}
	if (ranges.length > MAX_RAW_SHOT_RANGES) {
		throw new Error(
			`This source has ${ranges.length} scene cuts; shot analysis measures up to ${MAX_RAW_SHOT_RANGES}. Trim or split the source first.`
		);
	}
	return ranges;
}

type Rgb = readonly [number, number, number];

/** Rec. 709 luma of an 8-bit RGB triple, 0-1. */
function luma(red: number, green: number, blue: number): number {
	return (0.2126 * red + 0.7152 * green + 0.0722 * blue) / 255;
}

/** HSL of an 8-bit RGB triple: hue in degrees, saturation and lightness 0-1. */
export function rgbToHsl([red, green, blue]: Rgb): {
	hue: number;
	lightness: number;
	saturation: number;
} {
	const r = red / 255;
	const g = green / 255;
	const b = blue / 255;
	const max = Math.max(r, g, b);
	const min = Math.min(r, g, b);
	const lightness = (max + min) / 2;
	const chroma = max - min;
	if (chroma < 1e-9) {
		return { hue: 0, lightness, saturation: 0 };
	}
	const saturation = chroma / (1 - Math.abs(2 * lightness - 1));
	let hue: number;
	if (max === r) {
		hue = ((g - b) / chroma) % 6;
	} else if (max === g) {
		hue = (b - r) / chroma + 2;
	} else {
		hue = (r - g) / chroma + 4;
	}
	hue *= 60;
	return {
		hue: hue < 0 ? hue + 360 : hue,
		lightness,
		saturation: Math.min(1, saturation),
	};
}

/** Hue bands (upper bound in degrees, exclusive) for chromatic colors. */
const HUE_BANDS: readonly [number, ShotColorName][] = [
	[15, "red"],
	[42, "orange"],
	[68, "yellow"],
	[165, "green"],
	[200, "teal"],
	[258, "blue"],
	[290, "purple"],
	[340, "pink"],
	[360, "red"],
];

/** Plain-language name of an 8-bit RGB color. */
export function colorName(rgb: Rgb): ShotColorName {
	const { hue, lightness, saturation } = rgbToHsl(rgb);
	if (lightness < 0.1) {
		return "black";
	}
	if (lightness > 0.93) {
		return "white";
	}
	if (saturation < 0.15) {
		if (lightness < 0.22) {
			return "black";
		}
		return lightness > 0.82 ? "white" : "gray";
	}
	const band = HUE_BANDS.find(([upper]) => hue < upper)?.[1] ?? "red";
	if ((band === "orange" || band === "yellow") && lightness < 0.32) {
		return "brown";
	}
	if (band === "red" && lightness > 0.72) {
		return "pink";
	}
	return band;
}

function hex([red, green, blue]: Rgb): string {
	return `#${[red, green, blue]
		.map((channel) =>
			Math.round(Math.min(255, Math.max(0, channel)))
				.toString(16)
				.padStart(2, "0")
		)
		.join("")}`;
}

/**
 * Deterministic k-means over packed rgb24 pixels. Centroids start at luma
 * quantiles, so equal input always yields equal clusters. Returns clusters by
 * descending weight; empty clusters are dropped.
 */
export function dominantColors(
	pixels: Uint8Array,
	clusters = SHOT_COLOR_CLUSTERS
): ShotColor[] {
	const count = Math.floor(pixels.length / 3);
	if (count === 0 || clusters < 1) {
		return [];
	}
	const lumas = new Float64Array(count);
	for (let pixel = 0; pixel < count; pixel++) {
		lumas[pixel] = luma(
			pixels[pixel * 3] ?? 0,
			pixels[pixel * 3 + 1] ?? 0,
			pixels[pixel * 3 + 2] ?? 0
		);
	}
	const order = Uint32Array.from({ length: count }, (_, index) => index).sort(
		(a, b) => (lumas[a] ?? 0) - (lumas[b] ?? 0) || a - b
	);
	const k = Math.min(clusters, count);
	// Centroids and running sums as flat [r, g, b] triples per cluster.
	const centroids = new Float64Array(k * 3);
	for (let cluster = 0; cluster < k; cluster++) {
		const pixel =
			order[Math.min(count - 1, Math.floor(((cluster + 0.5) / k) * count))] ??
			0;
		centroids[cluster * 3] = pixels[pixel * 3] ?? 0;
		centroids[cluster * 3 + 1] = pixels[pixel * 3 + 1] ?? 0;
		centroids[cluster * 3 + 2] = pixels[pixel * 3 + 2] ?? 0;
	}
	const assignment = new Int32Array(count).fill(-1);
	const sizes = new Float64Array(k);
	const sums = new Float64Array(k * 3);
	for (let iteration = 0; iteration < KMEANS_ITERATIONS; iteration++) {
		sums.fill(0);
		sizes.fill(0);
		let changed = false;
		for (let pixel = 0; pixel < count; pixel++) {
			const red = pixels[pixel * 3] ?? 0;
			const green = pixels[pixel * 3 + 1] ?? 0;
			const blue = pixels[pixel * 3 + 2] ?? 0;
			let best = 0;
			let bestDistance = Number.POSITIVE_INFINITY;
			for (let cluster = 0; cluster < k; cluster++) {
				const distance =
					(red - (centroids[cluster * 3] ?? 0)) ** 2 +
					(green - (centroids[cluster * 3 + 1] ?? 0)) ** 2 +
					(blue - (centroids[cluster * 3 + 2] ?? 0)) ** 2;
				if (distance < bestDistance) {
					bestDistance = distance;
					best = cluster;
				}
			}
			if (assignment[pixel] !== best) {
				changed = true;
				assignment[pixel] = best;
			}
			sums[best * 3] = (sums[best * 3] ?? 0) + red;
			sums[best * 3 + 1] = (sums[best * 3 + 1] ?? 0) + green;
			sums[best * 3 + 2] = (sums[best * 3 + 2] ?? 0) + blue;
			sizes[best] = (sizes[best] ?? 0) + 1;
		}
		for (let cluster = 0; cluster < k; cluster++) {
			const size = sizes[cluster] ?? 0;
			if (size > 0) {
				for (let channel = 0; channel < 3; channel++) {
					centroids[cluster * 3 + channel] =
						(sums[cluster * 3 + channel] ?? 0) / size;
				}
			}
		}
		if (!changed && iteration > 0) {
			break;
		}
	}
	const result: ShotColor[] = [];
	for (let cluster = 0; cluster < k; cluster++) {
		const size = sizes[cluster] ?? 0;
		if (size === 0) {
			continue;
		}
		const rounded: Rgb = [
			Math.round(centroids[cluster * 3] ?? 0),
			Math.round(centroids[cluster * 3 + 1] ?? 0),
			Math.round(centroids[cluster * 3 + 2] ?? 0),
		];
		result.push({
			hex: hex(rounded),
			name: colorName(rounded),
			weight: round(size / count),
		});
	}
	return result.sort(
		(a, b) => b.weight - a.weight || a.hex.localeCompare(b.hex)
	);
}

function round(value: number, places = 4): number {
	const scale = 10 ** places;
	return Math.round(value * scale) / scale;
}

/** Mean luma, mean HSV saturation and edge density of one rgb24 frame. */
export function frameStats(
	frame: Uint8Array,
	width = SHOT_FRAME_WIDTH,
	height = SHOT_FRAME_HEIGHT
): { brightness: number; edgeDensity: number; saturation: number } {
	const pixels = width * height;
	if (frame.length < pixels * 3 || pixels === 0) {
		throw new Error("Analysis frame is smaller than its dimensions.");
	}
	const lumas = new Float64Array(pixels);
	let brightness = 0;
	let saturation = 0;
	for (let pixel = 0; pixel < pixels; pixel++) {
		const red = frame[pixel * 3] ?? 0;
		const green = frame[pixel * 3 + 1] ?? 0;
		const blue = frame[pixel * 3 + 2] ?? 0;
		const value = luma(red, green, blue);
		lumas[pixel] = value;
		brightness += value;
		const max = Math.max(red, green, blue);
		saturation += max === 0 ? 0 : (max - Math.min(red, green, blue)) / max;
	}
	let edges = 0;
	let compared = 0;
	for (let y = 0; y < height - 1; y++) {
		for (let x = 0; x < width - 1; x++) {
			const here = lumas[y * width + x] ?? 0;
			const gradient =
				Math.abs((lumas[y * width + x + 1] ?? 0) - here) +
				Math.abs((lumas[(y + 1) * width + x] ?? 0) - here);
			compared++;
			if (gradient >= SHOT_THRESHOLDS.edgeStep) {
				edges++;
			}
		}
	}
	return {
		brightness: brightness / pixels,
		edgeDensity: compared ? edges / compared : 0,
		saturation: saturation / pixels,
	};
}

/** Mean absolute luma difference between consecutive frames, 0-1. */
export function motionEnergy(frames: readonly Uint8Array[]): number {
	if (frames.length < 2) {
		return 0;
	}
	let total = 0;
	let samples = 0;
	for (let index = 1; index < frames.length; index++) {
		const previous = frames[index - 1];
		const current = frames[index];
		if (!(previous && current)) {
			continue;
		}
		const pixels = Math.floor(Math.min(previous.length, current.length) / 3);
		for (let pixel = 0; pixel < pixels; pixel++) {
			total += Math.abs(
				luma(
					current[pixel * 3] ?? 0,
					current[pixel * 3 + 1] ?? 0,
					current[pixel * 3 + 2] ?? 0
				) -
					luma(
						previous[pixel * 3] ?? 0,
						previous[pixel * 3 + 1] ?? 0,
						previous[pixel * 3 + 2] ?? 0
					)
			);
			samples++;
		}
	}
	return samples ? total / samples : 0;
}

/** Search labels for measured shot statistics, in a stable order. */
export function shotLabels(
	stats: Pick<
		ShotStats,
		| "brightness"
		| "colors"
		| "edgeDensity"
		| "end"
		| "motion"
		| "saturation"
		| "start"
	>,
	options: { motionMeasured?: boolean } = {}
): ShotLabel[] {
	const labels: ShotLabel[] = [];
	const t = SHOT_THRESHOLDS;
	if (stats.brightness >= t.bright) {
		labels.push("bright");
	} else if (stats.brightness <= t.dark) {
		labels.push("dark");
	}
	if (stats.saturation >= t.vivid) {
		labels.push("vivid");
	} else if (stats.saturation <= t.muted) {
		labels.push("muted");
	}
	if (stats.edgeDensity < t.closeUpEdges) {
		labels.push("close-up");
	} else if (stats.edgeDensity >= t.wideEdges) {
		labels.push("wide");
	}
	// One analysis frame cannot show motion; such shots get neither label.
	if (options.motionMeasured !== false) {
		if (stats.motion < t.static) {
			labels.push("static");
		} else if (stats.motion >= t.motion) {
			labels.push("motion");
		}
	}
	const duration = stats.end - stats.start;
	if (duration < t.shortSeconds) {
		labels.push("short");
	} else if (duration >= t.longSeconds) {
		labels.push("long");
	}
	const weights = colorWeights(stats.colors);
	for (const name of SHOT_COLOR_NAMES) {
		if ((weights.get(name) ?? 0) >= t.colorLabelWeight) {
			labels.push(name);
		}
	}
	return labels;
}

function colorWeights(
	colors: readonly ShotColor[]
): Map<ShotColorName, number> {
	const weights = new Map<ShotColorName, number>();
	for (const color of colors) {
		weights.set(color.name, (weights.get(color.name) ?? 0) + color.weight);
	}
	return weights;
}

/** Evenly spaced indices in `[first, last]`, at most `limit`, ends included. */
function spreadIndices(first: number, last: number, limit: number): number[] {
	const count = last - first + 1;
	if (count <= limit) {
		return Array.from({ length: count }, (_, offset) => first + offset);
	}
	return Array.from(
		{ length: limit },
		(_, slot) => first + Math.round((slot * (count - 1)) / (limit - 1))
	);
}

/** Inclusive frame-index window `[first, last]` of a shot range. */
function frameWindow(
	frameCount: number,
	sampleRate: number,
	range: ShotRange
): [number, number] {
	const first = Math.max(0, Math.ceil(range.start * sampleRate - 1e-9));
	const last = Math.min(
		frameCount - 1,
		Math.ceil(range.end * sampleRate - 1e-9) - 1
	);
	if (first <= last) {
		return [first, last];
	}
	// Shorter than one sample interval: use the nearest frame.
	const nearest = Math.min(
		frameCount - 1,
		Math.max(0, Math.round(((range.start + range.end) / 2) * sampleRate))
	);
	return [nearest, nearest];
}

/**
 * Prefix sums of every per-frame statistic, computed once per source so any
 * frame window is measured in constant time (plus a fixed-size k-means).
 * `motion[i]` sums the frame differences between frames `1..i` and their
 * predecessors.
 */
interface FrameSums {
	brightness: Float64Array;
	edgeDensity: Float64Array;
	frames: readonly Uint8Array[];
	motion: Float64Array;
	/**
	 * Prefix sums of each frame's per-pixel named-color shares, flat:
	 * `palette[i * SHOT_COLOR_NAMES.length + c]` sums frames `0..i-1`.
	 */
	palette: Float64Array;
	saturation: Float64Array;
}

const COLOR_COUNT = SHOT_COLOR_NAMES.length;
/** Bits kept per channel when naming pixels through the lookup table. */
const NAME_BITS = 5;
let colorNameTable: Uint8Array | undefined;

/** `SHOT_COLOR_NAMES` index of every 15-bit RGB color (bucket centers). */
function colorNameLookup(): Uint8Array {
	if (colorNameTable) {
		return colorNameTable;
	}
	const levels = 1 << NAME_BITS;
	const step = 256 / levels;
	const table = new Uint8Array(levels ** 3);
	for (let red = 0; red < levels; red++) {
		for (let green = 0; green < levels; green++) {
			for (let blue = 0; blue < levels; blue++) {
				const name = colorName([
					red * step + step / 2,
					green * step + step / 2,
					blue * step + step / 2,
				]);
				table[(red * levels + green) * levels + blue] =
					SHOT_COLOR_NAMES.indexOf(name);
			}
		}
	}
	colorNameTable = table;
	return table;
}

/** Adds one frame's per-pixel named-color shares into `target` at `offset`. */
function addFramePalette(
	frame: Uint8Array,
	target: Float64Array,
	offset: number
): void {
	const table = colorNameLookup();
	const shift = 8 - NAME_BITS;
	const share = 1 / SHOT_FRAME_PIXELS;
	for (let pixel = 0; pixel < SHOT_FRAME_PIXELS; pixel++) {
		const key =
			(((((frame[pixel * 3] ?? 0) >> shift) << NAME_BITS) |
				((frame[pixel * 3 + 1] ?? 0) >> shift)) <<
				NAME_BITS) |
			((frame[pixel * 3 + 2] ?? 0) >> shift);
		const slot = offset + (table[key] ?? 0);
		target[slot] = (target[slot] ?? 0) + share;
	}
}

function frameSums(frames: readonly Uint8Array[]): FrameSums {
	const count = frames.length;
	const sums: FrameSums = {
		brightness: new Float64Array(count + 1),
		edgeDensity: new Float64Array(count + 1),
		frames,
		motion: new Float64Array(count),
		palette: new Float64Array((count + 1) * COLOR_COUNT),
		saturation: new Float64Array(count + 1),
	};
	for (let index = 0; index < count; index++) {
		const frame = frames[index] ?? new Uint8Array(SHOT_FRAME_BYTES);
		const stats = frameStats(frame);
		sums.brightness[index + 1] =
			(sums.brightness[index] ?? 0) + stats.brightness;
		sums.saturation[index + 1] =
			(sums.saturation[index] ?? 0) + stats.saturation;
		sums.edgeDensity[index + 1] =
			(sums.edgeDensity[index] ?? 0) + stats.edgeDensity;
		const row = (index + 1) * COLOR_COUNT;
		for (let color = 0; color < COLOR_COUNT; color++) {
			sums.palette[row + color] =
				sums.palette[index * COLOR_COUNT + color] ?? 0;
		}
		addFramePalette(frame, sums.palette, row);
		if (index > 0) {
			const previous = frames[index - 1] ?? frame;
			sums.motion[index] =
				(sums.motion[index - 1] ?? 0) + motionEnergy([previous, frame]);
		}
	}
	return sums;
}

function windowMean(prefix: Float64Array, first: number, last: number): number {
	return ((prefix[last + 1] ?? 0) - (prefix[first] ?? 0)) / (last - first + 1);
}

function measureShot(
	sums: FrameSums,
	sampleRate: number,
	range: ShotRange
): ShotStats {
	const [first, last] = frameWindow(sums.frames.length, sampleRate, range);
	const sampled = spreadIndices(first, last, KMEANS_FRAMES);
	const pixels = new Uint8Array(sampled.length * SHOT_FRAME_BYTES);
	for (const [slot, frameIndex] of sampled.entries()) {
		const frame = sums.frames[frameIndex] ?? new Uint8Array(SHOT_FRAME_BYTES);
		pixels.set(frame.subarray(0, SHOT_FRAME_BYTES), slot * SHOT_FRAME_BYTES);
	}
	const motion =
		last > first
			? ((sums.motion[last] ?? 0) - (sums.motion[first] ?? 0)) / (last - first)
			: 0;
	const base = {
		start: round(range.start, 6),
		end: round(range.end, 6),
		brightness: round(windowMean(sums.brightness, first, last)),
		saturation: round(windowMean(sums.saturation, first, last)),
		motion: round(Math.min(1, Math.max(0, motion))),
		edgeDensity: round(windowMean(sums.edgeDensity, first, last)),
		colors: dominantColors(pixels),
	};
	return shotStatsSchema.parse({
		...base,
		labels: shotLabels(base, { motionMeasured: last > first }),
	});
}

/** Limits under which two neighboring shots read as one continuous shot. */
export const SHOT_CONTINUITY = {
	brightness: 0.08,
	saturation: 0.1,
	/** Minimum shared share of named pixel colors. */
	palette: 0.75,
} as const;

/** The cheap look of a frame window used to decide continuity. */
export interface ShotLook {
	brightness: number;
	/** Share of pixels per color name; shares sum to 1. */
	palette: Readonly<Partial<Record<ShotColorName, number>>>;
	saturation: number;
}

/**
 * True when two neighboring shots look alike: close brightness and
 * saturation and mostly the same named palette. Scene detection fires on
 * fast motion inside flat footage; such false cuts merge back.
 */
export function shotsAreContinuous(a: ShotLook, b: ShotLook): boolean {
	if (
		Math.abs(a.brightness - b.brightness) > SHOT_CONTINUITY.brightness ||
		Math.abs(a.saturation - b.saturation) > SHOT_CONTINUITY.saturation
	) {
		return false;
	}
	let shared = 0;
	for (const name of SHOT_COLOR_NAMES) {
		shared += Math.min(a.palette[name] ?? 0, b.palette[name] ?? 0);
	}
	return shared >= SHOT_CONTINUITY.palette;
}

/** Look of frames `[first, last]` from the prefix sums, in constant time. */
function windowLook(sums: FrameSums, first: number, last: number): ShotLook {
	const frames = last - first + 1;
	const palette: Partial<Record<ShotColorName, number>> = {};
	for (const [color, name] of SHOT_COLOR_NAMES.entries()) {
		const share =
			((sums.palette[(last + 1) * COLOR_COUNT + color] ?? 0) -
				(sums.palette[first * COLOR_COUNT + color] ?? 0)) /
			frames;
		if (share > 0) {
			palette[name] = share;
		}
	}
	return {
		brightness: windowMean(sums.brightness, first, last),
		palette,
		saturation: windowMean(sums.saturation, first, last),
	};
}

/**
 * Per-shot statistics from decoded analysis frames. Frame `i` is sampled at
 * `i / sampleRate` seconds. A shot shorter than one sample interval uses the
 * nearest frame, so every range gets colors and labels. Unless `merge` is
 * false, a range whose look `shotsAreContinuous` with the (already merged)
 * shot before it extends that shot.
 *
 * Per-frame statistics and named-color shares are computed once into prefix
 * sums, merges are decided on those in constant time per range, and each
 * final shot is measured (k-means included) exactly once. The whole pass is
 * linear in frames plus ranges, however many shots merge. Throws when more
 * than `MAX_SHOTS` shots remain after merging, before any k-means runs.
 */
export function shotStatsFromFrames(
	frames: readonly Uint8Array[],
	sampleRate: number,
	ranges: readonly ShotRange[],
	options: { merge?: boolean } = {}
): ShotStats[] {
	if (!(sampleRate > 0)) {
		throw new Error("The analysis frame rate must be positive.");
	}
	if (frames.length === 0) {
		throw new Error("No video frames could be decoded for shot analysis.");
	}
	if (ranges.length > MAX_RAW_SHOT_RANGES) {
		throw new Error(
			`This source has ${ranges.length} scene cuts; shot analysis measures up to ${MAX_RAW_SHOT_RANGES}.`
		);
	}
	const sums = frameSums(frames);
	const merged: ShotRange[] = [];
	for (const range of ranges) {
		const [first, last] = frameWindow(frames.length, sampleRate, range);
		const previous = merged.at(-1);
		if (options.merge !== false && previous) {
			const [previousFirst, previousLast] = frameWindow(
				frames.length,
				sampleRate,
				previous
			);
			if (
				shotsAreContinuous(
					windowLook(sums, previousFirst, previousLast),
					windowLook(sums, first, last)
				)
			) {
				merged[merged.length - 1] = { start: previous.start, end: range.end };
				continue;
			}
		}
		merged.push(range);
	}
	if (merged.length > MAX_SHOTS) {
		throw new Error(
			`This source has ${merged.length} distinct shots; visual search indexes up to ${MAX_SHOTS}. Trim or split the source first.`
		);
	}
	return merged.map((range) => measureShot(sums, sampleRate, range));
}

/** Plain-text description indexed as the shot's Spaces document body. */
export function describeShot(
	shot: ShotStats,
	position: number,
	total: number
): string {
	const colors = shot.colors
		.map((color) => `${color.name} ${Math.round(color.weight * 100)}%`)
		.join(", ");
	return [
		`Shot ${position + 1} of ${total}, ${shot.start.toFixed(1)}–${shot.end.toFixed(1)}s (${(shot.end - shot.start).toFixed(1)}s).`,
		`Looks: ${shot.labels.join(", ") || "neutral"}.`,
		`Dominant colors: ${colors || "none"}.`,
		`Brightness ${Math.round(shot.brightness * 100)}%, saturation ${Math.round(shot.saturation * 100)}%, motion ${Math.round(shot.motion * 1000) / 10}%, detail ${Math.round(shot.edgeDensity * 100)}%.`,
	].join(" ");
}

/** Query words mapped to the label they mean. */
const QUERY_SYNONYMS: Readonly<Record<string, ShotLabel>> = {
	bright: "bright",
	light: "bright",
	sunny: "bright",
	daylight: "bright",
	lit: "bright",
	dark: "dark",
	dim: "dark",
	night: "dark",
	shadowy: "dark",
	moody: "dark",
	vivid: "vivid",
	colorful: "vivid",
	colourful: "vivid",
	saturated: "vivid",
	muted: "muted",
	desaturated: "muted",
	washed: "muted",
	"close-up": "close-up",
	closeup: "close-up",
	tight: "close-up",
	detail: "close-up",
	wide: "wide",
	establishing: "wide",
	landscape: "wide",
	static: "static",
	still: "static",
	steady: "static",
	locked: "static",
	calm: "static",
	motion: "motion",
	moving: "motion",
	movement: "motion",
	action: "motion",
	fast: "motion",
	dynamic: "motion",
	short: "short",
	quick: "short",
	brief: "short",
	long: "long",
	lengthy: "long",
	black: "black",
	white: "white",
	gray: "gray",
	grey: "gray",
	silver: "gray",
	red: "red",
	crimson: "red",
	scarlet: "red",
	orange: "orange",
	brown: "brown",
	tan: "brown",
	yellow: "yellow",
	gold: "yellow",
	golden: "yellow",
	green: "green",
	teal: "teal",
	cyan: "teal",
	turquoise: "teal",
	aqua: "teal",
	blue: "blue",
	navy: "blue",
	azure: "blue",
	purple: "purple",
	violet: "purple",
	pink: "pink",
	magenta: "pink",
};

/** Words a visual query may contain that carry no visual meaning. */
const QUERY_STOPWORDS = new Set([
	"a",
	"an",
	"and",
	"clip",
	"clips",
	"footage",
	"in",
	"is",
	"moment",
	"moments",
	"of",
	"scene",
	"scenes",
	"shot",
	"shots",
	"the",
	"with",
]);

/** Words that negate the visual term right after them. */
const QUERY_NEGATIONS = new Set(["no", "non", "not", "without"]);

/**
 * Multi-word look phrases rewritten to a single label word before
 * tokenizing, so "low light" means dark rather than "low" + "light".
 */
const QUERY_PHRASES: readonly [RegExp, string][] = [
	[/\bclose[\s-]?ups?\b/gu, " close-up "],
	[/\b(?:wide|long|establishing)[\s-]shots?\b/gu, " wide "],
	[/\b(?:low|dim|poor)[\s-]?(?:light|lighting|lit)\b/gu, " dark "],
	[/\b(?:dimly|poorly|badly|darkly)[\s-]lit\b/gu, " dark "],
	[/\blow[\s-]key\b/gu, " dark "],
	[/\b(?:brightly|well|fully|sun)[\s-]?lit\b/gu, " bright "],
	[/\bhigh[\s-]key\b/gu, " bright "],
];

export interface ParsedShotQuery {
	/** Labels the query negates ("not dark", "without blue"); none may match. */
	excluded: ShotLabel[];
	/** Query words with no visual meaning that the search ignored. */
	ignored: string[];
	/** Recognized labels; every one must match. */
	labels: ShotLabel[];
}

/** Lowercased query words, with look phrases and hyphenated compounds split. */
function queryTerms(query: string): string[] {
	let normalized = query.toLocaleLowerCase();
	for (const [pattern, replacement] of QUERY_PHRASES) {
		normalized = normalized.replace(pattern, replacement);
	}
	const terms: string[] = [];
	for (const word of normalized.split(/[^a-z-]+/u)) {
		const term = word.replace(/^-+|-+$/gu, "");
		if (!term) {
			continue;
		}
		if (term === "close-up" || !term.includes("-")) {
			terms.push(term);
			continue;
		}
		for (const part of term.split("-")) {
			if (part) {
				terms.push(part);
			}
		}
	}
	return terms;
}

/**
 * Map a free-text visual query to the labels it asks for. A negation word
 * (`not`, `no`, `non`, `without`) excludes the label of the term after it;
 * stopwords between them ("without the blue") are skipped.
 */
export function parseShotQuery(query: string): ParsedShotQuery {
	const labels: ShotLabel[] = [];
	const excluded: ShotLabel[] = [];
	const ignored: string[] = [];
	let negated = false;
	for (const term of queryTerms(query)) {
		if (QUERY_NEGATIONS.has(term)) {
			negated = true;
			continue;
		}
		if (QUERY_STOPWORDS.has(term)) {
			continue;
		}
		const label = QUERY_SYNONYMS[term];
		if (label === undefined) {
			const word = negated ? `not ${term}` : term;
			if (!ignored.includes(word)) {
				ignored.push(word);
			}
		} else if (negated) {
			if (!excluded.includes(label)) {
				excluded.push(label);
			}
		} else if (!labels.includes(label)) {
			labels.push(label);
		}
		negated = false;
	}
	return {
		excluded,
		ignored,
		labels: labels.filter((label) => !excluded.includes(label)),
	};
}

export interface ShotMatch {
	assetId: string;
	caption?: string;
	colors: ShotColor[];
	end: number;
	labels: ShotLabel[];
	score: number;
	start: number;
	tags?: string[];
	/** Query words found in the shot's caption or tags. */
	textMatches?: string[];
}

/** Lowercased words of a shot's caption and tags, for text matching. */
function describedWords(
	shot: Pick<ShotStats, "caption" | "tags">
): Set<string> {
	const words = new Set<string>();
	const text = [shot.caption ?? "", ...(shot.tags ?? [])]
		.join(" ")
		.toLocaleLowerCase();
	for (const word of text.split(/[^\p{L}\p{N}]+/u)) {
		if (word) {
			words.add(word);
			// A plural tag ("dogs") still matches the singular query word.
			if (word.length > 3 && word.endsWith("s")) {
				words.add(word.slice(0, -1));
			}
		}
	}
	return words;
}

const isDescribed = (shot: Pick<ShotStats, "caption" | "tags">) =>
	Boolean(shot.caption || shot.tags?.length);

const colorNames = new Set<string>(SHOT_COLOR_NAMES);

/** How strongly a matched label applies, 0-1, used to rank matches. */
function labelStrength(shot: ShotStats, label: ShotLabel): number {
	const t = SHOT_THRESHOLDS;
	if (colorNames.has(label)) {
		return colorWeights(shot.colors).get(label as ShotColorName) ?? 0;
	}
	switch (label) {
		case "bright":
			return shot.brightness;
		case "dark":
			return 1 - shot.brightness;
		case "vivid":
			return shot.saturation;
		case "muted":
			return 1 - shot.saturation;
		case "close-up":
			return 1 - shot.edgeDensity / t.closeUpEdges;
		case "wide":
			return shot.edgeDensity;
		case "static":
			return 1 - shot.motion / t.static;
		case "motion":
			return Math.min(1, shot.motion / (t.motion * 4));
		default:
			return 0.5;
	}
}

/**
 * Shots whose labels include every recognized query label and none of the
 * excluded ones, best first. A query with neither a recognized nor an
 * excluded label matches nothing rather than everything.
 */
export function searchShots(
	indexes: readonly ShotIndex[],
	query: string,
	options: { assetId?: string; limit?: number } = {}
): ParsedShotQuery & { results: ShotMatch[]; textTerms: string[] } {
	const parsed = parseShotQuery(query);
	// Words with no measured meaning are matched against vision captions and
	// tags. Shots without a description fall back to the labels alone.
	const textTerms = parsed.ignored.filter((word) => !word.startsWith("not "));
	const excludedText = parsed.ignored
		.filter((word) => word.startsWith("not "))
		.map((word) => word.slice(4));
	const results: ShotMatch[] = [];
	const matchedText = new Set<string>();
	const hasLabels = parsed.labels.length > 0 || parsed.excluded.length > 0;
	for (const index of indexes) {
		if (options.assetId && index.assetId !== options.assetId) {
			continue;
		}
		for (const shot of index.shots) {
			if (
				!parsed.labels.every((label) => shot.labels.includes(label)) ||
				parsed.excluded.some((label) => shot.labels.includes(label))
			) {
				continue;
			}
			const described = isDescribed(shot);
			const words = described ? describedWords(shot) : new Set<string>();
			const hits = textTerms.filter((term) => words.has(term));
			if (described) {
				if (excludedText.some((term) => words.has(term))) {
					continue;
				}
				if (textTerms.length && hits.length < textTerms.length) {
					continue;
				}
				if (!(hasLabels || hits.length)) {
					continue;
				}
			} else if (!hasLabels) {
				continue;
			}
			for (const hit of hits) {
				matchedText.add(hit);
			}
			const strength = parsed.labels.reduce(
				(total, label) =>
					total + Math.max(0, Math.min(1, labelStrength(shot, label))),
				0
			);
			const match: ShotMatch = {
				assetId: index.assetId,
				colors: shot.colors,
				end: shot.end,
				labels: shot.labels,
				score: round(parsed.labels.length + strength + hits.length * 1.5),
				start: shot.start,
			};
			if (shot.caption) {
				match.caption = shot.caption;
			}
			if (shot.tags?.length) {
				match.tags = shot.tags;
			}
			if (hits.length) {
				match.textMatches = hits;
			}
			results.push(match);
		}
	}
	results.sort(
		(a, b) =>
			b.score - a.score ||
			a.assetId.localeCompare(b.assetId) ||
			a.start - b.start
	);
	return {
		...parsed,
		ignored: parsed.ignored.filter((word) => !matchedText.has(word)),
		results: results.slice(0, options.limit ?? 20),
		textTerms,
	};
}

/** The JSON schema a vision model answers with for a batch of keyframes. */
export const shotDescriptionBatchSchema = z
	.object({
		shots: z
			.array(
				z
					.object({
						index: z
							.number()
							.int()
							.min(0)
							.max(MAX_SHOTS - 1),
						caption: z.string().trim().min(1).max(300),
						tags: z.array(z.string().trim().min(1).max(40)).max(MAX_SHOT_TAGS),
					})
					.strict()
			)
			.max(MAX_SHOTS),
	})
	.strict();
export type ShotDescriptionBatch = z.infer<typeof shotDescriptionBatchSchema>;

/** Keyframes sent to a vision model in one request (the bridge allows 8). */
export const SHOT_DESCRIPTION_BATCH = 6;

/** Instructions for describing one batch of keyframes, in order. */
export function shotDescriptionPrompt(indices: readonly number[]): string {
	return [
		`You are given ${indices.length} video keyframes in order. Their shot indices are ${indices.join(", ")}.`,
		"For each keyframe write a plain one-sentence caption of what is visible (subjects, setting, action) and up to 8 short lowercase tags (nouns or adjectives a person would search for).",
		"Describe only what is visible. Do not guess names, brands, or identities of people.",
		'Answer with JSON only, exactly in this shape: {"shots":[{"index":<shot index>,"caption":"...","tags":["..."]}]}.',
	].join(" ");
}

/**
 * Parse a vision model's answer for a batch. Accepts the JSON alone or
 * inside a fenced block, keeps only shots that were asked for, and throws
 * with an editor-facing reason when nothing usable came back.
 */
export function parseShotDescriptions(
	answer: string,
	indices: readonly number[]
): ShotDescriptionBatch["shots"] {
	const fenced = answer.match(/```(?:json)?\s*([\s\S]*?)```/u);
	const body = (fenced?.[1] ?? answer).trim();
	const start = body.indexOf("{");
	const end = body.lastIndexOf("}");
	let value: unknown;
	try {
		value = JSON.parse(
			start >= 0 && end > start ? body.slice(start, end + 1) : body
		);
	} catch {
		throw new Error("The vision model did not answer with shot descriptions.");
	}
	const parsed = shotDescriptionBatchSchema.safeParse(value);
	if (!parsed.success) {
		throw new Error(
			"The vision model's shot descriptions do not match the expected shape."
		);
	}
	const wanted = new Set(indices);
	const shots = parsed.data.shots.filter((shot) => wanted.has(shot.index));
	if (!shots.length) {
		throw new Error("The vision model described none of the requested shots.");
	}
	return shots;
}

/**
 * `index` with captions and tags applied to the shots they name. Tags are
 * lowercased and de-duplicated; shots not named keep their description.
 */
export function applyShotDescriptions(
	index: ShotIndex,
	descriptions: ShotDescriptionBatch["shots"],
	describedBy: { model: string; provider: string },
	now = new Date().toISOString()
): ShotIndex {
	const byIndex = new Map(descriptions.map((entry) => [entry.index, entry]));
	return shotIndexSchema.parse({
		...index,
		describedBy: { ...describedBy, describedAt: now },
		shots: index.shots.map((shot, position) => {
			const entry = byIndex.get(position);
			if (!entry) {
				return shot;
			}
			return {
				...shot,
				caption: entry.caption,
				tags: [
					...new Set(entry.tags.map((tag) => tag.toLocaleLowerCase())),
				].slice(0, MAX_SHOT_TAGS),
			};
		}),
	});
}
