import { describe, expect, test } from "bun:test";
import type { Effect, EffectType } from "../../../../../shared/effects.ts";
import {
	type Asset,
	newSegment,
	type Segment,
	segmentSchema,
} from "../../../../../shared/project.ts";
import { orderedGlPasses } from "../pass.ts";
import {
	effectsFragment,
	effectsPass,
	glCropUniform,
	glEffectUniforms,
	glEffectUniformValues,
} from "./effects.ts";

const video: Asset = {
	createdAt: "2026-01-01T00:00:00.000Z",
	duration: 4,
	hasAudio: false,
	height: 1080,
	id: "00000000-0000-4000-8000-000000000001",
	kind: "video",
	name: "Clip",
	width: 1920,
};
const EFFECT_ID = "00000000-0000-4000-9000-000000000001";

const effect = (type: EffectType, patch: Partial<Effect> = {}): Effect => ({
	amount: 1,
	enabled: true,
	type,
	...patch,
});

const withEffects = (
	effects: Effect[],
	patch: Partial<Segment> = {}
): Segment => segmentSchema.parse({ ...newSegment(video), effects, ...patch });

describe("effectsPass", () => {
	test("clips without GL effects get no pass", () => {
		expect(effectsPass(newSegment(video), 0)).toBeNull();
		for (const type of [
			"blur",
			"invert",
			"hue-cycle",
			"dehaze",
			"motion-blur",
			"echo",
		] as const) {
			expect(effectsPass(withEffects([effect(type)]), 0)).toBeNull();
		}
		expect(
			effectsPass(withEffects([effect("glow", { enabled: false })]), 0)
		).toBeNull();
		expect(
			effectsPass(withEffects([effect("glow", { amount: 0 })]), 0)
		).toBeNull();
	});

	test("every GL effect has a uniform the shader declares", () => {
		for (const name of Object.values(glEffectUniforms)) {
			expect(effectsFragment).toContain(`uniform float ${name};`);
		}
		expect(effectsFragment).toContain("void main()");
	});

	test("uniforms take the strongest instance and its seed phase", () => {
		const pass = effectsPass(
			withEffects([
				effect("grain", { amount: 0.3 }),
				effect("grain", { amount: 0.7, seed: 1 }),
				effect("mosaic", { amount: 0.5 }),
			]),
			0
		);
		expect(pass?.id).toBe("effects");
		expect(pass?.uniforms.u_grain).toBe(0.7);
		expect(pass?.uniforms.u_grainPhase).toBeCloseTo(2.399_963);
		expect(pass?.uniforms.u_mosaic).toBe(0.5);
		expect(pass?.uniforms.u_glow).toBe(0);
		expect(orderedGlPasses({ effects: pass })).toHaveLength(1);
	});

	test("keyframed amounts resolve at the clip time", () => {
		const segment = withEffects([effect("glow", { id: EFFECT_ID })], {
			keyframes: [
				{
					id: "00000000-0000-4000-a000-000000000001",
					property: "effectAmount",
					target: EFFECT_ID,
					time: 0,
					value: 0,
				},
				{
					id: "00000000-0000-4000-a000-000000000002",
					property: "effectAmount",
					target: EFFECT_ID,
					time: 2,
					value: 1,
				},
			],
		});
		expect(effectsPass(segment, 0)).toBeNull();
		expect(effectsPass(segment, 1)?.uniforms.u_glow).toBeCloseTo(0.5);
	});

	test("geometry follows the crop rectangle the render crops to first", () => {
		const uncropped = effectsPass(withEffects([effect("letterbox")]), 0);
		expect(uncropped?.uniforms.u_crop).toEqual([0, 0, 0, 0]);
		const cropped = withEffects([effect("letterbox")], {
			crop: { bottom: 0.15, left: 0.1, right: 0.2, top: 0.15 },
		});
		expect(glCropUniform(cropped)).toEqual([0.1, 0.15, 0.2, 0.15]);
		expect(effectsPass(cropped, 0)?.uniforms.u_crop).toEqual([
			0.1, 0.15, 0.2, 0.15,
		]);
		expect(effectsFragment).toContain("uniform vec4 u_crop;");
		// Letterbox, lights and sampling all go through crop space.
		expect(effectsFragment).toContain("vec2 uv = sourceUv(pos);");
		expect(effectsFragment).toContain(
			"(vec2(v_uv.x, 1.0 - v_uv.y) - u_crop.xy) / cropSize()"
		);
	});

	test("uniform values are null for an empty stack", () => {
		expect(glEffectUniformValues([])).toBeNull();
	});
});

test("relight presets drive the light position and tint uniforms", () => {
	const uniforms = glEffectUniformValues([
		{
			amount: 0.6,
			enabled: true,
			light: { preset: "rim-right", y: 0.7 },
			type: "relight",
		},
	]);
	expect(uniforms?.u_relight).toBe(0.6);
	expect(uniforms?.u_relightPos).toEqual([0.98, 0.7]);
	expect(uniforms?.u_relightOffset).toEqual([70, 68, 66]);
	const key = glEffectUniformValues([
		{ amount: 1, enabled: true, type: "relight" },
	]);
	expect(key?.u_relightPos).toEqual([0.3, 0.25]);
});
