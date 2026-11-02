/**
 * WebGL effects pass (W2-V6): the library effects CSS cannot express. It
 * approximates the FFmpeg recipes in `shared/effects.ts` in one shader with
 * a fixed order (frame geometry, then sampling, then colour, then overlays)
 * rather than the stack order; each effect type uses its strongest enabled
 * instance. The render crops before its effects, so frame geometry (shake,
 * mirror, mosaic grid, letterbox, light positions) is computed in the
 * clip's crop rectangle (`u_crop`), not the full source. Invert, hue cycle, dehaze, clarity and denoise preview as CSS
 * (`../../stages/effects.ts`); motion blur and echo trails need previous
 * frames and are only rendered. Clips without a GL effect get no pass, so
 * the plain media element stays.
 */
import {
	type Effect,
	type EffectType,
	effectSeedPhase,
	effectsAt,
	relightParams,
} from "../../../../../shared/effects.ts";
import type { Segment } from "../../../../../shared/project.ts";
import type { GlPass, GlUniformValue } from "../pass.ts";

/** Effect types this pass draws, with the uniform each one drives. */
export const glEffectUniforms = {
	"edge-detect": "u_edge",
	glitch: "u_glitch",
	glow: "u_glow",
	grain: "u_grain",
	letterbox: "u_letterbox",
	"light-leak": "u_leak",
	mirror: "u_mirror",
	mosaic: "u_mosaic",
	relight: "u_relight",
	"rgb-split": "u_rgbSplit",
	shake: "u_shake",
	"skin-smooth": "u_skin",
} as const satisfies Partial<Record<EffectType, string>>;
type GlEffectType = keyof typeof glEffectUniforms;

/** Seeded effects and the uniform that carries their phase. */
const phaseUniforms = {
	glitch: "u_glitchPhase",
	grain: "u_grainPhase",
	"light-leak": "u_leakPhase",
	shake: "u_shakePhase",
} as const satisfies Partial<Record<GlEffectType, string>>;

const isGlEffect = (type: EffectType): type is GlEffectType =>
	type in glEffectUniforms;

export const effectsFragment = `
uniform float u_edge;
uniform float u_glitch;
uniform float u_glow;
uniform float u_grain;
uniform float u_letterbox;
uniform float u_leak;
uniform float u_mirror;
uniform float u_mosaic;
uniform float u_relight;
/* Relight center (frame fractions) and per-channel tint, in 8-bit units. */
uniform vec2 u_relightPos;
uniform vec3 u_relightOffset;
uniform vec3 u_relightScale;
uniform float u_rgbSplit;
uniform float u_shake;
uniform float u_skin;
uniform float u_glitchPhase;
uniform float u_grainPhase;
uniform float u_leakPhase;
uniform float u_shakePhase;
/* Crop insets as fractions of the source: left, top, right, bottom. */
uniform vec4 u_crop;

const float PI = 3.141592653589793;

float hash(vec2 p) {
	return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
}

vec4 tap(vec2 uv) {
	return texture(u_source, clamp(uv, vec2(0.0), vec2(1.0)));
}

/* Average of 12 taps on two rings of radius px pixels around uv. */
vec3 ringBlur(vec2 uv, float px) {
	vec2 texel = px / u_resolution;
	vec3 sum = tap(uv).rgb;
	for (int i = 0; i < 6; i++) {
		float angle = float(i) * PI / 3.0;
		vec2 dir = vec2(cos(angle), sin(angle));
		sum += tap(uv + dir * texel).rgb;
		sum += tap(uv + dir.yx * texel * 0.5).rgb;
	}
	return sum / 13.0;
}

/* Size of the crop rectangle as a fraction of the source. */
vec2 cropSize() {
	return max(vec2(1.0) - u_crop.xy - u_crop.zw, vec2(1e-4));
}

/* Crop-space position (0..1, top-left origin) to a source texture uv. */
vec2 sourceUv(vec2 cropPos) {
	vec2 topLeft = u_crop.xy + cropPos * cropSize();
	return vec2(topLeft.x, 1.0 - topLeft.y);
}

/* FFmpeg's natural vignette at full angle: 1 at the point, 0 at half the diagonal. */
float spot(vec2 topLeftUv, vec2 center) {
	vec2 size = u_resolution * cropSize();
	vec2 px = (topLeftUv - center) * size;
	float dmax = length(size * 0.5);
	float d = min(length(px) / dmax, 1.0);
	return pow(cos(d * PI * 0.5), 4.0);
}

float softLight(float a, float b) {
	float shape = 0.5 - abs(b - 0.5);
	return a > 0.5
		? b + (1.0 - b) * (a - 0.5) / 0.5 * shape
		: b - b * ((0.5 - a) / 0.5) * shape;
}

void main() {
	/* Top-left-origin position inside the crop rectangle. */
	vec2 topLeft = (vec2(v_uv.x, 1.0 - v_uv.y) - u_crop.xy) / cropSize();
	vec2 pos = topLeft;
	if (u_shake > 0.0) {
		float keep = 1.0 - 0.08 * u_shake;
		float wobX = 0.6 * sin(u_time * 31.0 + u_shakePhase) + 0.4 * sin(u_time * 17.3 + u_shakePhase * 2.0);
		float wobY = 0.6 * sin(u_time * 27.0 + u_shakePhase) + 0.4 * sin(u_time * 13.1 + u_shakePhase * 2.0);
		pos = (1.0 - keep) * 0.5 * (1.0 + vec2(wobX, wobY)) + pos * keep;
	}
	if (u_mirror > 0.0 && pos.x > 0.5) {
		pos.x = 1.0 - pos.x;
	}
	if (u_mosaic > 0.0) {
		vec2 block = vec2(2.0 + floor(u_mosaic * 30.0 + 0.5)) / (u_resolution * cropSize());
		pos = (floor(pos / block) + 0.5) * block;
	}
	vec2 uv = sourceUv(pos);
	vec4 color = tap(uv);
	vec2 texel = 1.0 / u_resolution;
	if (u_rgbSplit > 0.0) {
		float shift = max(1.0, floor(u_rgbSplit * 8.0 + 0.5));
		color.r = tap(uv + vec2(shift * texel.x, 0.0)).r;
		color.b = tap(uv - vec2(shift * texel.x, 0.0)).b;
	}
	float glitchCycle = u_time + u_glitchPhase / (2.0 * PI);
	if (u_glitch > 0.0 && mod(glitchCycle, 1.3) < 0.18) {
		float shift = max(1.0, floor(u_glitch * 24.0 + 0.5));
		float drift = max(1.0, floor(u_glitch * 10.0 + 0.5));
		color.r = tap(uv - vec2(shift * texel.x, 0.0)).r;
		color.g = tap(uv + vec2(drift * texel.x, 0.0)).g;
		color.b = tap(uv + vec2(0.0, max(1.0, floor(drift * 0.5 + 0.5)) * texel.y)).b;
	}
	if (u_skin > 0.0) {
		float cb = 128.0 + dot(color.rgb, vec3(-0.168736, -0.331264, 0.5)) * 255.0;
		float cr = 128.0 + dot(color.rgb, vec3(0.5, -0.418688, -0.081312)) * 255.0;
		float skin = step(77.0, cb) * step(cb, 127.0) * step(133.0, cr) * step(cr, 173.0);
		color.rgb = mix(color.rgb, ringBlur(uv, 1.0 + u_skin * 3.0), skin * u_skin);
	}
	if (u_glow > 0.0) {
		vec3 blurred = ringBlur(uv, 4.0 + u_glow * 16.0);
		vec3 screened = 1.0 - (1.0 - color.rgb) * (1.0 - blurred);
		color.rgb = mix(color.rgb, screened, u_glow);
	}
	if (u_edge > 0.0) {
		vec3 gx = tap(uv + vec2(texel.x, 0.0)).rgb - tap(uv - vec2(texel.x, 0.0)).rgb;
		vec3 gy = tap(uv + vec2(0.0, texel.y)).rgb - tap(uv - vec2(0.0, texel.y)).rgb;
		vec3 edges = clamp(sqrt(gx * gx + gy * gy) * 2.0, 0.0, 1.0);
		color.rgb = mix(color.rgb, edges, u_edge);
	}
	if (u_relight > 0.0) {
		float level = spot(topLeft, u_relightPos) * 255.0;
		vec3 light = (u_relightOffset + level * u_relightScale) / 255.0;
		vec3 lit = vec3(
			softLight(color.r, light.r),
			softLight(color.g, light.g),
			softLight(color.b, light.b)
		);
		color.rgb = mix(color.rgb, lit, u_relight);
	}
	if (u_leak > 0.0) {
		vec2 center = vec2(
			0.18 + 0.12 * sin(u_time * 0.6 + u_leakPhase),
			0.2 + 0.1 * cos(u_time * 0.45 + u_leakPhase)
		);
		vec3 light = spot(topLeft, center) * vec3(1.0, 0.59, 0.22);
		color.rgb = mix(color.rgb, 1.0 - (1.0 - color.rgb) * (1.0 - light), u_leak);
	}
	if (u_grain > 0.0) {
		float frame = floor(u_time * 30.0);
		float noise = hash(v_uv * u_resolution + vec2(frame * 7.13 + u_grainPhase, frame * 3.71));
		color.rgb += (noise - 0.5) * 2.0 * (u_grain * 40.0 / 255.0);
	}
	if (u_glitch > 0.0 && mod(u_time + u_glitchPhase / (2.0 * PI) * 0.7, 0.9) < 0.08) {
		float noise = hash(v_uv * u_resolution + vec2(floor(u_time * 30.0)));
		color.rgb += (noise - 0.5) * 2.0 * (u_glitch * 50.0 / 255.0);
	}
	if (u_letterbox > 0.0) {
		float bar = u_letterbox * 0.12;
		if (topLeft.y < bar || topLeft.y > 1.0 - bar) {
			color.rgb = vec3(0.0);
		}
	}
	outColor = vec4(clamp(color.rgb, 0.0, 1.0), color.a);
}
`;

/** Strongest enabled amount per GL effect type, plus each seeded phase. */
export function glEffectUniformValues(
	effects: readonly Effect[]
): Record<string, GlUniformValue> | null {
	const uniforms: Record<string, number> = {};
	let relight = relightParams(undefined);
	for (const name of Object.values(glEffectUniforms)) {
		uniforms[name] = 0;
	}
	for (const name of Object.values(phaseUniforms)) {
		uniforms[name] = 0;
	}
	let active = false;
	for (const effect of effects) {
		if (!(effect.enabled && effect.amount > 0 && isGlEffect(effect.type))) {
			continue;
		}
		const name = glEffectUniforms[effect.type];
		if (effect.amount > (uniforms[name] ?? 0)) {
			uniforms[name] = effect.amount;
			const phase = (phaseUniforms as Partial<Record<EffectType, string>>)[
				effect.type
			];
			if (phase) {
				uniforms[phase] = effectSeedPhase(effect);
			}
			if (effect.type === "relight") {
				relight = relightParams(effect.light);
			}
		}
		active = true;
	}
	return active
		? {
				...uniforms,
				u_relightOffset: relight.offset,
				u_relightPos: [relight.x, relight.y],
				u_relightScale: relight.scale,
			}
		: null;
}

/** Crop insets (left, top, right, bottom) the shader maps geometry into. */
export const glCropUniform = (
	segment: Segment
): readonly [number, number, number, number] => {
	const { bottom, left, right, top } = segment.crop;
	return [left, top, right, bottom];
};

export function effectsPass(segment: Segment, elapsed: number): GlPass | null {
	const uniforms = glEffectUniformValues(effectsAt(segment, elapsed));
	if (!uniforms) {
		return null;
	}
	return {
		fragment: effectsFragment,
		id: "effects",
		uniforms: { ...uniforms, u_crop: glCropUniform(segment) },
	};
}
