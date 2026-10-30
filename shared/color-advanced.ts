/**
 * Advanced color grade math (W2-V5): levels (whites and blacks), the
 * shadows/highlights tone curve, lift/gamma/gain wheels, RGB curves, HSL
 * bands, hue-vs-saturation and LUT intensity.
 *
 * Every function is pure. The render stage
 * (`sidecar/src/render-stages/color-advanced.ts`) turns these values into
 * FFmpeg filters, the WebGL grade pass (`ui/src/preview/gl/passes/grade.ts`)
 * into uniforms, and `compileGrade` is the CPU reference both mirror (look
 * thumbnails use it directly).
 *
 * Fixed order: levels → tone curve → wheels → curves (per channel, then
 * master) → HSL bands and hue-vs-sat → LUT.
 */
import { type CubeLut, sampleCubeLut } from "./cube-lut.ts";
import type {
	ColorGrade,
	ColorWheel,
	CurvePoint,
	HslBand,
} from "./schema/color.ts";

export type Rgb = [number, number, number];

const EPSILON = 1e-6;
const clamp = (value: number, min: number, max: number) =>
	Math.min(max, Math.max(min, value));
const clamp01 = (value: number) => clamp(value, 0, 1);
const round = (value: number) => Number(value.toFixed(6));

// ---------------------------------------------------------------------------
// Levels (whites and blacks)

export interface Levels {
	inMax: number;
	inMin: number;
	outMax: number;
	outMin: number;
}

/** How far whites/blacks at ±1 move a level point. */
export const LEVELS_RANGE = 0.25;

/**
 * Input and output level points from `whites` and `blacks`. Positive blacks
 * crush (raise the input black point); negative blacks lift (raise the output
 * black point). Positive whites brighten (lower the input white point);
 * negative whites dim (lower the output white point). Null when neutral.
 */
export function levelsOf(grade: ColorGrade): Levels | null {
	const blacks = grade.blacks ?? 0;
	const whites = grade.whites ?? 0;
	if (Math.abs(blacks) < EPSILON && Math.abs(whites) < EPSILON) {
		return null;
	}
	return {
		inMax: round(whites > 0 ? 1 - whites * LEVELS_RANGE : 1),
		inMin: round(blacks > 0 ? blacks * LEVELS_RANGE : 0),
		outMax: round(whites < 0 ? 1 + whites * LEVELS_RANGE : 1),
		outMin: round(blacks < 0 ? -blacks * LEVELS_RANGE : 0),
	};
}

export function applyLevels(levels: Levels, value: number): number {
	const normalized = clamp01(
		(value - levels.inMin) / (levels.inMax - levels.inMin)
	);
	return levels.outMin + normalized * (levels.outMax - levels.outMin);
}

// ---------------------------------------------------------------------------
// Curves (monotone cubic / PCHIP, matching FFmpeg `curves=interp=pchip`)

/** How far shadows/highlights at ±1 move the quarter-tone points. */
export const TONE_RANGE = 0.125;

/** The master curve implied by `shadows` and `highlights`, or null. */
export function toneCurveOf(grade: ColorGrade): CurvePoint[] | null {
	const shadows = grade.shadows ?? 0;
	const highlights = grade.highlights ?? 0;
	if (Math.abs(shadows) < EPSILON && Math.abs(highlights) < EPSILON) {
		return null;
	}
	return [
		{ x: 0, y: 0 },
		{ x: 0.25, y: round(clamp01(0.25 + shadows * TONE_RANGE)) },
		{ x: 0.75, y: round(clamp01(0.75 + highlights * TONE_RANGE)) },
		{ x: 1, y: 1 },
	];
}

/** True when a curve maps every input to itself. */
export function isIdentityCurve(points: readonly CurvePoint[] | undefined) {
	if (!points || points.length < 2) {
		return true;
	}
	const first = points[0];
	const last = points.at(-1);
	return (
		points.every((point) => Math.abs(point.x - point.y) < EPSILON) &&
		(first?.x ?? 0) < EPSILON &&
		(last?.x ?? 1) > 1 - EPSILON
	);
}

const sign = (value: number) => (value > 0 ? 1 : value < 0 ? -1 : 0);

/** Fritsch–Carlson endpoint slope with shape preservation. */
function endSlope(h0: number, h1: number, d0: number, d1: number): number {
	const slope = ((2 * h0 + h1) * d0 - h0 * d1) / (h0 + h1);
	if (sign(slope) !== sign(d0)) {
		return 0;
	}
	if (sign(d0) !== sign(d1) && Math.abs(slope) > Math.abs(3 * d0)) {
		return 3 * d0;
	}
	return slope;
}

function pchipSlopes(xs: readonly number[], ys: readonly number[]): number[] {
	const count = xs.length;
	const h: number[] = [];
	const d: number[] = [];
	for (let index = 0; index < count - 1; index++) {
		const width = (xs[index + 1] ?? 0) - (xs[index] ?? 0);
		h.push(width);
		d.push(((ys[index + 1] ?? 0) - (ys[index] ?? 0)) / width);
	}
	if (count === 2) {
		return [d[0] ?? 0, d[0] ?? 0];
	}
	const slopes = new Array<number>(count).fill(0);
	for (let index = 1; index < count - 1; index++) {
		const before = d[index - 1] ?? 0;
		const after = d[index] ?? 0;
		if (before * after <= 0) {
			continue;
		}
		const w1 = 2 * (h[index] ?? 0) + (h[index - 1] ?? 0);
		const w2 = (h[index] ?? 0) + 2 * (h[index - 1] ?? 0);
		slopes[index] = (w1 + w2) / (w1 / before + w2 / after);
	}
	slopes[0] = endSlope(h[0] ?? 1, h[1] ?? 1, d[0] ?? 0, d[1] ?? 0);
	slopes[count - 1] = endSlope(
		h[count - 2] ?? 1,
		h[count - 3] ?? 1,
		d[count - 2] ?? 0,
		d[count - 3] ?? 0
	);
	return slopes;
}

/**
 * A curve evaluator. Inputs left of the first point take its `y`, right of
 * the last point take its `y` (as FFmpeg does); outputs are clamped to 0..1.
 */
export function curveFunction(
	points: readonly CurvePoint[]
): (x: number) => number {
	if (points.length === 0) {
		return (x) => clamp01(x);
	}
	if (points.length === 1) {
		const only = clamp01(points[0]?.y ?? 0);
		return () => only;
	}
	const xs = points.map((point) => point.x);
	const ys = points.map((point) => point.y);
	const slopes = pchipSlopes(xs, ys);
	const firstX = xs[0] ?? 0;
	const lastX = xs.at(-1) ?? 1;
	return (x) => {
		if (x <= firstX) {
			return clamp01(ys[0] ?? 0);
		}
		if (x >= lastX) {
			return clamp01(ys.at(-1) ?? 1);
		}
		let segment = 0;
		while (segment < xs.length - 2 && x > (xs[segment + 1] ?? 1)) {
			segment += 1;
		}
		const x0 = xs[segment] ?? 0;
		const width = (xs[segment + 1] ?? 1) - x0;
		const t = (x - x0) / width;
		const t2 = t * t;
		const t3 = t2 * t;
		const value =
			(2 * t3 - 3 * t2 + 1) * (ys[segment] ?? 0) +
			(t3 - 2 * t2 + t) * width * (slopes[segment] ?? 0) +
			(-2 * t3 + 3 * t2) * (ys[segment + 1] ?? 0) +
			(t3 - t2) * width * (slopes[segment + 1] ?? 0);
		return clamp01(value);
	};
}

/** Sample a curve at `size` evenly spaced inputs from 0 to 1. */
export function curveToTable(
	points: readonly CurvePoint[],
	size = 256
): number[] {
	const evaluate = curveFunction(points);
	return Array.from({ length: size }, (_, index) =>
		evaluate(index / (size - 1))
	);
}

/** Linear lookup into a table built by `curveToTable`. */
export function lookupTable(table: readonly number[], x: number): number {
	const position = clamp01(x) * (table.length - 1);
	const index = Math.min(table.length - 2, Math.floor(position));
	const fraction = position - index;
	return (
		(table[index] ?? 0) * (1 - fraction) + (table[index + 1] ?? 0) * fraction
	);
}

export type CurveChannel = "master" | "red" | "green" | "blue";
export const curveChannels: readonly CurveChannel[] = [
	"master",
	"red",
	"green",
	"blue",
];

/** The user curves that change anything, keyed by channel. */
export function activeCurves(
	grade: ColorGrade
): Partial<Record<CurveChannel, CurvePoint[]>> {
	const active: Partial<Record<CurveChannel, CurvePoint[]>> = {};
	for (const channel of curveChannels) {
		const points = grade.curves?.[channel];
		if (points && !isIdentityCurve(points)) {
			active[channel] = points;
		}
	}
	return active;
}

// ---------------------------------------------------------------------------
// Lift / gamma / gain wheels (FFmpeg `colorbalance`)

/** `colorbalance` value of a wheel channel at ±1. */
export const WHEEL_STRENGTH = 0.5;

export interface WheelBalance {
	highlights: Rgb;
	midtones: Rgb;
	shadows: Rgb;
}

function wheelRgb(wheel: ColorWheel | undefined): Rgb {
	if (!wheel) {
		return [0, 0, 0];
	}
	const channel = (value: number) =>
		round(clamp(value + wheel.master, -1, 1) * WHEEL_STRENGTH);
	return [channel(wheel.r), channel(wheel.g), channel(wheel.b)];
}

/** Lift → shadows, gamma → midtones, gain → highlights; null when neutral. */
export function wheelBalanceOf(grade: ColorGrade): WheelBalance | null {
	const balance = {
		highlights: wheelRgb(grade.gain),
		midtones: wheelRgb(grade.gamma),
		shadows: wheelRgb(grade.lift),
	};
	const neutral = [balance.shadows, balance.midtones, balance.highlights]
		.flat()
		.every((value) => Math.abs(value) < EPSILON);
	return neutral ? null : balance;
}

/** FFmpeg `colorbalance` per-component response (lightness = max + min). */
function balanceComponent(
	value: number,
	lightness: number,
	shadows: number,
	midtones: number,
	highlights: number
): number {
	const a = 4;
	const b = 0.333;
	const scale = 0.7;
	const s = shadows * clamp01((b - lightness) * a + 0.5) * scale;
	const m =
		midtones *
		clamp01((lightness - b) * a + 0.5) *
		clamp01((1 - lightness - b) * a + 0.5) *
		scale;
	const h = highlights * clamp01((lightness + b - 1) * a + 0.5) * scale;
	return clamp01(value + s + m + h);
}

export function applyWheelBalance(balance: WheelBalance, rgb: Rgb): Rgb {
	const lightness = Math.max(...rgb) + Math.min(...rgb);
	return [0, 1, 2].map((channel) =>
		balanceComponent(
			rgb[channel] ?? 0,
			lightness,
			balance.shadows[channel] ?? 0,
			balance.midtones[channel] ?? 0,
			balance.highlights[channel] ?? 0
		)
	) as Rgb;
}

// ---------------------------------------------------------------------------
// HSL bands and hue-vs-saturation (FFmpeg `huesaturation`)

/** FFmpeg `huesaturation` color ranges and their hue centers in degrees. */
export type HueColor = "r" | "y" | "g" | "c" | "b" | "m";
export const hueColors: readonly HueColor[] = ["r", "y", "g", "c", "b", "m"];
export const hueCenters: Record<HueColor, number> = {
	b: 240,
	c: 180,
	g: 120,
	m: 300,
	r: 0,
	y: 60,
};

/** Each band's FFmpeg ranges; a between-range band applies half to both. */
const bandTargets: Record<HslBand["band"], readonly HueColor[]> = {
	aqua: ["c"],
	blue: ["b"],
	green: ["g"],
	magenta: ["m"],
	orange: ["r", "y"],
	purple: ["b", "m"],
	red: ["r"],
	yellow: ["y"],
};

/** Degrees of hue shift for an HSL band at ±1. */
export const HSL_HUE_DEGREES = 30;
/** `huesaturation` intensity for an HSL band lightness at ±1. */
export const HSL_LIGHTNESS_STRENGTH = 0.5;

export interface HueAdjustment {
	/** Hue shift in degrees. */
	hue: number;
	/** Intensity shift, -1..1. */
	intensity: number;
	/** Saturation shift, -1..1. */
	saturation: number;
}

export interface HueSaturationFilter extends HueAdjustment {
	colors: HueColor[];
	/**
	 * FFmpeg `strength`: how hard the range selection saturates. 1 for
	 * selective residuals (a soft 60° hue falloff, weighed by pixel
	 * saturation); the shared global part uses `GLOBAL_HUE_STRENGTH`.
	 */
	strength: number;
}

/** `huesaturation` strength of the global (all-range) filter. */
export const GLOBAL_HUE_STRENGTH = 100;

/** Saturation shift of a hue-vs-sat curve (y = 0.5 is neutral). */
export function hueVsSatAt(
	points: readonly CurvePoint[],
	degrees: number
): number {
	if (points.length === 0) {
		return 0;
	}
	const y = curveFunction(points)(degrees / 360);
	return round((y - 0.5) * 2);
}

/** Per-range hue, saturation and intensity shifts from the HSL bands and hue-vs-sat. */
export function hueAdjustmentsOf(
	grade: ColorGrade
): Record<HueColor, HueAdjustment> {
	const adjustments = Object.fromEntries(
		hueColors.map((color) => [color, { hue: 0, intensity: 0, saturation: 0 }])
	) as Record<HueColor, HueAdjustment>;
	for (const band of grade.hsl ?? []) {
		const targets = bandTargets[band.band];
		const share = 1 / targets.length;
		for (const color of targets) {
			const entry = adjustments[color];
			entry.hue += band.hue * HSL_HUE_DEGREES * share;
			entry.saturation += band.saturation * share;
			entry.intensity += band.lightness * HSL_LIGHTNESS_STRENGTH * share;
		}
	}
	for (const color of hueColors) {
		adjustments[color].saturation += hueVsSatAt(
			grade.hueVsSat ?? [],
			hueCenters[color]
		);
	}
	for (const color of hueColors) {
		const entry = adjustments[color];
		entry.hue = round(clamp(entry.hue, -180, 180));
		entry.saturation = round(clamp(entry.saturation, -1, 1));
		entry.intensity = round(clamp(entry.intensity, -1, 1));
	}
	return adjustments;
}

/**
 * The part of a per-range value that every range shares: the value nearest
 * zero when all six ranges push the same way, otherwise 0. It changes
 * continuously with the inputs, so near-identical grades split alike.
 */
function sharedPart(values: readonly number[]): number {
	if (values.every((value) => value > 0)) {
		return Math.min(...values);
	}
	if (values.every((value) => value < 0)) {
		return Math.max(...values);
	}
	return 0;
}

/**
 * The `huesaturation` filters to emit. The adjustment every range shares
 * becomes one global filter (all ranges, `GLOBAL_HUE_STRENGTH`); what is left
 * per range becomes selective filters (strength 1), one per distinct non-zero
 * residual with every range that shares it, in r, y, g, c, b, m order. The
 * split is continuous: two close grades always produce close filters.
 */
export function hueSaturationFilters(grade: ColorGrade): HueSaturationFilter[] {
	const adjustments = hueAdjustmentsOf(grade);
	const shared = (key: keyof HueAdjustment) =>
		sharedPart(hueColors.map((color) => adjustments[color][key]));
	const global: HueAdjustment = {
		hue: shared("hue"),
		intensity: shared("intensity"),
		saturation: shared("saturation"),
	};
	const filters: HueSaturationFilter[] = [];
	if (global.hue || global.intensity || global.saturation) {
		filters.push({
			colors: [...hueColors],
			...global,
			strength: GLOBAL_HUE_STRENGTH,
		});
	}
	for (const color of hueColors) {
		const hue = round(adjustments[color].hue - global.hue);
		const intensity = round(adjustments[color].intensity - global.intensity);
		const saturation = round(adjustments[color].saturation - global.saturation);
		if (!(hue || intensity || saturation)) {
			continue;
		}
		const same = filters.find(
			(filter) =>
				filter.strength === 1 &&
				filter.hue === hue &&
				filter.intensity === intensity &&
				filter.saturation === saturation
		);
		if (same) {
			same.colors.push(color);
		} else {
			filters.push({
				colors: [color],
				hue,
				intensity,
				saturation,
				strength: 1,
			});
		}
	}
	return filters;
}

function rgbToHsv([r, g, b]: Rgb): Rgb {
	const max = Math.max(r, g, b);
	const min = Math.min(r, g, b);
	const delta = max - min;
	let hue = 0;
	if (delta > EPSILON) {
		if (max === r) {
			hue = 60 * (((g - b) / delta + 6) % 6);
		} else if (max === g) {
			hue = 60 * ((b - r) / delta + 2);
		} else {
			hue = 60 * ((r - g) / delta + 4);
		}
	}
	return [hue, max > EPSILON ? delta / max : 0, max];
}

function hsvToRgb([hue, saturation, value]: Rgb): Rgb {
	const chroma = value * saturation;
	const sector = (((hue % 360) + 360) % 360) / 60;
	const x = chroma * (1 - Math.abs((sector % 2) - 1));
	const m = value - chroma;
	const table: Rgb[] = [
		[chroma, x, 0],
		[x, chroma, 0],
		[0, chroma, x],
		[0, x, chroma],
		[x, 0, chroma],
		[chroma, 0, x],
	];
	const [r, g, b] = table[Math.floor(sector) % 6] ?? [0, 0, 0];
	return [r + m, g + m, b + m];
}

/** Triangular membership of a hue (degrees) in a range: 1 at its center, 0 at ±60°. */
export function hueMembership(hue: number, color: HueColor): number {
	const distance = Math.abs(((hue - hueCenters[color] + 540) % 360) - 180);
	return Math.max(0, 1 - distance / 60);
}

/** HSL saturation of an RGB pixel. */
function hslSaturation(rgb: Rgb): number {
	const max = Math.max(...rgb);
	const min = Math.min(...rgb);
	const lightness = (max + min) / 2;
	const denominator = 1 - Math.abs(2 * lightness - 1);
	return denominator > EPSILON ? (max - min) / denominator : 0;
}

/**
 * The response of one `huesaturation` filter, as measured against FFmpeg:
 * the weight is `min(1, membership × HSL saturation × strength)`; the hue
 * rotates by `hue × weight`, chroma scales around the channel mean by
 * `1 + saturation × weight`, and the pixel scales by `1 + intensity × weight`.
 */
export function applyHueSaturation(filter: HueSaturationFilter, rgb: Rgb): Rgb {
	const [hue, saturation, value] = rgbToHsv(rgb);
	let membership = 0;
	for (const color of filter.colors) {
		membership += hueMembership(hue, color);
	}
	const weight = clamp01(
		Math.min(1, membership) * hslSaturation(rgb) * filter.strength
	);
	if (weight <= 0) {
		return rgb;
	}
	const rotated = filter.hue
		? hsvToRgb([hue + filter.hue * weight, saturation, value])
		: rgb;
	const mean = (rotated[0] + rotated[1] + rotated[2]) / 3;
	const chroma = 1 + filter.saturation * weight;
	const gain = 1 + filter.intensity * weight;
	return rotated.map((channel) =>
		clamp01((mean + (channel - mean) * chroma) * gain)
	) as Rgb;
}

// ---------------------------------------------------------------------------
// The whole grade

/** LUT intensity in effect (0 when no LUT is referenced). */
export function lutIntensityOf(grade: ColorGrade): number {
	return grade.lut ? clamp01(grade.lut.intensity) : 0;
}

/** True when any advanced control changes pixels. */
export function hasAdvancedGrade(grade: ColorGrade): boolean {
	return Boolean(
		levelsOf(grade) ||
			toneCurveOf(grade) ||
			wheelBalanceOf(grade) ||
			Object.keys(activeCurves(grade)).length > 0 ||
			hueSaturationFilters(grade).length > 0 ||
			lutIntensityOf(grade) > 0
	);
}

/**
 * Compile the advanced grade into a per-pixel function over 0..1 RGB (the
 * CPU reference for the WebGL pass and the look thumbnails). Pass the parsed
 * LUT when `grade.lut` is set; without it the LUT step is skipped.
 */
export function compileGrade(
	grade: ColorGrade,
	lut?: CubeLut | null
): (rgb: Rgb) => Rgb {
	const levels = levelsOf(grade);
	const tone = toneCurveOf(grade);
	const toneTable = tone ? curveToTable(tone) : null;
	const balance = wheelBalanceOf(grade);
	const curves = activeCurves(grade);
	const tables = {
		blue: curves.blue ? curveToTable(curves.blue) : null,
		green: curves.green ? curveToTable(curves.green) : null,
		master: curves.master ? curveToTable(curves.master) : null,
		red: curves.red ? curveToTable(curves.red) : null,
	};
	const channelTables = [tables.red, tables.green, tables.blue];
	const hueFilters = hueSaturationFilters(grade);
	const intensity = lut ? lutIntensityOf(grade) : 0;
	return (input) => {
		let rgb: Rgb = [input[0], input[1], input[2]];
		if (levels) {
			rgb = rgb.map((value) => applyLevels(levels, value)) as Rgb;
		}
		if (toneTable) {
			rgb = rgb.map((value) => lookupTable(toneTable, value)) as Rgb;
		}
		if (balance) {
			rgb = applyWheelBalance(balance, rgb);
		}
		rgb = rgb.map((value, channel) => {
			const table = channelTables[channel];
			const per = table ? lookupTable(table, value) : value;
			return tables.master ? lookupTable(tables.master, per) : per;
		}) as Rgb;
		for (const filter of hueFilters) {
			rgb = applyHueSaturation(filter, rgb);
		}
		if (lut && intensity > 0) {
			const graded = sampleCubeLut(lut, rgb[0], rgb[1], rgb[2]);
			rgb = rgb.map(
				(value, channel) =>
					value + ((graded[channel] ?? value) - value) * intensity
			) as Rgb;
		}
		return rgb;
	};
}
