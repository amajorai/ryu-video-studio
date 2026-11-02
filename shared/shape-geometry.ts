/**
 * Shape graphics (W2-V11): outline geometry, stroke alignment, keyframed
 * motion and an anti-aliased rasterizer shared by the render and the preview.
 *
 * Every shape is reduced to one closed polygon in frame pixels. The render
 * rasterizes that polygon with a signed-distance coverage (so strokes get
 * round joins and every edge a one-pixel ramp) and the preview draws the
 * same points as an SVG path, so both agree on the silhouette.
 *
 * Legacy graphics (an axis-aligned rectangle, line, or an unstroked ellipse
 * or triangle without rotation, radius, keyframes, alignment, masks or a
 * blend mode) keep their original `drawbox` render and CSS preview byte for
 * byte; see `usesLegacyDrawbox`.
 */
import type { Graphic, Keyframe } from "./project.ts";
import {
	type KeyframeInterpolation,
	mixKeyframeColor,
} from "./schema/keyframe.ts";

export interface Point {
	x: number;
	y: number;
}

export interface FrameSize {
	height: number;
	width: number;
}

export type StrokeAlign = "center" | "inside" | "outside";

/** The fields geometry reads; the full `Graphic` satisfies it. */
export type ShapeGraphic = Pick<
	Graphic,
	| "animation"
	| "blendMode"
	| "cornerRadius"
	| "end"
	| "entryDuration"
	| "fill"
	| "height"
	| "innerRadius"
	| "keyframes"
	| "masks"
	| "opacity"
	| "points"
	| "rotation"
	| "shape"
	| "sides"
	| "start"
	| "stroke"
	| "strokeAlign"
	| "strokeWidth"
	| "width"
	| "x"
	| "y"
>;

export const DEFAULT_POLYGON_SIDES = 6;
export const DEFAULT_STAR_POINTS = 5;
export const DEFAULT_STAR_INNER_RADIUS = 0.5;
/** Minimum drawn thickness of a line graphic, as a fraction of frame height. */
export const MIN_LINE_THICKNESS = 0.006;

const ELLIPSE_SEGMENTS = 96;
const HEART_SAMPLES = 128;
const CORNER_SEGMENTS = 12;
const BEZIER_STEPS = 16;
/** Extra transparent pixels around a raster so edge ramps never clip. */
const RASTER_MARGIN = 2;

export const sidesOf = (graphic: Pick<Graphic, "sides">): number =>
	graphic.sides ?? DEFAULT_POLYGON_SIDES;
export const starPointsOf = (graphic: Pick<Graphic, "points">): number =>
	graphic.points ?? DEFAULT_STAR_POINTS;
export const innerRadiusOf = (graphic: Pick<Graphic, "innerRadius">): number =>
	graphic.innerRadius ?? DEFAULT_STAR_INNER_RADIUS;
export const cornerRadiusOf = (
	graphic: Pick<Graphic, "cornerRadius">
): number => graphic.cornerRadius ?? 0;
/**
 * Absent alignment is `inside`: the legacy rectangle draws its border inside
 * the box, and the legacy CSS border is inside the border box too.
 */
export const strokeAlignOf = (
	graphic: Pick<Graphic, "strokeAlign">
): StrokeAlign => graphic.strokeAlign ?? "inside";
export const graphicRotationOf = (graphic: Pick<Graphic, "rotation">): number =>
	graphic.rotation ?? 0;

/**
 * Numeric keyframable graphic properties. Other keyframe properties are
 * ignored. `scale` multiplies the box about its center; `strokeWidth`,
 * `cornerRadius` and `innerRadius` animate the shape fields of that name.
 */
export const graphicKeyframeProperties = [
	"x",
	"y",
	"rotation",
	"opacity",
	"scale",
	"strokeWidth",
	"cornerRadius",
	"innerRadius",
] as const;
/** Keyframable graphic paint colors (keyframes carry `color`). */
export const graphicColorKeyframes = ["fill", "stroke"] as const;
export type GraphicColorKeyframeProperty =
	(typeof graphicColorKeyframes)[number];
/** Channels that change the drawn shape itself (not just where it sits). */
const SHAPE_CHANNELS: ReadonlySet<string> = new Set([
	"scale",
	"strokeWidth",
	"cornerRadius",
	"innerRadius",
	...graphicColorKeyframes,
]);
export type GraphicKeyframeProperty =
	(typeof graphicKeyframeProperties)[number];

const graphicKeyframePropertySet: ReadonlySet<string> = new Set(
	graphicKeyframeProperties
);

export const isGraphicKeyframeProperty = (
	property: string
): property is GraphicKeyframeProperty =>
	graphicKeyframePropertySet.has(property);

/** The graphic's keyframes for `property`, sorted by time. */
export function graphicKeyframesFor(
	graphic: Pick<Graphic, "keyframes">,
	property: GraphicKeyframeProperty
): Keyframe[] {
	return (graphic.keyframes ?? [])
		.filter((keyframe) => keyframe.property === property)
		.sort((a, b) => a.time - b.time);
}

/** True when keyframes change the shape's size, stroke, corners or colors. */
export const hasGraphicShapeKeyframes = (
	graphic: Pick<Graphic, "keyframes">
): boolean =>
	(graphic.keyframes ?? []).some((keyframe) =>
		SHAPE_CHANNELS.has(keyframe.property)
	);

export const hasGraphicKeyframes = (
	graphic: Pick<Graphic, "keyframes">,
	property: GraphicKeyframeProperty
): boolean =>
	(graphic.keyframes ?? []).some((keyframe) => keyframe.property === property);

/**
 * True when the graphic keeps the original `drawbox` render (and CSS
 * preview): one of the four original shapes with none of the W2-V11 fields
 * that `drawbox` cannot express. Ellipses and triangles keep their slices
 * (which never drew a stroke) so existing renders do not change; setting a
 * stroke alignment moves them to the raster path, which draws the stroke.
 */
export function usesLegacyDrawbox(graphic: ShapeGraphic): boolean {
	const legacyShape =
		graphic.shape === "rectangle" ||
		graphic.shape === "line" ||
		graphic.shape === "ellipse" ||
		graphic.shape === "triangle";
	return (
		legacyShape &&
		graphicRotationOf(graphic) === 0 &&
		cornerRadiusOf(graphic) === 0 &&
		graphic.strokeAlign === undefined &&
		(graphic.keyframes ?? []).length === 0 &&
		(graphic.masks ?? []).length === 0 &&
		(graphic.blendMode ?? "normal") === "normal"
	);
}

// ---------------------------------------------------------------------------
// Outlines

/**
 * A regular polygon inscribed in the ellipse with radii `rx`/`ry` around
 * `center`, first vertex straight up, clockwise on screen.
 */
export function regularPolygonVertices(
	sides: number,
	center: Point,
	rx: number,
	ry: number
): Point[] {
	const count = Math.max(3, Math.round(sides));
	return Array.from({ length: count }, (_, index) => {
		const angle = -Math.PI / 2 + (index * 2 * Math.PI) / count;
		return {
			x: center.x + rx * Math.cos(angle),
			y: center.y + ry * Math.sin(angle),
		};
	});
}

/**
 * A star with `points` tips on the ellipse and notches at `innerRadius`
 * times the radii, first tip straight up, alternating tip and notch.
 */
export function starVertices(
	points: number,
	innerRadius: number,
	center: Point,
	rx: number,
	ry: number
): Point[] {
	const count = Math.max(3, Math.round(points));
	return Array.from({ length: count * 2 }, (_, index) => {
		const angle = -Math.PI / 2 + (index * Math.PI) / count;
		const radius = index % 2 === 0 ? 1 : innerRadius;
		return {
			x: center.x + rx * radius * Math.cos(angle),
			y: center.y + ry * radius * Math.sin(angle),
		};
	});
}

/** An ellipse filling the `width` x `height` box. */
export function ellipseVertices(width: number, height: number): Point[] {
	return regularPolygonVertices(
		ELLIPSE_SEGMENTS,
		{ x: width / 2, y: height / 2 },
		width / 2,
		height / 2
	);
}

/** An upward triangle filling the box. */
export function triangleVertices(width: number, height: number): Point[] {
	return [
		{ x: width / 2, y: 0 },
		{ x: width, y: height },
		{ x: 0, y: height },
	];
}

/**
 * A rectangle whose corners are quarter ellipses with radii `radius` and
 * `radiusY` (in pixels, each clamped to half the matching side). A zero
 * radius on either axis gives four sharp corners.
 */
export function roundedRectVertices(
	width: number,
	height: number,
	radius: number,
	radiusY: number = radius
): Point[] {
	const rx = Math.max(0, Math.min(radius, width / 2));
	const ry = Math.max(0, Math.min(radiusY, height / 2));
	if (rx === 0 || ry === 0) {
		return [
			{ x: 0, y: 0 },
			{ x: width, y: 0 },
			{ x: width, y: height },
			{ x: 0, y: height },
		];
	}
	const corners: [number, number, number][] = [
		[width - rx, ry, -Math.PI / 2],
		[width - rx, height - ry, 0],
		[rx, height - ry, Math.PI / 2],
		[rx, ry, Math.PI],
	];
	const points: Point[] = [];
	for (const [cx, cy, from] of corners) {
		for (let step = 0; step <= CORNER_SEGMENTS; step++) {
			const angle = from + (step / CORNER_SEGMENTS) * (Math.PI / 2);
			points.push({
				x: cx + rx * Math.cos(angle),
				y: cy + ry * Math.sin(angle),
			});
		}
	}
	return points;
}

/** The classic parametric heart, scaled to fill the box exactly. */
export function heartVertices(width: number, height: number): Point[] {
	const raw = Array.from({ length: HEART_SAMPLES }, (_, index) => {
		const t = (index / HEART_SAMPLES) * 2 * Math.PI;
		return {
			x: 16 * Math.sin(t) ** 3,
			y: -(
				13 * Math.cos(t) -
				5 * Math.cos(2 * t) -
				2 * Math.cos(3 * t) -
				Math.cos(4 * t)
			),
		};
	});
	const xs = raw.map((point) => point.x);
	const ys = raw.map((point) => point.y);
	const minX = Math.min(...xs);
	const minY = Math.min(...ys);
	const spanX = Math.max(...xs) - minX;
	const spanY = Math.max(...ys) - minY;
	return raw.map((point) => ({
		x: ((point.x - minX) / spanX) * width,
		y: ((point.y - minY) / spanY) * height,
	}));
}

/** A right-pointing block arrow: a shaft 40% tall and a head 45% long. */
export function arrowVertices(width: number, height: number): Point[] {
	const neck = width * 0.55;
	return [
		{ x: 0, y: height * 0.3 },
		{ x: neck, y: height * 0.3 },
		{ x: neck, y: 0 },
		{ x: width, y: height / 2 },
		{ x: neck, y: height },
		{ x: neck, y: height * 0.7 },
		{ x: 0, y: height * 0.7 },
	];
}

/**
 * Stroke width in frame pixels for every shape except the rectangle: a
 * fraction of the frame height (see `rectangleStrokePx` for rectangles).
 */
export const strokeWidthPx = (
	graphic: Pick<Graphic, "strokeWidth">,
	frame: FrameSize
): number => graphic.strokeWidth * frame.height;

/** Box size of the graphic in frame pixels. */
export const graphicBoxPx = (
	graphic: Pick<Graphic, "height" | "width">,
	frame: FrameSize
): FrameSize => ({
	height: graphic.height * frame.height,
	width: graphic.width * frame.width,
});

/**
 * A rectangle's stroke in frame pixels on each axis. The legacy `drawbox`
 * border is `strokeWidth` of the frame width on the left and right and of the
 * frame height on the top and bottom; rasterized rectangles keep that unit so
 * a border does not change when a rectangle leaves the legacy path.
 */
export const rectangleStrokePx = (
	graphic: Pick<Graphic, "strokeWidth">,
	frame: FrameSize
): { x: number; y: number } => ({
	x: graphic.strokeWidth * frame.width,
	y: graphic.strokeWidth * frame.height,
});

/** Stroke and fill outlines of a two-region paint (see `rectangleRegions`). */
export interface PaintRegions {
	/** Fill outline; empty when the stroke covers the whole shape. */
	inner: Point[];
	/** Silhouette: the stroke paints the part outside `inner`. */
	outer: Point[];
}

/** A rounded rectangle grown (negative inset) or shrunk on each axis. */
function insetRoundedRect(
	box: FrameSize,
	radius: number,
	insetX: number,
	insetY: number
): Point[] {
	const width = box.width - 2 * insetX;
	const height = box.height - 2 * insetY;
	if (width <= 0 || height <= 0) {
		return [];
	}
	const rx = radius > 0 ? Math.max(0, radius - insetX) : 0;
	const ry = radius > 0 ? Math.max(0, radius - insetY) : 0;
	return roundedRectVertices(width, height, rx, ry).map((point) => ({
		x: point.x + insetX,
		y: point.y + insetY,
	}));
}

/**
 * A stroked rectangle as two outlines relative to its box (W2-V11): the
 * silhouette in the stroke color and the fill outline over it, offset by
 * the anisotropic `rectangleStrokePx` for the alignment. Inside alignment
 * with no radius matches the legacy border box plus inset fill box exactly.
 * Undefined for other shapes and unstroked rectangles.
 */
export function rectangleRegions(
	graphic: ShapeGraphic,
	frame: FrameSize
): PaintRegions | undefined {
	if (graphic.shape !== "rectangle" || graphic.strokeWidth <= 0) {
		return;
	}
	const box = graphicBoxPx(graphic, frame);
	const radius = cornerRadiusOf(graphic) * Math.min(box.width, box.height);
	const stroke = rectangleStrokePx(graphic, frame);
	const align = strokeAlignOf(graphic);
	const outerShare = { center: 0.5, inside: 0, outside: 1 }[align];
	return {
		inner: insetRoundedRect(
			box,
			radius,
			stroke.x * (1 - outerShare),
			stroke.y * (1 - outerShare)
		),
		outer: insetRoundedRect(
			box,
			radius,
			-stroke.x * outerShare,
			-stroke.y * outerShare
		),
	};
}

/**
 * The unrotated outline in pixels relative to the box's top-left corner.
 * A line is its thin stroke-colored bar through the box's middle.
 */
export function shapeOutline(graphic: ShapeGraphic, frame: FrameSize): Point[] {
	const { width, height } = graphicBoxPx(graphic, frame);
	const center = { x: width / 2, y: height / 2 };
	switch (graphic.shape) {
		case "rectangle":
			return roundedRectVertices(
				width,
				height,
				cornerRadiusOf(graphic) * Math.min(width, height)
			);
		case "ellipse":
			return ellipseVertices(width, height);
		case "triangle":
			return triangleVertices(width, height);
		case "line": {
			const thickness =
				Math.max(graphic.strokeWidth, MIN_LINE_THICKNESS) * frame.height;
			const top = height / 2 - thickness / 2;
			return [
				{ x: 0, y: top },
				{ x: width, y: top },
				{ x: width, y: top + thickness },
				{ x: 0, y: top + thickness },
			];
		}
		case "polygon":
			return regularPolygonVertices(
				sidesOf(graphic),
				center,
				width / 2,
				height / 2
			);
		case "star":
			return starVertices(
				starPointsOf(graphic),
				innerRadiusOf(graphic),
				center,
				width / 2,
				height / 2
			);
		case "heart":
			return heartVertices(width, height);
		case "arrow":
			return arrowVertices(width, height);
		default:
			return roundedRectVertices(width, height, 0);
	}
}

/** Rotates points clockwise on screen (y down) by `degrees` about `center`. */
export function rotatePoints(
	points: Point[],
	center: Point,
	degrees: number
): Point[] {
	if (degrees === 0) {
		return points.map((point) => ({ ...point }));
	}
	const radians = (degrees * Math.PI) / 180;
	const cos = Math.cos(radians);
	const sin = Math.sin(radians);
	return points.map((point) => {
		const dx = point.x - center.x;
		const dy = point.y - center.y;
		return {
			x: center.x + dx * cos - dy * sin,
			y: center.y + dx * sin + dy * cos,
		};
	});
}

/**
 * The stroke's signed-distance band: negative inside the outline, positive
 * outside. `center` straddles the edge, `inside` lies within it (the legacy
 * rectangle border) and `outside` grows the silhouette.
 */
export function strokeBand(
	align: StrokeAlign,
	width: number
): { inner: number; outer: number } {
	if (width <= 0) {
		return { inner: 0, outer: 0 };
	}
	if (align === "inside") {
		return { inner: -width, outer: 0 };
	}
	if (align === "outside") {
		return { inner: 0, outer: width };
	}
	return { inner: -width / 2, outer: width / 2 };
}

/** SVG path data for a closed polygon. */
export function svgPathData(points: Point[]): string {
	const format = (value: number) => Number(value.toFixed(3));
	return `${points
		.map(
			(point, index) =>
				`${index === 0 ? "M" : "L"}${format(point.x)} ${format(point.y)}`
		)
		.join(" ")} Z`;
}

// ---------------------------------------------------------------------------
// Signed distance and rasterization

function segmentDistance(px: number, py: number, a: Point, b: Point): number {
	const dx = b.x - a.x;
	const dy = b.y - a.y;
	const lengthSquared = dx * dx + dy * dy;
	const along =
		lengthSquared === 0
			? 0
			: Math.max(
					0,
					Math.min(1, ((px - a.x) * dx + (py - a.y) * dy) / lengthSquared)
				);
	const ex = px - (a.x + along * dx);
	const ey = py - (a.y + along * dy);
	return Math.sqrt(ex * ex + ey * ey);
}

/** Even-odd inside test. */
export function pointInPolygon(points: Point[], x: number, y: number): boolean {
	let inside = false;
	for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
		const a = points[i] as Point;
		const b = points[j] as Point;
		if (
			a.y > y !== b.y > y &&
			x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x
		) {
			inside = !inside;
		}
	}
	return inside;
}

/** Signed distance from `(x, y)` to the outline: negative inside. */
export function signedDistance(points: Point[], x: number, y: number): number {
	let distance = Number.POSITIVE_INFINITY;
	for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
		distance = Math.min(
			distance,
			segmentDistance(x, y, points[j] as Point, points[i] as Point)
		);
	}
	return pointInPolygon(points, x, y) ? -distance : distance;
}

const coverage = (distance: number, edge: number) =>
	Math.max(0, Math.min(1, 0.5 - (distance - edge)));

export type Rgb = readonly [number, number, number];

export function hexToRgb(hex: string): Rgb {
	const value = Number.parseInt(hex.slice(1), 16);
	return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

export interface RasterRequest {
	band: { inner: number; outer: number };
	fill: Rgb;
	/**
	 * Two-region paint: the fill covers this outline and the stroke the rest
	 * of `points` (`band` is then ignored). An empty outline is all stroke.
	 */
	fillPoints?: Point[];
	height: number;
	/** Multiplies the final alpha (the graphic's opacity). */
	opacity: number;
	/** Closed outline in raster pixel coordinates. */
	points: Point[];
	stroke: Rgb;
	width: number;
}

/**
 * Unsigned distance from each pixel center of row `y` to the outline, for
 * pixels within `reach`; farther pixels stay `Infinity`. Each edge only
 * visits the span of the row its capsule of radius `reach` can touch, so
 * the work grows with the perimeter times the reach, not the edge's
 * bounding box.
 */
function rowDistances(
	points: Point[],
	sampleY: number,
	reach: number,
	out: Float32Array
): void {
	out.fill(Number.POSITIVE_INFINITY);
	const last = out.length - 1;
	for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
		const a = points[j] as Point;
		const b = points[i] as Point;
		if (
			sampleY < Math.min(a.y, b.y) - reach ||
			sampleY > Math.max(a.y, b.y) + reach
		) {
			continue;
		}
		const dy = b.y - a.y;
		let fromX = Math.min(a.x, b.x);
		let toX = Math.max(a.x, b.x);
		if (Math.abs(dy) > 1e-9) {
			const t0 = Math.max(0, Math.min(1, (sampleY - reach - a.y) / dy));
			const t1 = Math.max(0, Math.min(1, (sampleY + reach - a.y) / dy));
			const x0 = a.x + t0 * (b.x - a.x);
			const x1 = a.x + t1 * (b.x - a.x);
			fromX = Math.min(x0, x1);
			toX = Math.max(x0, x1);
		}
		const from = Math.max(0, Math.floor(fromX - reach - 0.5));
		const to = Math.min(last, Math.ceil(toX + reach - 0.5));
		for (let x = from; x <= to; x++) {
			const d = segmentDistance(x + 0.5, sampleY, a, b);
			if (d < (out[x] as number)) {
				out[x] = d;
			}
		}
	}
}

/** Marks the pixel centers of row `y` inside the outline (even-odd). */
function rowInside(points: Point[], sampleY: number, out: Uint8Array): void {
	out.fill(0);
	const crossings: number[] = [];
	for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
		const a = points[i] as Point;
		const b = points[j] as Point;
		if (a.y > sampleY !== b.y > sampleY) {
			crossings.push(((b.x - a.x) * (sampleY - a.y)) / (b.y - a.y) + a.x);
		}
	}
	crossings.sort((left, right) => left - right);
	for (let k = 0; k + 1 < crossings.length; k += 2) {
		const from = Math.max(0, Math.ceil((crossings[k] as number) - 0.5));
		const to = Math.min(
			out.length - 1,
			Math.ceil((crossings[k + 1] as number) - 0.5) - 1
		);
		if (to >= from) {
			out.fill(1, from, to + 1);
		}
	}
}

/** Signed distances of row `y`: negative inside the outline. */
function rowSigned(
	points: Point[],
	sampleY: number,
	reach: number,
	distance: Float32Array,
	inside: Uint8Array
): void {
	rowDistances(points, sampleY, reach, distance);
	rowInside(points, sampleY, inside);
	for (let x = 0; x < distance.length; x++) {
		if (inside[x]) {
			distance[x] = -(distance[x] as number);
		}
	}
}

/**
 * Rasterizes the outline into straight-alpha RGBA, one row at a time. Each
 * pixel center gets a signed distance to the outline (only computed near
 * edges); fill coverage ramps across the outline and stroke coverage across
 * the band, then the stroke composites over the fill. Fully transparent
 * pixels carry the edge color so later scaling or rotation in FFmpeg does
 * not pull a dark fringe into the edge.
 */
export function rasterizeShape(request: RasterRequest): Uint8Array {
	const { width, height, points, band, fillPoints } = request;
	const pixels = new Uint8Array(width * height * 4);
	const words = new Uint32Array(pixels.buffer);
	const regions = fillPoints !== undefined;
	const hasStroke = regions || band.outer > band.inner;
	const [fr, fg, fb] = request.fill;
	const [sr, sg, sb] = request.stroke;
	const solidAlpha = Math.round(255 * request.opacity);
	const pack = (red: number, green: number, blue: number, alpha: number) =>
		new Uint32Array(new Uint8Array([red, green, blue, alpha]).buffer)[0] ?? 0;
	const solidFill = pack(fr, fg, fb, solidAlpha);
	const solidStroke = pack(sr, sg, sb, solidAlpha);
	words.fill(hasStroke ? pack(sr, sg, sb, 0) : pack(fr, fg, fb, 0));
	const reach = regions
		? 1.5
		: Math.max(Math.abs(band.inner), Math.abs(band.outer)) + 1.5;
	const outer = new Float32Array(width);
	const outerInside = new Uint8Array(width);
	const inner = new Float32Array(width);
	const innerInside = new Uint8Array(width);
	for (let y = 0; y < height; y++) {
		const sampleY = y + 0.5;
		rowSigned(points, sampleY, reach, outer, outerInside);
		if (regions) {
			if (fillPoints.length > 0) {
				rowSigned(fillPoints, sampleY, reach, inner, innerInside);
			} else {
				inner.fill(Number.POSITIVE_INFINITY);
			}
		}
		const row = y * width;
		for (let x = 0; x < width; x++) {
			const d = outer[x] as number;
			if (d === Number.POSITIVE_INFINITY) {
				continue;
			}
			const innerDistance = inner[x] as number;
			if (d === Number.NEGATIVE_INFINITY) {
				// Far from every edge, inside the silhouette.
				if (!regions || innerDistance === Number.NEGATIVE_INFINITY) {
					words[row + x] = solidFill;
					continue;
				}
				if (innerDistance === Number.POSITIVE_INFINITY) {
					words[row + x] = solidStroke;
					continue;
				}
			}
			let alpha: number;
			let fillShare: number;
			if (regions) {
				alpha = coverage(d, 0);
				fillShare = Math.min(alpha, coverage(innerDistance, 0));
			} else {
				const fillAlpha = coverage(d, 0);
				const strokeAlpha = hasStroke
					? Math.max(0, coverage(d, band.outer) - coverage(d, band.inner))
					: 0;
				alpha = strokeAlpha + fillAlpha * (1 - strokeAlpha);
				fillShare = fillAlpha * (1 - strokeAlpha);
			}
			if (alpha <= 0) {
				continue;
			}
			const fillWeight = fillShare / alpha;
			const strokeWeight = 1 - fillWeight;
			const offset = (row + x) * 4;
			pixels[offset] = Math.round(sr * strokeWeight + fr * fillWeight);
			pixels[offset + 1] = Math.round(sg * strokeWeight + fg * fillWeight);
			pixels[offset + 2] = Math.round(sb * strokeWeight + fb * fillWeight);
			pixels[offset + 3] = Math.round(
				255 * Math.min(1, alpha) * request.opacity
			);
		}
	}
	return pixels;
}

/**
 * Largest raster side rasterized in JavaScript. Bigger shapes (a full-frame
 * shape at 4K is about 4600 px square) are rasterized at this side and
 * scaled up once in FFmpeg, which bounds the synchronous work in
 * `buildRender` to roughly a 1440p frame's worth of pixels.
 */
export const MAX_RASTER_SIDE = 2560;

export interface GraphicRaster {
	/** Frame-pixel offset from the box's top-left to the raster's top-left. */
	offset: Point;
	/**
	 * Side of `pixels` (even). Equals `size` unless the raster was capped at
	 * `MAX_RASTER_SIDE`; the render then scales it up to `size`.
	 */
	pixelSize: number;
	pixels: Uint8Array;
	/** Side of the square raster in frame pixels (even, so chroma aligns). */
	size: number;
}

export interface GraphicPaint {
	/** Signed-distance stroke band (zero when `regions` paints the stroke). */
	band: { inner: number; outer: number };
	fill: string;
	/** Two-region paint of a stroked rectangle, relative to its box. */
	regions?: PaintRegions;
	stroke: string;
}

/**
 * Fill/stroke colors and stroke geometry of the graphic. A line is a filled
 * bar in the stroke color with no separate stroke; a stroked rectangle uses
 * `rectangleRegions`; every other shape a signed-distance band.
 */
export function graphicPaint(
	graphic: ShapeGraphic,
	frame: FrameSize
): GraphicPaint {
	if (graphic.shape === "line") {
		return {
			band: { inner: 0, outer: 0 },
			fill: graphic.stroke,
			stroke: graphic.stroke,
		};
	}
	const regions = rectangleRegions(graphic, frame);
	if (regions) {
		return {
			band: { inner: 0, outer: 0 },
			fill: graphic.fill,
			regions,
			stroke: graphic.stroke,
		};
	}
	return {
		band: strokeBand(strokeAlignOf(graphic), strokeWidthPx(graphic, frame)),
		fill: graphic.fill,
		stroke: graphic.stroke,
	};
}

/**
 * The graphic as a square RGBA raster centered on its box center, large
 * enough for any rotation. `rotation` is baked in (pass 0 when the render
 * rotates per frame) and `opacity` multiplies alpha (pass 1 when it is
 * keyframed). Rasters larger than `MAX_RASTER_SIDE` are drawn at that side
 * (`pixelSize`) for the render to scale up.
 */
/**
 * Half the side of the square raster that holds the graphic at any rotation
 * (see `graphicRaster`).
 */
export function graphicRasterHalf(
	graphic: ShapeGraphic,
	frame: FrameSize
): number {
	const box = graphicBoxPx(graphic, frame);
	const paint = graphicPaint(graphic, frame);
	const outline = paint.regions?.outer ?? shapeOutline(graphic, frame);
	const center = { x: box.width / 2, y: box.height / 2 };
	const radius = Math.max(
		0,
		...outline.map((point) =>
			Math.hypot(point.x - center.x, point.y - center.y)
		)
	);
	return Math.ceil(radius + Math.max(0, paint.band.outer) + RASTER_MARGIN);
}

export function graphicRaster(
	graphic: ShapeGraphic,
	frame: FrameSize,
	bake: { opacity: number; rotation: number },
	/** A larger half side, so rasters of an animated shape share one size. */
	minimumHalf = 0
): GraphicRaster {
	const box = graphicBoxPx(graphic, frame);
	const paint = graphicPaint(graphic, frame);
	const outline = paint.regions?.outer ?? shapeOutline(graphic, frame);
	const center = { x: box.width / 2, y: box.height / 2 };
	const half = Math.max(minimumHalf, graphicRasterHalf(graphic, frame));
	const size = half * 2;
	const pixelSize = Math.min(size, MAX_RASTER_SIDE);
	const scale = pixelSize / size;
	const shift = { x: half - center.x, y: half - center.y };
	const place = (points: Point[]) =>
		rotatePoints(points, center, bake.rotation).map((point) => ({
			x: (point.x + shift.x) * scale,
			y: (point.y + shift.y) * scale,
		}));
	return {
		offset: { x: -shift.x, y: -shift.y },
		pixelSize,
		pixels: rasterizeShape({
			band: {
				inner: paint.band.inner * scale,
				outer: paint.band.outer * scale,
			},
			fill: hexToRgb(paint.fill),
			fillPoints: paint.regions ? place(paint.regions.inner) : undefined,
			height: pixelSize,
			opacity: bake.opacity,
			points: place(outline),
			stroke: hexToRgb(paint.stroke),
			width: pixelSize,
		}),
		size,
	};
}

// ---------------------------------------------------------------------------
// Keyframes and entry motion

/** The un-keyframed value of a graphic property. */
export function graphicBaseValue(
	graphic: ShapeGraphic,
	property: GraphicKeyframeProperty
): number {
	switch (property) {
		case "rotation":
			return graphicRotationOf(graphic);
		case "scale":
			return 1;
		case "cornerRadius":
			return cornerRadiusOf(graphic);
		case "innerRadius":
			return innerRadiusOf(graphic);
		default:
			return graphic[property];
	}
}

/** Cubic Bezier `y` at `x` (CSS timing-function semantics), by bisection. */
export function cubicBezierAt(
	bezier: readonly [number, number, number, number],
	x: number
): number {
	const [x1, y1, x2, y2] = bezier;
	const curve = (t: number, p1: number, p2: number) =>
		3 * (1 - t) ** 2 * t * p1 + 3 * (1 - t) * t ** 2 * p2 + t ** 3;
	let low = 0;
	let high = 1;
	for (let iteration = 0; iteration < 40; iteration++) {
		const middle = (low + high) / 2;
		if (curve(middle, x1, x2) < x) {
			low = middle;
		} else {
			high = middle;
		}
	}
	return curve((low + high) / 2, y1, y2);
}

/** The eased fraction `0..1` of a segment at linear progress `p`. */
export function easedProgress(
	interpolation: KeyframeInterpolation,
	p: number,
	bezier?: readonly [number, number, number, number]
): number {
	switch (interpolation) {
		case "hold":
			return 0;
		case "ease-in":
			return p * p;
		case "ease-out":
			return 1 - (1 - p) * (1 - p);
		case "ease-in-out":
			return p * p * (3 - 2 * p);
		case "bezier": {
			if (!bezier) {
				return p;
			}
			// Sampled piecewise-linearly so the FFmpeg expression matches.
			const scaled = p * BEZIER_STEPS;
			const step = Math.min(BEZIER_STEPS - 1, Math.floor(scaled));
			const from = cubicBezierAt(bezier, step / BEZIER_STEPS);
			const to = cubicBezierAt(bezier, (step + 1) / BEZIER_STEPS);
			return from + (to - from) * (scaled - step);
		}
		default:
			return p;
	}
}

interface GraphicPoint {
	bezier?: readonly [number, number, number, number];
	interpolation: KeyframeInterpolation;
	time: number;
	value: number;
}

function graphicPoints(
	graphic: ShapeGraphic,
	property: GraphicKeyframeProperty
): GraphicPoint[] {
	const frames: GraphicPoint[] = graphicKeyframesFor(graphic, property).map(
		(keyframe) => ({
			bezier: keyframe.bezier,
			interpolation: keyframe.interpolation ?? "linear",
			time: keyframe.time,
			value: keyframe.value,
		})
	);
	if (frames.length === 0 || frames[0]?.time === 0) {
		return frames;
	}
	return [
		{
			interpolation: "linear",
			time: 0,
			value: graphicBaseValue(graphic, property),
		},
		...frames,
	];
}

/** The keyframed value at `elapsed` seconds after the graphic's start. */
export function graphicAnimatedValue(
	graphic: ShapeGraphic,
	property: GraphicKeyframeProperty,
	elapsed: number
): number {
	const points = graphicPoints(graphic, property);
	let previous = points[0];
	if (!previous) {
		return graphicBaseValue(graphic, property);
	}
	for (const next of points.slice(1)) {
		if (elapsed < next.time) {
			const p = Math.max(
				0,
				Math.min(1, (elapsed - previous.time) / (next.time - previous.time))
			);
			return (
				previous.value +
				(next.value - previous.value) *
					easedProgress(previous.interpolation, p, previous.bezier)
			);
		}
		previous = next;
	}
	return previous.value;
}

const formatNumber = (value: number): string => {
	const rounded = Number(value.toFixed(9));
	return `${Object.is(rounded, -0) ? 0 : rounded}`;
};

function easedExpression(point: GraphicPoint, progress: string): string {
	switch (point.interpolation) {
		case "hold":
			return "0";
		case "ease-in":
			return `${progress}*${progress}`;
		case "ease-out":
			return `(1-(1-${progress})*(1-${progress}))`;
		case "ease-in-out":
			return `${progress}*${progress}*(3-2*${progress})`;
		case "bezier": {
			if (!point.bezier) {
				return progress;
			}
			const bezier = point.bezier;
			let expression = formatNumber(cubicBezierAt(bezier, 1));
			for (let step = BEZIER_STEPS - 1; step >= 0; step--) {
				const from = cubicBezierAt(bezier, step / BEZIER_STEPS);
				const to = cubicBezierAt(bezier, (step + 1) / BEZIER_STEPS);
				const local = `(${progress}*${BEZIER_STEPS}-${step})`;
				const piece = `${formatNumber(from)}+(${formatNumber(to - from)})*${local}`;
				expression =
					step === BEZIER_STEPS - 1
						? piece
						: `if(lt(${progress},${formatNumber((step + 1) / BEZIER_STEPS)}),${piece},${expression})`;
			}
			return `(${expression})`;
		}
		default:
			return progress;
	}
}

/**
 * FFmpeg expression of the keyframed value. `clock` is the time since the
 * graphic's start (for example `(t-2)`); the shape matches
 * `graphicAnimatedValue` exactly.
 */
export function graphicAnimationExpression(
	graphic: ShapeGraphic,
	property: GraphicKeyframeProperty,
	clock: string
): string {
	const points = graphicPoints(graphic, property);
	let result = formatNumber(
		points.at(-1)?.value ?? graphicBaseValue(graphic, property)
	);
	for (let i = points.length - 2; i >= 0; i--) {
		const a = points[i] as GraphicPoint;
		const b = points[i + 1] as GraphicPoint;
		const span = b.time - a.time;
		const progress = `clip((${clock}-${formatNumber(a.time)})/${formatNumber(span)},0,1)`;
		result = `if(lt(${clock},${formatNumber(b.time)}),${formatNumber(a.value)}+(${formatNumber(b.value - a.value)})*${easedExpression(a, progress)},${result})`;
	}
	return result;
}

/**
 * A keyframed paint color at `elapsed`, mixed per RGB channel with the same
 * easing as the numeric channels. Before a first keyframe after zero the
 * static color eases into it.
 */
export function graphicColorValue(
	graphic: ShapeGraphic,
	property: GraphicColorKeyframeProperty,
	elapsed: number
): string {
	const keys = (graphic.keyframes ?? [])
		.filter((keyframe) => keyframe.property === property && keyframe.color)
		.sort((a, b) => a.time - b.time);
	const base = graphic[property];
	const first = keys[0];
	if (!first) {
		return base;
	}
	const points = [
		...(first.time === 0
			? []
			: [{ color: base, interpolation: undefined, time: 0 } as Keyframe]),
		...keys,
	];
	let previous = points[0] as Keyframe;
	for (const next of points.slice(1)) {
		if (elapsed < next.time) {
			const p = Math.max(
				0,
				Math.min(1, (elapsed - previous.time) / (next.time - previous.time))
			);
			return mixKeyframeColor(
				previous.color ?? base,
				next.color ?? base,
				easedProgress(previous.interpolation ?? "linear", p, previous.bezier)
			);
		}
		previous = next;
	}
	return previous.color ?? base;
}

const clampTo = (value: number, min: number, max: number) =>
	Math.min(max, Math.max(min, value));

/**
 * The graphic's drawn shape at `elapsed`: its box scaled about its center by
 * the `scale` channel, and keyframed stroke width, corner and inner radius
 * and paint colors resolved. Position, rotation and opacity stay with
 * `graphicFrameState`. Returns the graphic itself when nothing changes it.
 */
export function graphicShapeAt<Shape extends ShapeGraphic>(
	graphic: Shape,
	elapsed: number
): Shape {
	if (!hasGraphicShapeKeyframes(graphic)) {
		return graphic;
	}
	const scale = Math.max(0, graphicAnimatedValue(graphic, "scale", elapsed));
	const next: Shape = {
		...graphic,
		fill: graphicColorValue(graphic, "fill", elapsed),
		height: graphic.height * scale,
		stroke: graphicColorValue(graphic, "stroke", elapsed),
		strokeWidth: clampTo(
			graphicAnimatedValue(graphic, "strokeWidth", elapsed),
			0,
			0.08
		),
		width: graphic.width * scale,
	};
	if (hasGraphicKeyframes(graphic, "cornerRadius")) {
		next.cornerRadius = clampTo(
			graphicAnimatedValue(graphic, "cornerRadius", elapsed),
			0,
			0.5
		);
	}
	if (hasGraphicKeyframes(graphic, "innerRadius")) {
		next.innerRadius = clampTo(
			graphicAnimatedValue(graphic, "innerRadius", elapsed),
			0.1,
			0.95
		);
	}
	return next;
}

/** Entry slide offset (normalized frame units) at `elapsed`. */
export function graphicSlideOffset(
	graphic: Pick<Graphic, "animation" | "entryDuration">,
	elapsed: number
): Point {
	const progress = graphic.entryDuration
		? Math.min(1, Math.max(0, elapsed / graphic.entryDuration))
		: 1;
	const offset = (1 - progress) * 0.08;
	switch (graphic.animation) {
		case "slide-left":
			return { x: -offset, y: 0 };
		case "slide-right":
			return { x: offset, y: 0 };
		case "slide-up":
			return { x: 0, y: offset };
		case "slide-down":
			return { x: 0, y: -offset };
		default:
			return { x: 0, y: 0 };
	}
}

export interface GraphicFrameState {
	opacity: number;
	/** Clockwise degrees about the box center. */
	rotation: number;
	/** Box top-left, normalized to the frame, including the entry slide. */
	x: number;
	y: number;
}

/** Position, rotation and opacity of the graphic at absolute `time`. */
export function graphicFrameState(
	graphic: ShapeGraphic,
	time: number
): GraphicFrameState {
	const elapsed = time - graphic.start;
	const slide = graphicSlideOffset(graphic, elapsed);
	// A scaled box keeps its center: shift the top-left by the size change.
	const shrink =
		1 - Math.max(0, graphicAnimatedValue(graphic, "scale", elapsed));
	return {
		opacity: Math.max(
			0,
			Math.min(1, graphicAnimatedValue(graphic, "opacity", elapsed))
		),
		rotation: graphicAnimatedValue(graphic, "rotation", elapsed),
		x:
			graphicAnimatedValue(graphic, "x", elapsed) +
			slide.x +
			(graphic.width * shrink) / 2,
		y:
			graphicAnimatedValue(graphic, "y", elapsed) +
			slide.y +
			(graphic.height * shrink) / 2,
	};
}

/** Places box-relative points in the frame at `time` (rotation, position). */
function placeInFrame(
	points: Point[],
	graphic: ShapeGraphic,
	frame: FrameSize,
	time: number
): Point[] {
	const state = graphicFrameState(graphic, time);
	const box = graphicBoxPx(
		graphicShapeAt(graphic, time - graphic.start),
		frame
	);
	const center = { x: box.width / 2, y: box.height / 2 };
	const left = state.x * frame.width;
	const top = state.y * frame.height;
	return rotatePoints(points, center, state.rotation).map((point) => ({
		x: point.x + left,
		y: point.y + top,
	}));
}

/**
 * The outline in frame pixels at `time`: rotated about the box center and
 * placed at the animated position. The preview draws exactly this path.
 */
export function graphicFramePoints(
	graphic: ShapeGraphic,
	frame: FrameSize,
	time: number
): Point[] {
	const shape = graphicShapeAt(graphic, time - graphic.start);
	return placeInFrame(shapeOutline(shape, frame), graphic, frame, time);
}

/**
 * The two-region paint of a stroked rectangle in frame pixels at `time`
 * (see `rectangleRegions`), or undefined for every other graphic.
 */
export function graphicFrameRegions(
	graphic: ShapeGraphic,
	frame: FrameSize,
	time: number
): PaintRegions | undefined {
	const regions = rectangleRegions(
		graphicShapeAt(graphic, time - graphic.start),
		frame
	);
	if (!regions) {
		return;
	}
	return {
		inner: placeInFrame(regions.inner, graphic, frame, time),
		outer: placeInFrame(regions.outer, graphic, frame, time),
	};
}
