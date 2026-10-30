/**
 * Preview stage: masks and clip edges. Mirrors
 * `sidecar/src/render-stages/{mask,edges}.ts`. Edge rounding and softness
 * reproduce the current preview; masks (W2-V3) are CSS `mask-image` layers.
 */
import {
	maskStrokeSvgUrl,
	maskSvgPad,
	maskSvgUrl,
	segmentMasksAt,
} from "../../../../shared/masks.ts";
import type { Segment } from "../../../../shared/project.ts";
import type { PreviewStyle } from "../preview-style.ts";

/** Corner radius for the clip path's `round` keyword. */
export function edgeRadiusCss(segment: Segment, _elapsed: number): string {
	return `${segment.edgeRounding * 100}%`;
}

/** Appended to the media filter; empty or ` blur(<n>px)` with a leading space. */
export function edgeSoftnessFilterCss(
	segment: Segment,
	_elapsed: number
): string {
	return segment.edgeSoftness ? ` blur(${segment.edgeSoftness}px)` : "";
}

/** Pixel size the mask SVGs are drawn at when the frame size is unknown. */
export const DEFAULT_MASK_FRAME = { height: 1080, width: 1920 } as const;

export interface PixelSize {
	height: number;
	width: number;
}

/** A rectangle as fractions (0..1) of the media element's box. */
export interface ElementBox {
	height: number;
	left: number;
	top: number;
	width: number;
}

/**
 * Where a clip's mask frame sits inside its media element, and its pixel
 * size. The render masks the clip's own cropped source frame (`W`×`H` after
 * crop) before it is fitted into the project, so the mask frame is the crop
 * window of the `object-fit: contain` content box of `source` inside an
 * element the size of `frame` (the project). Without `source` the medium is
 * taken to fill the element.
 */
export function maskFrameBox(
	segment: Pick<Segment, "crop">,
	frame: PixelSize = DEFAULT_MASK_FRAME,
	source?: PixelSize
): { box: ElementBox; size: PixelSize } {
	const media =
		source && source.width > 0 && source.height > 0 ? source : frame;
	const scale = Math.min(
		frame.width / media.width,
		frame.height / media.height
	);
	const content = {
		height: (media.height * scale) / frame.height,
		width: (media.width * scale) / frame.width,
	};
	const { bottom, left, right, top } = segment.crop;
	const across = Math.max(0, 1 - left - right);
	const down = Math.max(0, 1 - top - bottom);
	return {
		box: {
			height: content.height * down,
			left: (1 - content.width) / 2 + content.width * left,
			top: (1 - content.height) / 2 + content.height * top,
			width: content.width * across,
		},
		size: {
			height: Math.max(1, media.height * down),
			width: Math.max(1, media.width * across),
		},
	};
}

const percent = (value: number) => `${Math.round(value * 1e4) / 1e4}%`;

/**
 * CSS `mask-position` percentage that puts a layer `size` wide (a fraction
 * of the element) at `start`: percentages align the layer by `p·(1 − size)`.
 */
function alignPercent(start: number, size: number): string {
	const room = 1 - size;
	return Math.abs(room) < 1e-9 ? "50%" : percent((start / room) * 100);
}

/**
 * The clip's masks as CSS mask layers. Each mask is an SVG data URL drawn at
 * the clip's cropped source size (so feather sigma and rotation use the
 * render's frame), sized and placed over the mask frame from `maskFrameBox`
 * (grown by the SVG's blur pad), and combined with `intersect` so
 * overlapping masks multiply like the render. Pass the project size as
 * `frame` and the asset's pixel size as `source`; a medium whose aspect
 * differs from the project's is letterboxed by `object-fit: contain`.
 */
export function maskStyle(
	segment: Segment,
	elapsed: number,
	frame: PixelSize = DEFAULT_MASK_FRAME,
	source?: PixelSize
): PreviewStyle {
	const masks = segmentMasksAt(segment, elapsed);
	if (masks.length === 0) {
		return {};
	}
	const { box, size } = maskFrameBox(segment, frame, source);
	// The render masks after flipping, while CSS masks the element before its
	// flip transform, so the drawn mask is mirrored to land in the same place.
	const flip = { flipX: segment.flipH === true, flipY: segment.flipV === true };
	const layers = masks.map((mask) => {
		const pad = maskSvgPad(mask, size.width, size.height);
		const width = box.width * (1 + (2 * pad) / size.width);
		const height = box.height * (1 + (2 * pad) / size.height);
		const left = box.left - (box.width * pad) / size.width;
		const top = box.top - (box.height * pad) / size.height;
		return {
			image: maskSvgUrl(mask, size.width, size.height, flip),
			position: `${alignPercent(left, width)} ${alignPercent(top, height)}`,
			size: `${percent(width * 100)} ${percent(height * 100)}`,
		};
	});
	const all = (value: string) => masks.map(() => value).join(", ");
	const image = layers.map((layer) => layer.image).join(", ");
	const position = layers.map((layer) => layer.position).join(", ");
	const sizes = layers.map((layer) => layer.size).join(", ");
	return {
		maskComposite: all("intersect"),
		maskImage: image,
		maskMode: all("alpha"),
		maskPosition: position,
		maskRepeat: all("no-repeat"),
		maskSize: sizes,
		WebkitMaskComposite: all("source-in"),
		WebkitMaskImage: image,
		WebkitMaskPosition: position,
		WebkitMaskRepeat: all("no-repeat"),
		WebkitMaskSize: sizes,
	};
}

/**
 * Mask outline strokes as CSS background layers for an overlay drawn over
 * the masked clip (the render overlays strokes after masking, so they are
 * not cut by the mask). Each stroke SVG covers the mask frame from
 * `maskFrameBox`, mirrored like the masks; the overlay shares the clip's
 * transform, crop and opacity. `undefined` when no mask has a stroke.
 */
export function maskStrokeStyle(
	segment: Segment,
	elapsed: number,
	frame: PixelSize = DEFAULT_MASK_FRAME,
	source?: PixelSize
): PreviewStyle | undefined {
	const { box, size } = maskFrameBox(segment, frame, source);
	const flip = { flipX: segment.flipH === true, flipY: segment.flipV === true };
	const images = segmentMasksAt(segment, elapsed).flatMap((mask) => {
		const url = maskStrokeSvgUrl(mask, size.width, size.height, flip);
		return url ? [url] : [];
	});
	if (images.length === 0) {
		return;
	}
	const all = (value: string) => images.map(() => value).join(", ");
	return {
		backgroundImage: images.join(", "),
		backgroundPosition: all(
			`${alignPercent(box.left, box.width)} ${alignPercent(box.top, box.height)}`
		),
		backgroundRepeat: all("no-repeat"),
		backgroundSize: all(
			`${percent(box.width * 100)} ${percent(box.height * 100)}`
		),
	};
}
