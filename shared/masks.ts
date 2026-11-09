/**
 * Clip masks (W2-V3): shape geometry, the pure reference coverage used by
 * tests, animated values, inspector edits and the preview SVG. The render
 * stage (`sidecar/src/render-stages/mask.ts`) builds FFmpeg expressions from
 * the same formulas, so preview, render and tests agree on every shape.
 *
 * Coordinates: a mask is placed in the clip frame (after crop, before the
 * clip's own scale and rotation). `x`/`y` put its center in `-1..1` across the
 * frame, `width`/`height` are fractions of the frame, and `rotation` turns it
 * clockwise in pixel space. Shape outlines and freeform paths are expressed in
 * the mask's own box, `-1..1` on both axes with `y` pointing down.
 */
import { animatedValue } from "./animation.ts";
import type { Segment } from "./project.ts";
import {
	defaultMask,
	MAX_CLIP_MASKS,
	type Mask,
	type MaskPathPoint,
	type MaskShape,
	type MaskStrokeAlign,
	maskSchema,
	maskShapeSchema,
} from "./schema/mask.ts";
import type { FontFamily } from "./schema/text-style.ts";

export type { Mask, MaskShape, MaskStrokeAlign };
export { defaultMask, MAX_CLIP_MASKS };

export const maskShapes = maskShapeSchema.options;

export const maskShapeLabels: Record<MaskShape, string> = {
	rectangle: "Rectangle",
	ellipse: "Ellipse",
	linear: "Linear",
	mirror: "Mirror",
	polygon: "Polygon",
	star: "Star",
	heart: "Heart",
	text: "Text",
	freeform: "Freeform",
};

export const isMaskShape = (value: string): value is MaskShape =>
	(maskShapes as readonly string[]).includes(value);

/** Shapes whose feather is an analytic gradient instead of a blur. */
export const rampMaskShapes: ReadonlySet<MaskShape> = new Set([
	"linear",
	"mirror",
]);

/** Feather 1 blurs with a sigma of a tenth of the frame's shorter side. */
export const MASK_FEATHER_SIGMA_SCALE = 0.1;

/** Gaussian sigma in pixels for a feather on a `width`×`height` frame. */
export function maskFeatherSigma(
	feather: number,
	width: number,
	height: number
): number {
	return feather * Math.min(width, height) * MASK_FEATHER_SIGMA_SCALE;
}

/**
 * Width in pixels of the soft edge of linear and mirror masks: four sigmas,
 * never below one pixel so a hard edge stays anti-aliased.
 */
export function maskRampWidth(
	feather: number,
	width: number,
	height: number
): number {
	return Math.max(1, 4 * maskFeatherSigma(feather, width, height));
}

// ---------------------------------------------------------------------------
// Animated geometry

/** Mask fields a keyframe can drive, with the keyframe property for each. */
export const maskAnimatedFields = [
	["x", "maskX"],
	["y", "maskY"],
	["width", "maskWidth"],
	["height", "maskHeight"],
	["rotation", "maskRotation"],
	["feather", "maskFeather"],
] as const;
export type MaskAnimatedField = (typeof maskAnimatedFields)[number][0];
export type MaskKeyframeProperty = (typeof maskAnimatedFields)[number][1];

export const maskKeyframePropertyOf = Object.fromEntries(
	maskAnimatedFields
) as Record<MaskAnimatedField, MaskKeyframeProperty>;

/** Whether any keyframe on the clip drives `field` of this mask. */
export function maskFieldAnimated(
	segment: Pick<Segment, "keyframes">,
	mask: Pick<Mask, "id">,
	field: MaskAnimatedField
): boolean {
	const property = maskKeyframePropertyOf[field];
	return segment.keyframes.some(
		(frame) => frame.property === property && frame.target === mask.id
	);
}

/** Whether any keyframe on the clip drives this mask. */
export function maskAnimated(
	segment: Pick<Segment, "keyframes">,
	mask: Pick<Mask, "id">
): boolean {
	return maskAnimatedFields.some(([field]) =>
		maskFieldAnimated(segment, mask, field)
	);
}

/** The mask with its keyframed fields evaluated `elapsed` seconds into the clip. */
export function maskAt(segment: Segment, mask: Mask, elapsed: number): Mask {
	let resolved = mask;
	for (const [field, property] of maskAnimatedFields) {
		if (maskFieldAnimated(segment, mask, field)) {
			resolved = {
				...resolved,
				[field]: animatedValue(segment, property, elapsed, mask.id),
			};
		}
	}
	return resolved;
}

/** The clip's masks at `elapsed`; empty when it has none. */
export function segmentMasksAt(segment: Segment, elapsed: number): Mask[] {
	return (segment.masks ?? []).map((mask) => maskAt(segment, mask, elapsed));
}

// ---------------------------------------------------------------------------
// Outlines

export interface MaskPoint {
	x: number;
	y: number;
}

/** Curve steps per freeform edge that has a Bezier handle. */
export const FREEFORM_CURVE_STEPS = 8;
const HEART_SAMPLES = 48;

/** Vertices of a regular polygon with its first vertex at the top. */
export function polygonOutline(sides: number): MaskPoint[] {
	return Array.from({ length: sides }, (_, index) => {
		const angle = -Math.PI / 2 + (index * 2 * Math.PI) / sides;
		return { x: Math.cos(angle), y: Math.sin(angle) };
	});
}

/** Alternating outer and inner vertices of a star with its first point at the top. */
export function starOutline(points: number, innerRadius: number): MaskPoint[] {
	return Array.from({ length: points * 2 }, (_, index) => {
		const radius = index % 2 === 0 ? 1 : innerRadius;
		const angle = -Math.PI / 2 + (index * Math.PI) / points;
		return { x: radius * Math.cos(angle), y: radius * Math.sin(angle) };
	});
}

function computeHeartOutline(): MaskPoint[] {
	const raw = Array.from({ length: HEART_SAMPLES }, (_, index) => {
		const t = (index * 2 * Math.PI) / HEART_SAMPLES;
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
	const [minX, maxX, minY, maxY] = [
		Math.min(...xs),
		Math.max(...xs),
		Math.min(...ys),
		Math.max(...ys),
	];
	return raw.map((point) => ({
		x: round6(((point.x - minX) / (maxX - minX)) * 2 - 1),
		y: round6(((point.y - minY) / (maxY - minY)) * 2 - 1),
	}));
}

/** A heart filling its box, sampled from the classic parametric curve. */
export const heartOutline: readonly MaskPoint[] = computeHeartOutline();

function cubicPoint(
	from: MaskPoint,
	c1: MaskPoint,
	c2: MaskPoint,
	to: MaskPoint,
	t: number
): MaskPoint {
	const u = 1 - t;
	const a = u * u * u;
	const b = 3 * u * u * t;
	const c = 3 * u * t * t;
	const d = t * t * t;
	return {
		x: round6(a * from.x + b * c1.x + c * c2.x + d * to.x),
		y: round6(a * from.y + b * c1.y + c * c2.y + d * to.y),
	};
}

/**
 * A closed freeform path as a polygon. An edge is a cubic Bezier when its
 * start has an out-handle or its end has an in-handle (handles are absolute
 * box coordinates); otherwise it stays a straight line.
 */
export function flattenMaskPath(
	path: readonly MaskPathPoint[],
	steps = FREEFORM_CURVE_STEPS
): MaskPoint[] {
	const outline: MaskPoint[] = [];
	for (const [index, from] of path.entries()) {
		const to = path[(index + 1) % path.length] ?? from;
		outline.push({ x: from.x, y: from.y });
		const curved =
			from.outX !== undefined ||
			from.outY !== undefined ||
			to.inX !== undefined ||
			to.inY !== undefined;
		if (!curved) {
			continue;
		}
		const c1 = { x: from.outX ?? from.x, y: from.outY ?? from.y };
		const c2 = { x: to.inX ?? to.x, y: to.inY ?? to.y };
		for (let step = 1; step < steps; step++) {
			outline.push(cubicPoint(from, c1, c2, to, step / steps));
		}
	}
	return outline;
}

/**
 * The polygon outline of a mask in box coordinates, for shapes drawn as
 * polygons (polygon, star, heart, freeform). Other shapes return `undefined`.
 */
export function maskOutline(mask: Mask): MaskPoint[] | undefined {
	switch (mask.shape) {
		case "polygon":
			return polygonOutline(mask.sides ?? 6);
		case "star":
			return starOutline(mask.points ?? 5, mask.innerRadius ?? 0.5);
		case "heart":
			return [...heartOutline];
		case "freeform":
			return flattenMaskPath(mask.path ?? []);
		default:
			return undefined;
	}
}

/** Even-odd point-in-polygon test, identical to the render's crossing sum. */
export function insideOutline(
	outline: readonly MaskPoint[],
	x: number,
	y: number
): boolean {
	let crossings = 0;
	for (const [index, a] of outline.entries()) {
		const b = outline[(index + 1) % outline.length] ?? a;
		if (a.y === b.y) {
			continue;
		}
		if (
			y > a.y !== y > b.y &&
			x < a.x + ((y - a.y) * (b.x - a.x)) / (b.y - a.y)
		) {
			crossings++;
		}
	}
	return crossings % 2 === 1;
}

// ---------------------------------------------------------------------------
// Reference coverage

/** Pixel geometry of a mask on a `width`×`height` frame. */
export interface MaskFrameGeometry {
	centerX: number;
	centerY: number;
	halfHeight: number;
	halfWidth: number;
	/** Radians, clockwise. */
	rotation: number;
}

export function maskFrameGeometry(
	mask: Pick<Mask, "height" | "rotation" | "width" | "x" | "y">,
	width: number,
	height: number
): MaskFrameGeometry {
	return {
		centerX: (width / 2) * (1 + mask.x),
		centerY: (height / 2) * (1 + mask.y),
		halfHeight: Math.max((height * mask.height) / 2, 0.5),
		halfWidth: Math.max((width * mask.width) / 2, 0.5),
		rotation: (mask.rotation * Math.PI) / 180,
	};
}

/** Constants of the star edge test for `points` and `innerRadius`. */
export function starEdge(points: number, innerRadius: number) {
	const half = Math.PI / points;
	return {
		ex: innerRadius * Math.cos(half) - 1,
		ey: innerRadius * Math.sin(half),
		half,
	};
}

/** Euclidean remainder, matching FFmpeg's `mod` (sign of the divisor). */
const floorMod = (value: number, divisor: number) =>
	value - divisor * Math.floor(value / divisor);

/**
 * Hard coverage (0..1) of the shape at a pixel offset from the mask center,
 * before feather, invert and opacity. `u`/`v` are pixels in the mask's
 * rotated frame. Linear and mirror masks return their soft ramp. Text masks
 * have no analytic coverage and return 0.
 */
export function maskShapeCoverage(
	mask: Mask,
	u: number,
	v: number,
	geometry: Pick<MaskFrameGeometry, "halfHeight" | "halfWidth">,
	ramp: number
): number {
	const { halfHeight, halfWidth } = geometry;
	const nu = u / halfWidth;
	const nv = v / halfHeight;
	switch (mask.shape) {
		case "rectangle": {
			const radius =
				(mask.cornerRadius ?? 0) * 2 * Math.min(halfWidth, halfHeight);
			if (radius <= 0) {
				return Math.abs(nu) <= 1 && Math.abs(nv) <= 1 ? 1 : 0;
			}
			const qx = Math.abs(u) - halfWidth + radius;
			const qy = Math.abs(v) - halfHeight + radius;
			const distance =
				Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) +
				Math.min(Math.max(qx, qy), 0);
			return distance <= radius ? 1 : 0;
		}
		case "ellipse":
			return nu * nu + nv * nv <= 1 ? 1 : 0;
		case "linear":
			return clamp01(0.5 - v / ramp);
		case "mirror":
			return clamp01(0.5 - (Math.abs(v) - halfHeight) / ramp);
		case "polygon": {
			const sides = mask.sides ?? 6;
			const step = (2 * Math.PI) / sides;
			const phi =
				floorMod(Math.atan2(nv, nu) + Math.PI / 2 + 4 * Math.PI, step) -
				Math.PI / sides;
			return Math.hypot(nu, nv) * Math.cos(phi) <= Math.cos(Math.PI / sides)
				? 1
				: 0;
		}
		case "star": {
			const points = mask.points ?? 5;
			const { ex, ey, half } = starEdge(points, mask.innerRadius ?? 0.5);
			const psi = Math.abs(
				floorMod(
					Math.atan2(nv, nu) + Math.PI / 2 + half + 4 * Math.PI,
					2 * half
				) - half
			);
			const radius = Math.hypot(nu, nv);
			return ex * radius * Math.sin(psi) - ey * (radius * Math.cos(psi) - 1) >=
				0
				? 1
				: 0;
		}
		case "heart":
		case "freeform":
			return insideOutline(maskOutline(mask) ?? [], nu, nv) ? 1 : 0;
		default:
			return 0;
	}
}

/** Coverage after invert and opacity (`opacity` 0 leaves the clip untouched). */
export function maskStrength(mask: Mask, coverage: number): number {
	const kept = mask.invert ? 1 - coverage : coverage;
	return 1 - mask.opacity * (1 - kept);
}

/**
 * Reference alpha (0..1) of one mask at the center of pixel (`px`, `py`) on a
 * `width`×`height` frame, before any blur feather. Tests compare FFmpeg
 * renders with this function.
 */
export function maskAlphaAt(
	mask: Mask,
	px: number,
	py: number,
	width: number,
	height: number
): number {
	return maskAlphaAtPoint(mask, px + 0.5, py + 0.5, width, height);
}

/** `maskAlphaAt` at a continuous frame position (`x`, `y` in pixels). */
export function maskAlphaAtPoint(
	mask: Mask,
	x: number,
	y: number,
	width: number,
	height: number
): number {
	const geometry = maskFrameGeometry(mask, width, height);
	const dx = x - geometry.centerX;
	const dy = y - geometry.centerY;
	const cos = Math.cos(geometry.rotation);
	const sin = Math.sin(geometry.rotation);
	const u = dx * cos + dy * sin;
	const v = dy * cos - dx * sin;
	const coverage = maskShapeCoverage(
		mask,
		u,
		v,
		geometry,
		maskRampWidth(mask.feather, width, height)
	);
	return maskStrength(mask, coverage);
}

// ---------------------------------------------------------------------------
// Outline stroke

/** A mask stroke without an explicit color is white. */
export const DEFAULT_MASK_STROKE_COLOR = "#ffffff";
/** A mask stroke without an explicit alignment straddles the edge. */
export const DEFAULT_MASK_STROKE_ALIGN: MaskStrokeAlign = "center";

export const maskStrokeAlignLabels: Record<MaskStrokeAlign, string> = {
	center: "Center",
	inside: "Inside",
	outside: "Outside",
};

export const maskStrokeColorOf = (mask: Pick<Mask, "strokeColor">): string =>
	mask.strokeColor ?? DEFAULT_MASK_STROKE_COLOR;
export const maskStrokeAlignOf = (
	mask: Pick<Mask, "strokeAlign">
): MaskStrokeAlign => mask.strokeAlign ?? DEFAULT_MASK_STROKE_ALIGN;

/** Whether the mask draws an outline stroke (text masks never do). */
export function maskHasStroke(
	mask: Pick<Mask, "shape" | "strokeWidth">
): boolean {
	return mask.shape !== "text" && (mask.strokeWidth ?? 0) > 0;
}

/** Stroke width in pixels on a frame `height` pixels tall. */
export function maskStrokeWidthPx(
	mask: Pick<Mask, "strokeWidth">,
	height: number
): number {
	return (mask.strokeWidth ?? 0) * height;
}

/**
 * The stroke's signed-distance band in pixels (negative inside the mask
 * edge): `center` straddles the edge, `inside` lies within the kept shape
 * and `outside` around it. Invert does not move the band; it is the edge.
 */
export function maskStrokeBand(
	mask: Pick<Mask, "strokeAlign" | "strokeWidth">,
	height: number
): { inner: number; outer: number } {
	const width = maskStrokeWidthPx(mask, height);
	if (width <= 0) {
		return { inner: 0, outer: 0 };
	}
	switch (maskStrokeAlignOf(mask)) {
		case "inside":
			return { inner: -width, outer: 0 };
		case "outside":
			return { inner: 0, outer: width };
		default:
			return { inner: -width / 2, outer: width / 2 };
	}
}

/** Distance in pixels from (`u`, `v`) to the segment `a`→`b`. */
function segmentDistancePx(
	u: number,
	v: number,
	ax: number,
	ay: number,
	bx: number,
	by: number
): number {
	const dx = bx - ax;
	const dy = by - ay;
	const lengthSquared = dx * dx + dy * dy;
	const along =
		lengthSquared === 0
			? 0
			: clamp01(((u - ax) * dx + (v - ay) * dy) / lengthSquared);
	return Math.hypot(u - (ax + along * dx), v - (ay + along * dy));
}

/** Most outline edges a stroke measures distances to. */
export const MAX_STROKE_OUTLINE_EDGES = 96;
/** First simplification tolerance for long stroke outlines, in box units. */
const STROKE_SIMPLIFY_TOLERANCE = 0.002;

function pointLineDistance(
	point: MaskPoint,
	a: MaskPoint,
	b: MaskPoint
): number {
	const dx = b.x - a.x;
	const dy = b.y - a.y;
	const length = Math.hypot(dx, dy);
	if (length === 0) {
		return Math.hypot(point.x - a.x, point.y - a.y);
	}
	return Math.abs((point.x - a.x) * dy - (point.y - a.y) * dx) / length;
}

/** Douglas–Peucker simplification of an open polyline. */
function simplifyPolyline(
	points: readonly MaskPoint[],
	tolerance: number
): MaskPoint[] {
	const first = points[0];
	const last = points.at(-1);
	if (!(first && last) || points.length < 3) {
		return [...points];
	}
	let farthest = 0;
	let index = 0;
	for (let at = 1; at < points.length - 1; at++) {
		const distance = pointLineDistance(points[at] as MaskPoint, first, last);
		if (distance > farthest) {
			farthest = distance;
			index = at;
		}
	}
	if (farthest <= tolerance) {
		return [first, last];
	}
	return [
		...simplifyPolyline(points.slice(0, index + 1), tolerance).slice(0, -1),
		...simplifyPolyline(points.slice(index), tolerance),
	];
}

/**
 * The outline a stroke measures distances to: the shape's own outline, or,
 * past `MAX_STROKE_OUTLINE_EDGES` edges (detailed curved freeform paths),
 * a Douglas–Peucker simplification of it within 0.002 of the box (about a
 * pixel on a full-height 1080p mask), loosened until it fits. The inside
 * test always uses the full outline.
 */
export function maskDistanceOutline(mask: Mask): MaskPoint[] {
	const outline = maskOutline(mask) ?? [];
	if (outline.length <= MAX_STROKE_OUTLINE_EDGES) {
		return outline;
	}
	const closed = [...outline, outline[0] as MaskPoint];
	let tolerance = STROKE_SIMPLIFY_TOLERANCE;
	let simplified = closed;
	do {
		simplified = simplifyPolyline(closed, tolerance);
		tolerance *= 2;
	} while (simplified.length - 1 > MAX_STROKE_OUTLINE_EDGES);
	return simplified.slice(0, -1);
}

/**
 * Signed distance in pixels from a pixel offset (`u`, `v`, in the mask's
 * rotated frame) to the mask edge, negative inside the shape. Rectangles
 * (rounded or not) are exact, ellipses use the standard first-order
 * approximation `k0·(k0 − 1)/k1`, the polygonal shapes measure every edge of
 * `maskDistanceOutline` in pixels, linear masks measure to their edge line and mirror masks
 * to their two edges. The render's `geq` evaluates the same formulas.
 */
export function maskSignedDistance(
	mask: Mask,
	u: number,
	v: number,
	geometry: Pick<MaskFrameGeometry, "halfHeight" | "halfWidth">
): number {
	const { halfHeight, halfWidth } = geometry;
	switch (mask.shape) {
		case "rectangle": {
			const radius =
				(mask.cornerRadius ?? 0) * 2 * Math.min(halfWidth, halfHeight);
			const qx = Math.abs(u) - halfWidth + radius;
			const qy = Math.abs(v) - halfHeight + radius;
			return (
				Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) +
				Math.min(Math.max(qx, qy), 0) -
				radius
			);
		}
		case "ellipse": {
			const nu = u / halfWidth;
			const nv = v / halfHeight;
			const k0 = Math.hypot(nu, nv);
			if (k0 < MIN_ELLIPSE_GRADIENT) {
				// The first-order estimate vanishes at the very center.
				return -Math.min(halfWidth, halfHeight);
			}
			const k1 = Math.hypot(nu / halfWidth, nv / halfHeight);
			return (k0 * (k0 - 1)) / k1;
		}
		case "linear":
			return v;
		case "mirror":
			return Math.abs(v) - halfHeight;
		case "text":
			return Number.POSITIVE_INFINITY;
		default: {
			const outline = maskDistanceOutline(mask);
			let distance = Number.POSITIVE_INFINITY;
			for (const [index, a] of outline.entries()) {
				const b = outline[(index + 1) % outline.length] ?? a;
				distance = Math.min(
					distance,
					segmentDistancePx(
						u,
						v,
						a.x * halfWidth,
						a.y * halfHeight,
						b.x * halfWidth,
						b.y * halfHeight
					)
				);
			}
			const inside = maskShapeCoverage(mask, u, v, geometry, 1) > 0;
			return inside ? -distance : distance;
		}
	}
}

/** Below this normalized radius an ellipse pixel is treated as its center. */
export const MIN_ELLIPSE_GRADIENT = 1e-6;

/** Anti-aliased coverage of the band (`inner`, `outer`) at signed distance `d`. */
export function strokeBandCoverage(
	distance: number,
	band: { inner: number; outer: number }
): number {
	const edge = (at: number) => clamp01(0.5 - (distance - at));
	return Math.max(0, edge(band.outer) - edge(band.inner));
}

/**
 * Reference stroke alpha (0..1) of one mask at the center of pixel (`px`,
 * `py`) on a `width`×`height` frame. Zero for masks without a stroke.
 */
export function maskStrokeAlphaAt(
	mask: Mask,
	px: number,
	py: number,
	width: number,
	height: number
): number {
	return maskStrokeAlphaAtPoint(mask, px + 0.5, py + 0.5, width, height);
}

/** `maskStrokeAlphaAt` at a continuous frame position (`x`, `y` in pixels). */
export function maskStrokeAlphaAtPoint(
	mask: Mask,
	x: number,
	y: number,
	width: number,
	height: number
): number {
	if (!maskHasStroke(mask)) {
		return 0;
	}
	const geometry = maskFrameGeometry(mask, width, height);
	const dx = x - geometry.centerX;
	const dy = y - geometry.centerY;
	const cos = Math.cos(geometry.rotation);
	const sin = Math.sin(geometry.rotation);
	const u = dx * cos + dy * sin;
	const v = dy * cos - dx * sin;
	return strokeBandCoverage(
		maskSignedDistance(mask, u, v, geometry),
		maskStrokeBand(mask, height)
	);
}

// ---------------------------------------------------------------------------
// Text masks

const fontNames: Record<FontFamily, string> = {
	"system-sans": "Sans",
	inter: "Inter",
	roboto: "Roboto",
	montserrat: "Montserrat",
	poppins: "Poppins",
	oswald: "Oswald",
	"bebas-neue": "Bebas Neue",
	anton: "Anton",
	"playfair-display": "Playfair Display",
	merriweather: "Merriweather",
	"source-code-pro": "Source Code Pro",
	"permanent-marker": "Permanent Marker",
	lobster: "Lobster",
};

/** Font family name for fontconfig and CSS; unknown fonts fall back to sans. */
export function maskFontName(fontFamily: FontFamily | undefined): string {
	return fontNames[fontFamily ?? "system-sans"];
}

/** Text masks fill this fraction of their box height. */
export const TEXT_MASK_SIZE = 0.8;

/**
 * Text that is safe inside an FFmpeg filtergraph and an SVG: straight quotes
 * become typographic ones, and filtergraph or markup metacharacters are
 * dropped.
 */
export function sanitizeMaskText(text: string): string {
	const unsafe = new Set("\\:;,[]{}%<>&=");
	let safe = "";
	for (const character of text
		.replaceAll("'", "\u2019")
		.replaceAll('"', "\u201D")) {
		const code = character.codePointAt(0) ?? 0;
		if (code >= 32 && code !== 127 && !unsafe.has(character)) {
			safe += character;
		}
	}
	return safe.trim();
}

// ---------------------------------------------------------------------------
// Edits

/** Add a default mask of `shape`. Throws when the clip already has the maximum. */
export function addMask(
	masks: readonly Mask[] | undefined,
	shape: MaskShape,
	id: string
): Mask[] {
	const current = masks ?? [];
	if (current.length >= MAX_CLIP_MASKS) {
		throw new Error(`A clip can have at most ${MAX_CLIP_MASKS} masks.`);
	}
	return [...current, defaultMask(shape, id)];
}

/**
 * Patch one mask and validate it. Changing the shape fills in the defaults
 * that shape needs (sides, star points, text or a path).
 */
export function updateMask(
	masks: readonly Mask[],
	id: string,
	patch: Partial<Omit<Mask, "id">>
): Mask[] {
	if (!masks.some((mask) => mask.id === id)) {
		throw new Error("That mask is not on this clip.");
	}
	return masks.map((mask) => {
		if (mask.id !== id) {
			return mask;
		}
		const shape = patch.shape ?? mask.shape;
		const shapeDefaults =
			shape === mask.shape ? {} : shapeFields(defaultMask(shape, id));
		const next = { ...mask, ...shapeDefaults, ...patch };
		if (shape === "text" && mask.shape !== "text") {
			// Text masks have no stroke; switching to one drops it.
			next.strokeWidth = undefined;
			next.strokeColor = undefined;
			next.strokeAlign = undefined;
		}
		return maskSchema.parse(stripUndefined(next));
	});
}

function stripUndefined<Value extends object>(value: Value): Value {
	return Object.fromEntries(
		Object.entries(value).filter(([, field]) => field !== undefined)
	) as Value;
}

function shapeFields(mask: Mask): Partial<Mask> {
	const { cornerRadius, fontFamily, innerRadius, path, points, sides, text } =
		mask;
	return Object.fromEntries(
		Object.entries({
			cornerRadius,
			fontFamily,
			innerRadius,
			path,
			points,
			sides,
			text,
		}).filter(([, value]) => value !== undefined)
	);
}

/** Remove one mask; returns `undefined` once none are left, so the field clears. */
export function removeMask(
	masks: readonly Mask[],
	id: string
): Mask[] | undefined {
	const next = masks.filter((mask) => mask.id !== id);
	return next.length ? next : undefined;
}

const maskKeyframeProperties: ReadonlySet<string> = new Set(
	maskAnimatedFields.map(([, property]) => property)
);

/**
 * Segment patch that removes one mask and every `mask*` keyframe targeting
 * it, so the project stays valid (targeted keyframes need their target).
 * `keyframes` is only included when one was dropped.
 */
export function removeMaskPatch(
	segment: Pick<Segment, "keyframes" | "masks">,
	id: string
): Pick<Segment, "masks"> & Partial<Pick<Segment, "keyframes">> {
	const masks = removeMask(segment.masks ?? [], id);
	const keyframes = segment.keyframes.filter(
		(frame) =>
			!(frame.target === id && maskKeyframeProperties.has(frame.property))
	);
	return keyframes.length === segment.keyframes.length
		? { masks }
		: { keyframes, masks };
}

// ---------------------------------------------------------------------------
// Direct manipulation

export type MaskHandle =
	| "move"
	| "nw"
	| "ne"
	| "sw"
	| "se"
	| "rotate"
	| "feather"
	| `point:${number}`;

/** A pointer position as a fraction (0..1) of the clip frame. */
export interface FramePoint {
	x: number;
	y: number;
}

const clamp = (value: number, min: number, max: number) =>
	Math.min(max, Math.max(min, value));
const clamp01 = (value: number) => clamp(value, 0, 1);
function round6(value: number): number {
	const rounded = Math.round(value * 1e6) / 1e6;
	return Object.is(rounded, -0) ? 0 : rounded;
}

/**
 * Direct manipulation works on a virtual frame this many units tall (and
 * `aspect` times as wide), far above the half-pixel floor of the geometry.
 */
const HANDLE_FRAME = 1000;

const handleGeometry = (mask: Mask, aspect: number) =>
	maskFrameGeometry(mask, aspect * HANDLE_FRAME, HANDLE_FRAME);

/** Pointer position in the mask's own box (`-1..1`), given the frame aspect. */
export function frameToMaskBox(
	mask: Mask,
	point: FramePoint,
	aspect: number
): MaskPoint {
	const geometry = handleGeometry(mask, aspect);
	const dx = point.x * aspect * HANDLE_FRAME - geometry.centerX;
	const dy = point.y * HANDLE_FRAME - geometry.centerY;
	const cos = Math.cos(geometry.rotation);
	const sin = Math.sin(geometry.rotation);
	return {
		x: (dx * cos + dy * sin) / geometry.halfWidth,
		y: (dy * cos - dx * sin) / geometry.halfHeight,
	};
}

/** A box point (`-1..1`) as a fraction of the clip frame. */
export function maskBoxToFrame(
	mask: Mask,
	point: MaskPoint,
	aspect: number
): FramePoint {
	const geometry = handleGeometry(mask, aspect);
	const u = point.x * geometry.halfWidth;
	const v = point.y * geometry.halfHeight;
	const cos = Math.cos(geometry.rotation);
	const sin = Math.sin(geometry.rotation);
	return {
		x: (geometry.centerX + u * cos - v * sin) / (aspect * HANDLE_FRAME),
		y: (geometry.centerY + u * sin + v * cos) / HANDLE_FRAME,
	};
}

/**
 * The mask after dragging `handle` from `from` to `to` (frame fractions) on a
 * frame of `aspect` (width / height). `start` is the mask when the drag
 * began. Corners resize about the center, the rotation handle sits above the
 * box, the feather handle measures outward from the right edge, and
 * `point:<i>` moves one freeform vertex.
 */
export function dragMask(
	start: Mask,
	handle: MaskHandle,
	from: FramePoint,
	to: FramePoint,
	aspect: number
): Mask {
	if (handle === "move") {
		return {
			...start,
			x: round6(clamp(start.x + 2 * (to.x - from.x), -1, 1)),
			y: round6(clamp(start.y + 2 * (to.y - from.y), -1, 1)),
		};
	}
	if (handle === "rotate") {
		const geometry = handleGeometry(start, aspect);
		const angle =
			(Math.atan2(
				to.y * HANDLE_FRAME - geometry.centerY,
				to.x * aspect * HANDLE_FRAME - geometry.centerX
			) *
				180) /
				Math.PI +
			90;
		const wrapped = floorMod(angle + 180, 360) - 180;
		return { ...start, rotation: round6(wrapped) };
	}
	const local = frameToMaskBox(start, to, aspect);
	if (handle === "feather") {
		const geometry = handleGeometry(start, aspect);
		const outward = (local.x - 1) * geometry.halfWidth;
		const perFeather =
			4 * maskFeatherSigma(1, aspect * HANDLE_FRAME, HANDLE_FRAME);
		return { ...start, feather: round6(clamp01(outward / perFeather)) };
	}
	if (handle.startsWith("point:")) {
		const index = Number(handle.slice("point:".length));
		const path = start.path?.map((point, at) =>
			at === index
				? {
						...point,
						x: round6(clamp(local.x, -1, 1)),
						y: round6(clamp(local.y, -1, 1)),
					}
				: point
		);
		return path ? { ...start, path } : start;
	}
	// Corners resize symmetrically: the corner follows the pointer in the
	// mask's rotated frame, so any corner works the same way.
	return {
		...start,
		height: round6(clamp(start.height * Math.abs(local.y), 0.01, 2)),
		width: round6(clamp(start.width * Math.abs(local.x), 0.01, 2)),
	};
}

// ---------------------------------------------------------------------------
// Preview SVG

const svgNumber = (value: number) => String(round6(value));

function escapeXml(text: string): string {
	return text
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;");
}

function svgShape(
	mask: Mask,
	geometry: MaskFrameGeometry,
	ramp: number
): {
	defs: string;
	shape: string;
} {
	const { halfHeight, halfWidth } = geometry;
	const reach = svgNumber((halfWidth + halfHeight) * 8);
	switch (mask.shape) {
		case "rectangle": {
			const radius = svgNumber(
				(mask.cornerRadius ?? 0) * 2 * Math.min(halfWidth, halfHeight)
			);
			return {
				defs: "",
				shape: `<rect x="${svgNumber(-halfWidth)}" y="${svgNumber(-halfHeight)}" width="${svgNumber(2 * halfWidth)}" height="${svgNumber(2 * halfHeight)}" rx="${radius}" ry="${radius}"/>`,
			};
		}
		case "ellipse":
			return {
				defs: "",
				shape: `<ellipse rx="${svgNumber(halfWidth)}" ry="${svgNumber(halfHeight)}"/>`,
			};
		case "linear":
			return {
				defs: `<linearGradient id="g" gradientUnits="userSpaceOnUse" x1="0" y1="${svgNumber(-ramp / 2)}" x2="0" y2="${svgNumber(ramp / 2)}"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>`,
				shape: `<rect x="-${reach}" y="-${reach}" width="${svgNumber(2 * Number(reach))}" height="${svgNumber(Number(reach) + ramp / 2)}" fill="url(#g)"/>`,
			};
		case "mirror": {
			const edge = halfHeight + ramp / 2;
			const peak = Math.min(1, 0.5 + halfHeight / ramp);
			const inner = Math.max(0, halfHeight - ramp / 2);
			const stops =
				inner > 0
					? [
							[0, 0],
							[(edge - inner) / (2 * edge), 1],
							[(edge + inner) / (2 * edge), 1],
							[1, 0],
						]
					: [
							[0, 0],
							[0.5, peak],
							[1, 0],
						];
			return {
				defs: `<linearGradient id="g" gradientUnits="userSpaceOnUse" x1="0" y1="${svgNumber(-edge)}" x2="0" y2="${svgNumber(edge)}">${stops
					.map(
						([offset, opacity]) =>
							`<stop offset="${svgNumber(offset ?? 0)}" stop-color="#fff" stop-opacity="${svgNumber(opacity ?? 0)}"/>`
					)
					.join("")}</linearGradient>`,
				shape: `<rect x="-${reach}" y="${svgNumber(-edge)}" width="${svgNumber(2 * Number(reach))}" height="${svgNumber(2 * edge)}" fill="url(#g)"/>`,
			};
		}
		case "text":
			return {
				defs: "",
				shape: `<text x="0" y="0" text-anchor="middle" dominant-baseline="central" font-family="${escapeXml(maskFontName(mask.fontFamily))}, sans-serif" font-size="${svgNumber(2 * halfHeight * TEXT_MASK_SIZE)}">${escapeXml(sanitizeMaskText(mask.text ?? ""))}</text>`,
			};
		default: {
			const points = (maskOutline(mask) ?? [])
				.map(
					(point) =>
						`${svgNumber(point.x * halfWidth)},${svgNumber(point.y * halfHeight)}`
				)
				.join(" ");
			return {
				defs: "",
				shape: `<polygon points="${points}" fill-rule="evenodd"/>`,
			};
		}
	}
}

/** Mirror the drawn mask, for a clip flipped after it is masked. */
export interface MaskSvgOptions {
	flipX?: boolean;
	flipY?: boolean;
}

/**
 * Copies of the frame-clipped shape `#s` mirrored across each frame border
 * and corner, so the blur sees the frame reflected past its edges as the
 * render's `boxblur` does (it mirrors about the border). A shape touching
 * the border then stays opaque there instead of fading.
 */
function edgeReflections(width: number, height: number): string {
	const w = svgNumber(2 * width);
	const h = svgNumber(2 * height);
	return [
		"scale(1 -1)",
		`translate(0 ${h}) scale(1 -1)`,
		"scale(-1 1)",
		`translate(${w} 0) scale(-1 1)`,
		"scale(-1 -1)",
		`translate(${w} 0) scale(-1 -1)`,
		`translate(0 ${h}) scale(-1 -1)`,
		`translate(${w} ${h}) scale(-1 -1)`,
	]
		.map(
			(transform) =>
				`<g transform="${transform}"><g clip-path="url(#c)"><use href="#s"/></g></g>`
		)
		.join("");
}

/**
 * Pixels `maskToSvg` adds on every side of the frame for a blurred mask (the
 * blur's reach), 0 when nothing is blurred. The SVG's viewport covers the
 * pad too, because renderers only filter what lies inside the viewport, so
 * a CSS layer showing it must be that much larger than the frame.
 */
export function maskSvgPad(mask: Mask, width: number, height: number): number {
	if (rampMaskShapes.has(mask.shape)) {
		return 0;
	}
	const sigma = maskFeatherSigma(mask.feather, width, height);
	return sigma > 0 ? Math.ceil(3 * sigma) + 2 : 0;
}

/**
 * A standalone SVG whose alpha is the mask on a `width`×`height` frame:
 * white shape, blur feather (or the analytic ramp for linear and mirror),
 * then invert and opacity as one alpha transfer. Used as a CSS `mask-image`.
 * A blurred shape is clipped to the frame and mirrored past its borders
 * first, matching the render at the frame edges; its SVG
 * then spans the frame plus `maskSvgPad` on every side.
 */
export function maskToSvg(
	mask: Mask,
	width: number,
	height: number,
	options: MaskSvgOptions = {}
): string {
	const geometry = maskFrameGeometry(mask, width, height);
	const ramp = maskRampWidth(mask.feather, width, height);
	const { defs, shape } = svgShape(mask, geometry, ramp);
	const sigma = maskSvgPad(mask, width, height)
		? maskFeatherSigma(mask.feather, width, height)
		: 0;
	const slope = mask.invert ? -mask.opacity : mask.opacity;
	const intercept = mask.invert ? 1 : 1 - mask.opacity;
	const w = svgNumber(width);
	const h = svgNumber(height);
	const mirror =
		options.flipX || options.flipY
			? `translate(${options.flipX ? w : 0} ${options.flipY ? h : 0}) scale(${options.flipX ? -1 : 1} ${options.flipY ? -1 : 1})`
			: "";
	const drawn = `${mirror ? `<g transform="${mirror}">` : ""}<g transform="translate(${svgNumber(geometry.centerX)} ${svgNumber(geometry.centerY)}) rotate(${svgNumber(mask.rotation)})">${shape}</g>${mirror ? "</g>" : ""}`;
	const transfer = `<feComponentTransfer><feFuncA type="linear" slope="${svgNumber(slope)}" intercept="${svgNumber(intercept)}"/></feComponentTransfer>`;
	if (sigma <= 0) {
		return [
			`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">`,
			`<defs>${defs}<filter id="f" filterUnits="userSpaceOnUse" x="0" y="0" width="${w}" height="${h}" color-interpolation-filters="sRGB">${transfer}</filter></defs>`,
			`<g filter="url(#f)"><g fill="#fff">${drawn}</g></g>`,
			"</svg>",
		].join("");
	}
	const pad = maskSvgPad(mask, width, height);
	const outerWidth = svgNumber(width + 2 * pad);
	const outerHeight = svgNumber(height + 2 * pad);
	return [
		`<svg xmlns="http://www.w3.org/2000/svg" width="${outerWidth}" height="${outerHeight}" viewBox="-${pad} -${pad} ${outerWidth} ${outerHeight}" preserveAspectRatio="none">`,
		`<defs>${defs}<g id="s" fill="#fff">${drawn}</g><clipPath id="c"><rect width="${w}" height="${h}"/></clipPath>`,
		`<filter id="f" filterUnits="userSpaceOnUse" x="-${pad}" y="-${pad}" width="${outerWidth}" height="${outerHeight}" color-interpolation-filters="sRGB"><feGaussianBlur stdDeviation="${svgNumber(sigma)}"/>${transfer}</filter></defs>`,
		`<g filter="url(#f)"><g clip-path="url(#c)"><use href="#s"/></g>${edgeReflections(width, height)}</g>`,
		"</svg>",
	].join("");
}

/** `maskToSvg` as a `data:` URL, for an SVG `<image>`. */
export function maskSvgDataUrl(
	mask: Mask,
	width: number,
	height: number,
	options: MaskSvgOptions = {}
): string {
	return `data:image/svg+xml,${encodeURIComponent(maskToSvg(mask, width, height, options))}`;
}

/** `maskToSvg` as a CSS `url()` value. */
export function maskSvgUrl(
	mask: Mask,
	width: number,
	height: number,
	options: MaskSvgOptions = {}
): string {
	return `url("data:image/svg+xml,${encodeURIComponent(maskToSvg(mask, width, height, options))}")`;
}

/**
 * A standalone SVG of the mask's outline stroke on a `width`×`height` frame,
 * in the stroke color, or `undefined` when the mask has none. The preview
 * draws it over the masked clip in the same box as the mask layer. SVG
 * strokes are true offsets of the edge with round joins, so they match the
 * render's signed-distance band: `center` is a stroke of the band width,
 * `inside`/`outside` a stroke twice as wide kept inside or outside the
 * shape. Linear and mirror masks draw their band as rectangles.
 */
export function maskStrokeSvg(
	mask: Mask,
	width: number,
	height: number,
	options: MaskSvgOptions = {}
): string | undefined {
	if (!maskHasStroke(mask)) {
		return;
	}
	const geometry = maskFrameGeometry(mask, width, height);
	const band = maskStrokeBand(mask, height);
	const color = maskStrokeColorOf(mask);
	const w = svgNumber(width);
	const h = svgNumber(height);
	const mirror =
		options.flipX || options.flipY
			? `translate(${options.flipX ? w : 0} ${options.flipY ? h : 0}) scale(${options.flipX ? -1 : 1} ${options.flipY ? -1 : 1})`
			: "";
	const place = (content: string) =>
		`${mirror ? `<g transform="${mirror}">` : ""}<g transform="translate(${svgNumber(geometry.centerX)} ${svgNumber(geometry.centerY)}) rotate(${svgNumber(mask.rotation)})">${content}</g>${mirror ? "</g>" : ""}`;
	const open = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">`;
	if (mask.shape === "linear" || mask.shape === "mirror") {
		const reach = svgNumber((geometry.halfWidth + geometry.halfHeight) * 8);
		const bandRect = (top: number, bottom: number) =>
			`<rect x="-${reach}" y="${svgNumber(top)}" width="${svgNumber(2 * Number(reach))}" height="${svgNumber(bottom - top)}"/>`;
		const rects =
			mask.shape === "linear"
				? bandRect(band.inner, band.outer)
				: bandRect(
						geometry.halfHeight + band.inner,
						geometry.halfHeight + band.outer
					) +
					bandRect(
						-geometry.halfHeight - band.outer,
						-geometry.halfHeight - band.inner
					);
		return `${open}<g fill="${color}">${place(rects)}</g></svg>`;
	}
	const { shape } = svgShape(mask, geometry, 1);
	const align = maskStrokeAlignOf(mask);
	const strokeWidth = svgNumber(
		align === "center" ? band.outer - band.inner : 2 * (band.outer - band.inner)
	);
	const stroked = `<g fill="none" stroke="${color}" stroke-width="${strokeWidth}" stroke-linejoin="round">${place(shape)}</g>`;
	if (align === "center") {
		return `${open}${stroked}</svg>`;
	}
	const keep = align === "inside";
	return [
		open,
		`<defs><mask id="k" maskUnits="userSpaceOnUse" x="0" y="0" width="${w}" height="${h}">`,
		`<rect width="${w}" height="${h}" fill="${keep ? "#000" : "#fff"}"/>`,
		`<g fill="${keep ? "#fff" : "#000"}">${place(shape)}</g>`,
		"</mask></defs>",
		`<g mask="url(#k)">${stroked}</g>`,
		"</svg>",
	].join("");
}

/** `maskStrokeSvg` as a CSS `url()` value, or `undefined` without a stroke. */
export function maskStrokeSvgUrl(
	mask: Mask,
	width: number,
	height: number,
	options: MaskSvgOptions = {}
): string | undefined {
	const svg = maskStrokeSvg(mask, width, height, options);
	return svg
		? `url("data:image/svg+xml,${encodeURIComponent(svg)}")`
		: undefined;
}
