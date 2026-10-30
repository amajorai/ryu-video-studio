import { animationExpression } from "../../../shared/animation.ts";
import {
	MASK_FEATHER_SIGMA_SCALE,
	type MaskAnimatedField,
	MIN_ELLIPSE_GRADIENT,
	maskAnimatedFields,
	maskDistanceOutline,
	maskFieldAnimated,
	maskFontName,
	maskHasStroke,
	maskKeyframePropertyOf,
	maskOutline,
	maskStrokeAlignOf,
	maskStrokeColorOf,
	rampMaskShapes,
	sanitizeMaskText,
	starEdge,
	TEXT_MASK_SIZE,
} from "../../../shared/masks.ts";
import type { Segment } from "../../../shared/project.ts";
import type { Mask } from "../../../shared/schema/mask.ts";
import type { RenderStageContext, StageOutputWithInputs } from "./types.ts";

/**
 * Clip masks (W2-V3). Each mask becomes a grayscale matte computed per pixel
 * with `geq` from the clip's own frame size (`W`/`H`) and time (`T`, seconds
 * into the clip), so keyframed position, size, rotation and feather animate
 * without precomputed images. The mattes multiply into the clip's alpha:
 *
 *   [in] → rgba → split ─ color ───────────────────────────────┐
 *                      └ alpha → split ─ alpha ─ ×matte₀ ─ … ─ alphamerge → [out]
 *                                     └ matte₀ … mattek
 *
 * Shapes follow `shared/masks.ts` (`maskShapeCoverage`) exactly. Feather is a
 * three-pass box blur with radius `feather × min(w,h) × 0.1` (≈ that Gaussian
 * sigma); a keyframed feather crossfades the sharp and fully feathered matte.
 * Linear and mirror masks use an analytic ramp instead. Text masks draw with
 * `drawtext` (fontconfig family name) and are rotated and moved after.
 *
 * A mask with a stroke (`strokeWidth` > 0, never a text mask) also draws its
 * outline: a per-pixel RGBA `geq` on a copy of the clip computes the signed
 * distance to the mask edge (`maskSignedDistance`) and paints the stroke
 * band in the stroke color, overlaid on the masked clip after `alphamerge`.
 *
 * Clips without masks pass through: no filters, no inputs, same label.
 */

export interface MaskStageContext extends RenderStageContext {
	/** Label of the clip stream after effects, without brackets. */
	input: string;
	/** One-based segment number, unique per render, for label names. */
	n: number;
}

/** How a mask field resolves: a number, or an FFmpeg expression of `clock`. */
export type MaskValueOf = (
	mask: Mask,
	field: MaskAnimatedField,
	clock: string
) => string;

export interface MaskMatteInput {
	/** Label of the stream to mask, without brackets. */
	input: string;
	masks: readonly Mask[];
	/** Prefix for every label this stage creates, unique per render. */
	prefix: string;
	value: MaskValueOf;
}

/** Plain decimal text for FFmpeg expressions (no exponent, six decimals). */
export function exprNumber(value: number): string {
	const rounded = Math.round(value * 1e6) / 1e6;
	return Object.is(rounded, -0) ? "0" : String(rounded);
}

/** Static values for clips without keyframes on the mask. */
export const staticMaskValue: MaskValueOf = (mask, field) =>
	exprNumber(mask[field]);

/** Keyframed mask fields as `animationExpression`s of the clip clock. */
export function segmentMaskValue(segment: Segment): MaskValueOf {
	return (mask, field, clock) =>
		maskFieldAnimated(segment, mask, field)
			? `(${animationExpression(segment, maskKeyframePropertyOf[field], clock, mask.id)})`
			: exprNumber(mask[field]);
}

const isNumber = (expression: string) => /^-?\d+(\.\d+)?$/.test(expression);

/**
 * Variables (`st`/`ld` slots): 0,1 center; 2,3 half size; 4 rotation; 5,6 the
 * pixel offset in the mask's rotated frame; 7,8 the same in box units; 9 is
 * scratch for one shape.
 */
function geometryPrelude(mask: Mask, value: MaskValueOf): string {
	const x = value(mask, "x", "T");
	const y = value(mask, "y", "T");
	const width = value(mask, "width", "T");
	const height = value(mask, "height", "T");
	const rotation = value(mask, "rotation", "T");
	return [
		`st(0,W/2*(1+${x}))`,
		`st(1,H/2*(1+${y}))`,
		`st(2,max(W*${width}/2,0.5))`,
		`st(3,max(H*${height}/2,0.5))`,
		`st(4,${rotation}*PI/180)`,
		"st(5,(X+0.5-ld(0))*cos(ld(4))+(Y+0.5-ld(1))*sin(ld(4)))",
		"st(6,(Y+0.5-ld(1))*cos(ld(4))-(X+0.5-ld(0))*sin(ld(4)))",
		"st(7,ld(5)/ld(2))",
		"st(8,ld(6)/ld(3))",
	].join(";");
}

/** Outline edges with fewer crossings than this are tested in one leaf. */
const OUTLINE_LEAF_EDGES = 6;
/** Deepest y-band split of an outline (at most 2^depth bands). */
const OUTLINE_MAX_DEPTH = 5;

export interface OutlineEdge {
	ax: number;
	ay: number;
	bx: number;
	by: number;
	maxY: number;
	minY: number;
}

/** Crossing term of one edge for (`ld(7)`,`ld(8)`). */
function edgeTerm({ ax, ay, bx, by, maxY, minY }: OutlineEdge): string {
	const slope = (bx - ax) / (by - ay);
	return `gt(ld(8),${exprNumber(minY)})*lte(ld(8),${exprNumber(maxY)})*lt(ld(7),${exprNumber(ax - ay * slope)}+ld(8)*${exprNumber(slope)})`;
}

/** A y band of an outline: a leaf of edges, or a split at `middle`. */
export type OutlineBand =
	| { edges: readonly OutlineEdge[]; high: number; low: number }
	| { above: OutlineBand; below: OutlineBand; middle: number };

/**
 * The edges that can cross rows in [`low`, `high`), as a binary tree of y
 * bands. An edge's term is non-zero only for rows in (minY, maxY], so a band
 * keeps the edges with minY < high and maxY >= low; summing a pixel's leaf
 * equals summing every edge, while each pixel evaluates only the few edges
 * near its row (a 512-edge freeform outline would otherwise cost 512 terms
 * per pixel).
 */
export function outlineBands(
	edges: readonly OutlineEdge[],
	low: number,
	high: number,
	depth = 0
): OutlineBand {
	const inBand = edges.filter((edge) => edge.minY < high && edge.maxY >= low);
	if (inBand.length <= OUTLINE_LEAF_EDGES || depth >= OUTLINE_MAX_DEPTH) {
		return { edges: inBand, high, low };
	}
	const middle = (low + high) / 2;
	return {
		above: outlineBands(inBand, middle, high, depth + 1),
		below: outlineBands(inBand, low, middle, depth + 1),
		middle,
	};
}

function bandExpression(band: OutlineBand): string {
	if ("edges" in band) {
		return band.edges.map(edgeTerm).join("+") || "0";
	}
	return `if(lt(ld(8),${exprNumber(band.middle)}),${bandExpression(band.below)},${bandExpression(band.above)})`;
}

/** The non-horizontal edges of a closed outline. */
export function outlineEdges(
	outline: readonly { x: number; y: number }[]
): OutlineEdge[] {
	const edges: OutlineEdge[] = [];
	for (const [index, a] of outline.entries()) {
		const b = outline[(index + 1) % outline.length] ?? a;
		if (a.y !== b.y) {
			edges.push({
				ax: a.x,
				ay: a.y,
				bx: b.x,
				by: b.y,
				maxY: Math.max(a.y, b.y),
				minY: Math.min(a.y, b.y),
			});
		}
	}
	return edges;
}

/**
 * Crossing-number test of (`ld(7)`,`ld(8)`) against a polygon outline, with
 * a bounding-box early out and y-banded edges (FFmpeg's `if` only evaluates
 * the branch it takes).
 */
export function outlineExpression(
	outline: readonly { x: number; y: number }[]
): string {
	const xs = outline.map((point) => point.x);
	const ys = outline.map((point) => point.y);
	const top = Math.min(...ys);
	const bottom = Math.max(...ys);
	const bounds = `between(ld(7),${exprNumber(Math.min(...xs))},${exprNumber(Math.max(...xs))})*between(ld(8),${exprNumber(top)},${exprNumber(bottom)})`;
	const bands = outlineBands(outlineEdges(outline), top, bottom);
	return `if(${bounds},mod(${bandExpression(bands)},2),0)`;
}

/** Ramp width in pixels for linear and mirror masks (see `maskRampWidth`). */
function rampExpression(feather: string): string {
	return `max(1,${exprNumber(4 * MASK_FEATHER_SIGMA_SCALE)}*${feather}*min(W,H))`;
}

/** Hard coverage (0..1) of a non-text shape; mirrors `maskShapeCoverage`. */
export function shapeExpression(mask: Mask, value: MaskValueOf): string {
	switch (mask.shape) {
		case "rectangle": {
			const corner = mask.cornerRadius ?? 0;
			if (corner <= 0) {
				return "lte(abs(ld(7)),1)*lte(abs(ld(8)),1)";
			}
			const qx = "(abs(ld(5))-ld(2)+ld(9))";
			const qy = "(abs(ld(6))-ld(3)+ld(9))";
			return `st(9,${exprNumber(corner * 2)}*min(ld(2),ld(3)));lte(hypot(max(${qx},0),max(${qy},0))+min(max(${qx},${qy}),0),ld(9))`;
		}
		case "ellipse":
			return "lte(ld(7)*ld(7)+ld(8)*ld(8),1)";
		case "linear":
			return `clip(0.5-ld(6)/${rampExpression(value(mask, "feather", "T"))},0,1)`;
		case "mirror":
			return `clip(0.5-(abs(ld(6))-ld(3))/${rampExpression(value(mask, "feather", "T"))},0,1)`;
		case "polygon": {
			const sides = mask.sides ?? 6;
			return `st(9,mod(atan2(ld(8),ld(7))+PI/2+4*PI,${exprNumber((2 * Math.PI) / sides)})-${exprNumber(Math.PI / sides)});lte(hypot(ld(7),ld(8))*cos(ld(9)),${exprNumber(Math.cos(Math.PI / sides))})`;
		}
		case "star": {
			const { ex, ey, half } = starEdge(
				mask.points ?? 5,
				mask.innerRadius ?? 0.5
			);
			return `st(9,abs(mod(atan2(ld(8),ld(7))+PI/2+${exprNumber(half)}+4*PI,${exprNumber(2 * half)})-${exprNumber(half)}));gte(${exprNumber(ex)}*hypot(ld(7),ld(8))*sin(ld(9))-${exprNumber(ey)}*(hypot(ld(7),ld(8))*cos(ld(9))-1),0)`;
		}
		default:
			return outlineExpression(maskOutline(mask) ?? []);
	}
}

/** Consecutive outline edges measured together behind one box test. */
const DISTANCE_GROUP_EDGES = 4;

/** `st(1, min(ld(1), distance))` for one edge, in pixels. */
function edgeDistanceStatement(
	a: { x: number; y: number },
	b: { x: number; y: number }
): string {
	const ex = exprNumber(b.x - a.x);
	const ey = exprNumber(b.y - a.y);
	const exx = exprNumber((b.x - a.x) ** 2);
	const eyy = exprNumber((b.y - a.y) ** 2);
	return [
		`st(0,ld(5)-${exprNumber(a.x)}*ld(2))`,
		`st(9,ld(6)-${exprNumber(a.y)}*ld(3))`,
		`st(4,clip((ld(0)*${ex}*ld(2)+ld(9)*${ey}*ld(3))/max(${exx}*ld(7)+${eyy}*ld(8),1e-12),0,1))`,
		`st(1,min(ld(1),hypot(ld(0)-ld(4)*${ex}*ld(2),ld(9)-ld(4)*${ey}*ld(3))))`,
	].join(";");
}

/**
 * Signed distance in pixels from (`ld(5)`,`ld(6)`) to the mask edge,
 * negative inside; mirrors `maskSignedDistance` within `reach` pixels of the
 * edge (farther pixels only need to be known as beyond it, and get
 * `reach + 1`). Keeps slots 2, 3, 5 and 6; the others are scratch.
 *
 * Polygonal shapes measure the edges of `maskDistanceOutline` in runs of
 * four, each run behind a box test grown by `reach`, so a pixel computes
 * distances only to the few edges near it. The inside test then restores
 * the box-unit slots 7 and 8 it reads.
 */
export function signedDistanceExpression(mask: Mask, reach: string): string {
	switch (mask.shape) {
		case "rectangle": {
			const corner = exprNumber((mask.cornerRadius ?? 0) * 2);
			const qx = "(abs(ld(5))-ld(2)+ld(9))";
			const qy = "(abs(ld(6))-ld(3)+ld(9))";
			return `st(9,${corner}*min(ld(2),ld(3)));hypot(max(${qx},0),max(${qy},0))+min(max(${qx},${qy}),0)-ld(9)`;
		}
		case "ellipse":
			return `st(9,hypot(ld(7),ld(8)));if(lt(ld(9),${exprNumber(MIN_ELLIPSE_GRADIENT)}),-min(ld(2),ld(3)),ld(9)*(ld(9)-1)/hypot(ld(7)/ld(2),ld(8)/ld(3)))`;
		case "linear":
			return "ld(6)";
		case "mirror":
			return "abs(ld(6))-ld(3)";
		default: {
			const outline = maskDistanceOutline(mask);
			const groups: string[] = [];
			for (
				let first = 0;
				first < outline.length;
				first += DISTANCE_GROUP_EDGES
			) {
				const edges = Array.from(
					{ length: Math.min(DISTANCE_GROUP_EDGES, outline.length - first) },
					(_, offset) => {
						const a = outline[first + offset] ?? { x: 0, y: 0 };
						const b = outline[(first + offset + 1) % outline.length] ?? a;
						return { a, b };
					}
				);
				const xs = edges.flatMap(({ a, b }) => [a.x, b.x]);
				const ys = edges.flatMap(({ a, b }) => [a.y, b.y]);
				const box = `between(ld(5),${exprNumber(Math.min(...xs))}*ld(2)-${reach},${exprNumber(Math.max(...xs))}*ld(2)+${reach})*between(ld(6),${exprNumber(Math.min(...ys))}*ld(3)-${reach},${exprNumber(Math.max(...ys))}*ld(3)+${reach})`;
				groups.push(
					`if(${box},${edges.map(({ a, b }) => edgeDistanceStatement(a, b)).join(";")},0)`
				);
			}
			const inside = shapeExpression(mask, staticMaskValue);
			return [
				`st(1,${reach}+1)`,
				"st(7,ld(2)*ld(2))",
				"st(8,ld(3)*ld(3))",
				...groups,
				"st(7,ld(5)/ld(2))",
				"st(8,ld(6)/ld(3))",
				`if(${inside},-ld(1),ld(1))`,
			].join(";");
		}
	}
}

/** RGB components (0..255) of a `#rrggbb` color. */
function rgbOf(hex: string): [number, number, number] {
	const value = Number.parseInt(hex.slice(1), 16);
	return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

/**
 * The RGBA `geq` that paints a mask's stroke band (`maskStrokeBand`) in its
 * color on a transparent frame; mirrors `maskStrokeAlphaAt`.
 */
export function maskStrokeGeqFilter(mask: Mask, value: MaskValueOf): string {
	const width = `${exprNumber(mask.strokeWidth ?? 0)}*H`;
	const band = {
		center: { inner: `-${width}/2`, outer: `${width}/2` },
		inside: { inner: `-${width}`, outer: "0" },
		outside: { inner: "0", outer: width },
	}[maskStrokeAlignOf(mask)];
	const reach = `(${width}+1.5)`;
	const [red, green, blue] = rgbOf(maskStrokeColorOf(mask));
	const alpha = `${geometryPrelude(mask, value)};st(0,${signedDistanceExpression(mask, reach)});255*max(0,clip(0.5-(ld(0)-(${band.outer})),0,1)-clip(0.5-(ld(0)-(${band.inner})),0,1))`;
	return `geq=r=${red}:g=${green}:b=${blue}:a='${alpha}'`;
}

/** `coverage` → strength after invert and opacity; mirrors `maskStrength`. */
function strengthExpression(mask: Mask, coverage: string): string {
	const opacity = exprNumber(mask.opacity);
	return mask.invert
		? `1-${opacity}*(${coverage})`
		: `1-${opacity}*(1-(${coverage}))`;
}

/** The `geq` matte (0..255) of a non-text mask. */
export function maskGeqFilter(mask: Mask, value: MaskValueOf): string {
	const coverage = shapeExpression(mask, value);
	return `geq=lum='${geometryPrelude(mask, value)};255*(${strengthExpression(mask, coverage)})'`;
}

/** Box-blur radius for a feather value (≈ Gaussian sigma in pixels). */
function blurFilter(feather: string): string {
	return `boxblur=lr='min(w,h)*${feather}*${exprNumber(MASK_FEATHER_SIGMA_SCALE)}':lp=3`;
}

/**
 * Drawtext matte of a text mask, rotated and moved about the mask center.
 * The font size follows the static mask height; position and rotation
 * keyframes animate.
 */
function textMatteFilters(mask: Mask, value: MaskValueOf): string[] {
	const text = sanitizeMaskText(mask.text ?? "") || " ";
	const font = maskFontName(mask.fontFamily);
	const fontsize = `${exprNumber(TEXT_MASK_SIZE)}*h*${exprNumber(mask.height)}`;
	const filters = [
		"geq=lum=0",
		`drawtext=font='${font}':text='${text}':expansion=none:fontcolor=white:fontsize='${fontsize}':x='(w-text_w)/2':y='(h-text_h)/2'`,
	];
	const rotation = value(mask, "rotation", "t");
	if (rotation !== "0") {
		filters.push(`rotate=a='${rotation}*PI/180':fillcolor=black`);
	}
	const x = value(mask, "x", "t");
	const y = value(mask, "y", "t");
	if (x !== "0" || y !== "0") {
		// Translate by the mask offset: pad three times larger, then crop the
		// window back out, shifted by (x·W/2, y·H/2).
		filters.push(
			"pad=iw*3:ih*3:iw:ih:black",
			`crop=w=iw/3:h=ih/3:x='iw/3-${x}*iw/6':y='ih/3-${y}*ih/6'`
		);
	}
	if (mask.invert || mask.opacity !== 1) {
		filters.push(`geq=lum='255*(${strengthExpression(mask, "p(X,Y)/255")})'`);
	}
	return filters;
}

/** Whether every animatable field of the mask resolves to a constant. */
export function maskIsStatic(mask: Mask, value: MaskValueOf): boolean {
	return maskAnimatedFields.every(([field]) =>
		isNumber(value(mask, field, "T"))
	);
}

/** Largest feather a keyframed mask reaches (its static value otherwise). */
function maxFeather(keyframed: readonly number[], mask: Mask): number {
	return Math.max(mask.feather, ...keyframed);
}

/**
 * Filter statements that multiply `masks` into the alpha of `input`. Returns
 * no filters (and the input label) for an empty list. Adjustment layers reuse
 * this with their own value resolver.
 */
export function maskMatteFilters(
	{ input, masks, prefix, value }: MaskMatteInput,
	featherKeyframes: (mask: Mask) => number[] = () => []
): { filters: string[]; label: string } {
	if (masks.length === 0) {
		return { filters: [], label: input };
	}
	const stroked = masks.flatMap((mask, index) =>
		maskHasStroke(mask) ? [index] : []
	);
	const filters = [
		`[${input}]format=rgba,split=${2 + stroked.length}[${prefix}c][${prefix}s]${stroked
			.map((index) => `[${prefix}k${index}]`)
			.join("")}`,
		`[${prefix}s]alphaextract,split=${masks.length + 1}[${prefix}a0]${masks
			.map((_, index) => `[${prefix}s${index}]`)
			.join("")}`,
	];
	for (const [index, mask] of masks.entries()) {
		const matte = `${prefix}m${index}`;
		// A static matte (no keyframes on the mask) is drawn once from the
		// first frame and held by the multiply's `eof_action=repeat`, so
		// the per-pixel `geq` cost is paid once per clip, not per frame.
		const once = maskIsStatic(mask, value);
		const shape =
			mask.shape === "text"
				? textMatteFilters(mask, value)
				: [maskGeqFilter(mask, value)];
		const chain = once ? ["trim=end_frame=1", ...shape] : shape;
		const feather = value(mask, "feather", "T");
		const blurs = !rampMaskShapes.has(mask.shape);
		const peak = maxFeather(featherKeyframes(mask), mask);
		if (!blurs || peak <= 0) {
			filters.push(`[${prefix}s${index}]${chain.join(",")}[${matte}]`);
		} else if (isNumber(feather)) {
			filters.push(
				`[${prefix}s${index}]${[...chain, blurFilter(feather)].join(",")}[${matte}]`
			);
		} else {
			const peakText = exprNumber(peak);
			filters.push(
				`[${prefix}s${index}]${chain.join(",")},split=2[${matte}h][${matte}b]`,
				`[${matte}b]${blurFilter(peakText)}[${matte}f]`,
				`[${matte}h][${matte}f]blend=all_expr='A+(B-A)*clip(${feather}/${peakText},0,1)'[${matte}]`
			);
		}
		filters.push(
			`[${prefix}a${index}][${matte}]blend=all_mode=multiply${once ? ":eof_action=repeat" : ""}[${prefix}a${index + 1}]`
		);
	}
	const out = `${prefix}out`;
	if (stroked.length === 0) {
		filters.push(`[${prefix}c][${prefix}a${masks.length}]alphamerge[${out}]`);
		return { filters, label: out };
	}
	let label = `${prefix}merged`;
	filters.push(`[${prefix}c][${prefix}a${masks.length}]alphamerge[${label}]`);
	for (const [position, index] of stroked.entries()) {
		const mask = masks[index] as Mask;
		const once = maskIsStatic(mask, value);
		const next = position === stroked.length - 1 ? out : `${prefix}o${index}`;
		filters.push(
			`[${prefix}k${index}]${once ? "trim=end_frame=1," : ""}${maskStrokeGeqFilter(mask, value)}[${prefix}g${index}]`,
			`[${label}][${prefix}g${index}]overlay=format=rgb${once ? ":eof_action=repeat" : ""}[${next}]`
		);
		label = next;
	}
	return { filters, label: out };
}

/** The values a clip's `property` keyframes take for one mask. */
export function maskKeyframeValues(
	segment: Pick<Segment, "keyframes">,
	property: "maskFeather"
): (mask: Mask) => number[] {
	return (mask) =>
		segment.keyframes
			.filter(
				(frame) => frame.property === property && frame.target === mask.id
			)
			.map((frame) => frame.value);
}

/** Clip masks applied in the clip's frame, after effects and before rotation. */
export function maskStage(
	segment: Segment,
	context: MaskStageContext
): StageOutputWithInputs {
	const masks = segment.masks ?? [];
	const { filters, label } = maskMatteFilters(
		{
			input: context.input,
			masks,
			prefix: `mask${context.n}`,
			value: segmentMaskValue(segment),
		},
		maskKeyframeValues(segment, "maskFeather")
	);
	return { filters, inputs: [], label };
}
