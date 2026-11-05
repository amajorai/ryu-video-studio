/**
 * WebGL grade pass (W2-V5): the basic colour (folded in so it runs first,
 * as in the render), levels, the shadows/highlights tone curve,
 * lift/gamma/gain wheels, RGB curves, HSL bands / hue-vs-sat and an imported
 * LUT. It mirrors the CPU reference `compileGrade` in
 * `shared/color-advanced.ts`; the render uses the matching FFmpeg filters.
 *
 * The pass runner only binds scalar and vector uniforms, so curves travel as
 * `CURVE_SAMPLES`-point tables packed into `vec4` arrays (`u_master[0]`…),
 * and a LUT is resampled to a `PREVIEW_LUT_SIZE`³ grid embedded in the shader
 * source as a constant array. LUTs reach the preview through
 * `setPreviewLut` (each preview media layer loads its clip's LUT from
 * `GET /luts?id=` with `usePreviewLut`); until a clip's LUT is loaded its
 * preview skips the LUT step.
 */
import {
	activeCurves,
	type CurveChannel,
	curveToTable,
	type HueColor,
	hasAdvancedGrade,
	hueSaturationFilters,
	levelsOf,
	lutIntensityOf,
	toneCurveOf,
	wheelBalanceOf,
} from "../../../../../shared/color-advanced.ts";
import {
	type CubeLut,
	resampleCubeLut,
} from "../../../../../shared/cube-lut.ts";
import type { Segment } from "../../../../../shared/project.ts";
import type { GlPass, GlUniformValue } from "../pass.ts";

/** Pass id of the grade pass (suffixed with `:<lut id>` when a LUT is embedded). */
const GRADE_PASS_ID = "grade";
/** Points per curve table (packed four per `vec4`). */
export const CURVE_SAMPLES = 33;
const CURVE_VECTORS = Math.ceil(CURVE_SAMPLES / 4);
/** Grid size of the LUT embedded in the preview shader. */
export const PREVIEW_LUT_SIZE = 9;
/** Most `huesaturation` filters a grade produces (global plus one per hue range). */
export const MAX_HUE_FILTERS = 7;

const curveUniforms = ["tone", "master", "red", "green", "blue"] as const;

const hueBits: Record<HueColor, number> = {
	b: 16,
	c: 8,
	g: 4,
	m: 32,
	r: 1,
	y: 2,
};

/**
 * `u_hueMask` bits of a filter's hue ranges; bit k is the range centered at
 * k × 60° (r, y, g, c, b, m), matching the shader loop.
 */
export function hueMaskOf(colors: readonly HueColor[]): number {
	return colors.reduce((mask, color) => mask + hueBits[color], 0);
}

const previewLuts = new Map<string, Float32Array>();

/** Make a parsed LUT available to the preview under its id. */
export function setPreviewLut(lutId: string, lut: CubeLut) {
	previewLuts.set(lutId, resampleCubeLut(lut, PREVIEW_LUT_SIZE).data);
}

/** Whether the preview has the LUT's table. */
export function hasPreviewLut(lutId: string): boolean {
	return previewLuts.has(lutId);
}

/** Forget every preview LUT (tests, or after a LUT is deleted). */
export function clearPreviewLuts(lutId?: string) {
	if (lutId) {
		previewLuts.delete(lutId);
	} else {
		previewLuts.clear();
	}
}

const curveFunctions = `
float curveAt(vec4 table[${CURVE_VECTORS}], float x) {
	float position = clamp(x, 0.0, 1.0) * ${CURVE_SAMPLES - 1}.0;
	int index = min(int(floor(position)), ${CURVE_SAMPLES - 2});
	int next = index + 1;
	float a = table[index / 4][index % 4];
	float b = table[next / 4][next % 4];
	return mix(a, b, position - float(index));
}
`;

const balanceFunctions = `
float balanceComponent(float v, float l, float s, float m, float h) {
	const float a = 4.0;
	const float b = 0.333;
	const float scale = 0.7;
	s *= clamp((b - l) * a + 0.5, 0.0, 1.0) * scale;
	m *= clamp((l - b) * a + 0.5, 0.0, 1.0) * clamp((1.0 - l - b) * a + 0.5, 0.0, 1.0) * scale;
	h *= clamp((l + b - 1.0) * a + 0.5, 0.0, 1.0) * scale;
	return clamp(v + s + m + h, 0.0, 1.0);
}
`;

const hueFunctions = `
vec3 rgbToHsv(vec3 c) {
	float maxValue = max(c.r, max(c.g, c.b));
	float minValue = min(c.r, min(c.g, c.b));
	float delta = maxValue - minValue;
	float hue = 0.0;
	if (delta > 1e-6) {
		if (maxValue == c.r) {
			hue = 60.0 * mod((c.g - c.b) / delta + 6.0, 6.0);
		} else if (maxValue == c.g) {
			hue = 60.0 * ((c.b - c.r) / delta + 2.0);
		} else {
			hue = 60.0 * ((c.r - c.g) / delta + 4.0);
		}
	}
	return vec3(hue, maxValue > 1e-6 ? delta / maxValue : 0.0, maxValue);
}

vec3 hsvToRgb(vec3 hsv) {
	float chroma = hsv.z * hsv.y;
	float sector = mod(mod(hsv.x, 360.0) + 360.0, 360.0) / 60.0;
	float x = chroma * (1.0 - abs(mod(sector, 2.0) - 1.0));
	float m = hsv.z - chroma;
	int index = int(floor(sector)) % 6;
	vec3 rgb = index == 0 ? vec3(chroma, x, 0.0)
		: index == 1 ? vec3(x, chroma, 0.0)
		: index == 2 ? vec3(0.0, chroma, x)
		: index == 3 ? vec3(0.0, x, chroma)
		: index == 4 ? vec3(x, 0.0, chroma)
		: vec3(chroma, 0.0, x);
	return rgb + m;
}

vec3 hueSaturation(vec3 rgb, vec4 adjust, float mask) {
	vec3 hsv = rgbToHsv(rgb);
	float membership = 0.0;
	for (int k = 0; k < 6; k++) {
		float bit = mod(floor(mask / pow(2.0, float(k))), 2.0);
		float center = float(k) * 60.0;
		float hueDistance = abs(mod(hsv.x - center + 540.0, 360.0) - 180.0);
		membership += bit * max(0.0, 1.0 - hueDistance / 60.0);
	}
	float maxValue = max(rgb.r, max(rgb.g, rgb.b));
	float minValue = min(rgb.r, min(rgb.g, rgb.b));
	float lightness = (maxValue + minValue) * 0.5;
	float denominator = 1.0 - abs(2.0 * lightness - 1.0);
	float saturation = denominator > 1e-6 ? (maxValue - minValue) / denominator : 0.0;
	float weight = clamp(min(1.0, membership) * saturation * adjust.w, 0.0, 1.0);
	if (weight <= 0.0) {
		return rgb;
	}
	vec3 rotated = adjust.x != 0.0 ? hsvToRgb(vec3(hsv.x + adjust.x * weight, hsv.y, hsv.z)) : rgb;
	float mean = (rotated.r + rotated.g + rotated.b) / 3.0;
	vec3 graded = (vec3(mean) + (rotated - vec3(mean)) * (1.0 + adjust.y * weight)) * (1.0 + adjust.z * weight);
	return clamp(graded, 0.0, 1.0);
}
`;

const formatFloat = (value: number) => {
	const text = Number(value.toFixed(5)).toString();
	return text.includes(".") || text.includes("e") ? text : `${text}.0`;
};

function lutFunctions(table: Float32Array | undefined): string {
	if (!table) {
		return "vec3 lutSample(vec3 c) { return c; }\n";
	}
	const size = PREVIEW_LUT_SIZE;
	const entries: string[] = [];
	for (let index = 0; index < size ** 3; index++) {
		entries.push(
			`vec3(${formatFloat(table[index * 3] ?? 0)},${formatFloat(table[index * 3 + 1] ?? 0)},${formatFloat(table[index * 3 + 2] ?? 0)})`
		);
	}
	return `
const vec3 LUT[${size ** 3}] = vec3[${size ** 3}](${entries.join(",")});
vec3 lutAt(int r, int g, int b) {
	return LUT[r + g * ${size} + b * ${size * size}];
}
vec3 lutSample(vec3 c) {
	vec3 position = clamp(c, 0.0, 1.0) * ${size - 1}.0;
	ivec3 low = min(ivec3(floor(position)), ivec3(${size - 2}));
	vec3 f = position - vec3(low);
	vec3 c00 = mix(lutAt(low.x, low.y, low.z), lutAt(low.x + 1, low.y, low.z), f.x);
	vec3 c10 = mix(lutAt(low.x, low.y + 1, low.z), lutAt(low.x + 1, low.y + 1, low.z), f.x);
	vec3 c01 = mix(lutAt(low.x, low.y, low.z + 1), lutAt(low.x + 1, low.y, low.z + 1), f.x);
	vec3 c11 = mix(lutAt(low.x, low.y + 1, low.z + 1), lutAt(low.x + 1, low.y + 1, low.z + 1), f.x);
	return mix(mix(c00, c10, f.y), mix(c01, c11, f.y), f.z);
}
`;
}

/** The grade fragment body, with an embedded LUT table when one is given. */
export function gradeFragment(lutTable?: Float32Array): string {
	return `
uniform vec4 u_levels;
uniform vec4 u_steps;
uniform vec4 u_channels;
uniform vec4 u_tone[${CURVE_VECTORS}];
uniform vec4 u_master[${CURVE_VECTORS}];
uniform vec4 u_red[${CURVE_VECTORS}];
uniform vec4 u_green[${CURVE_VECTORS}];
uniform vec4 u_blue[${CURVE_VECTORS}];
uniform vec3 u_shadows;
uniform vec3 u_midtones;
uniform vec3 u_highlights;
uniform float u_hueCount;
uniform vec4 u_hueAdjust[${MAX_HUE_FILTERS}];
uniform float u_hueMask[${MAX_HUE_FILTERS}];
uniform vec4 u_basic;
uniform vec3 u_basicBalance;
uniform float u_lutIntensity;
${curveFunctions}${balanceFunctions}${hueFunctions}${lutFunctions(lutTable)}
void main() {
	vec4 color = texture(u_source, v_uv);
	vec3 rgb = color.rgb;
	if (u_basic.w > 0.5) {
		// Basic colour first, like the render's eq + colorbalance: brightness
		// and contrast on luma, saturation on chroma, then the shadow balance.
		float luma = dot(rgb, vec3(0.299, 0.587, 0.114));
		float adjusted = (luma - 0.5) * u_basic.y + 0.5 + u_basic.x;
		rgb = clamp(vec3(adjusted) + (rgb - vec3(luma)) * u_basic.z, 0.0, 1.0);
		float lightness = max(rgb.r, max(rgb.g, rgb.b)) + min(rgb.r, min(rgb.g, rgb.b));
		rgb = vec3(
			balanceComponent(rgb.r, lightness, u_basicBalance.r, 0.0, 0.0),
			balanceComponent(rgb.g, lightness, u_basicBalance.g, 0.0, 0.0),
			balanceComponent(rgb.b, lightness, u_basicBalance.b, 0.0, 0.0)
		);
	}
	if (u_steps.x > 0.5) {
		rgb = u_levels.z + clamp((rgb - u_levels.x) / (u_levels.y - u_levels.x), 0.0, 1.0) * (u_levels.w - u_levels.z);
	}
	if (u_steps.y > 0.5) {
		rgb = vec3(curveAt(u_tone, rgb.r), curveAt(u_tone, rgb.g), curveAt(u_tone, rgb.b));
	}
	if (u_steps.z > 0.5) {
		float l = max(rgb.r, max(rgb.g, rgb.b)) + min(rgb.r, min(rgb.g, rgb.b));
		rgb = vec3(
			balanceComponent(rgb.r, l, u_shadows.r, u_midtones.r, u_highlights.r),
			balanceComponent(rgb.g, l, u_shadows.g, u_midtones.g, u_highlights.g),
			balanceComponent(rgb.b, l, u_shadows.b, u_midtones.b, u_highlights.b)
		);
	}
	if (u_steps.w > 0.5) {
		if (u_channels.y > 0.5) { rgb.r = curveAt(u_red, rgb.r); }
		if (u_channels.z > 0.5) { rgb.g = curveAt(u_green, rgb.g); }
		if (u_channels.w > 0.5) { rgb.b = curveAt(u_blue, rgb.b); }
		if (u_channels.x > 0.5) {
			rgb = vec3(curveAt(u_master, rgb.r), curveAt(u_master, rgb.g), curveAt(u_master, rgb.b));
		}
	}
	for (int i = 0; i < ${MAX_HUE_FILTERS}; i++) {
		if (float(i) >= u_hueCount) {
			break;
		}
		rgb = hueSaturation(rgb, u_hueAdjust[i], u_hueMask[i]);
	}
	if (u_lutIntensity > 0.0) {
		rgb = mix(rgb, lutSample(rgb), u_lutIntensity);
	}
	outColor = vec4(rgb, color.a);
}
`;
}

/** Pack a curve (or the identity) into `vec4` uniforms named `<name>[i]`. */
function packCurve(
	uniforms: Record<string, GlUniformValue>,
	name: string,
	table: readonly number[] | null
) {
	for (let vector = 0; vector < CURVE_VECTORS; vector++) {
		const values = [0, 1, 2, 3].map((offset) => {
			const index = Math.min(CURVE_SAMPLES - 1, vector * 4 + offset);
			const value = table ? table[index] : index / (CURVE_SAMPLES - 1);
			return Number((value ?? 0).toFixed(6));
		});
		uniforms[`${name}[${vector}]`] = [
			values[0] ?? 0,
			values[1] ?? 0,
			values[2] ?? 0,
			values[3] ?? 0,
		];
	}
}

/**
 * The basic colour step folded into the grade pass, matching the render's
 * `eq` + `colorbalance` (`render-stages/color-basic.ts`): brightness,
 * contrast and saturation, then the temperature/tint shadow balance.
 */
export function basicColorUniforms(segment: Segment): {
	u_basic: [number, number, number, number];
	u_basicBalance: [number, number, number];
} {
	const { exposure, temperature, tint, vibrance } = segment.colorGrade;
	return {
		u_basic: [
			segment.brightness + exposure / 3,
			segment.contrast,
			segment.saturation * (1 + vibrance * 0.5),
			1,
		],
		u_basicBalance: [temperature, tint, -temperature],
	};
}

/** Uniforms for a clip's grade (the LUT table travels in the shader source). */
export function gradeUniforms(
	segment: Segment,
	lutLoaded: boolean
): Record<string, GlUniformValue> {
	const grade = segment.colorGrade;
	const uniforms: Record<string, GlUniformValue> = {
		...basicColorUniforms(segment),
	};
	const levels = levelsOf(grade);
	uniforms.u_levels = levels
		? [levels.inMin, levels.inMax, levels.outMin, levels.outMax]
		: [0, 1, 0, 1];
	const tone = toneCurveOf(grade);
	const balance = wheelBalanceOf(grade);
	const curves = activeCurves(grade);
	const curveTable = (channel: CurveChannel) => {
		const points = curves[channel];
		return points ? curveToTable(points, CURVE_SAMPLES) : null;
	};
	uniforms.u_steps = [
		levels ? 1 : 0,
		tone ? 1 : 0,
		balance ? 1 : 0,
		Object.keys(curves).length ? 1 : 0,
	];
	uniforms.u_channels = [
		curves.master ? 1 : 0,
		curves.red ? 1 : 0,
		curves.green ? 1 : 0,
		curves.blue ? 1 : 0,
	];
	for (const name of curveUniforms) {
		packCurve(
			uniforms,
			`u_${name}`,
			name === "tone"
				? tone && curveToTable(tone, CURVE_SAMPLES)
				: curveTable(name)
		);
	}
	uniforms.u_shadows = balance?.shadows ?? [0, 0, 0];
	uniforms.u_midtones = balance?.midtones ?? [0, 0, 0];
	uniforms.u_highlights = balance?.highlights ?? [0, 0, 0];
	const filters = hueSaturationFilters(grade).slice(0, MAX_HUE_FILTERS);
	uniforms.u_hueCount = filters.length;
	for (let index = 0; index < MAX_HUE_FILTERS; index++) {
		const filter = filters[index];
		uniforms[`u_hueAdjust[${index}]`] = filter
			? [filter.hue, filter.saturation, filter.intensity, filter.strength]
			: [0, 0, 0, 0];
		uniforms[`u_hueMask[${index}]`] = filter ? hueMaskOf(filter.colors) : 0;
	}
	uniforms.u_lutIntensity = lutLoaded ? lutIntensityOf(grade) : 0;
	return uniforms;
}

/**
 * Whether a pass list draws the grade pass. The grade pass applies the basic
 * colour itself (before the advanced steps, like the render), so the CSS
 * filter must then leave basic colour out.
 */
export function hasGradePass(passes: readonly GlPass[]): boolean {
	return passes.some(
		(pass) =>
			pass.id === GRADE_PASS_ID || pass.id.startsWith(`${GRADE_PASS_ID}:`)
	);
}

export function gradePass(segment: Segment, _elapsed: number): GlPass | null {
	const grade = segment.colorGrade;
	if (!hasAdvancedGrade(grade)) {
		return null;
	}
	const table =
		grade.lut && lutIntensityOf(grade) > 0
			? previewLuts.get(grade.lut.lutId)
			: undefined;
	// A LUT-only grade whose table is not loaded yet has nothing to draw.
	if (!(table || hasAdvancedGrade({ ...grade, lut: undefined }))) {
		return null;
	}
	return {
		fragment: gradeFragment(table),
		id:
			table && grade.lut
				? `${GRADE_PASS_ID}:${grade.lut.lutId}`
				: GRADE_PASS_ID,
		uniforms: gradeUniforms(segment, Boolean(table)),
	};
}
