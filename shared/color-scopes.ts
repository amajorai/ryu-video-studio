import { z } from "zod";
import { idSchema } from "./project.ts";

const normalized = z.number().finite().min(0).max(1);

export const colorScopesSchema = z
	.object({
		assetId: idSchema,
		hueDegrees: z.number().finite().min(0).max(360),
		luma: z
			.object({
				average: normalized,
				max: normalized,
				min: normalized,
			})
			.strict(),
		sampledAt: z.number().finite().min(0).max(7200),
		saturation: z
			.object({
				average: normalized,
				max: normalized,
				min: normalized,
			})
			.strict(),
		clipping: z
			.object({
				black: z.boolean(),
				white: z.boolean(),
			})
			.strict(),
		chroma: z
			.object({
				u: normalized,
				v: normalized,
			})
			.strict(),
	})
	.strict();

export type ColorScopes = z.infer<typeof colorScopesSchema>;

/** Luma histogram bins: one per 8-bit code value. */
export const SCOPE_HISTOGRAM_BINS = 256;
/** Value bins per RGB parade column (8-bit values grouped by four). */
export const SCOPE_PARADE_BINS = 64;
/** Vectorscope grid edge (Cb across, Cr down). */
export const SCOPE_VECTOR_SIZE = 64;
/** Parade columns used when the caller does not ask for a count. */
export const DEFAULT_SCOPE_COLUMNS = 64;
/** Most parade columns one request may ask for. */
export const MAX_SCOPE_COLUMNS = 256;
/** Longest edge of the downscaled frame the scopes are measured on. */
export const SCOPE_SAMPLE_EDGE = 256;
/** Full-range luma at or below this code value counts as crushed black. */
export const SCOPE_BLACK_CLIP = 2;
/** Full-range luma at or above this code value counts as clipped white. */
export const SCOPE_WHITE_CLIP = 253;

export const scopeColumnsSchema = z
	.number()
	.int()
	.min(1)
	.max(MAX_SCOPE_COLUMNS);

const count = z.number().int().nonnegative();
const countRow = (length: number) => z.array(count).length(length);

/**
 * Histogram, RGB parade, and vectorscope arrays measured on one RGB frame.
 * Every array holds pixel counts; `parade.*[column][bin]` reads left to right
 * across the frame and dark to bright, and `vectorscope.cells[row][column]`
 * has Cb increasing to the right and Cr increasing upward (row 0 is +Cr).
 */
export const scopeWaveformsSchema = z
	.object({
		clipped: z
			.object({
				black: normalized,
				white: normalized,
			})
			.strict(),
		height: z.number().int().min(1).max(SCOPE_SAMPLE_EDGE),
		histogram: countRow(SCOPE_HISTOGRAM_BINS),
		luma: z
			.object({
				average: normalized,
				max: normalized,
				min: normalized,
			})
			.strict(),
		parade: z
			.object({
				b: z.array(countRow(SCOPE_PARADE_BINS)).min(1),
				bins: z.literal(SCOPE_PARADE_BINS),
				columns: scopeColumnsSchema,
				g: z.array(countRow(SCOPE_PARADE_BINS)).min(1),
				r: z.array(countRow(SCOPE_PARADE_BINS)).min(1),
			})
			.strict(),
		pixels: z.number().int().min(1),
		vectorscope: z
			.object({
				cells: z.array(countRow(SCOPE_VECTOR_SIZE)).length(SCOPE_VECTOR_SIZE),
				size: z.literal(SCOPE_VECTOR_SIZE),
			})
			.strict(),
		width: z.number().int().min(1).max(SCOPE_SAMPLE_EDGE),
	})
	.strict()
	.superRefine((value, context) => {
		const { columns, r, g, b } = value.parade;
		if (r.length !== columns || g.length !== columns || b.length !== columns) {
			context.addIssue({
				code: "custom",
				message: "Every parade channel needs one row per column.",
				path: ["parade"],
			});
		}
	});

export type ScopeWaveforms = z.infer<typeof scopeWaveformsSchema>;

/** `GET /assets/:id/scopes?detail=full`: the summary plus the scope arrays. */
export const colorScopesDetailSchema = colorScopesSchema
	.extend({ waveforms: scopeWaveformsSchema })
	.strict();

export type ColorScopesDetail = z.infer<typeof colorScopesDetailSchema>;

/** `GET /projects/:id/scopes`: scopes of the composited timeline frame. */
export const timelineScopesSchema = z
	.object({
		projectId: idSchema,
		revision: z.number().int().nonnegative(),
		time: z.number().finite().min(0).max(7200),
		waveforms: scopeWaveformsSchema,
	})
	.strict();

export type TimelineScopes = z.infer<typeof timelineScopesSchema>;

/**
 * Size of the downscaled frame the scopes read: the longest edge becomes
 * `edge` (never upscaled) and the aspect ratio is kept. Unknown sizes fall
 * back to 16:9.
 */
export function scopeSampleSize(
	width: number,
	height: number,
	edge = SCOPE_SAMPLE_EDGE
): { height: number; width: number } {
	if (!(width > 0 && height > 0)) {
		return { height: Math.round((edge * 9) / 16), width: edge };
	}
	const scale = Math.min(1, edge / Math.max(width, height));
	return {
		height: Math.max(1, Math.round(height * scale)),
		width: Math.max(1, Math.round(width * scale)),
	};
}

/** BT.709 full-range luma of an 8-bit RGB triple, as a code value 0-255. */
export function lumaCode(red: number, green: number, blue: number): number {
	const value = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
	return Math.max(0, Math.min(255, Math.round(value)));
}

/**
 * Vectorscope cell of an 8-bit RGB triple. BT.709 Cb and Cr span -0.5..0.5
 * for normalized RGB; neutral grey lands in the centre cell.
 */
export function vectorscopeCell(
	red: number,
	green: number,
	blue: number,
	size = SCOPE_VECTOR_SIZE
): { column: number; row: number } {
	const r = red / 255;
	const g = green / 255;
	const b = blue / 255;
	const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
	const cb = (b - y) / 1.8556;
	const cr = (r - y) / 1.5748;
	const cell = (value: number) =>
		Math.max(0, Math.min(size - 1, Math.floor(value * size)));
	return { column: cell(cb + 0.5), row: cell(0.5 - cr) };
}

const zeros = (length: number) => new Array<number>(length).fill(0);
const round6 = (value: number) => Number(value.toFixed(6));

/**
 * Measure histogram, RGB parade, and vectorscope arrays from packed 8-bit
 * RGB (`rgb24`, row-major, no padding). Pure and deterministic.
 */
export function computeScopeWaveforms(
	rgb: Uint8Array,
	width: number,
	height: number,
	columns = DEFAULT_SCOPE_COLUMNS
): ScopeWaveforms {
	if (
		!(Number.isInteger(width) && Number.isInteger(height)) ||
		width < 1 ||
		height < 1
	) {
		throw new Error("Scopes need a frame of at least one pixel.");
	}
	if (rgb.length !== width * height * 3) {
		throw new Error("The RGB frame does not match its width and height.");
	}
	const columnCount = Math.min(scopeColumnsSchema.parse(columns), width);
	const histogram = zeros(SCOPE_HISTOGRAM_BINS);
	const parade = {
		b: Array.from({ length: columnCount }, () => zeros(SCOPE_PARADE_BINS)),
		g: Array.from({ length: columnCount }, () => zeros(SCOPE_PARADE_BINS)),
		r: Array.from({ length: columnCount }, () => zeros(SCOPE_PARADE_BINS)),
	};
	const cells = Array.from({ length: SCOPE_VECTOR_SIZE }, () =>
		zeros(SCOPE_VECTOR_SIZE)
	);
	const binShift = Math.log2(256 / SCOPE_PARADE_BINS);
	let lumaTotal = 0;
	let lumaMin = 255;
	let lumaMax = 0;
	let black = 0;
	let white = 0;
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const offset = (y * width + x) * 3;
			const red = rgb[offset] ?? 0;
			const green = rgb[offset + 1] ?? 0;
			const blue = rgb[offset + 2] ?? 0;
			const luma = lumaCode(red, green, blue);
			histogram[luma] = (histogram[luma] ?? 0) + 1;
			lumaTotal += luma;
			lumaMin = Math.min(lumaMin, luma);
			lumaMax = Math.max(lumaMax, luma);
			if (luma <= SCOPE_BLACK_CLIP) {
				black++;
			}
			if (luma >= SCOPE_WHITE_CLIP) {
				white++;
			}
			const column = Math.floor((x * columnCount) / width);
			const redRow = parade.r[column];
			const greenRow = parade.g[column];
			const blueRow = parade.b[column];
			if (redRow && greenRow && blueRow) {
				redRow[red >> binShift] = (redRow[red >> binShift] ?? 0) + 1;
				greenRow[green >> binShift] = (greenRow[green >> binShift] ?? 0) + 1;
				blueRow[blue >> binShift] = (blueRow[blue >> binShift] ?? 0) + 1;
			}
			const cell = vectorscopeCell(red, green, blue);
			const row = cells[cell.row];
			if (row) {
				row[cell.column] = (row[cell.column] ?? 0) + 1;
			}
		}
	}
	const pixels = width * height;
	return scopeWaveformsSchema.parse({
		clipped: { black: round6(black / pixels), white: round6(white / pixels) },
		height,
		histogram,
		luma: {
			average: round6(lumaTotal / pixels / 255),
			max: round6(lumaMax / 255),
			min: round6(lumaMin / 255),
		},
		parade: { ...parade, bins: SCOPE_PARADE_BINS, columns: columnCount },
		pixels,
		vectorscope: { cells, size: SCOPE_VECTOR_SIZE },
		width,
	});
}

/** Largest count in a scope array (flat or nested). */
export function scopePeak(values: readonly number[] | readonly number[][]) {
	let peak = 0;
	for (const value of values) {
		if (typeof value === "number") {
			peak = Math.max(peak, value);
		} else {
			for (const item of value) {
				peak = Math.max(peak, item);
			}
		}
	}
	return peak;
}

/**
 * Display intensity 0-1 for a count against the array's peak. Logarithmic,
 * so sparse traces stay visible next to a dominant flat background.
 */
export function scopeIntensity(value: number, peak: number): number {
	if (!(peak > 0 && value > 0)) {
		return 0;
	}
	return Math.min(1, Math.log1p(value) / Math.log1p(peak));
}
