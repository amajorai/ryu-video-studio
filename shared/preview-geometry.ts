/**
 * Pure geometry for direct manipulation in the preview: bounding boxes of
 * clips, titles and graphics, move/scale/rotate gestures, canvas snapping and
 * the crop rectangle.
 *
 * Coordinates are frame-normalized: `x` is a fraction of the frame width and
 * `y` a fraction of the frame height, with (0, 0) at the top-left corner.
 * Rotation is in degrees, clockwise (CSS and FFmpeg `rotate` agree on this
 * with y pointing down). Rotation only makes sense in pixel space, so every
 * function that rotates takes the frame size in pixels; any size with the
 * project's aspect ratio gives the same normalized result.
 */
import { animatedValue, inKeyframeGroup } from "./animation.ts";
import type { Crop, Graphic, Keyframe, Segment, Title } from "./project.ts";
import {
	type KeyframeProperty,
	keyframeValueBounds,
} from "./schema/keyframe.ts";
import { fillCropWithin, fitModeOf } from "./transform.ts";

export interface Point {
	x: number;
	y: number;
}

/** Pixel size of the frame the normalized coordinates refer to. */
export interface FrameSize {
	height: number;
	width: number;
}

/**
 * A rotated rectangle. `cx`/`cy` is the center; `width`/`height` are the
 * unrotated extents (fractions of the frame width and height).
 */
export interface TransformBox {
	cx: number;
	cy: number;
	height: number;
	rotation: number;
	width: number;
}

export type CornerHandle = "nw" | "ne" | "se" | "sw";
export type EdgeHandle = "n" | "e" | "s" | "w";
export type ScaleHandle = CornerHandle | EdgeHandle;

export const CORNER_HANDLES: readonly CornerHandle[] = ["nw", "ne", "se", "sw"];
export const EDGE_HANDLES: readonly EdgeHandle[] = ["n", "e", "s", "w"];

/** Rotation snap step while Shift is held. */
export const ROTATION_SNAP_DEGREES = 15;
/** Distance (pixels) inside which a moved box snaps to a guide. */
export const SNAP_THRESHOLD_PX = 8;
/** Smallest box side (pixels) a scale gesture may produce. */
export const MIN_BOX_PX = 4;
/** Smallest visible crop window, as a fraction of the source side. */
export const MIN_CROP_VISIBLE = 0.05;
/** Largest single crop edge allowed by the project schema. */
export const MAX_CROP_EDGE = 0.9;

/** Unit position of every handle on a box: -1 is left/top, 1 is right/bottom. */
const handleUnit: Record<ScaleHandle, Point> = {
	e: { x: 1, y: 0 },
	n: { x: 0, y: -1 },
	ne: { x: 1, y: -1 },
	nw: { x: -1, y: -1 },
	s: { x: 0, y: 1 },
	se: { x: 1, y: 1 },
	sw: { x: -1, y: 1 },
	w: { x: -1, y: 0 },
};

export const isCornerHandle = (handle: ScaleHandle): handle is CornerHandle =>
	handle.length === 2;

export function normalizedToPixel(point: Point, frame: FrameSize): Point {
	return { x: point.x * frame.width, y: point.y * frame.height };
}

export function pixelToNormalized(point: Point, frame: FrameSize): Point {
	return {
		x: frame.width ? point.x / frame.width : 0,
		y: frame.height ? point.y / frame.height : 0,
	};
}

const radians = (degrees: number) => (degrees * Math.PI) / 180;

/** Rotate a vector clockwise (y down) by `degrees`. */
export function rotateVector(vector: Point, degrees: number): Point {
	const angle = radians(degrees);
	const cos = Math.cos(angle);
	const sin = Math.sin(angle);
	return {
		x: vector.x * cos - vector.y * sin,
		y: vector.x * sin + vector.y * cos,
	};
}

/** Wrap an angle into the schema range (-180, 180]. */
export function normalizeDegrees(degrees: number): number {
	const wrapped = ((((degrees + 180) % 360) + 360) % 360) - 180;
	return wrapped === -180 ? 180 : wrapped;
}

/** Round an angle to the nearest multiple of `step` degrees. */
export function snapRotation(
	degrees: number,
	step = ROTATION_SNAP_DEGREES
): number {
	return normalizeDegrees(Math.round(degrees / step) * step);
}

/** Round to four decimals so repeated gestures do not accumulate float noise. */
export const roundGeometry = (value: number) =>
	Math.round(value * 10_000) / 10_000 || 0;

const clamp = (value: number, min: number, max: number) =>
	Math.min(max, Math.max(min, value));

/** Box center in pixels. */
export function boxCenterPx(box: TransformBox, frame: FrameSize): Point {
	return normalizedToPixel({ x: box.cx, y: box.cy }, frame);
}

/** Half extents of the unrotated box in pixels. */
function halfSizePx(box: TransformBox, frame: FrameSize): Point {
	return {
		x: (box.width * frame.width) / 2,
		y: (box.height * frame.height) / 2,
	};
}

/** Box-local pixel offset (unrotated, from the center) → frame pixels. */
export function localToFramePx(
	box: TransformBox,
	frame: FrameSize,
	local: Point
): Point {
	const center = boxCenterPx(box, frame);
	const offset = rotateVector(local, box.rotation);
	return { x: center.x + offset.x, y: center.y + offset.y };
}

/** Frame pixels → box-local pixel offset (unrotated, from the center). */
export function frameToLocalPx(
	box: TransformBox,
	frame: FrameSize,
	point: Point
): Point {
	const center = boxCenterPx(box, frame);
	return rotateVector(
		{ x: point.x - center.x, y: point.y - center.y },
		-box.rotation
	);
}

/** A handle's position in frame pixels. */
export function handlePositionPx(
	box: TransformBox,
	frame: FrameSize,
	handle: ScaleHandle
): Point {
	const half = halfSizePx(box, frame);
	const unit = handleUnit[handle];
	return localToFramePx(box, frame, { x: unit.x * half.x, y: unit.y * half.y });
}

/** Corners in frame pixels, clockwise from the top-left. */
export function boxCornersPx(box: TransformBox, frame: FrameSize): Point[] {
	return CORNER_HANDLES.map((handle) => handlePositionPx(box, frame, handle));
}

/** The rotation knob: `offsetPx` above the top edge, following the rotation. */
export function rotationHandlePx(
	box: TransformBox,
	frame: FrameSize,
	offsetPx = 24
): Point {
	const half = halfSizePx(box, frame);
	return localToFramePx(box, frame, { x: 0, y: -half.y - offsetPx });
}

/** Whether a frame-pixel point lies inside the rotated box. */
export function boxContainsPx(
	box: TransformBox,
	frame: FrameSize,
	point: Point
): boolean {
	const local = frameToLocalPx(box, frame, point);
	const half = halfSizePx(box, frame);
	return Math.abs(local.x) <= half.x && Math.abs(local.y) <= half.y;
}

export interface BoxExtents {
	bottom: number;
	left: number;
	right: number;
	top: number;
}

/** Axis-aligned bounds of the rotated box, normalized. */
export function boxExtents(box: TransformBox, frame: FrameSize): BoxExtents {
	const corners = boxCornersPx(box, frame).map((corner) =>
		pixelToNormalized(corner, frame)
	);
	const xs = corners.map((corner) => corner.x);
	const ys = corners.map((corner) => corner.y);
	return {
		bottom: Math.max(...ys),
		left: Math.min(...xs),
		right: Math.max(...xs),
		top: Math.min(...ys),
	};
}

/** Translate a box by a pixel delta. */
export function moveBox(
	start: TransformBox,
	deltaPx: Point,
	frame: FrameSize
): TransformBox {
	const delta = pixelToNormalized(deltaPx, frame);
	return { ...start, cx: start.cx + delta.x, cy: start.cy + delta.y };
}

/** Inclusive `[min, max]` multiplier allowed for one axis. */
export type FactorRange = readonly [number, number];

export interface ScaleOptions {
	/** Scale about the center instead of the opposite handle (Alt). */
	fromCenter?: boolean;
	/** Keep the aspect ratio. Corner handles default to true, edges ignore it. */
	keepAspect?: boolean;
	/**
	 * Limits on the width/height multipliers, so a gesture stops at the
	 * schema bounds instead of drifting (uniform scaling uses both).
	 */
	range?: { x?: FactorRange; y?: FactorRange };
}

const clampFactor = (factor: number, range: FactorRange | undefined) =>
	range ? clamp(factor, range[0], range[1]) : factor;

/**
 * Resize a box by dragging `handle` to `pointerPx`. Corner handles scale
 * uniformly (projected onto the diagonal); edge handles scale one axis. The
 * opposite handle stays fixed unless `fromCenter`.
 */
export function scaleBox(
	start: TransformBox,
	handle: ScaleHandle,
	pointerPx: Point,
	frame: FrameSize,
	options: ScaleOptions = {}
): TransformBox {
	const half = halfSizePx(start, frame);
	const unit = handleUnit[handle];
	const handleLocal = { x: unit.x * half.x, y: unit.y * half.y };
	const anchor = options.fromCenter
		? { x: 0, y: 0 }
		: { x: -handleLocal.x, y: -handleLocal.y };
	const pointer = frameToLocalPx(start, frame, pointerPx);
	const span = { x: handleLocal.x - anchor.x, y: handleLocal.y - anchor.y };
	const reach = { x: pointer.x - anchor.x, y: pointer.y - anchor.y };
	const minFactor = (side: number) => (side > 0 ? MIN_BOX_PX / side : 1);
	const fullWidth = half.x * 2;
	const fullHeight = half.y * 2;
	let factorX = 1;
	let factorY = 1;
	if (isCornerHandle(handle) && (options.keepAspect ?? true)) {
		const lengthSquared = span.x * span.x + span.y * span.y;
		const projected = lengthSquared
			? (reach.x * span.x + reach.y * span.y) / lengthSquared
			: 1;
		const factor = clampFactor(
			clampFactor(
				Math.max(projected, minFactor(fullWidth), minFactor(fullHeight)),
				options.range?.x
			),
			options.range?.y
		);
		factorX = factor;
		factorY = factor;
	} else {
		if (span.x) {
			factorX = clampFactor(
				Math.max(reach.x / span.x, minFactor(fullWidth)),
				options.range?.x
			);
		}
		if (span.y) {
			factorY = clampFactor(
				Math.max(reach.y / span.y, minFactor(fullHeight)),
				options.range?.y
			);
		}
	}
	const centerLocal = options.fromCenter
		? { x: 0, y: 0 }
		: {
				x: anchor.x + (span.x * factorX) / 2,
				y: anchor.y + (span.y * factorY) / 2,
			};
	const center = pixelToNormalized(
		localToFramePx(start, frame, centerLocal),
		frame
	);
	return {
		cx: center.x,
		cy: center.y,
		height: start.height * factorY,
		rotation: start.rotation,
		width: start.width * factorX,
	};
}

/** Clockwise angle (degrees) of `point` around `center`, 0 pointing up. */
export function pointerAngle(center: Point, point: Point): number {
	return (
		(Math.atan2(point.x - center.x, -(point.y - center.y)) * 180) / Math.PI
	);
}

/**
 * Rotate a box by the angle the pointer swept around its center since the
 * gesture started. `snap` rounds the result to 15° steps.
 */
export function rotateBox(
	start: TransformBox,
	startPointerPx: Point,
	pointerPx: Point,
	frame: FrameSize,
	snap = false
): TransformBox {
	const center = boxCenterPx(start, frame);
	const swept =
		pointerAngle(center, pointerPx) - pointerAngle(center, startPointerPx);
	const rotation = normalizeDegrees(start.rotation + swept);
	return { ...start, rotation: snap ? snapRotation(rotation) : rotation };
}

/** Normalized lines a moved box may snap to. */
export interface SnapTargets {
	x: number[];
	y: number[];
}

/** Canvas center and edges, plus the edges and centers of `others`. */
export function snapTargets(
	others: readonly TransformBox[],
	frame: FrameSize
): SnapTargets {
	const x = [0, 0.5, 1];
	const y = [0, 0.5, 1];
	for (const other of others) {
		const extents = boxExtents(other, frame);
		x.push(extents.left, other.cx, extents.right);
		y.push(extents.top, other.cy, extents.bottom);
	}
	return { x, y };
}

/** Guides drawn while a box is snapped (normalized positions). */
export interface SnapGuides {
	x: number | null;
	y: number | null;
}

function nearestSnap(
	candidates: readonly number[],
	targets: readonly number[],
	threshold: number
): { offset: number; target: number } | null {
	let best: { distance: number; offset: number; target: number } | null = null;
	for (const target of targets) {
		for (const candidate of candidates) {
			const distance = Math.abs(target - candidate);
			if (distance <= threshold && (!best || distance < best.distance)) {
				best = { distance, offset: target - candidate, target };
			}
		}
	}
	return best && { offset: best.offset, target: best.target };
}

/**
 * Snap a moved box so its left edge, center or right edge (and top, center or
 * bottom) lands on the closest target within `thresholdPx`. Returns the
 * adjusted box and the guide lines to draw.
 */
export function snapMove(
	box: TransformBox,
	targets: SnapTargets,
	frame: FrameSize,
	thresholdPx = SNAP_THRESHOLD_PX
): { box: TransformBox; guides: SnapGuides } {
	const extents = boxExtents(box, frame);
	const snapX = nearestSnap(
		[extents.left, box.cx, extents.right],
		targets.x,
		frame.width ? thresholdPx / frame.width : 0
	);
	const snapY = nearestSnap(
		[extents.top, box.cy, extents.bottom],
		targets.y,
		frame.height ? thresholdPx / frame.height : 0
	);
	return {
		box: {
			...box,
			cx: box.cx + (snapX?.offset ?? 0),
			cy: box.cy + (snapY?.offset ?? 0),
		},
		guides: { x: snapX?.target ?? null, y: snapY?.target ?? null },
	};
}

/** Source pixel size of a clip's media (canvas size when unknown). */
export interface ContentSize {
	height: number;
	width: number;
}

/** Where a clip sits: its visible (cropped) box and the uncropped one. */
export interface SegmentPlacement {
	/** The crop window, as fractions of the uncropped source. */
	crop: Crop;
	/**
	 * The whole uncropped source at the scale it is drawn, so `crop` cut out
	 * of it gives `visible`.
	 */
	full: TransformBox;
	/** The cropped rectangle the viewer sees and the handles wrap. */
	visible: TransformBox;
}

/** The clip's crop at `elapsed` seconds into it (crop channels animate). */
export function animatedCrop(segment: Segment, elapsed: number): Crop {
	return {
		bottom: animatedValue(segment, "cropBottom", elapsed),
		left: animatedValue(segment, "cropLeft", elapsed),
		right: animatedValue(segment, "cropRight", elapsed),
		top: animatedValue(segment, "cropTop", elapsed),
	};
}

/**
 * Fraction of the canvas the media fills before scaling: the largest box
 * with the media's aspect that fits inside the canvas. This is the `fit`
 * (letterbox) base; `segmentPlacement` applies `scaleX`/`scaleY` and the
 * `fill`/`stretch` modes on top of it (see `shared/transform.ts`).
 */
export function fittedSize(
	content: ContentSize,
	canvas: FrameSize
): { height: number; width: number } {
	if (!(content.width > 0 && content.height > 0)) {
		return { height: 1, width: 1 };
	}
	const ratio =
		content.width / content.height / (canvas.width / canvas.height || 1);
	return ratio >= 1
		? { height: 1 / ratio, width: 1 }
		: { height: 1, width: ratio };
}

/** Pixel size of the part of `content` a crop leaves. */
export function croppedContentSize(
	content: ContentSize,
	crop: Crop
): ContentSize {
	return {
		height: content.height * Math.max(0, 1 - crop.top - crop.bottom),
		width: content.width * Math.max(0, 1 - crop.left - crop.right),
	};
}

/** Local (unrotated) pixel offset of the crop window's center from the full box center. */
function cropCenterOffsetPx(
	full: TransformBox,
	crop: Crop,
	frame: FrameSize
): Point {
	return {
		x: ((crop.left - crop.right) / 2) * full.width * frame.width,
		y: ((crop.top - crop.bottom) / 2) * full.height * frame.height,
	};
}

/** The visible box of a crop window inside an uncropped box. */
export function croppedBox(
	full: TransformBox,
	crop: Crop,
	frame: FrameSize
): TransformBox {
	const center = pixelToNormalized(
		localToFramePx(full, frame, cropCenterOffsetPx(full, crop, frame)),
		frame
	);
	return {
		cx: center.x,
		cy: center.y,
		height: full.height * (1 - crop.top - crop.bottom),
		rotation: full.rotation,
		width: full.width * (1 - crop.left - crop.right),
	};
}

/**
 * The uncropped box whose crop window is `visible`: the inverse of
 * `croppedBox`. A window with no width or height gives a box of that size.
 */
export function uncroppedBox(
	visible: TransformBox,
	crop: Crop,
	frame: FrameSize
): TransformBox {
	const keptWidth = 1 - crop.left - crop.right;
	const keptHeight = 1 - crop.top - crop.bottom;
	const sized: TransformBox = {
		...visible,
		height: keptHeight > 0 ? visible.height / keptHeight : visible.height,
		width: keptWidth > 0 ? visible.width / keptWidth : visible.width,
	};
	const offset = rotateVector(
		cropCenterOffsetPx(sized, crop, frame),
		visible.rotation
	);
	const center = pixelToNormalized(
		{
			x: visible.cx * frame.width - offset.x,
			y: visible.cy * frame.height - offset.y,
		},
		frame
	);
	return { ...sized, cx: center.x, cy: center.y };
}

/**
 * Where a clip is drawn at `elapsed` seconds into it, following the render
 * (`sidecar/src/render-stages/transform.ts`): the source is cropped first,
 * and the clip's box is the canvas times `scale`, then its width times
 * `scaleX` and its height times `scaleY`. `fit` letterboxes the kept part
 * inside the box, `stretch` distorts it to the box, and `fill` covers the box
 * by cutting a centred window (`fillCropWithin`) out of the kept part. The
 * box is centred at `x`/`y` (±1 is half the frame) and rotated about its
 * center, so a crop never moves the clip's center.
 *
 * `crop` stays the user crop the crop handles edit; for `fill`, `full` is
 * derived from the combined crop so it is the whole source at its drawn
 * scale. A `fill` clip whose box shape is keyframed is drawn covering the
 * box (the render keeps the first-frame crop), so its box is approximate.
 */
export function segmentPlacement(
	segment: Segment,
	content: ContentSize,
	canvas: FrameSize,
	elapsed: number
): SegmentPlacement {
	const crop = animatedCrop(segment, elapsed);
	const scale = animatedValue(segment, "scale", elapsed);
	const box = {
		height: scale * animatedValue(segment, "scaleY", elapsed),
		width: scale * animatedValue(segment, "scaleX", elapsed),
	};
	const mode = fitModeOf(segment);
	let size = box;
	let drawnCrop = crop;
	if (mode === "fit") {
		// Contain the kept part inside the box (normalized to the canvas).
		const base = fittedSize(croppedContentSize(content, crop), canvas);
		const factor = Math.min(box.width / base.width, box.height / base.height);
		size = { height: base.height * factor, width: base.width * factor };
	} else if (mode === "fill") {
		drawnCrop = fillCropWithin(
			crop,
			content.width,
			content.height,
			box.width * canvas.width,
			box.height * canvas.height
		);
	}
	const visible: TransformBox = {
		cx: 0.5 + animatedValue(segment, "x", elapsed) / 2,
		cy: 0.5 + animatedValue(segment, "y", elapsed) / 2,
		height: size.height,
		rotation: animatedValue(segment, "rotation", elapsed),
		width: size.width,
	};
	return { crop, full: uncroppedBox(visible, drawnCrop, canvas), visible };
}

/** Clip transform fields implied by a new visible box. */
export interface SegmentTransform {
	/** Multiplier for the current `scale` (1 when unchanged). */
	factor: number;
	rotation: number;
	/** New `x`/`y` (unclamped). */
	x: number;
	y: number;
}

/**
 * Invert `segmentPlacement`: the clip `x`/`y`, rotation and scale factor that
 * draw the visible box at `visible`. The box center is the clip center, and
 * clips scale uniformly, so the width ratio (the height ratio for a box with
 * no width) is the factor.
 */
export function segmentTransformFromBox(
	start: SegmentPlacement,
	visible: TransformBox
): SegmentTransform {
	const startVisible = start.visible;
	let factor = 1;
	if (startVisible.width) {
		factor = visible.width / startVisible.width;
	} else if (startVisible.height) {
		factor = visible.height / startVisible.height;
	}
	return {
		factor,
		rotation: visible.rotation,
		x: (visible.cx - 0.5) * 2,
		y: (visible.cy - 0.5) * 2,
	};
}

/**
 * Titles and graphics are drawn rotated by the preview (`PreviewTitles`,
 * vector graphic outlines) and the render (ASS `\frz`, baked graphic
 * layers), around their centers, so their boxes carry `rotation`, the
 * handles offer the rotation knob, and gestures write it.
 */
export const OVERLAY_ROTATION_DRAWN = true;

/** A graphic's box: `x`/`y` is its top-left corner; it rotates about its center. */
export function graphicBox(graphic: Graphic): TransformBox {
	return {
		cx: graphic.x + graphic.width / 2,
		cy: graphic.y + graphic.height / 2,
		height: graphic.height,
		rotation: graphic.rotation ?? 0,
		width: graphic.width,
	};
}

/** Average glyph advance of the title font, as a fraction of the font size. */
const TITLE_GLYPH_ADVANCE = 0.56;
/** Line box height, as a fraction of the font size. */
const TITLE_LINE_HEIGHT = 1.2;
/** Titles wrap at 90% of the frame width (see `.studio-title`). */
const TITLE_MAX_WIDTH = 0.9;

/**
 * Estimated title size (normalized) when the DOM cannot measure it: the
 * longest line times an average glyph advance, one line box per line.
 */
export function estimateTitleSize(
	title: Pick<Title, "fontSize" | "lineHeight" | "text">,
	canvas: FrameSize
): { height: number; width: number } {
	const lines = title.text.split("\n");
	const longest = Math.max(1, ...lines.map((line) => line.length));
	const fontPx = title.fontSize * canvas.height;
	const width = (longest * fontPx * TITLE_GLYPH_ADVANCE) / canvas.width;
	return {
		height:
			lines.length * title.fontSize * (title.lineHeight ?? TITLE_LINE_HEIGHT),
		width: Math.min(TITLE_MAX_WIDTH, width),
	};
}

/** A title's box: `x`/`y` is its center, which it rotates about. */
export function titleBox(
	title: Title,
	size: { height: number; width: number }
): TransformBox {
	return {
		cx: title.x,
		cy: title.y,
		height: size.height,
		rotation: title.rotation ?? 0,
		width: size.width,
	};
}

/** A rotation in degrees, wrapped into the overlay schema's -180..180. */
const overlayRotation = (degrees: number) =>
	roundGeometry(clamp(normalizeDegrees(degrees), -180, 180));

/** Crop aspect presets offered in crop mode. */
export const CROP_ASPECT_PRESETS = [
	{ id: "free", label: "Free", ratio: null },
	{ id: "16:9", label: "16:9", ratio: 16 / 9 },
	{ id: "9:16", label: "9:16", ratio: 9 / 16 },
	{ id: "1:1", label: "1:1", ratio: 1 },
	{ id: "4:5", label: "4:5", ratio: 4 / 5 },
	{ id: "4:3", label: "4:3", ratio: 4 / 3 },
] as const;
export type CropAspectId = (typeof CROP_ASPECT_PRESETS)[number]["id"];

export function cropAspectRatio(id: CropAspectId): number | null {
	return CROP_ASPECT_PRESETS.find((preset) => preset.id === id)?.ratio ?? null;
}

/** Pixel aspect ratio (width / height) of a crop window on `content`. */
export function cropWindowAspect(crop: Crop, content: ContentSize): number {
	const sourceAspect =
		content.width > 0 && content.height > 0
			? content.width / content.height
			: 1;
	const visibleHeight = 1 - crop.top - crop.bottom;
	return visibleHeight > 0
		? (sourceAspect * (1 - crop.left - crop.right)) / visibleHeight
		: sourceAspect;
}

interface CropWindow {
	height: number;
	left: number;
	top: number;
	width: number;
}

const toWindow = (crop: Crop): CropWindow => ({
	height: 1 - crop.top - crop.bottom,
	left: crop.left,
	top: crop.top,
	width: 1 - crop.left - crop.right,
});

/** A crop from a window, clamped into the schema's limits. */
function fromWindow(window: CropWindow): Crop {
	const width = clamp(window.width, MIN_CROP_VISIBLE, 1);
	const height = clamp(window.height, MIN_CROP_VISIBLE, 1);
	const left = clamp(window.left, 0, 1 - width);
	const top = clamp(window.top, 0, 1 - height);
	return {
		bottom: roundGeometry(clamp(1 - top - height, 0, MAX_CROP_EDGE)),
		left: roundGeometry(clamp(left, 0, MAX_CROP_EDGE)),
		right: roundGeometry(clamp(1 - left - width, 0, MAX_CROP_EDGE)),
		top: roundGeometry(clamp(top, 0, MAX_CROP_EDGE)),
	};
}

/** Clamp any crop into the schema's limits (each edge ≤ 0.9, a visible window left). */
export function clampCrop(crop: Crop): Crop {
	return fromWindow(toWindow(crop));
}

/**
 * The largest window with pixel aspect `ratio` that fits the source, centered
 * on the current window's center (shifted inward when it would overflow).
 */
export function cropToAspect(
	crop: Crop,
	ratio: number,
	content: ContentSize
): Crop {
	const sourceAspect =
		content.width > 0 && content.height > 0
			? content.width / content.height
			: 1;
	// Window width/height in source fractions with width/height = ratio in pixels.
	const relative = ratio / sourceAspect;
	const width = relative >= 1 ? 1 : relative;
	const height = relative >= 1 ? 1 / relative : 1;
	const current = toWindow(crop);
	const centerX = current.left + current.width / 2;
	const centerY = current.top + current.height / 2;
	return fromWindow({
		height,
		left: clamp(centerX - width / 2, 0, 1 - width),
		top: clamp(centerY - height / 2, 0, 1 - height),
		width,
	});
}

/** Move the crop window by a source-normalized delta, keeping its size. */
export function moveCrop(crop: Crop, delta: Point): Crop {
	const window = toWindow(crop);
	return fromWindow({
		...window,
		left: clamp(window.left + delta.x, 0, 1 - window.width),
		top: clamp(window.top + delta.y, 0, 1 - window.height),
	});
}

/**
 * Drag one crop handle by a source-normalized delta (fractions of the full
 * source width/height). With an aspect `ratio`, corner drags keep it
 * (the opposite corner stays fixed) and edge drags are ignored.
 */
export function dragCropHandle(
	crop: Crop,
	handle: ScaleHandle,
	delta: Point,
	options: { content: ContentSize; ratio: number | null }
): Crop {
	const unit = handleUnit[handle];
	if (options.ratio !== null) {
		if (!isCornerHandle(handle)) {
			return clampCrop(crop);
		}
		return dragLockedCorner(crop, unit, delta, options.ratio, options.content);
	}
	const window = toWindow(crop);
	let { left, top } = window;
	let right = window.left + window.width;
	let bottom = window.top + window.height;
	if (unit.x < 0) {
		left = clamp(left + delta.x, 0, right - MIN_CROP_VISIBLE);
	} else if (unit.x > 0) {
		right = clamp(right + delta.x, left + MIN_CROP_VISIBLE, 1);
	}
	if (unit.y < 0) {
		top = clamp(top + delta.y, 0, bottom - MIN_CROP_VISIBLE);
	} else if (unit.y > 0) {
		bottom = clamp(bottom + delta.y, top + MIN_CROP_VISIBLE, 1);
	}
	return fromWindow({ height: bottom - top, left, top, width: right - left });
}

function dragLockedCorner(
	crop: Crop,
	unit: Point,
	delta: Point,
	ratio: number,
	content: ContentSize
): Crop {
	const sourceAspect =
		content.width > 0 && content.height > 0
			? content.width / content.height
			: 1;
	const relative = ratio / sourceAspect;
	const window = toWindow(crop);
	const anchorX = unit.x > 0 ? window.left : window.left + window.width;
	const anchorY = unit.y > 0 ? window.top : window.top + window.height;
	const proposedWidth = window.width + unit.x * delta.x;
	const proposedHeight = window.height + unit.y * delta.y;
	// Follow whichever axis the pointer moved further, in pixel terms.
	let width = Math.max(proposedWidth, proposedHeight * relative);
	const roomX = unit.x > 0 ? 1 - anchorX : anchorX;
	const roomY = unit.y > 0 ? 1 - anchorY : anchorY;
	width = clamp(
		width,
		Math.max(MIN_CROP_VISIBLE, MIN_CROP_VISIBLE * relative),
		Math.min(roomX, roomY * relative)
	);
	const height = width / relative;
	return fromWindow({
		height,
		left: unit.x > 0 ? anchorX : anchorX - width,
		top: unit.y > 0 ? anchorY : anchorY - height,
		width,
	});
}

/** Clip properties direct manipulation writes (all keyframable). */
export type SegmentGeometryProperty =
	| "x"
	| "y"
	| "scale"
	| "scaleX"
	| "scaleY"
	| "rotation"
	| "cropLeft"
	| "cropRight"
	| "cropTop"
	| "cropBottom";
export type SegmentGeometryChanges = Partial<
	Record<SegmentGeometryProperty, number>
>;

const cropEdgeOf: Partial<Record<SegmentGeometryProperty, keyof Crop>> = {
	cropBottom: "bottom",
	cropLeft: "left",
	cropRight: "right",
	cropTop: "top",
};

/** Values closer than this count as unchanged. */
const UNCHANGED_EPSILON = 1e-6;

const keyframeTimeOf = (value: number) => Number(value.toFixed(6));

/** Clamp a value into the property's schema range and round off float noise. */
export function clampGeometryValue(
	property: KeyframeProperty,
	value: number
): number {
	const [min, max] = keyframeValueBounds(property);
	return roundGeometry(clamp(value, min, max));
}

/** Whether the clip animates `property` (an untargeted channel). */
export function hasKeyframes(
	segment: Pick<Segment, "keyframes">,
	property: KeyframeProperty
): boolean {
	return segment.keyframes.some(inKeyframeGroup({ property }));
}

export interface KeyframeWriteOptions {
	/** Id factory for inserted keyframes (tests pass a deterministic one). */
	newId?: () => string;
	/** Existing keyframes within this many seconds are replaced, not doubled. */
	tolerance?: number;
}

/**
 * Set `property` to `value` at clip time `elapsed`: replace the keyframe
 * already there (within `tolerance`) or insert one that keeps the curve
 * shape of the keyframe it follows.
 */
export function upsertKeyframe(
	keyframes: readonly Keyframe[],
	property: KeyframeProperty,
	elapsed: number,
	value: number,
	options: KeyframeWriteOptions = {}
): Keyframe[] {
	const inGroup = inKeyframeGroup({ property });
	const time = keyframeTimeOf(Math.max(0, elapsed));
	const tolerance = options.tolerance ?? 1e-6;
	const existing = keyframes.find(
		(frame) => inGroup(frame) && Math.abs(frame.time - time) <= tolerance
	);
	if (existing) {
		return keyframes.map((frame) =>
			frame === existing ? { ...frame, value } : frame
		);
	}
	const previous = keyframes
		.filter((frame) => inGroup(frame) && frame.time <= time)
		.sort((a, b) => b.time - a.time)[0];
	const frame: Keyframe = {
		id: (options.newId ?? (() => crypto.randomUUID()))(),
		property,
		time,
		value,
	};
	if (previous?.interpolation !== undefined) {
		frame.interpolation = previous.interpolation;
	}
	if (previous?.bezier !== undefined) {
		frame.bezier = previous.bezier;
	}
	return [...keyframes, frame];
}

/**
 * The `clip-properties` patch for new geometry values at clip time
 * `elapsed`. Animated properties get a keyframe at the playhead; static ones
 * change the clip field. Unchanged values are left out, so an empty object
 * means there is nothing to write.
 */
export function segmentGeometryPatch(
	segment: Segment,
	changes: SegmentGeometryChanges,
	elapsed: number,
	options: KeyframeWriteOptions = {}
): Partial<Segment> {
	const patch: Partial<Segment> = {};
	let keyframes = segment.keyframes;
	let crop: Crop | null = null;
	for (const [key, raw] of Object.entries(changes)) {
		const property = key as SegmentGeometryProperty;
		if (raw === undefined || !Number.isFinite(raw)) {
			continue;
		}
		const value = clampGeometryValue(property, raw);
		if (
			Math.abs(value - animatedValue(segment, property, elapsed)) <
			UNCHANGED_EPSILON
		) {
			continue;
		}
		const edge = cropEdgeOf[property];
		if (hasKeyframes(segment, property)) {
			keyframes = upsertKeyframe(keyframes, property, elapsed, value, options);
		} else if (edge) {
			crop = { ...(crop ?? segment.crop), [edge]: value };
		} else {
			patch[property as Exclude<SegmentGeometryProperty, `crop${string}`>] =
				value;
		}
	}
	if (crop) {
		patch.crop = clampCrop(crop);
	}
	if (keyframes !== segment.keyframes) {
		patch.keyframes = keyframes;
	}
	return patch;
}

const factorRange = (current: number, [min, max]: readonly [number, number]) =>
	current > 0 ? ([min / current, max / current] as const) : undefined;

/** Factor limits for scaling a clip's `scale` at `elapsed`. */
export function segmentScaleRange(
	segment: Segment,
	elapsed: number,
	handle?: ScaleHandle
): NonNullable<ScaleOptions["range"]> {
	if (handle && !isCornerHandle(handle)) {
		// Edge handles stretch one axis through scaleX / scaleY.
		return {
			x: factorRange(
				animatedValue(segment, "scaleX", elapsed),
				keyframeValueBounds("scaleX")
			),
			y: factorRange(
				animatedValue(segment, "scaleY", elapsed),
				keyframeValueBounds("scaleY")
			),
		};
	}
	const range = factorRange(
		animatedValue(segment, "scale", elapsed),
		keyframeValueBounds("scale")
	);
	return { x: range, y: range };
}

const changed = (next: number, current: number) =>
	Math.abs(next - current) >= UNCHANGED_EPSILON;

/**
 * Geometry changes that draw the clip's visible box at `visible`. A corner
 * handle keeps the box aspect, so both axes scale by one factor and `scale`
 * is written; an edge handle stretches one axis, which writes that axis's
 * `scaleX` or `scaleY` (the box shape) and leaves `scale` alone.
 */
export function segmentGestureChanges(
	segment: Segment,
	start: SegmentPlacement,
	visible: TransformBox,
	elapsed: number
): SegmentGeometryChanges {
	const transform = segmentTransformFromBox(start, visible);
	const current = (property: SegmentGeometryProperty) =>
		animatedValue(segment, property, elapsed);
	const changes: SegmentGeometryChanges = {};
	if (changed(transform.x, current("x"))) {
		changes.x = transform.x;
	}
	if (changed(transform.y, current("y"))) {
		changes.y = transform.y;
	}
	if (changed(normalizeDegrees(transform.rotation), current("rotation"))) {
		changes.rotation = normalizeDegrees(transform.rotation);
	}
	const factorX = start.visible.width
		? visible.width / start.visible.width
		: transform.factor;
	const factorY = start.visible.height
		? visible.height / start.visible.height
		: transform.factor;
	if (Math.abs(factorX - factorY) >= 1e-4) {
		if (changed(factorX, 1)) {
			changes.scaleX = current("scaleX") * factorX;
		}
		if (changed(factorY, 1)) {
			changes.scaleY = current("scaleY") * factorY;
		}
	} else if (changed(transform.factor, 1)) {
		changes.scale = current("scale") * transform.factor;
	}
	return changes;
}

/** Geometry changes for a new crop window. */
export function cropGestureChanges(next: Crop): SegmentGeometryChanges {
	const crop = clampCrop(next);
	return {
		cropBottom: crop.bottom,
		cropLeft: crop.left,
		cropRight: crop.right,
		cropTop: crop.top,
	};
}

const unit = (value: number) => roundGeometry(clamp(value, 0, 1));

/** Font-size factor limits for scaling a title. */
export function titleScaleRange(
	title: Pick<Title, "fontSize">
): NonNullable<ScaleOptions["range"]> {
	const range = factorRange(title.fontSize, [0.02, 0.2]);
	return { x: range, y: range };
}

/** The title patch for a moved, scaled (font size) or rotated box. */
export function titleGesturePatch(
	title: Title,
	start: TransformBox,
	box: TransformBox
): Partial<Title> {
	const patch: Partial<Title> = {};
	const rotation = overlayRotation(box.rotation);
	if (changed(rotation, title.rotation ?? 0)) {
		patch.rotation = rotation;
	}
	const x = unit(box.cx);
	const y = unit(box.cy);
	if (changed(x, title.x)) {
		patch.x = x;
	}
	if (changed(y, title.y)) {
		patch.y = y;
	}
	const factor = start.width ? box.width / start.width : 1;
	if (changed(factor, 1)) {
		patch.fontSize = roundGeometry(clamp(title.fontSize * factor, 0.02, 0.2));
	}
	return patch;
}

/** Width/height factor limits for scaling a graphic. */
export function graphicScaleRange(
	graphic: Pick<Graphic, "height" | "width">
): NonNullable<ScaleOptions["range"]> {
	return {
		x: factorRange(graphic.width, [0.02, 1]),
		y: factorRange(graphic.height, [0.02, 1]),
	};
}

/** The graphic patch for a moved, resized or rotated box (`x`/`y` is its top-left). */
export function graphicGesturePatch(
	graphic: Graphic,
	box: TransformBox
): Partial<Graphic> {
	const patch: Partial<Graphic> = {};
	const rotation = overlayRotation(box.rotation);
	if (changed(rotation, graphic.rotation ?? 0)) {
		patch.rotation = rotation;
	}
	const width = roundGeometry(clamp(box.width, 0.02, 1));
	const height = roundGeometry(clamp(box.height, 0.02, 1));
	const x = unit(box.cx - width / 2);
	const y = unit(box.cy - height / 2);
	for (const [key, value] of [
		["width", width],
		["height", height],
		["x", x],
		["y", y],
	] as const) {
		if (changed(value, graphic[key])) {
			patch[key] = value;
		}
	}
	return patch;
}
