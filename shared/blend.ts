/**
 * Blend modes (W2-V1), shared by the render composite
 * (`sidecar/src/render-composite.ts`), the preview stage
 * (`ui/src/preview/stages/blend.ts`) and the inspector.
 *
 * Every mode is defined per RGB channel on values in 0..1, with `base` the
 * composite below the layer (the backdrop) and `layer` the clip, title or
 * graphic being placed. The layer's alpha then mixes the blended colour over
 * the base: `out = base + (blend(base, layer) - base) * alpha`.
 *
 * The render uses FFmpeg's `blend` filter, whose operands are not symmetric:
 * some modes treat the first ("top") input as the backdrop and others treat it
 * as the source. `ffmpegBlendOf` records which input goes first so every mode
 * matches the definitions in `blendChannel`. Soft light follows FFmpeg's
 * curve, `(1 - 2s)b² + 2sb`, so the reference math and the render agree.
 *
 * Hue, saturation, color and luminosity are non-separable: they mix whole
 * pixels, not channels, and FFmpeg's `blend` filter has no such modes. They
 * are defined in full-range Rec.601 YCbCr (luma `0.299R + 0.587G + 0.114B`,
 * close to the W3C `Lum` weights): the luma, the chroma direction (hue) and
 * the chroma magnitude (saturation) each come from the base or the layer
 * (`componentBlendOf`), and the render rebuilds the planes with `mergeplanes`
 * and `geq` (`sidecar/src/render-composite.ts`).
 *
 * Every function is pure and deterministic. The optional field is read through
 * `blendModeOf`, so layers without one stay on the legacy alpha-over path.
 */
import { type BlendMode, blendModeSchema } from "./schema/blend.ts";
import { blendModeOf } from "./schema/defaults.ts";

export type { BlendMode } from "./schema/blend.ts";

/** Every blend mode, in menu order (`normal` first). */
export const blendModes: readonly BlendMode[] = blendModeSchema.options;

export const blendModeLabels: Record<BlendMode, string> = {
	add: "Add",
	color: "Color",
	"color-burn": "Color burn",
	"color-dodge": "Color dodge",
	darken: "Darken",
	difference: "Difference",
	exclusion: "Exclusion",
	"hard-light": "Hard light",
	hue: "Hue",
	lighten: "Lighten",
	"linear-light": "Linear light",
	luminosity: "Luminosity",
	multiply: "Multiply",
	normal: "Normal",
	overlay: "Overlay",
	"pin-light": "Pin light",
	saturation: "Saturation",
	screen: "Screen",
	"soft-light": "Soft light",
	subtract: "Subtract",
};

export const isBlendMode = (value: string): value is BlendMode =>
	(blendModes as readonly string[]).includes(value);

/** Whether the layer composites with a mode other than plain alpha-over. */
export const isBlended = (layer: { blendMode?: BlendMode }): boolean =>
	blendModeOf(layer) !== "normal";

/** How the render expresses a mode with FFmpeg's `blend` filter. */
export interface FfmpegBlend {
	/**
	 * Whether the layer is the filter's first ("top") input. FFmpeg's dodge,
	 * burn and linear light divide or offset the second input by the first, so
	 * the source layer goes first for them; every other mode takes the
	 * backdrop first.
	 */
	layerFirst: boolean;
	/** The `all_mode` value. */
	mode: string;
}

/** The non-separable modes, which the render builds from YCbCr planes. */
export type ComponentBlendMode = "color" | "hue" | "luminosity" | "saturation";

/** Which input supplies each YCbCr component of a component-mode pixel. */
export interface ComponentBlend {
	/** Source of the chroma magnitude (saturation). */
	chromaAmount: "base" | "layer";
	/** Source of the chroma direction (hue). */
	chromaDirection: "base" | "layer";
	/** Source of the luma. */
	luma: "base" | "layer";
}

const componentModes: Record<ComponentBlendMode, ComponentBlend> = {
	color: { chromaAmount: "layer", chromaDirection: "layer", luma: "base" },
	hue: { chromaAmount: "base", chromaDirection: "layer", luma: "base" },
	luminosity: { chromaAmount: "base", chromaDirection: "base", luma: "layer" },
	saturation: { chromaAmount: "layer", chromaDirection: "base", luma: "base" },
};

export const isComponentBlendMode = (
	mode: BlendMode
): mode is ComponentBlendMode => Object.hasOwn(componentModes, mode);

/** The YCbCr recipe for a non-separable mode; `null` for every other mode. */
export function componentBlendOf(mode: BlendMode): ComponentBlend | null {
	return isComponentBlendMode(mode) ? componentModes[mode] : null;
}

const ffmpegModes: Record<
	Exclude<BlendMode, "normal" | ComponentBlendMode>,
	FfmpegBlend
> = {
	add: { layerFirst: false, mode: "addition" },
	"color-burn": { layerFirst: true, mode: "burn" },
	"color-dodge": { layerFirst: true, mode: "dodge" },
	darken: { layerFirst: false, mode: "darken" },
	difference: { layerFirst: false, mode: "difference" },
	exclusion: { layerFirst: false, mode: "exclusion" },
	"hard-light": { layerFirst: false, mode: "hardlight" },
	lighten: { layerFirst: false, mode: "lighten" },
	"linear-light": { layerFirst: true, mode: "linearlight" },
	multiply: { layerFirst: false, mode: "multiply" },
	overlay: { layerFirst: false, mode: "overlay" },
	"pin-light": { layerFirst: false, mode: "pinlight" },
	screen: { layerFirst: false, mode: "screen" },
	"soft-light": { layerFirst: false, mode: "softlight" },
	subtract: { layerFirst: false, mode: "subtract" },
};

/**
 * The FFmpeg `blend` settings for a separable mode; `null` for `normal` (the
 * plain overlay) and for the component modes (`componentBlendOf`).
 */
export function ffmpegBlendOf(mode: BlendMode): FfmpegBlend | null {
	if (mode === "normal" || isComponentBlendMode(mode)) {
		return null;
	}
	return ffmpegModes[mode];
}

/** CSS `mix-blend-mode` values the preview can use. */
export type CssBlendMode =
	| "color"
	| "color-burn"
	| "color-dodge"
	| "darken"
	| "difference"
	| "exclusion"
	| "hard-light"
	| "hue"
	| "lighten"
	| "luminosity"
	| "multiply"
	| "normal"
	| "overlay"
	| "plus-lighter"
	| "saturation"
	| "screen"
	| "soft-light";

/**
 * Closest CSS mode. CSS has no subtract, linear light or pin light, so the
 * preview shows difference and hard light instead (`previewApproximates`).
 * `add` is CSS `plus-lighter` (OpenCut's "plus lighter").
 */
const cssModes: Record<BlendMode, CssBlendMode> = {
	add: "plus-lighter",
	color: "color",
	"color-burn": "color-burn",
	"color-dodge": "color-dodge",
	darken: "darken",
	difference: "difference",
	exclusion: "exclusion",
	"hard-light": "hard-light",
	hue: "hue",
	lighten: "lighten",
	"linear-light": "hard-light",
	luminosity: "luminosity",
	multiply: "multiply",
	normal: "normal",
	overlay: "overlay",
	"pin-light": "hard-light",
	saturation: "saturation",
	screen: "screen",
	"soft-light": "soft-light",
	subtract: "difference",
};

export const cssBlendModeOf = (mode: BlendMode): CssBlendMode => cssModes[mode];

/**
 * What the live preview knows about a blended layer beyond its mode. Both
 * flags are optional so a caller without the project (or the clip) gets the
 * mode-only answer.
 */
export interface BlendPreviewContext {
	/**
	 * Whether the layer draws a per-clip background fill. The render blends the
	 * fill and the clip as one layer; the preview draws the fill as a separate
	 * element, so the two only match approximately.
	 */
	clipBackground?: boolean;
	/**
	 * Whether the layer can draw below full opacity (opacity under 1, opacity
	 * keyframes, fades or edge transitions).
	 */
	partlyTransparent?: boolean;
}

/** Why the live preview differs from the render for a blended layer. */
export type BlendPreviewGap =
	/** Add is CSS `plus-lighter`, a compositing operator: at partial opacity it gives `min(1, a·L + B)`, not `B + (min(1, B + L) − B)·a`. */
	| "add-opacity"
	/** The fill and the clip blend as one layer in the render. */
	| "clip-background"
	/** CSS mixes hue, saturation, color and luminosity with the W3C RGB `SetLum`/`SetSat` math; the render works in YCbCr. */
	| "component-ycbcr"
	/** CSS has no such mode (subtract, linear light, pin light). */
	| "css-fallback"
	/** CSS soft light is the W3C curve; the render uses FFmpeg's `(1 - 2s)b² + 2sb`. */
	| "soft-light-curve";

const cssFallbackModes: ReadonlySet<BlendMode> = new Set<BlendMode>([
	"linear-light",
	"pin-light",
	"subtract",
]);

/**
 * Every reason the browser preview only approximates the rendered layer, in a
 * stable order. Normal layers composite identically and never have gaps.
 */
export function blendPreviewGaps(
	mode: BlendMode,
	context: BlendPreviewContext = {}
): BlendPreviewGap[] {
	if (mode === "normal") {
		return [];
	}
	const gaps: BlendPreviewGap[] = [];
	if (cssFallbackModes.has(mode)) {
		gaps.push("css-fallback");
	}
	if (mode === "soft-light") {
		gaps.push("soft-light-curve");
	}
	if (isComponentBlendMode(mode)) {
		gaps.push("component-ycbcr");
	}
	if (mode === "add" && context.partlyTransparent) {
		gaps.push("add-opacity");
	}
	if (context.clipBackground) {
		gaps.push("clip-background");
	}
	return gaps;
}

/** Whether the browser preview only approximates the rendered layer. */
export const previewApproximates = (
	mode: BlendMode,
	context?: BlendPreviewContext
): boolean => blendPreviewGaps(mode, context).length > 0;

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

function screenChannel(base: number, layer: number): number {
	return base + layer - base * layer;
}

function hardLightChannel(base: number, layer: number): number {
	return layer <= 0.5 ? 2 * base * layer : 1 - 2 * (1 - base) * (1 - layer);
}

function dodgeChannel(base: number, layer: number): number {
	if (layer >= 1) {
		return 1;
	}
	return Math.min(1, base / (1 - layer));
}

function burnChannel(base: number, layer: number): number {
	if (layer <= 0) {
		return 0;
	}
	return 1 - Math.min(1, (1 - base) / layer);
}

/** The modes defined per RGB channel (every mode but the component ones). */
export type SeparableBlendMode = Exclude<BlendMode, ComponentBlendMode>;

const channelModes: Record<
	SeparableBlendMode,
	(base: number, layer: number) => number
> = {
	add: (base, layer) => Math.min(1, base + layer),
	"color-burn": burnChannel,
	"color-dodge": dodgeChannel,
	darken: Math.min,
	difference: (base, layer) => Math.abs(base - layer),
	exclusion: (base, layer) => base + layer - 2 * base * layer,
	"hard-light": hardLightChannel,
	lighten: Math.max,
	"linear-light": (base, layer) => clamp01(base + 2 * layer - 1),
	multiply: (base, layer) => base * layer,
	normal: (_base, layer) => layer,
	overlay: (base, layer) => hardLightChannel(layer, base),
	"pin-light": (base, layer) =>
		layer < 0.5 ? Math.min(base, 2 * layer) : Math.max(base, 2 * layer - 1),
	screen: screenChannel,
	"soft-light": (base, layer) =>
		(1 - 2 * layer) * base * base + 2 * layer * base,
	subtract: (base, layer) => Math.max(0, base - layer),
};

/** One channel of `mode` applied to `layer` over `base`, both in 0..1. */
export function blendChannel(
	mode: SeparableBlendMode,
	base: number,
	layer: number
): number {
	return clamp01(channelModes[mode](clamp01(base), clamp01(layer)));
}

export type Rgb = readonly [number, number, number];

/** Full-range Rec.601 YCbCr; `cb` and `cr` are centred on 0 (−0.5..0.5). */
export interface Ycc {
	cb: number;
	cr: number;
	y: number;
}

/** RGB (0..1) to full-range Rec.601 YCbCr, as the render's `scale` does. */
export function rgbToYcc([red, green, blue]: Rgb): Ycc {
	const y = 0.299 * red + 0.587 * green + 0.114 * blue;
	return { cb: (blue - y) / 1.772, cr: (red - y) / 1.402, y };
}

/** Full-range Rec.601 YCbCr back to RGB, clamped to 0..1. */
export function yccToRgb({ cb, cr, y }: Ycc): [number, number, number] {
	return [
		clamp01(y + 1.402 * cr),
		clamp01(y - 0.344_136 * cb - 0.714_136 * cr),
		clamp01(y + 1.772 * cb),
	];
}

/**
 * A component mode applied to whole pixels: luma, chroma direction and
 * chroma magnitude each come from the base or the layer (`componentBlendOf`).
 * A grey direction source has no hue, so the result stays grey.
 */
export function componentPixel(
	mode: ComponentBlendMode,
	base: Rgb,
	layer: Rgb
): [number, number, number] {
	const recipe = componentModes[mode];
	const below = rgbToYcc(base);
	const above = rgbToYcc(layer);
	const pick = (from: "base" | "layer") => (from === "base" ? below : above);
	const direction = pick(recipe.chromaDirection);
	const amount = pick(recipe.chromaAmount);
	const length = Math.hypot(direction.cb, direction.cr);
	// Float noise gives greys a ~1e-17 chroma; treat that as no hue.
	const scale = length > 1e-9 ? Math.hypot(amount.cb, amount.cr) / length : 0;
	return yccToRgb({
		cb: direction.cb * scale,
		cr: direction.cr * scale,
		y: pick(recipe.luma).y,
	});
}

/**
 * The composited colour of a layer pixel with `alpha` (0..1, clip opacity
 * included) over a base pixel; channels in 0..1.
 */
export function compositePixel(
	mode: BlendMode,
	base: Rgb,
	layer: Rgb,
	alpha: number
): [number, number, number] {
	const coverage = clamp01(alpha);
	const below: Rgb = [clamp01(base[0]), clamp01(base[1]), clamp01(base[2])];
	const blended: Rgb = isComponentBlendMode(mode)
		? componentPixel(mode, below, [
				clamp01(layer[0]),
				clamp01(layer[1]),
				clamp01(layer[2]),
			])
		: [
				blendChannel(mode, below[0], layer[0]),
				blendChannel(mode, below[1], layer[1]),
				blendChannel(mode, below[2], layer[2]),
			];
	const mix = (index: 0 | 1 | 2) =>
		below[index] + (blended[index] - below[index]) * coverage;
	return [mix(0), mix(1), mix(2)];
}
