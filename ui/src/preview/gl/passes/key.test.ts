import { describe, expect, test } from "bun:test";
import {
	type Key,
	keyedPixel,
	type Rgb,
} from "../../../../../shared/keying.ts";
import {
	type Asset,
	newSegment,
	type Segment,
	segmentSchema,
} from "../../../../../shared/project.ts";
import { type GlUniformValue, orderedGlPasses } from "../pass.ts";
import {
	type KeyUniforms,
	keyFragment,
	keyPass,
	keyTypeCodes,
	keyUniforms,
} from "./key.ts";

const video: Asset = {
	createdAt: "2026-01-01T00:00:00.000Z",
	duration: 4,
	hasAudio: false,
	height: 1080,
	id: "00000000-0000-4000-8000-000000000001",
	kind: "video",
	name: "Green screen",
	width: 1920,
};

const keyed = (key: Segment["key"]): Segment =>
	segmentSchema.parse({ ...newSegment(video), key });

const scalar = (value: GlUniformValue | undefined): number =>
	typeof value === "number" ? value : Number.NaN;
const vector = (value: GlUniformValue | undefined): readonly number[] =>
	typeof value === "object" ? value : [];

/**
 * A line-by-line TypeScript port of `keyAlpha` in `keyFragment`, driven by
 * the pass uniforms, so the parity test below checks the shader's math and
 * its uniforms against `keyedPixel` (which matches FFmpeg).
 */
function shaderAlpha(uniforms: KeyUniforms, rgb: Rgb): number {
	const keyType = scalar(uniforms.u_keyType);
	const similarity = scalar(uniforms.u_similarity);
	const blend = scalar(uniforms.u_blend);
	const ramp = (distance: number, sim: number, soft: number) => {
		if (soft > 0.0001) {
			return Math.min(1, Math.max(0, (distance - sim) / soft));
		}
		return distance > sim ? 1 : 0;
	};
	const hsvRamp = (distance: number, sim: number, soft: number) => {
		if (distance < sim) {
			return 0;
		}
		return soft > 0 ? Math.min(1, Math.max(0, (distance - sim) / soft)) : 1;
	};
	const [r, g, b] = rgb;
	const y = Math.floor(16 + 65.481 * r + 128.553 * g + 24.966 * b + 0.5);
	const u = Math.floor(128 - 37.797 * r - 74.203 * g + 112 * b + 0.5);
	const v = Math.floor(128 + 112 * r - 93.786 * g - 18.214 * b + 0.5);
	if (keyType < 0.5) {
		const [keyU = 0, keyV = 0] = vector(uniforms.u_keyUV);
		const distance = Math.sqrt(((u - keyU) ** 2 + (v - keyV) ** 2) / 130_050);
		return ramp(distance, similarity, blend);
	}
	if (keyType < 1.5) {
		const [kr = 0, kg = 0, kb = 0] = vector(uniforms.u_keyColor);
		const distance = Math.sqrt(
			((r - kr) ** 2 + (g - kg) ** 2 + (b - kb) ** 2) / 3
		);
		return ramp(distance, similarity, blend);
	}
	if (keyType < 2.5) {
		const keyHue = scalar(uniforms.u_keyHue);
		if (keyHue < 0) {
			return 1;
		}
		const [gateSimilarity = 0, gateBlend = 0] = vector(uniforms.u_hueGate);
		const cu = u - 127.5;
		const cv = v - 127.5;
		const hue = Math.atan2(cu, cv) + Math.PI;
		const chord = Math.sqrt(Math.max(2 - 2 * Math.cos(keyHue - hue), 0));
		const saturation = Math.sqrt((cu * cu + cv * cv) / 32_512.5);
		return Math.max(
			hsvRamp(chord, similarity, blend),
			1 - hsvRamp(saturation, gateSimilarity, gateBlend)
		);
	}
	const [black = 0, white = 0, soft = 0] = vector(uniforms.u_lumaBand);
	if (y >= black && y <= white) {
		return 0;
	}
	if (y > black - soft && y < white + soft) {
		return y < black ? (black - y) / soft : (y - white) / soft;
	}
	return 1;
}

describe("keyPass", () => {
	test("unkeyed clips get no pass, so the plain media element stays", () => {
		expect(keyPass(newSegment(video), 0)).toBeNull();
		expect(orderedGlPasses({ key: keyPass(newSegment(video), 0) })).toEqual([]);
	});

	test("a chroma key resolves defaults into uniforms", () => {
		const pass = keyPass(keyed({ color: "#00ff00", type: "chroma" }), 0);
		expect(pass?.id).toBe("key");
		expect(pass?.fragment).toBe(keyFragment);
		expect(pass?.uniforms.u_keyType).toBe(keyTypeCodes.chroma);
		expect(pass?.uniforms.u_keyColor).toEqual([0, 1, 0]);
		// Limited-range U/V of pure green, as FFmpeg's yuva444p frame holds it.
		expect(pass?.uniforms.u_keyUV).toEqual([54, 34]);
		expect(pass?.uniforms.u_similarity).toBe(0.15);
		expect(pass?.uniforms.u_blend).toBe(0.08);
		expect(pass?.uniforms.u_spillChannel).toBe(1);
	});

	test("blue screens suppress blue spill; luma keys have no spill channel", () => {
		const blue = keyPass(
			keyed({ color: "#0000ff", spill: 0.6, type: "color" }),
			0
		);
		expect(blue?.uniforms.u_spillChannel).toBe(2);
		expect(blue?.uniforms.u_spill).toBe(0.6);
		expect(blue?.uniforms.u_keyType).toBe(keyTypeCodes.color);
		const luma = keyPass(
			keyed({ blend: 0, lumaHigh: 1, lumaLow: 0, spill: 1, type: "luma" }),
			0
		);
		expect(luma?.uniforms.u_spillChannel).toBe(0);
		// The full band is limited-range black 16 to white 235 (half a level wider).
		expect(luma?.uniforms.u_lumaBand).toEqual([15, 235, 0]);
	});

	test("a grey hue key disables the hue match", () => {
		expect(
			keyPass(keyed({ color: "#808080", type: "hsv" }), 0)?.uniforms.u_keyHue
		).toBe(-1);
		const red = scalar(
			keyPass(keyed({ color: "#ff0000", type: "hsv" }), 0)?.uniforms.u_keyHue
		);
		expect(red).toBeGreaterThan(0);
	});

	test("the shader declares every uniform it is given", () => {
		const pass = keyPass(keyed({ color: "#00ff00", type: "chroma" }), 0);
		for (const name of Object.keys(pass?.uniforms ?? {})) {
			expect(keyFragment).toMatch(new RegExp(`uniform \\w+ ${name};`));
		}
		// The limited-range BT.601 weights match `limitedYuvOf` in shared/keying.ts.
		expect(keyFragment).toContain("vec3(65.481, 128.553, 24.966)");
		expect(keyFragment).toContain("vec3(-37.797, -74.203, 112.0)");
		expect(keyFragment).toContain("vec3(112.0, -93.786, -18.214)");
		expect(keyFragment).toContain("void main()");
	});
});

describe("shader parity with keyedPixel", () => {
	const keys: Key[] = [
		{ color: "#00ff00", type: "chroma" },
		{ blend: 0.1, color: "#0000ff", similarity: 0.2, type: "chroma" },
		{ color: "#00ff00", type: "color" },
		{ color: "#00ff00", type: "hsv" },
		{ blend: 0.1, color: "#ff0000", similarity: 0.1, type: "hsv" },
		{ color: "#ff00ff", similarity: 0.25, type: "hsv" },
		{ color: "#808080", type: "hsv" },
		{ type: "luma" },
		{ blend: 0, lumaHigh: 1, lumaLow: 0.95, type: "luma" },
		{ blend: 0.2, lumaHigh: 0.6, lumaLow: 0.4, type: "luma" },
	];
	const steps = [0, 0.08, 0.25, 0.5, 0.75, 0.94, 1];
	const pixels: Rgb[] = [];
	for (const r of steps) {
		for (const g of steps) {
			for (const b of steps) {
				pixels.push([r, g, b]);
			}
		}
	}

	for (const key of keys) {
		test(`${key.type} ${key.color ?? ""} matches the reference`, () => {
			const uniforms = keyUniforms(key);
			for (const pixel of pixels) {
				expect(shaderAlpha(uniforms, pixel)).toBeCloseTo(
					keyedPixel(key, pixel).alpha,
					6
				);
			}
		});
	}
});
