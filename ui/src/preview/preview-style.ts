import type { CSSProperties } from "react";
import { animatedValue, type Segment } from "../../../shared/project.ts";
import { blendStyle } from "./stages/blend.ts";
import { cropInsetCss } from "./stages/crop.ts";
import { effectFilterCss } from "./stages/effects.ts";
import { basicFilterCss } from "./stages/filter-basic.ts";
import { keyStyle } from "./stages/key.ts";
import {
	edgeRadiusCss,
	edgeSoftnessFilterCss,
	maskStrokeStyle,
	maskStyle,
} from "./stages/mask.ts";
import { type TransformMediaSize, transformCss } from "./stages/transform.ts";
import { entryTransitionState, fadeFactor } from "./stages/transitions.ts";

/** CSS custom properties consumed by `studio.css` for every preview layer. */
export interface PreviewStyle extends CSSProperties {
	"--studio-avatar-fill"?: string;
	"--studio-avatar-head-rotation"?: string;
	"--studio-avatar-height"?: string;
	"--studio-avatar-joint-rotation"?: string;
	"--studio-avatar-left"?: string;
	"--studio-avatar-mouth-width"?: string;
	"--studio-avatar-opacity"?: string;
	"--studio-avatar-shadow-blur"?: string;
	"--studio-avatar-shadow-opacity"?: string;
	"--studio-avatar-shadow-x"?: string;
	"--studio-avatar-shadow-y"?: string;
	"--studio-avatar-top"?: string;
	"--studio-avatar-transform"?: string;
	"--studio-avatar-width"?: string;
	"--studio-caption-font-size"?: string;
	"--studio-caption-highlight-color"?: string;
	"--studio-caption-inset"?: string;
	"--studio-graphic-background"?: string;
	"--studio-graphic-border"?: string;
	"--studio-graphic-clip-path"?: string;
	"--studio-graphic-height"?: string;
	"--studio-graphic-left"?: string;
	"--studio-graphic-opacity"?: string;
	"--studio-graphic-radius"?: string;
	"--studio-graphic-top"?: string;
	"--studio-graphic-transform"?: string;
	"--studio-graphic-width"?: string;
	"--studio-media-clip-path"?: string;
	"--studio-media-filter"?: string;
	"--studio-media-opacity"?: string;
	"--studio-media-transform"?: string;
	"--studio-media-visibility"?: string;
	"--studio-media-z-index"?: string;
	"--studio-mesh-opacity"?: string;
	"--studio-preview-aspect-ratio"?: string;
	"--studio-preview-width"?: string;
	"--studio-stage-object-fill"?: string;
	"--studio-stage-object-height"?: string;
	"--studio-stage-object-left"?: string;
	"--studio-stage-object-opacity"?: string;
	"--studio-stage-object-top"?: string;
	"--studio-stage-object-transform"?: string;
	"--studio-stage-object-width"?: string;
	"--studio-title-box"?: string;
	"--studio-title-box-x"?: string;
	"--studio-title-box-y"?: string;
	"--studio-title-color"?: string;
	"--studio-title-font-size"?: string;
	"--studio-title-left"?: string;
	"--studio-title-opacity"?: string;
	"--studio-title-top"?: string;
	"--studio-title-transform"?: string;
	"--studio-vignette-opacity"?: string;
	"--studio-vignette-z-index"?: string;
}

export interface MediaLayerContext {
	/** Whether the playhead is inside the clip. Inactive clips stay mounted but transparent. */
	active: boolean;
	/**
	 * True when the WebGL grade pass applies the basic colour itself (before
	 * the advanced grade, like the render), so the CSS filter leaves it out.
	 */
	basicColorInGl?: boolean;
	/**
	 * Media and canvas sizes, when known: fit modes and static crops then
	 * preview exactly like the render (the crop re-fits the kept window).
	 */
	media?: TransformMediaSize;
}

/**
 * A transition or animation blur (pixels of a 1080-line frame, as the render
 * measures it) as a CSS `blur()` scaled to the drawn frame: the frame is
 * `--studio-preview-width` wide, so its height is that times height/width.
 */
export function transitionBlurCss(
	blur: number | undefined,
	canvas?: { height: number; width: number }
): string {
	if (!(blur && blur > 0)) {
		return "";
	}
	const aspect =
		canvas && canvas.width > 0 && canvas.height > 0
			? canvas.height / canvas.width
			: 9 / 16;
	const share = Math.round((blur / 1080) * aspect * 1e6) / 1e6;
	return ` blur(calc(var(--studio-preview-width, 100cqw) * ${share}))`;
}

/**
 * The CSS for one media clip at `elapsed` seconds into the clip. The stage
 * order mirrors `sidecar/src/render-segment-video.ts`: key, crop, basic
 * colour, effects, mask/edges, transform, transitions and blend. Each stage
 * lives in `./stages/*` so features can change one without touching this
 * composition.
 */
export function mediaLayerStyle(
	segment: Segment,
	elapsed: number,
	context: MediaLayerContext
): PreviewStyle {
	const entry = entryTransitionState(segment, elapsed);
	const fade = fadeFactor(segment, elapsed);
	const opacity = context.active
		? animatedValue(segment, "opacity", elapsed) *
			Math.max(0, fade) *
			entry.opacity
		: 0;
	const media = context.media;
	const knownSource =
		media && media.media.width > 0 && media.media.height > 0
			? media.media
			: undefined;
	return {
		...keyStyle(segment, elapsed),
		"--studio-media-clip-path": `inset(${cropInsetCss(segment, elapsed, media)} round ${edgeRadiusCss(segment, elapsed)})`,
		"--studio-media-opacity": `${opacity}`,
		"--studio-media-transform": transformCss(
			segment,
			elapsed,
			entry,
			context.media
		),
		"--studio-media-filter": `${effectFilterCss(segment, elapsed)} ${context.basicColorInGl ? "" : basicFilterCss(segment, elapsed)}${edgeSoftnessFilterCss(segment, elapsed)}${transitionBlurCss(entry.blur, media?.canvas)}`,
		"--studio-media-z-index": `${segment.track + 1}`,
		...maskStyle(segment, elapsed, media?.canvas, knownSource),
		...blendStyle(segment, elapsed),
	};
}

const maskStyleKeys = new Set([
	"maskComposite",
	"maskImage",
	"maskMode",
	"maskPosition",
	"maskRepeat",
	"maskSize",
	"WebkitMaskComposite",
	"WebkitMaskImage",
	"WebkitMaskPosition",
	"WebkitMaskRepeat",
	"WebkitMaskSize",
]);

/**
 * The overlay that draws a clip's mask outline strokes (`maskStrokeStyle`)
 * above the masked clip, or `undefined` when no mask has a stroke. It takes
 * `layerStyle` (the clip's own `mediaLayerStyle`, so transform, crop,
 * opacity, stacking and blend match) without its masks and media filter:
 * the render strokes after effects and masks.
 */
export function maskStrokeLayerStyle(
	segment: Segment,
	elapsed: number,
	layerStyle: PreviewStyle,
	media?: MediaLayerContext["media"]
): PreviewStyle | undefined {
	const knownSource =
		media && media.media.width > 0 && media.media.height > 0
			? media.media
			: undefined;
	const strokes = maskStrokeStyle(segment, elapsed, media?.canvas, knownSource);
	if (!strokes) {
		return;
	}
	const unmasked = Object.fromEntries(
		Object.entries(layerStyle).filter(([key]) => !maskStyleKeys.has(key))
	) as PreviewStyle;
	return {
		...unmasked,
		...strokes,
		"--studio-media-filter": "none",
		"--studio-media-visibility": "visible",
	};
}
