/**
 * GLSL for the whole-stack blend compositor (`./compositor.ts`). Every mode
 * is a direct port of the reference math in `shared/blend.ts`
 * (`blendChannel`, `componentPixel`, `compositePixel`), which
 * `sidecar/src/verify-blend.ts` proves against the FFmpeg `blend` filter and
 * the YCbCr `mergeplanes`/`geq` graph the render builds in
 * `sidecar/src/render-composite.ts`. Each mode compiles to its own program,
 * so the shader has no per-pixel mode branch.
 */
import {
	type BlendMode,
	componentBlendOf,
	type SeparableBlendMode,
} from "../../../../shared/blend.ts";

/**
 * One RGB channel of each separable mode, with `b` the backdrop and `l` the
 * layer, both already clamped to 0..1 (as `blendChannel` clamps them).
 * Typed as a full record so a new mode cannot ship without a shader.
 */
export const separableBlendGlsl: Record<SeparableBlendMode, string> = {
	add: "min(1.0, b + l)",
	"color-burn": "l <= 0.0 ? 0.0 : 1.0 - min(1.0, (1.0 - b) / l)",
	"color-dodge": "l >= 1.0 ? 1.0 : min(1.0, b / (1.0 - l))",
	darken: "min(b, l)",
	difference: "abs(b - l)",
	exclusion: "b + l - 2.0 * b * l",
	"hard-light": "hardLight(b, l)",
	lighten: "max(b, l)",
	"linear-light": "b + 2.0 * l - 1.0",
	multiply: "b * l",
	normal: "l",
	overlay: "hardLight(l, b)",
	"pin-light": "l < 0.5 ? min(b, 2.0 * l) : max(b, 2.0 * l - 1.0)",
	screen: "b + l - b * l",
	"soft-light": "(1.0 - 2.0 * l) * b * b + 2.0 * l * b",
	subtract: "max(0.0, b - l)",
};

const sharedGlsl = `
float hardLight(float b, float l) {
	return l <= 0.5 ? 2.0 * b * l : 1.0 - 2.0 * (1.0 - b) * (1.0 - l);
}
vec3 toYcc(vec3 c) {
	float y = 0.299 * c.r + 0.587 * c.g + 0.114 * c.b;
	return vec3(y, (c.b - y) / 1.772, (c.r - y) / 1.402);
}
vec3 fromYcc(vec3 ycc) {
	return clamp(vec3(
		ycc.x + 1.402 * ycc.z,
		ycc.x - 0.344136 * ycc.y - 0.714136 * ycc.z,
		ycc.x + 1.772 * ycc.y
	), 0.0, 1.0);
}
`;

/** `vec3 blendColor(vec3 base, vec3 layer)` for one mode. */
export function blendFunctionGlsl(mode: BlendMode): string {
	const component = componentBlendOf(mode);
	if (component) {
		const pick = (from: "base" | "layer") => (from === "base" ? "lo" : "hi");
		return `${sharedGlsl}
vec3 blendColor(vec3 base, vec3 layer) {
	vec3 lo = toYcc(base);
	vec3 hi = toYcc(layer);
	vec3 direction = ${pick(component.chromaDirection)};
	vec3 amount = ${pick(component.chromaAmount)};
	float len = length(direction.yz);
	float scale = len > 1e-9 ? length(amount.yz) / len : 0.0;
	return fromYcc(vec3(${pick(component.luma)}.x, direction.yz * scale));
}
`;
	}
	const channel = separableBlendGlsl[mode as SeparableBlendMode];
	return `${sharedGlsl}
float blendChannel(float b, float l) {
	return clamp(${channel}, 0.0, 1.0);
}
vec3 blendColor(vec3 base, vec3 layer) {
	return vec3(
		blendChannel(base.r, layer.r),
		blendChannel(base.g, layer.g),
		blendChannel(base.b, layer.b)
	);
}
`;
}
