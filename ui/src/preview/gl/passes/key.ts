/**
 * WebGL key pass (W2-V4): chroma, RGB color, hue and luma keys plus spill
 * suppression. It mirrors the reference math in `shared/keying.ts`
 * (`keyedPixel`), which reproduces the FFmpeg filters the render emits
 * (`keyFilterPlan`): YUV keys work on 8-bit limited-range BT.601 values, as
 * FFmpeg's `format=yuva444p` gives them. Only clips with `segment.key` get a
 * pass; null keeps the plain media element.
 */
import {
	HUE_GATE_BLEND,
	HUE_GATE_SIMILARITY,
	hueAngleOf,
	type KeyType,
	limitedYuvOf,
	lumaKeyBandOf,
	resolvedKeyOf,
	spillChannelOf,
	unitRgbOf,
} from "../../../../../shared/keying.ts";
import type { Segment } from "../../../../../shared/project.ts";
import type { GlPass, GlUniformValue } from "../pass.ts";

/** Numeric `u_keyType` per key type (floats, so uniforms stay `uniform1f`). */
export const keyTypeCodes: Record<KeyType, number> = {
	chroma: 0,
	color: 1,
	hsv: 2,
	luma: 3,
};

export const keyFragment = `
uniform float u_keyType;
uniform vec3 u_keyColor;
uniform vec2 u_keyUV;
uniform float u_keyHue;
uniform vec2 u_hueGate;
uniform float u_similarity;
uniform float u_blend;
uniform float u_spill;
uniform float u_spillChannel;
uniform vec3 u_lumaBand;

const float PI = 3.141592653589793;

vec3 limitedYuv(vec3 rgb) {
	return floor(vec3(
		16.0 + dot(rgb, vec3(65.481, 128.553, 24.966)),
		128.0 + dot(rgb, vec3(-37.797, -74.203, 112.0)),
		128.0 + dot(rgb, vec3(112.0, -93.786, -18.214))
	) + 0.5);
}

float ramp(float keyDist, float similarity, float blend) {
	if (blend > 0.0001) {
		return clamp((keyDist - similarity) / blend, 0.0, 1.0);
	}
	return keyDist > similarity ? 1.0 : 0.0;
}

float hsvRamp(float keyDist, float similarity, float blend) {
	if (keyDist < similarity) {
		return 0.0;
	}
	return blend > 0.0 ? clamp((keyDist - similarity) / blend, 0.0, 1.0) : 1.0;
}

float keyAlpha(vec3 rgb) {
	vec3 yuv = limitedYuv(rgb);
	if (u_keyType < 0.5) {
		vec2 delta = yuv.yz - u_keyUV;
		return ramp(sqrt(dot(delta, delta) / 130050.0), u_similarity, u_blend);
	}
	if (u_keyType < 1.5) {
		vec3 delta = rgb - u_keyColor;
		return ramp(sqrt(dot(delta, delta) / 3.0), u_similarity, u_blend);
	}
	if (u_keyType < 2.5) {
		if (u_keyHue < 0.0) {
			return 1.0;
		}
		vec2 c = yuv.yz - 127.5;
		float hue = atan(c.x, c.y) + PI;
		float chord = sqrt(max(2.0 - 2.0 * cos(u_keyHue - hue), 0.0));
		float sat = sqrt(dot(c, c) / 32512.5);
		return max(
			hsvRamp(chord, u_similarity, u_blend),
			1.0 - hsvRamp(sat, u_hueGate.x, u_hueGate.y)
		);
	}
	float y = yuv.x;
	float black = u_lumaBand.x;
	float white = u_lumaBand.y;
	float soft = u_lumaBand.z;
	if (y >= black && y <= white) {
		return 0.0;
	}
	if (y > black - soft && y < white + soft) {
		return y < black ? (black - y) / soft : (y - white) / soft;
	}
	return 1.0;
}

void main() {
	vec4 color = texture(u_source, v_uv);
	float alpha = keyAlpha(color.rgb);
	vec3 rgb = color.rgb;
	if (u_spill > 0.0 && u_spillChannel > 0.5) {
		if (u_spillChannel < 1.5) {
			rgb.g -= max(0.0, rgb.g - (rgb.r + rgb.b) * 0.5) * u_spill;
		} else {
			rgb.b -= max(0.0, rgb.b - (rgb.r + rgb.g) * 0.5) * u_spill;
		}
	}
	outColor = vec4(rgb, color.a * alpha);
}
`;

const spillCodes = { blue: 2, green: 1 } as const;

export type KeyUniforms = Record<string, GlUniformValue>;

/** The key pass uniforms for a key (exported for the parity tests). */
export function keyUniforms(key: NonNullable<Segment["key"]>): KeyUniforms {
	const resolved = resolvedKeyOf(key);
	const target = unitRgbOf(resolved.color);
	const { u, v } = limitedYuvOf(target);
	const band = lumaKeyBandOf(resolved);
	const channel = spillChannelOf(key);
	return {
		u_blend: resolved.blend,
		u_hueGate: [HUE_GATE_SIMILARITY, HUE_GATE_BLEND],
		u_keyColor: target,
		u_keyHue: hueAngleOf(resolved.color) ?? -1,
		u_keyType: keyTypeCodes[resolved.type],
		u_keyUV: [u, v],
		u_lumaBand: [band.black, band.white, band.soft],
		u_similarity: resolved.similarity,
		u_spill: resolved.spill,
		u_spillChannel: channel ? spillCodes[channel] : 0,
	};
}

export function keyPass(segment: Segment, _elapsed: number): GlPass | null {
	const { key } = segment;
	if (!key) {
		return null;
	}
	return { fragment: keyFragment, id: "key", uniforms: keyUniforms(key) };
}
