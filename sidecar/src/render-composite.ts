import {
	type ComponentBlend,
	componentBlendOf,
	ffmpegBlendOf,
} from "../../shared/blend.ts";
import type { BlendMode } from "../../shared/schema/blend.ts";
import { blendModeOf } from "../../shared/schema/defaults.ts";

export interface CompositeLayerInput {
	/** Label of the composite so far, without brackets. */
	base: string;
	/** `between(t,…)` expression that limits when the layer draws. */
	enable: string;
	/** Label of the clip layer, without brackets. */
	layer: string;
	/** Output label, without brackets. Also prefixes the blend's own labels. */
	out: string;
	/**
	 * The layer's settings. Only `blendMode` is read, so clips, graphics and
	 * adjustment layers can all be composited here.
	 */
	s: { blendMode?: BlendMode };
	/** Overlay x expression. */
	x: string;
	/** Overlay y expression. */
	y: string;
}

/**
 * Places a layer on the composite (W2-V1).
 *
 * `normal` (and an absent mode) is the legacy alpha-over `overlay`, byte for
 * byte. Every other mode:
 *
 * 1. Splits the composite three ways: the backdrop to blend with, the base
 *    to merge onto, and a fully transparent canvas of the same size and
 *    timing.
 * 2. Overlays the layer onto the transparent canvas at its usual x/y and
 *    enable. Over zero main alpha, `overlay` keeps the layer's straight
 *    colour and copies its alpha, so semi-transparent clips are not darkened.
 * 3. Blends backdrop and placed layer in planar RGB (`gbrp`), so modes act on
 *    red, green and blue rather than on YUV.
 * 4. Gives the blended frame the placed layer's alpha (`alphaextract` then
 *    `alphamerge`) and overlays it on the base. Outside the layer, or while
 *    it is disabled, the alpha is zero and the base passes through.
 *
 * The component modes (hue, saturation, color, luminosity) replace step 3
 * with `componentMix`: both inputs go to full-range Rec.601 YCbCr and the
 * output planes are rebuilt from them.
 */
export function compositeLayer({
	base,
	enable,
	layer,
	out,
	s,
	x,
	y,
}: CompositeLayerInput): string[] {
	const mode = blendModeOf(s);
	const component = componentBlendOf(mode);
	const blend = ffmpegBlendOf(mode);
	if (!(blend || component)) {
		return [
			`[${base}][${layer}]overlay=x='${x}':y='${y}':eof_action=pass:enable='${enable}'[${out}]`,
		];
	}
	const label = (name: string) => `${out}${name}`;
	const backdrop = `[${label("backdrop")}]`;
	const source = `[${label("source")}]`;
	let mix: string[] = [];
	if (component) {
		mix = componentMix(component, label);
	} else if (blend) {
		const inputs = blend.layerFirst
			? `${source}${backdrop}`
			: `${backdrop}${source}`;
		mix = [
			`[${label("below")}]format=gbrp${backdrop}`,
			`[${label("color")}]format=gbrp${source}`,
			`${inputs}blend=all_mode=${blend.mode}:all_opacity=1:enable='${enable}',format=gbrap[${label("mixed")}]`,
		];
	}
	return [
		`[${base}]split=3[${label("under")}][${label("below")}][${label("canvas")}]`,
		`[${label("canvas")}]format=rgba,colorchannelmixer=aa=0[${label("clear")}]`,
		`[${label("clear")}][${layer}]overlay=x='${x}':y='${y}':format=rgb:eof_action=pass:enable='${enable}'[${label("placed")}]`,
		`[${label("placed")}]split=2[${label("color")}][${label("alpha")}]`,
		...mix,
		`[${label("alpha")}]alphaextract[${label("mask")}]`,
		`[${label("mixed")}][${label("mask")}]alphamerge[${label("blended")}]`,
		`[${label("under")}][${label("blended")}]overlay=x=0:y=0:eof_action=pass:enable='${enable}'[${out}]`,
	];
}

const TO_YCC = "scale=out_color_matrix=bt601:out_range=full,format=yuv444p";
const FROM_YCC = "scale=in_color_matrix=bt601:in_range=full,format=gbrap";
/** Chroma magnitude of an 8-bit full-range plane pair centred on 128. */
const CHROMA_LENGTH = "hypot(cb(X,Y)-128,cr(X,Y)-128)";

/**
 * Step 3 for a component mode, from `[below]` and `[color]` to `[mixed]`.
 *
 * Both inputs become full-range Rec.601 YCbCr 4:4:4. When the chroma
 * direction and magnitude share an input (color, luminosity), `mergeplanes`
 * takes Y from one input and Cb/Cr from the other. Otherwise (hue,
 * saturation) a `geq` turns the magnitude input's chroma length into a grey
 * plane, `mergeplanes` packs luma, direction chroma and that length into
 * YUVA, and a second `geq` rescales the chroma vector to the length. Grey
 * direction chroma stays grey.
 */
function componentMix(
	recipe: ComponentBlend,
	label: (name: string) => string
): string[] {
	const sources = { base: "below", layer: "color" } as const;
	const uses = [recipe.luma, recipe.chromaDirection];
	const scaled = recipe.chromaAmount !== recipe.chromaDirection;
	if (scaled) {
		uses.push(recipe.chromaAmount);
	}
	const lines: string[] = [];
	const taken = { base: 0, layer: 0 };
	for (const from of ["base", "layer"] as const) {
		const count = uses.filter((use) => use === from).length;
		if (count === 0) {
			continue;
		}
		const names = Array.from(
			{ length: count },
			(_, index) => `[${label(`${from}ycc${index}`)}]`
		);
		lines.push(
			`[${label(sources[from])}]${TO_YCC}${count > 1 ? `,split=${count}` : ""}${names.join("")}`
		);
	}
	const next = (from: "base" | "layer") => {
		const index = taken[from];
		taken[from] += 1;
		return `[${label(`${from}ycc${index}`)}]`;
	};
	const luma = next(recipe.luma);
	const direction = next(recipe.chromaDirection);
	if (!scaled) {
		lines.push(
			`${luma}${direction}mergeplanes=map0s=0:map0p=0:map1s=1:map1p=1:map2s=1:map2p=2:format=yuv444p,${FROM_YCC}[${label("mixed")}]`
		);
		return lines;
	}
	const amount = next(recipe.chromaAmount);
	const rescale = (plane: "cb" | "cr") =>
		`128+(${plane}(X,Y)-128)*alpha(X,Y)/max(${CHROMA_LENGTH},0.000001)`;
	lines.push(
		`${amount}geq=lum='${CHROMA_LENGTH}':cb=128:cr=128[${label("length")}]`,
		`${luma}${direction}[${label("length")}]mergeplanes=map0s=0:map0p=0:map1s=1:map1p=1:map2s=1:map2p=2:map3s=2:map3p=0:format=yuva444p,geq=lum='lum(X,Y)':cb='${rescale("cb")}':cr='${rescale("cr")}':a=255,format=yuv444p,${FROM_YCC}[${label("mixed")}]`
	);
	return lines;
}
