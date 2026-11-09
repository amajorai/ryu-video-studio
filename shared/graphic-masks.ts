/**
 * Masks on shape graphics. A graphic's masks live in its own box (`x`/`y`
 * across the box in `-1..1`, sizes as fractions of it, stroke width as a
 * fraction of its height), before the graphic's rotation, exactly as clip
 * masks live in the clip frame. The render applies them to the graphic's
 * raster in `applyGraphicMasks` (blurring feathered mattes like the clip
 * render, mirroring at the box border); the preview draws the same mask
 * SVGs (`maskToSvg`, `maskStrokeSvg`) as SVG masks placed on the box.
 * Graphic masks are static and never text masks.
 */
import { z } from "zod";
import {
	type Mask,
	maskAlphaAtPoint,
	maskFeatherSigma,
	maskHasStroke,
	maskStrokeAlphaAtPoint,
	maskStrokeColorOf,
	maskStrokeSvg,
	maskSvgDataUrl,
	maskSvgPad,
	rampMaskShapes,
} from "./masks.ts";
import { graphicSchema, type Project } from "./project.ts";
import { idSchema } from "./schema/primitives.ts";
import {
	type FrameSize,
	type GraphicRaster,
	graphicBoxPx,
	graphicFrameState,
	graphicRaster,
	graphicRasterHalf,
	graphicShapeAt,
	hexToRgb,
	type ShapeGraphic,
} from "./shape-geometry.ts";

export const graphicMasksOf = (graphic: Pick<ShapeGraphic, "masks">): Mask[] =>
	graphic.masks ?? [];

/**
 * Half side of a masked graphic's raster: a stroked mask can draw anywhere
 * in the box, so the raster then covers the whole box at any rotation.
 */
export function maskedGraphicRasterHalf(
	graphic: ShapeGraphic,
	frame: FrameSize
): number {
	const half = graphicRasterHalf(graphic, frame);
	if (!graphicMasksOf(graphic).some(maskHasStroke)) {
		return half;
	}
	const box = graphicBoxPx(graphic, frame);
	return Math.max(half, Math.ceil(Math.hypot(box.width, box.height) / 2) + 2);
}

/** Reflects `value` into `0..size`, as FFmpeg's blur mirrors a border. */
function reflect(value: number, size: number): number {
	if (size <= 0) {
		return 0;
	}
	const period = 2 * size;
	const wrapped = ((value % period) + period) % period;
	return wrapped > size ? period - wrapped : wrapped;
}

/** Three box-blur passes of `radius` over a `side`×`side` matte, both axes. */
export function boxBlurMatte(
	matte: Float32Array<ArrayBuffer>,
	side: number,
	radius: number
): Float32Array<ArrayBuffer> {
	const r = Math.floor(radius);
	if (r <= 0) {
		return matte;
	}
	let source = matte;
	let target = new Float32Array(matte.length);
	const pass = (horizontal: boolean) => {
		for (let line = 0; line < side; line++) {
			let sum = 0;
			const at = (index: number) => {
				const clamped = Math.min(side - 1, Math.max(0, index));
				return horizontal
					? (source[line * side + clamped] ?? 0)
					: (source[clamped * side + line] ?? 0);
			};
			for (let index = -r; index <= r; index++) {
				sum += at(index);
			}
			for (let index = 0; index < side; index++) {
				const out = horizontal ? line * side + index : index * side + line;
				target[out] = sum / (2 * r + 1);
				sum += at(index + r + 1) - at(index - r);
			}
		}
		[source, target] = [target, source];
	};
	for (let repeat = 0; repeat < 3; repeat++) {
		pass(true);
		pass(false);
	}
	return source;
}

/**
 * Applies the graphic's masks to its raster in place and returns it: every
 * mask's matte (blurred for a feather, mirrored at the box border, empty
 * outside the box and its blur pad) multiplies the alpha, then each stroked mask's band is drawn over in its color,
 * inside the box, at the baked opacity. `shape` is the graphic as drawn
 * (`graphicShapeAt`), `bake` the rotation and opacity the raster baked.
 */
export function applyGraphicMasks(
	raster: GraphicRaster,
	shape: ShapeGraphic,
	frame: FrameSize,
	bake: { opacity: number; rotation: number }
): GraphicRaster {
	const masks = graphicMasksOf(shape);
	if (masks.length === 0) {
		return raster;
	}
	const box = graphicBoxPx(shape, frame);
	const side = raster.pixelSize;
	const scale = side / raster.size;
	const half = raster.size / 2;
	const radians = (bake.rotation * Math.PI) / 180;
	const cos = Math.cos(radians);
	const sin = Math.sin(radians);
	/** Raster pixel → position in the box frame, in box pixels. */
	const boxPoint = (index: number) => {
		const ox = ((index % side) + 0.5) / scale - half;
		const oy = (Math.floor(index / side) + 0.5) / scale - half;
		return {
			x: ox * cos + oy * sin + box.width / 2,
			y: oy * cos - ox * sin + box.height / 2,
		};
	};
	const pixels = raster.pixels;
	const count = side * side;
	const alpha = new Float32Array(count).fill(1);
	for (const mask of masks) {
		const sigma = rampMaskShapes.has(mask.shape)
			? 0
			: maskFeatherSigma(mask.feather, box.width, box.height) * scale;
		// The mask covers the box (grown by the blur pad), like the preview's
		// mask image; outside it the graphic is hidden. A blurred matte sees
		// the box mirrored past its border, as the clip render's blur does.
		const pad = maskSvgPad(mask, box.width, box.height);
		let matte: Float32Array<ArrayBuffer> = new Float32Array(count);
		for (let index = 0; index < count; index++) {
			const point = boxPoint(index);
			const covered =
				point.x >= -pad &&
				point.y >= -pad &&
				point.x <= box.width + pad &&
				point.y <= box.height + pad;
			if (!covered) {
				continue;
			}
			matte[index] =
				sigma > 0
					? maskAlphaAtPoint(
							mask,
							reflect(point.x, box.width),
							reflect(point.y, box.height),
							box.width,
							box.height
						)
					: maskAlphaAtPoint(mask, point.x, point.y, box.width, box.height);
		}
		matte = boxBlurMatte(matte, side, sigma);
		for (let index = 0; index < count; index++) {
			alpha[index] = (alpha[index] ?? 1) * (matte[index] ?? 1);
		}
	}
	for (let index = 0; index < count; index++) {
		const offset = index * 4 + 3;
		pixels[offset] = Math.round((pixels[offset] ?? 0) * (alpha[index] ?? 1));
	}
	for (const mask of masks.filter(maskHasStroke)) {
		const [red, green, blue] = hexToRgb(maskStrokeColorOf(mask));
		for (let index = 0; index < count; index++) {
			const point = boxPoint(index);
			if (
				point.x < 0 ||
				point.y < 0 ||
				point.x > box.width ||
				point.y > box.height
			) {
				continue;
			}
			const stroke =
				maskStrokeAlphaAtPoint(mask, point.x, point.y, box.width, box.height) *
				bake.opacity;
			if (stroke <= 0) {
				continue;
			}
			const at = index * 4;
			const under = (pixels[at + 3] ?? 0) / 255;
			const out = stroke + under * (1 - stroke);
			const mix = (top: number, bottom: number) =>
				Math.round((top * stroke + bottom * under * (1 - stroke)) / out);
			pixels[at] = mix(red, pixels[at] ?? 0);
			pixels[at + 1] = mix(green, pixels[at + 1] ?? 0);
			pixels[at + 2] = mix(blue, pixels[at + 2] ?? 0);
			pixels[at + 3] = Math.round(out * 255);
		}
	}
	return raster;
}

/** `graphicRaster` with the graphic's masks applied (`applyGraphicMasks`). */
export function maskedGraphicRaster(
	graphic: ShapeGraphic,
	frame: FrameSize,
	bake: { opacity: number; rotation: number },
	minimumHalf = 0
): GraphicRaster {
	const half = Math.max(minimumHalf, maskedGraphicRasterHalf(graphic, frame));
	return applyGraphicMasks(
		graphicRaster(graphic, frame, bake, half),
		graphic,
		frame,
		bake
	);
}

/** One graphic mask placed for the preview's full-frame SVG. */
export interface GraphicMaskLayer {
	/** The mask's id. */
	id: string;
	/** `maskToSvg` data URL and its rectangle in box pixels (blur pad included). */
	image: { height: number; href: string; width: number; x: number; y: number };
	/** Stroke SVG data URL over the box, when the mask has a stroke. */
	stroke?: string;
}

/** Where a graphic's masks sit at `time`, and their SVG images. */
export interface GraphicMaskPlacement {
	box: FrameSize;
	layers: GraphicMaskLayer[];
	/** SVG transform from box pixels (top-left origin) to frame pixels. */
	transform: string;
}

const round3 = (value: number) => Math.round(value * 1000) / 1000;

/**
 * The graphic's masks for the preview at absolute `time`, or `undefined`
 * without masks. The box follows the graphic's position, scale, entry slide
 * and rotation at that time, like `graphicFramePoints`.
 */
export function graphicMaskPlacement(
	graphic: ShapeGraphic,
	frame: FrameSize,
	time: number
): GraphicMaskPlacement | undefined {
	const masks = graphicMasksOf(graphic);
	if (masks.length === 0) {
		return;
	}
	const shape = graphicShapeAt(graphic, time - graphic.start);
	const box = graphicBoxPx(shape, frame);
	const state = graphicFrameState(graphic, time);
	const centerX = state.x * frame.width + box.width / 2;
	const centerY = state.y * frame.height + box.height / 2;
	const transform = `translate(${round3(centerX)} ${round3(centerY)}) rotate(${round3(state.rotation)}) translate(${round3(-box.width / 2)} ${round3(-box.height / 2)})`;
	const layers = masks.map((mask): GraphicMaskLayer => {
		const pad = maskSvgPad(mask, box.width, box.height);
		const stroke = maskStrokeSvg(mask, box.width, box.height);
		return {
			id: mask.id,
			image: {
				height: box.height + 2 * pad,
				href: maskSvgDataUrl(mask, box.width, box.height),
				width: box.width + 2 * pad,
				x: pad > 0 ? -pad : 0,
				y: pad > 0 ? -pad : 0,
			},
			stroke: stroke
				? `data:image/svg+xml,${encodeURIComponent(stroke)}`
				: undefined,
		};
	});
	return { box, layers, transform };
}

// ---------------------------------------------------------------------------
// Edits

/** `POST /projects/:id/graphic-masks`: replace one graphic's masks. */
export const graphicMasksRequestSchema = z
	.object({
		graphicId: idSchema,
		/** The graphic's new masks; `null` or an empty list removes them. */
		masks: graphicSchema.shape.masks.unwrap().nullable(),
		revision: z.number().int().nonnegative(),
	})
	.strict();
export type GraphicMasksRequest = z.infer<typeof graphicMasksRequestSchema>;

/**
 * The project with `graphicId`'s masks replaced (an empty list or `null`
 * clears the field). Throws when the graphic is missing.
 */
export function setGraphicMasks(
	project: Project,
	request: Pick<GraphicMasksRequest, "graphicId" | "masks">
): Project {
	if (!project.graphics.some((graphic) => graphic.id === request.graphicId)) {
		throw new Error("That graphic is not in this project.");
	}
	const masks = request.masks?.length ? request.masks : undefined;
	return {
		...project,
		graphics: project.graphics.map((graphic) => {
			if (graphic.id !== request.graphicId) {
				return graphic;
			}
			const { masks: _previous, ...rest } = graphic;
			return masks ? { ...rest, masks } : rest;
		}),
	};
}
