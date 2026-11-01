/**
 * Layout presets (W2-V9): slot tables that place selected visual clips into
 * a composition, plus an optional `fit`/`fill` choice. `fill` writes
 * `segment.fit = "fill"` and a centred cover crop for the cell aspect
 * (`fillCrop` from `shared/transform.ts`), so a cell is never letterboxed.
 * `fit` later removes a crop that a fill wrote. Clips on locked tracks are
 * refused, as other clip-property edits do.
 *
 * Everything here is pure and deterministic; the UI (`ui/src/LayoutPanel.tsx`)
 * and the `layout` route share it.
 */
import { z } from "zod";
// Type-only: `project.ts` imports `layoutSchema` from here, so a value
// import would be circular.
import type { Asset, Crop, Project, Segment } from "./project.ts";
import { idSchema } from "./schema/primitives.ts";
import { fillCrop } from "./transform.ts";

export const layoutSchema = z.enum([
	"single",
	"side-by-side",
	"stacked",
	"grid-2x2",
	"grid-3x3",
	"grid-4x4",
	"picture-in-picture",
	"pip-top-left",
	"pip-top-right",
	"pip-bottom-left",
	"pip-bottom-right",
	"main-sidebar",
	"three-up",
	"three-stack",
]);
export type Layout = z.infer<typeof layoutSchema>;

/** How media sits in a layout cell: letterboxed (`fit`) or cropped to cover (`fill`). */
export const layoutFitSchema = z.enum(["fit", "fill"]);
export type LayoutFit = z.infer<typeof layoutFitSchema>;

/**
 * Agent and route body for applying a layout. `fit` is optional: when it is
 * absent the clips keep their fit mode and crop (the legacy behaviour).
 */
export const layoutRequestSchema = z
	.object({
		fit: layoutFitSchema.optional(),
		layout: layoutSchema,
		revision: z.number().int().nonnegative(),
		segmentIds: z.array(idSchema).min(1).max(16),
	})
	.strict();
export type LayoutRequest = z.infer<typeof layoutRequestSchema>;

/** Every layout now has a slot table (kept for callers that feature-check). */
export function layoutSupported(layout: Layout): boolean {
	return layoutSchema.options.includes(layout);
}

/**
 * One cell of a layout. The cell is the clip box on the canvas: the canvas
 * multiplied by `scale`, then its width by `scaleX` and its height by
 * `scaleY` (absent means 1). `x`/`y` place the cell centre in half-canvas
 * units, as the render's overlay position does (`0` is the canvas centre,
 * `-1`/`1` its edges).
 */
export interface LayoutSlot {
	scale: number;
	scaleX?: number;
	scaleY?: number;
	x: number;
	y: number;
}

/** Inset size of the corner picture-in-picture layouts, as a canvas fraction. */
export const PIP_CORNER_SCALE = 0.25;
/** Gap between a corner inset and the canvas edges, as a canvas fraction. */
export const PIP_CORNER_MARGIN = 0.04;
/** Width share of the main cell in `main-sidebar`. */
export const MAIN_SIDEBAR_SPLIT = 0.7;

function gridSlots(size: number): readonly LayoutSlot[] {
	const scale = 1 / size;
	return Array.from({ length: size * size }, (_, index) => ({
		scale,
		x: ((index % size) + 0.5) * 2 * scale - 1,
		y: (Math.floor(index / size) + 0.5) * 2 * scale - 1,
	}));
}

/** Centre, in half-canvas units, of a span that starts at `from` (canvas fraction). */
const spanCentre = (from: number, size: number) => (from + size / 2) * 2 - 1;

function cornerSlots(horizontal: -1 | 1, vertical: -1 | 1): LayoutSlot[] {
	const offset = -spanCentre(PIP_CORNER_MARGIN, PIP_CORNER_SCALE);
	return [
		{ scale: 1, x: 0, y: 0 },
		{
			scale: PIP_CORNER_SCALE,
			x: horizontal * offset,
			y: vertical * offset,
		},
	];
}

/** Equal columns (`axis: "x"`) or rows (`axis: "y"`) across the whole canvas. */
function bandSlots(count: number, axis: "x" | "y"): LayoutSlot[] {
	const share = 1 / count;
	return Array.from({ length: count }, (_, index) => {
		const centre = spanCentre(index * share, share);
		return axis === "x"
			? { scale: 1, scaleX: share, x: centre, y: 0 }
			: { scale: 1, scaleY: share, x: 0, y: centre };
	});
}

/**
 * The slot table of a layout, in selection order. Pure and deterministic:
 * the same layout always returns equal slots.
 */
export function layoutSlots(layout: Layout): readonly LayoutSlot[] {
	switch (layout) {
		case "side-by-side":
			return [
				{ scale: 0.5, x: -0.5, y: 0 },
				{ scale: 0.5, x: 0.5, y: 0 },
			];
		case "stacked":
			return [
				{ scale: 0.5, x: 0, y: -0.5 },
				{ scale: 0.5, x: 0, y: 0.5 },
			];
		case "grid-2x2":
			return gridSlots(2);
		case "grid-3x3":
			return gridSlots(3);
		case "grid-4x4":
			return gridSlots(4);
		case "picture-in-picture":
			return [
				{ scale: 1, x: 0, y: 0 },
				{ scale: 0.35, x: 0.55, y: -0.55 },
			];
		case "pip-top-left":
			return cornerSlots(-1, -1);
		case "pip-top-right":
			return cornerSlots(1, -1);
		case "pip-bottom-left":
			return cornerSlots(-1, 1);
		case "pip-bottom-right":
			return cornerSlots(1, 1);
		case "main-sidebar":
			return [
				{
					scale: 1,
					scaleX: MAIN_SIDEBAR_SPLIT,
					x: spanCentre(0, MAIN_SIDEBAR_SPLIT),
					y: 0,
				},
				{
					scale: 1,
					scaleX: 1 - MAIN_SIDEBAR_SPLIT,
					x: spanCentre(MAIN_SIDEBAR_SPLIT, 1 - MAIN_SIDEBAR_SPLIT),
					y: 0,
				},
			];
		case "three-up":
			return bandSlots(3, "x");
		case "three-stack":
			return bandSlots(3, "y");
		default:
			return [{ scale: 1, x: 0, y: 0 }];
	}
}

/** A slot's rectangle as canvas fractions (left/top edge plus size). */
export function slotRect(slot: LayoutSlot): {
	height: number;
	left: number;
	top: number;
	width: number;
} {
	const width = slot.scale * (slot.scaleX ?? 1);
	const height = slot.scale * (slot.scaleY ?? 1);
	return {
		height,
		left: (slot.x + 1) / 2 - width / 2,
		top: (slot.y + 1) / 2 - height / 2,
		width,
	};
}

/** Pixel size of a slot's cell on a canvas. */
export function slotCellSize(
	slot: LayoutSlot,
	canvas: { height: number; width: number }
): { height: number; width: number } {
	const rect = slotRect(slot);
	return {
		height: canvas.height * rect.height,
		width: canvas.width * rect.width,
	};
}

const MAX_CROP_EDGE = 0.9;

/**
 * Crop that makes an asset cover a slot's cell without distortion, or `null`
 * when the asset has no known pixel size (the render's `fill` crop then
 * covers the cell on its own).
 */
export function slotFillCrop(
	slot: LayoutSlot,
	asset: Pick<Asset, "height" | "width">,
	canvas: { height: number; width: number }
): Crop | null {
	if (!(asset.width > 0 && asset.height > 0)) {
		return null;
	}
	const cell = slotCellSize(slot, canvas);
	const crop = fillCrop(asset.width, asset.height, cell.width, cell.height);
	return {
		bottom: Math.min(MAX_CROP_EDGE, crop.bottom),
		left: Math.min(MAX_CROP_EDGE, crop.left),
		right: Math.min(MAX_CROP_EDGE, crop.right),
		top: Math.min(MAX_CROP_EDGE, crop.top),
	};
}

export function layoutLabel(layout: Layout): string {
	switch (layout) {
		case "side-by-side":
			return "Side by side";
		case "picture-in-picture":
			return "Picture in picture";
		case "grid-2x2":
			return "2 × 2 grid";
		case "grid-3x3":
			return "3 × 3 grid";
		case "grid-4x4":
			return "4 × 4 grid";
		case "stacked":
			return "Stacked";
		case "pip-top-left":
			return "Picture in picture, top left";
		case "pip-top-right":
			return "Picture in picture, top right";
		case "pip-bottom-left":
			return "Picture in picture, bottom left";
		case "pip-bottom-right":
			return "Picture in picture, bottom right";
		case "main-sidebar":
			return "Main and sidebar";
		case "three-up":
			return "Three up";
		case "three-stack":
			return "Three stacked";
		default:
			return "Single frame";
	}
}

export function layoutRange(layout: Layout): { max: number; min: number } {
	const count = layoutSlots(layout).length;
	return ["grid-2x2", "grid-3x3", "grid-4x4"].includes(layout)
		? { max: count, min: 2 }
		: { max: count, min: count };
}

/** Options for `applyLayout`. */
export interface LayoutOptions {
	/**
	 * Library assets, used for their pixel size when `fit` is `fill` (an
	 * unknown or unsized asset is assumed to share the canvas aspect).
	 */
	assets?: readonly Pick<Asset, "height" | "id" | "width">[];
	/** Absent keeps each clip's fit mode and crop. */
	fit?: LayoutFit;
}

/** Keyframes a layout replaces: placement, and crop when it writes one. */
const placementProperties: ReadonlySet<string> = new Set([
	"scale",
	"scaleX",
	"scaleY",
	"x",
	"y",
]);
const cropProperties: ReadonlySet<string> = new Set([
	"cropBottom",
	"cropLeft",
	"cropRight",
	"cropTop",
]);

const NO_CROP: Crop = { bottom: 0, left: 0, right: 0, top: 0 };
const CROP_EPSILON = 1e-6;

const sameCrop = (a: Crop, b: Crop) =>
	Math.abs(a.bottom - b.bottom) <= CROP_EPSILON &&
	Math.abs(a.left - b.left) <= CROP_EPSILON &&
	Math.abs(a.right - b.right) <= CROP_EPSILON &&
	Math.abs(a.top - b.top) <= CROP_EPSILON;

/**
 * Pixel size used for a clip's fill crop: the asset's size, or the canvas
 * size when the asset is unknown or unsized. The canvas fallback matches the
 * preview's own assumption (media shares the canvas aspect), so the preview
 * stays inside the cell; the render's `fill` crop still covers the cell if
 * the real media has another aspect.
 */
function fillMediaSize(
	segment: Segment,
	project: Pick<Project, "height" | "width">,
	options: LayoutOptions
): { height: number; width: number } {
	const asset = options.assets?.find((item) => item.id === segment.assetId);
	return asset && asset.width > 0 && asset.height > 0
		? { height: asset.height, width: asset.width }
		: { height: project.height, width: project.width };
}

/** The crop a layout fill writes for a clip in `slot`. */
function layoutFillCrop(
	segment: Segment,
	slot: LayoutSlot,
	project: Pick<Project, "height" | "width">,
	options: LayoutOptions
): Crop {
	return (
		slotFillCrop(slot, fillMediaSize(segment, project, options), project) ??
		NO_CROP
	);
}

/**
 * Whether a clip's crop is the one a layout fill wrote for its current box,
 * so switching that clip to `fit` can remove it instead of letterboxing a
 * still-cropped frame.
 */
export function isLayoutFillCrop(
	segment: Segment,
	project: Pick<Project, "height" | "width">,
	options: LayoutOptions = {}
): boolean {
	if (segment.fit !== "fill" || sameCrop(segment.crop, NO_CROP)) {
		return false;
	}
	const currentSlot: LayoutSlot = {
		scale: segment.scale,
		scaleX: segment.scaleX,
		scaleY: segment.scaleY,
		x: segment.x,
		y: segment.y,
	};
	return sameCrop(
		segment.crop,
		layoutFillCrop(segment, currentSlot, project, options)
	);
}

function placeSegment(
	segment: Segment,
	slot: LayoutSlot,
	project: Pick<Project, "height" | "width">,
	options: LayoutOptions
): Segment {
	// Spreads that override existing keys keep their position, so a legacy
	// clip serializes in the same key order as before.
	const { scaleX: _scaleX, scaleY: _scaleY, ...unscaled } = segment;
	const base: Segment = options.fit === "fit" ? withoutFit(unscaled) : unscaled;
	let crop: Crop | null = null;
	if (options.fit === "fill") {
		crop = layoutFillCrop(segment, slot, project, options);
	} else if (
		options.fit === "fit" &&
		isLayoutFillCrop(segment, project, options)
	) {
		crop = NO_CROP;
	}
	return {
		...base,
		scale: slot.scale,
		x: slot.x,
		y: slot.y,
		...(crop ? { crop: { ...crop } } : {}),
		keyframes: segment.keyframes.filter(
			(frame) =>
				!(
					placementProperties.has(frame.property) ||
					(options.fit === "fill" && cropProperties.has(frame.property))
				)
		),
		...(slot.scaleX === undefined ? {} : { scaleX: slot.scaleX }),
		...(slot.scaleY === undefined ? {} : { scaleY: slot.scaleY }),
		...(options.fit === "fill" ? { fit: "fill" as const } : {}),
	};
}

function withoutFit(segment: Segment): Segment {
	const { fit: _fit, ...rest } = segment;
	return rest;
}

export function applyLayout(
	project: Project,
	segmentIds: readonly string[],
	layout: Layout,
	options: LayoutOptions = {}
): Project {
	const ids = [...segmentIds];
	if (new Set(ids).size !== ids.length) {
		throw new Error("Select unique visual clips for the layout.");
	}
	const { max, min } = layoutRange(layout);
	if (ids.length < min || ids.length > max) {
		throw new Error(
			`${layoutLabel(layout)} needs ${min === max ? min : `${min}–${max}`} visual clips.`
		);
	}
	const selected = new Set(ids);
	if (
		ids.some((id) => !project.segments.some((segment) => segment.id === id))
	) {
		throw new Error("A selected layout clip is no longer on this timeline.");
	}
	const visualIds = new Set(
		project.segments
			.filter((segment) => selected.has(segment.id))
			.map((segment) => segment.id)
	);
	if (visualIds.size !== ids.length) {
		throw new Error("Select unique visual clips for the layout.");
	}
	// Same rule as `trackSettingFor(...).locked` in the other clip edits;
	// read directly because `project.ts` cannot be value-imported here.
	const lockedTracks = new Set(
		project.trackSettings
			.filter((setting) => setting.locked)
			.map((setting) => setting.track)
	);
	if (
		project.segments.some(
			(segment) => selected.has(segment.id) && lockedTracks.has(segment.track)
		)
	) {
		throw new Error(
			"Unlock every layout clip's track before applying a layout."
		);
	}
	const table = layoutSlots(layout);
	const placement = new Map(
		ids.map((id, index) => [id, table[index]!] as const)
	);
	return {
		...project,
		segments: project.segments.map((segment) => {
			const slot = placement.get(segment.id);
			return slot ? placeSegment(segment, slot, project, options) : segment;
		}),
	};
}
