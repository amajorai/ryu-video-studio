import { MAX_CANVAS } from "./limits.ts";

/**
 * Raster toolkit (W1-R1). Turns vector shapes (polygons, ellipses, rounded
 * rectangles, stars, hearts and cubic Bezier paths) into anti-aliased 8-bit
 * coverage masks with exact 4x4 supersampling, plus the small set of mask
 * operations (combine, invert, opacity, colorize) that masks, shapes and
 * region trackers need before the sidecar encodes them as PNG inputs.
 *
 * Every function is pure and deterministic, depends on no DOM or runtime API,
 * and works in pixel space with `y` growing downward. Rotations are degrees,
 * clockwise on screen (matching CSS `rotate()` and FFmpeg `rotate`).
 */

/** Sub-samples per pixel edge; each pixel averages 4 x 4 = 16 samples. */
export const RASTER_SUPERSAMPLE = 4;
/** Longest raster edge: masks may render at twice the largest canvas. */
export const MAX_RASTER_EDGE = MAX_CANVAS * 2;
/** Pixel budget of one raster (one byte per pixel for alpha masks). */
export const MAX_RASTER_PIXELS = MAX_CANVAS * MAX_CANVAS;
/** Vertex budget across every contour of one rasterization. */
export const MAX_RASTER_VERTICES = 1 << 20;
/** Most sides of a regular polygon or tips of a star. */
export const MAX_SHAPE_SIDES = 1024;
/** Largest distance, in pixels, between a curve and its flattened chords. */
export const FLATTEN_TOLERANCE = 0.1;

const SAMPLES_PER_PIXEL = RASTER_SUPERSAMPLE * RASTER_SUPERSAMPLE;
/** Covered sample count (0..16) to a rounded 0..255 coverage byte. */
const COVERAGE_TO_ALPHA = Uint8Array.from(
	{ length: SAMPLES_PER_PIXEL + 1 },
	(_, covered) => Math.round((covered * 255) / SAMPLES_PER_PIXEL)
);
const MAX_CURVE_STEPS = 1024;
const MIN_ELLIPSE_STEPS = 16;
const MAX_ELLIPSE_STEPS = 4096;

export interface RasterPoint {
	readonly x: number;
	readonly y: number;
}

/** A closed polygon; the last vertex joins back to the first. */
export type Contour = readonly RasterPoint[];

export type FillRule = "nonzero" | "evenodd";

/** One coverage byte per pixel, row-major, 0 = empty and 255 = covered. */
export interface AlphaRaster {
	readonly data: Uint8Array;
	readonly height: number;
	readonly width: number;
}

/** Four straight (non-premultiplied) RGBA bytes per pixel, row-major. */
export interface RgbaRaster {
	readonly data: Uint8Array;
	readonly height: number;
	readonly width: number;
}

/**
 * A vertex of a Bezier path. Handles are absolute positions; a missing handle
 * sits on its vertex, so a segment whose two handles are both missing is a
 * straight line.
 */
export interface RasterPathPoint {
	readonly inX?: number;
	readonly inY?: number;
	readonly outX?: number;
	readonly outY?: number;
	readonly x: number;
	readonly y: number;
}

/** Shapes are centered on `cx`/`cy` and rotate about that center. */
interface CenteredShape {
	readonly cx: number;
	readonly cy: number;
	readonly rotation?: number;
}

export type RasterShape =
	| { readonly kind: "polygon"; readonly points: readonly RasterPoint[] }
	| (CenteredShape & {
			readonly kind: "regular-polygon";
			/** Horizontal and vertical circumradius. */
			readonly rx: number;
			readonly ry: number;
			readonly sides: number;
	  })
	| (CenteredShape & {
			readonly kind: "ellipse";
			readonly rx: number;
			readonly ry: number;
	  })
	| (CenteredShape & {
			readonly kind: "rounded-rect";
			readonly height: number;
			/** Corner radius in pixels, clamped to half the shorter side. */
			readonly radius: number;
			readonly width: number;
	  })
	| (CenteredShape & {
			/** Inner vertex radius as a fraction of the outer radius. */
			readonly innerRadius: number;
			readonly kind: "star";
			readonly points: number;
			readonly rx: number;
			readonly ry: number;
	  })
	| (CenteredShape & {
			readonly height: number;
			readonly kind: "heart";
			readonly width: number;
	  })
	| { readonly kind: "path"; readonly points: readonly RasterPathPoint[] };

export interface RasterizeOptions {
	/** Winding rule for overlapping or nested contours (default `nonzero`). */
	fillRule?: FillRule;
}

export interface RgbaColor {
	/** 0..255, default 255. */
	readonly a?: number;
	readonly b: number;
	readonly g: number;
	readonly r: number;
}

export type AlphaCombineMode =
	/** Coverage of either mask (`max`). */
	| "union"
	/** Coverage of both masks (`min`). */
	| "intersect"
	/** Product of the two coverages (stacked masks). */
	| "multiply"
	/** First mask with the second cut away (`a * (1 - b)`). */
	| "subtract";

function assertFinite(value: number, label: string): void {
	if (!Number.isFinite(value)) {
		throw new RangeError(`${label} must be a finite number.`);
	}
}

function assertPositive(value: number, label: string): void {
	assertFinite(value, label);
	if (value < 0) {
		throw new RangeError(`${label} must not be negative.`);
	}
}

/** Rejects geometry before it is built once it would exceed the budget. */
function assertVertexBudget(count: number): void {
	if (count > MAX_RASTER_VERTICES) {
		throw new RangeError(
			`Rasterization is limited to ${MAX_RASTER_VERTICES} vertices.`
		);
	}
}

function assertSideCount(value: number, minimum: number, label: string): void {
	if (!Number.isInteger(value) || value < minimum || value > MAX_SHAPE_SIDES) {
		throw new RangeError(
			`${label} must be an integer from ${minimum} to ${MAX_SHAPE_SIDES}.`
		);
	}
}

function assertSize(width: number, height: number): void {
	for (const [value, label] of [
		[width, "Raster width"],
		[height, "Raster height"],
	] as const) {
		if (!Number.isInteger(value) || value < 1 || value > MAX_RASTER_EDGE) {
			throw new RangeError(
				`${label} must be an integer from 1 to ${MAX_RASTER_EDGE}.`
			);
		}
	}
	if (width * height > MAX_RASTER_PIXELS) {
		throw new RangeError(`Rasters are limited to ${MAX_RASTER_PIXELS} pixels.`);
	}
}

/** Shoelace area; positive when the contour runs clockwise on screen. */
export function contourArea(contour: Contour): number {
	let twice = 0;
	for (let index = 0; index < contour.length; index += 1) {
		const current = contour[index];
		const next = contour[(index + 1) % contour.length];
		if (current && next) {
			twice += current.x * next.y - next.x * current.y;
		}
	}
	return twice / 2;
}

/** Rotates a contour by `degrees` (clockwise on screen) about `cx`/`cy`. */
export function rotateContour(
	contour: Contour,
	cx: number,
	cy: number,
	degrees: number
): RasterPoint[] {
	assertFinite(degrees, "Rotation");
	if (degrees % 360 === 0) {
		return contour.map((point) => ({ x: point.x, y: point.y }));
	}
	const radians = (degrees * Math.PI) / 180;
	const cos = Math.cos(radians);
	const sin = Math.sin(radians);
	return contour.map((point) => {
		const dx = point.x - cx;
		const dy = point.y - cy;
		return { x: cx + dx * cos - dy * sin, y: cy + dx * sin + dy * cos };
	});
}

/** Chord count that keeps an arc of `radius` within the flatten tolerance. */
function arcSteps(radius: number, sweep: number, minimum: number): number {
	if (radius <= FLATTEN_TOLERANCE) {
		return minimum;
	}
	const step = 2 * Math.acos(1 - FLATTEN_TOLERANCE / radius);
	return Math.min(
		MAX_ELLIPSE_STEPS,
		Math.max(minimum, Math.ceil(sweep / step))
	);
}

function ellipseContour(
	cx: number,
	cy: number,
	rx: number,
	ry: number
): RasterPoint[] {
	const steps = arcSteps(Math.max(rx, ry), 2 * Math.PI, MIN_ELLIPSE_STEPS);
	const points: RasterPoint[] = [];
	for (let index = 0; index < steps; index += 1) {
		const angle = (index / steps) * 2 * Math.PI - Math.PI / 2;
		points.push({
			x: cx + rx * Math.cos(angle),
			y: cy + ry * Math.sin(angle),
		});
	}
	return points;
}

/** Vertices of a regular polygon whose first vertex points straight up. */
function regularPolygonContour(
	cx: number,
	cy: number,
	rx: number,
	ry: number,
	sides: number
): RasterPoint[] {
	const points: RasterPoint[] = [];
	for (let index = 0; index < sides; index += 1) {
		const angle = (index / sides) * 2 * Math.PI - Math.PI / 2;
		points.push({
			x: cx + rx * Math.cos(angle),
			y: cy + ry * Math.sin(angle),
		});
	}
	return points;
}

/** Alternating outer and inner vertices, the first outer tip pointing up. */
function starContour(
	cx: number,
	cy: number,
	rx: number,
	ry: number,
	tips: number,
	innerRadius: number
): RasterPoint[] {
	const points: RasterPoint[] = [];
	for (let index = 0; index < tips * 2; index += 1) {
		const angle = (index / tips) * Math.PI - Math.PI / 2;
		const factor = index % 2 === 0 ? 1 : innerRadius;
		points.push({
			x: cx + rx * factor * Math.cos(angle),
			y: cy + ry * factor * Math.sin(angle),
		});
	}
	return points;
}

function roundedRectContour(
	cx: number,
	cy: number,
	width: number,
	height: number,
	radius: number
): RasterPoint[] {
	const left = cx - width / 2;
	const top = cy - height / 2;
	const right = left + width;
	const bottom = top + height;
	const corner = Math.min(radius, width / 2, height / 2);
	if (corner <= 0) {
		return [
			{ x: left, y: top },
			{ x: right, y: top },
			{ x: right, y: bottom },
			{ x: left, y: bottom },
		];
	}
	const steps = arcSteps(corner, Math.PI / 2, 2);
	// Corner centers clockwise from top-right, each with its arc start angle.
	const corners: [number, number, number][] = [
		[right - corner, top + corner, -Math.PI / 2],
		[right - corner, bottom - corner, 0],
		[left + corner, bottom - corner, Math.PI / 2],
		[left + corner, top + corner, Math.PI],
	];
	const points: RasterPoint[] = [];
	for (const [centerX, centerY, start] of corners) {
		for (let index = 0; index <= steps; index += 1) {
			const angle = start + (index / steps) * (Math.PI / 2);
			points.push({
				x: centerX + corner * Math.cos(angle),
				y: centerY + corner * Math.sin(angle),
			});
		}
	}
	return points;
}

/**
 * Unit heart outline as a closed cubic Bezier path: the lobes touch the top
 * of a 1 x 1 box centered on the origin and the tip touches its bottom.
 */
const UNIT_HEART: readonly RasterPathPoint[] = [
	{ x: 0, y: 0.5, inX: 0.3, inY: 0.2778, outX: -0.3, outY: 0.2778 },
	{ x: -0.5, y: -0.1667, inX: -0.5, inY: 0.0556, outX: -0.5, outY: -0.3889 },
	{ x: -0.2, y: -0.5, inX: -0.35, inY: -0.5, outX: -0.1, outY: -0.5 },
	{ x: 0, y: -0.3333, inX: -0.02, inY: -0.4333, outX: 0.02, outY: -0.4333 },
	{ x: 0.2, y: -0.5, inX: 0.1, inY: -0.5, outX: 0.35, outY: -0.5 },
	{ x: 0.5, y: -0.1667, inX: 0.5, inY: -0.3889, outX: 0.5, outY: 0.0556 },
];

/** The heart's Bezier path scaled into a `width` x `height` box at `cx`/`cy`. */
export function heartPath(
	cx: number,
	cy: number,
	width: number,
	height: number
): RasterPathPoint[] {
	const map = (x: number | undefined, y: number | undefined) =>
		x === undefined || y === undefined
			? undefined
			: { x: cx + x * width, y: cy + y * height };
	return UNIT_HEART.map((point) => {
		const handleIn = map(point.inX, point.inY);
		const handleOut = map(point.outX, point.outY);
		return {
			x: cx + point.x * width,
			y: cy + point.y * height,
			...(handleIn ? { inX: handleIn.x, inY: handleIn.y } : {}),
			...(handleOut ? { outX: handleOut.x, outY: handleOut.y } : {}),
		};
	});
}

function cubicSteps(
	p0: RasterPoint,
	p1: RasterPoint,
	p2: RasterPoint,
	p3: RasterPoint
): number {
	// Wang's bound: n = sqrt(3 * 2 / 8 * M / tolerance) chords suffice, where
	// M is the largest second difference of the control polygon.
	const second = Math.max(
		Math.hypot(p0.x - 2 * p1.x + p2.x, p0.y - 2 * p1.y + p2.y),
		Math.hypot(p1.x - 2 * p2.x + p3.x, p1.y - 2 * p2.y + p3.y)
	);
	return Math.min(
		MAX_CURVE_STEPS,
		Math.max(1, Math.ceil(Math.sqrt((0.75 * second) / FLATTEN_TOLERANCE)))
	);
}

/** Flattens a closed Bezier path into one polygon within the tolerance. */
export function flattenPath(points: readonly RasterPathPoint[]): RasterPoint[] {
	assertVertexBudget(points.length);
	const contour: RasterPoint[] = [];
	for (let index = 0; index < points.length; index += 1) {
		const from = points[index];
		const to = points[(index + 1) % points.length];
		if (!(from && to)) {
			continue;
		}
		assertFinite(from.x, "Path x");
		assertFinite(from.y, "Path y");
		contour.push({ x: from.x, y: from.y });
		const c1 = { x: from.outX ?? from.x, y: from.outY ?? from.y };
		const c2 = { x: to.inX ?? to.x, y: to.inY ?? to.y };
		for (const value of [c1.x, c1.y, c2.x, c2.y]) {
			assertFinite(value, "Path handle");
		}
		const straight =
			c1.x === from.x && c1.y === from.y && c2.x === to.x && c2.y === to.y;
		if (straight) {
			continue;
		}
		const steps = cubicSteps(from, c1, c2, to);
		// Remaining vertices count at least one each, so a path that cannot
		// fit stops here instead of after every curve is flattened.
		assertVertexBudget(
			contour.length + steps - 1 + (points.length - index - 1)
		);
		for (let step = 1; step < steps; step += 1) {
			const t = step / steps;
			const u = 1 - t;
			const a = u * u * u;
			const b = 3 * u * u * t;
			const c = 3 * u * t * t;
			const d = t * t * t;
			contour.push({
				x: a * from.x + b * c1.x + c * c2.x + d * to.x,
				y: a * from.y + b * c1.y + c * c2.y + d * to.y,
			});
		}
	}
	return contour;
}

function rotated(contour: RasterPoint[], shape: CenteredShape): RasterPoint[] {
	return shape.rotation
		? rotateContour(contour, shape.cx, shape.cy, shape.rotation)
		: contour;
}

function assertCentered(shape: CenteredShape): void {
	assertFinite(shape.cx, "Shape center x");
	assertFinite(shape.cy, "Shape center y");
	assertFinite(shape.rotation ?? 0, "Shape rotation");
}

/**
 * Flattens a shape into closed polygons in pixel space. Contours of one shape
 * all run in the same direction, so any fill rule gives the same result.
 */
export function shapeContours(shape: RasterShape): RasterPoint[][] {
	switch (shape.kind) {
		case "polygon":
			assertVertexBudget(shape.points.length);
			for (const point of shape.points) {
				assertFinite(point.x, "Polygon x");
				assertFinite(point.y, "Polygon y");
			}
			return [shape.points.map((point) => ({ x: point.x, y: point.y }))];
		case "path":
			return [flattenPath(shape.points)];
		case "regular-polygon":
			assertCentered(shape);
			assertPositive(shape.rx, "Polygon radius");
			assertPositive(shape.ry, "Polygon radius");
			assertSideCount(shape.sides, 3, "Polygon sides");
			return [
				rotated(
					regularPolygonContour(
						shape.cx,
						shape.cy,
						shape.rx,
						shape.ry,
						shape.sides
					),
					shape
				),
			];
		case "ellipse":
			assertCentered(shape);
			assertPositive(shape.rx, "Ellipse radius");
			assertPositive(shape.ry, "Ellipse radius");
			return [
				rotated(ellipseContour(shape.cx, shape.cy, shape.rx, shape.ry), shape),
			];
		case "rounded-rect":
			assertCentered(shape);
			assertPositive(shape.width, "Rectangle width");
			assertPositive(shape.height, "Rectangle height");
			assertPositive(shape.radius, "Corner radius");
			return [
				rotated(
					roundedRectContour(
						shape.cx,
						shape.cy,
						shape.width,
						shape.height,
						shape.radius
					),
					shape
				),
			];
		case "star":
			assertCentered(shape);
			assertPositive(shape.rx, "Star radius");
			assertPositive(shape.ry, "Star radius");
			assertPositive(shape.innerRadius, "Star inner radius");
			assertSideCount(shape.points, 2, "Star points");
			return [
				rotated(
					starContour(
						shape.cx,
						shape.cy,
						shape.rx,
						shape.ry,
						shape.points,
						shape.innerRadius
					),
					shape
				),
			];
		case "heart":
			assertCentered(shape);
			assertPositive(shape.width, "Heart width");
			assertPositive(shape.height, "Heart height");
			return [
				rotated(
					flattenPath(heartPath(shape.cx, shape.cy, shape.width, shape.height)),
					shape
				),
			];
		default: {
			const unknown: never = shape;
			throw new RangeError(`Unknown raster shape ${String(unknown)}.`);
		}
	}
}

function clockwise(contour: RasterPoint[]): RasterPoint[] {
	return contourArea(contour) < 0 ? contour.reverse() : contour;
}

/**
 * Outline of `contour` as polygons to fill with the `nonzero` rule: a
 * `width`-wide band centered on every edge with round joins (and round caps
 * when `closed` is false). Every polygon runs clockwise, so the union is
 * exact under `nonzero`. Inside or outside alignment is the band at twice
 * the width intersected with, or subtracted from, the shape's own fill.
 */
export function strokeContour(
	contour: Contour,
	width: number,
	{ closed = true }: { closed?: boolean } = {}
): RasterPoint[][] {
	assertPositive(width, "Stroke width");
	const half = width / 2;
	if (half === 0 || contour.length === 0) {
		return [];
	}
	const edgeCount = closed ? contour.length : contour.length - 1;
	// Every join is the same round cap, so the output size is known up front:
	// four vertices per edge band plus one cap outline per vertex.
	const capSteps = arcSteps(half, 2 * Math.PI, MIN_ELLIPSE_STEPS);
	assertVertexBudget(edgeCount * 4 + contour.length * capSteps);
	const polygons: RasterPoint[][] = [];
	for (let index = 0; index < edgeCount; index += 1) {
		const from = contour[index];
		const to = contour[(index + 1) % contour.length];
		if (!(from && to)) {
			continue;
		}
		const length = Math.hypot(to.x - from.x, to.y - from.y);
		if (length === 0) {
			continue;
		}
		const nx = (-(to.y - from.y) / length) * half;
		const ny = ((to.x - from.x) / length) * half;
		polygons.push(
			clockwise([
				{ x: from.x + nx, y: from.y + ny },
				{ x: to.x + nx, y: to.y + ny },
				{ x: to.x - nx, y: to.y - ny },
				{ x: from.x - nx, y: from.y - ny },
			])
		);
	}
	for (const point of contour) {
		polygons.push(clockwise(ellipseContour(point.x, point.y, half, half)));
	}
	return polygons;
}

interface Edge {
	readonly direction: 1 | -1;
	readonly slope: number;
	readonly x0: number;
	readonly y0: number;
	readonly yBottom: number;
	readonly yTop: number;
}

function collectEdges(contours: readonly Contour[]): Edge[] {
	const edges: Edge[] = [];
	let vertices = 0;
	for (const contour of contours) {
		vertices += contour.length;
		assertVertexBudget(vertices);
		for (let index = 0; index < contour.length; index += 1) {
			const from = contour[index];
			const to = contour[(index + 1) % contour.length];
			if (!(from && to)) {
				continue;
			}
			for (const value of [from.x, from.y]) {
				assertFinite(value, "Contour coordinate");
			}
			if (from.y === to.y) {
				continue;
			}
			// Finite vertices can still span more than Number.MAX_VALUE, which
			// would make the edge's extent or slope overflow to Infinity and
			// poison every crossing with NaN.
			const dx = to.x - from.x;
			const dy = to.y - from.y;
			const slope = dx / dy;
			if (
				!(Number.isFinite(dx) && Number.isFinite(dy) && Number.isFinite(slope))
			) {
				throw new RangeError("Contour edge extent must be finite.");
			}
			const down = to.y > from.y;
			edges.push({
				direction: down ? 1 : -1,
				slope,
				x0: from.x,
				y0: from.y,
				yBottom: down ? to.y : from.y,
				yTop: down ? from.y : to.y,
			});
		}
	}
	return edges.sort((left, right) => left.yTop - right.yTop);
}

/**
 * Rasterizes closed contours into an anti-aliased coverage mask. Each pixel
 * holds the share of its 16 sample points (a 4 x 4 grid at sub-pixel
 * centers) inside the fill, rounded to 0..255. Geometry outside the raster
 * is clipped.
 */
export function rasterizeContours(
	contours: readonly Contour[],
	width: number,
	height: number,
	{ fillRule = "nonzero" }: RasterizeOptions = {}
): AlphaRaster {
	assertSize(width, height);
	const data = new Uint8Array(width * height);
	const edges = collectEdges(contours);
	if (edges.length === 0) {
		return { data, height, width };
	}
	let minX = Number.POSITIVE_INFINITY;
	let maxX = Number.NEGATIVE_INFINITY;
	let minY = Number.POSITIVE_INFINITY;
	let maxY = Number.NEGATIVE_INFINITY;
	for (const edge of edges) {
		const x1 = edge.x0 + edge.slope * (edge.yTop - edge.y0);
		const x2 = edge.x0 + edge.slope * (edge.yBottom - edge.y0);
		minX = Math.min(minX, x1, x2);
		maxX = Math.max(maxX, x1, x2);
		minY = Math.min(minY, edge.yTop);
		maxY = Math.max(maxY, edge.yBottom);
	}
	const columnStart = Math.max(0, Math.min(width, Math.floor(minX)));
	const columnEnd = Math.max(0, Math.min(width, Math.ceil(maxX)));
	const rowStart = Math.max(0, Math.min(height, Math.floor(minY)));
	const rowEnd = Math.max(0, Math.min(height, Math.ceil(maxY)));
	if (columnEnd <= columnStart || rowEnd <= rowStart) {
		return { data, height, width };
	}
	const sampleStart = columnStart * RASTER_SUPERSAMPLE;
	const sampleEnd = columnEnd * RASTER_SUPERSAMPLE;
	// Difference array over sub-columns, accumulated across a pixel row's
	// sub-rows; a running sum then gives the samples covered per sub-column.
	const deltas = new Int32Array(sampleEnd - sampleStart + 1);
	const columnCount = columnEnd - columnStart;
	const active: Edge[] = [];
	const crossings: { direction: number; x: number }[] = [];
	let nextEdge = 0;
	const evenOdd = fillRule === "evenodd";

	const addSpan = (left: number, right: number) => {
		const first = Math.max(
			sampleStart,
			Math.ceil(left * RASTER_SUPERSAMPLE - 0.5)
		);
		const last = Math.min(
			sampleEnd,
			Math.ceil(right * RASTER_SUPERSAMPLE - 0.5)
		);
		if (last > first) {
			deltas[first - sampleStart] = (deltas[first - sampleStart] ?? 0) + 1;
			deltas[last - sampleStart] = (deltas[last - sampleStart] ?? 0) - 1;
		}
	};

	for (let row = rowStart; row < rowEnd; row += 1) {
		for (let sub = 0; sub < RASTER_SUPERSAMPLE; sub += 1) {
			const sampleY = row + (sub + 0.5) / RASTER_SUPERSAMPLE;
			while (nextEdge < edges.length) {
				const edge = edges[nextEdge];
				if (!edge || edge.yTop > sampleY) {
					break;
				}
				active.push(edge);
				nextEdge += 1;
			}
			crossings.length = 0;
			let keep = 0;
			for (const edge of active) {
				if (edge.yBottom <= sampleY) {
					continue;
				}
				active[keep] = edge;
				keep += 1;
				if (edge.yTop <= sampleY) {
					crossings.push({
						direction: edge.direction,
						x: edge.x0 + edge.slope * (sampleY - edge.y0),
					});
				}
			}
			active.length = keep;
			crossings.sort((left, right) => left.x - right.x);
			let winding = 0;
			for (let index = 0; index < crossings.length; index += 1) {
				const crossing = crossings[index];
				if (!crossing) {
					continue;
				}
				const wasInside = evenOdd ? winding % 2 !== 0 : winding !== 0;
				winding += evenOdd ? 1 : crossing.direction;
				const isInside = evenOdd ? winding % 2 !== 0 : winding !== 0;
				if (isInside && !wasInside) {
					// Find where this span ends to emit it in one step.
					let end = index + 1;
					let spanWinding = winding;
					for (; end < crossings.length; end += 1) {
						spanWinding += evenOdd ? 1 : (crossings[end]?.direction ?? 0);
						const inside = evenOdd ? spanWinding % 2 !== 0 : spanWinding !== 0;
						if (!inside) {
							break;
						}
					}
					const right = crossings[end]?.x ?? Number.POSITIVE_INFINITY;
					addSpan(crossing.x, right);
					winding = spanWinding;
					index = end;
				}
			}
		}
		let running = 0;
		let sample = 0;
		const offset = row * width + columnStart;
		for (let column = 0; column < columnCount; column += 1) {
			let covered = 0;
			for (let sub = 0; sub < RASTER_SUPERSAMPLE; sub += 1) {
				running += deltas[sample] as number;
				deltas[sample] = 0;
				covered += running;
				sample += 1;
			}
			data[offset + column] = COVERAGE_TO_ALPHA[covered] as number;
		}
		deltas[sample] = 0;
	}
	return { data, height, width };
}

/** Rasterizes one shape into a coverage mask of `width` x `height`. */
export function rasterizeShape(
	shape: RasterShape,
	width: number,
	height: number,
	options: RasterizeOptions = {}
): AlphaRaster {
	return rasterizeContours(shapeContours(shape), width, height, options);
}

function assertSameSize(left: AlphaRaster, right: AlphaRaster): void {
	if (left.width !== right.width || left.height !== right.height) {
		throw new RangeError("Masks must share a size to be combined.");
	}
}

/** Combines two equally sized masks pixel by pixel. */
export function combineAlpha(
	left: AlphaRaster,
	right: AlphaRaster,
	mode: AlphaCombineMode
): AlphaRaster {
	assertSameSize(left, right);
	const data = new Uint8Array(left.data.length);
	for (let index = 0; index < data.length; index += 1) {
		const a = left.data[index] ?? 0;
		const b = right.data[index] ?? 0;
		switch (mode) {
			case "union":
				data[index] = Math.max(a, b);
				break;
			case "intersect":
				data[index] = Math.min(a, b);
				break;
			case "multiply":
				data[index] = Math.round((a * b) / 255);
				break;
			case "subtract":
				data[index] = Math.round((a * (255 - b)) / 255);
				break;
			default: {
				const unknown: never = mode;
				throw new RangeError(`Unknown combine mode ${String(unknown)}.`);
			}
		}
	}
	return { data, height: left.height, width: left.width };
}

/** Inverts coverage (`255 - alpha`), as an inverted mask needs. */
export function invertAlpha(mask: AlphaRaster): AlphaRaster {
	const data = new Uint8Array(mask.data.length);
	for (let index = 0; index < data.length; index += 1) {
		data[index] = 255 - (mask.data[index] ?? 0);
	}
	return { data, height: mask.height, width: mask.width };
}

/** Scales coverage by `opacity` (0..1). */
export function scaleAlpha(mask: AlphaRaster, opacity: number): AlphaRaster {
	assertFinite(opacity, "Opacity");
	const factor = Math.min(1, Math.max(0, opacity));
	const data = new Uint8Array(mask.data.length);
	for (let index = 0; index < data.length; index += 1) {
		data[index] = Math.round((mask.data[index] ?? 0) * factor);
	}
	return { data, height: mask.height, width: mask.width };
}

function channel(value: number, label: string): number {
	assertFinite(value, label);
	return Math.min(255, Math.max(0, Math.round(value)));
}

/** Paints `color` through a mask into straight-alpha RGBA. */
export function alphaToRgba(mask: AlphaRaster, color: RgbaColor): RgbaRaster {
	const r = channel(color.r, "Red");
	const g = channel(color.g, "Green");
	const b = channel(color.b, "Blue");
	const a = channel(color.a ?? 255, "Alpha");
	const data = new Uint8Array(mask.data.length * 4);
	for (let index = 0; index < mask.data.length; index += 1) {
		const offset = index * 4;
		data[offset] = r;
		data[offset + 1] = g;
		data[offset + 2] = b;
		data[offset + 3] = Math.round(((mask.data[index] ?? 0) * a) / 255);
	}
	return { data, height: mask.height, width: mask.width };
}

/** Parses `#rrggbb` (the schema's color form) into an opaque color. */
export function hexColor(hex: string): RgbaColor {
	const match = /^#([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})$/.exec(hex);
	if (!match) {
		throw new RangeError("Colors must be #rrggbb.");
	}
	return {
		b: Number.parseInt(match[3] ?? "0", 16),
		g: Number.parseInt(match[2] ?? "0", 16),
		r: Number.parseInt(match[1] ?? "0", 16),
	};
}

/** Covered area in square pixels (the sum of coverage divided by 255). */
export function alphaArea(mask: AlphaRaster): number {
	let total = 0;
	for (const value of mask.data) {
		total += value;
	}
	return total / 255;
}

const svgNumber = (value: number) =>
	String(Math.round(value * 1000) / 1000).replace(/^-0$/, "0");

/**
 * SVG path data for the same flattened contours the rasterizer fills, so a
 * CSS or SVG preview matches the rendered mask exactly.
 */
export function contoursToSvgPath(contours: readonly Contour[]): string {
	return contours
		.filter((contour) => contour.length > 0)
		.map(
			(contour) =>
				`M${contour.map((point) => `${svgNumber(point.x)} ${svgNumber(point.y)}`).join("L")}Z`
		)
		.join("");
}
