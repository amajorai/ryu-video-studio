import { describe, expect, test } from "bun:test";
import type { Effect, EffectType } from "../../../../shared/effects.ts";
import {
	type Asset,
	newSegment,
	type Segment,
	segmentSchema,
} from "../../../../shared/project.ts";
import { effectFilterCss, vignetteAmount } from "./effects.ts";

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

const ramp = (target: string): Segment["keyframes"] => [
	{
		id: "00000000-0000-4000-a000-000000000001",
		property: "effectAmount",
		target,
		time: 0,
		value: 0,
	},
	{
		id: "00000000-0000-4000-a000-000000000002",
		property: "effectAmount",
		target,
		time: 2,
		value: 1,
	},
];

const clip = (patch: Partial<Segment>): Segment =>
	segmentSchema.parse({ ...newSegment(video), ...patch });

describe("effect preview CSS", () => {
	test("library effects with a CSS form preview through filters", () => {
		const segment = clip({
			effects: [effect("invert", { amount: 0.5 }), effect("hue-cycle")],
		});
		expect(effectFilterCss(segment, 1)).toBe(" invert(0.5) hue-rotate(90deg)");
	});

	test("keyframed amounts resolve at the elapsed time", () => {
		const segment = clip({
			effects: [effect("invert", { id: EFFECT_ID })],
			keyframes: ramp(EFFECT_ID),
		});
		expect(effectFilterCss(segment, 0)).toBe(" ");
		expect(effectFilterCss(segment, 1)).toBe(" invert(0.5)");
	});

	test("a keyframed vignette follows its curve", () => {
		const segment = clip({
			effects: [effect("vignette", { id: EFFECT_ID })],
			keyframes: ramp(EFFECT_ID),
		});
		expect(vignetteAmount(segment, 0)).toBe(0);
		expect(vignetteAmount(segment, 1)).toBeCloseTo(0.5);
	});
});
