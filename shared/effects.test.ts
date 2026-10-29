import { describe, expect, test } from "bun:test";
import {
	type Effect,
	type EffectType,
	effectAmountSteps,
	effectLabelPrefix,
	effectLabels,
	effectStackCss,
	effectStackFilters,
	effectStackSchema,
	effectStackVignetteAmount,
	effectsAt,
	effectTypeSchema,
	MAX_EFFECT_STACK,
	MAX_EFFECT_STEPS,
	visualEffectFilters,
} from "./effects.ts";
import {
	type Asset,
	type Keyframe,
	newSegment,
	type Segment,
	segmentSchema,
} from "./project.ts";

const asset: Asset = {
	createdAt: "2026-01-01T00:00:00.000Z",
	duration: 10,
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

function clip(patch: Partial<Segment>): Segment {
	return segmentSchema.parse({ ...newSegment(asset), ...patch });
}

const amountKeyframes = (
	points: readonly [number, number][],
	target = EFFECT_ID
): Keyframe[] =>
	points.map(([time, value], index) => ({
		id: `00000000-0000-4000-a000-${index.toString(16).padStart(12, "0")}`,
		property: "effectAmount",
		target,
		time,
		value,
	}));

/** How often each `[label]` occurs in a filter list. */
function labelCounts(filters: readonly string[]): Map<string, number> {
	const counts = new Map<string, number>();
	for (const match of filters.join(",").matchAll(/\[([^\]]+)\]/g)) {
		const label = match[1] ?? "";
		counts.set(label, (counts.get(label) ?? 0) + 1);
	}
	return counts;
}

describe("legacy effects", () => {
	test("keep their historical filter strings", () => {
		expect(visualEffectFilters("none")).toEqual(["null"]);
		expect(visualEffectFilters("blur")).toEqual([
			"boxblur=luma_radius=2:luma_power=1",
		]);
		expect(visualEffectFilters("grayscale")).toEqual(["hue=s=0"]);
		expect(visualEffectFilters("sepia")).toEqual([
			"colorchannelmixer=.393:.769:.189:0:.349:.686:.168:0:.272:.534:.131",
		]);
		expect(effectStackFilters([effect("blur", { amount: 0.5 })])).toEqual([
			"boxblur=luma_radius=3.00:luma_power=1",
		]);
		expect(effectStackFilters([effect("sharpen")])).toEqual([
			"unsharp=lx=3:ly=3:la=1.500",
		]);
		expect(effectStackFilters([effect("vignette", { amount: 0.5 })])).toEqual([
			"vignette=angle=0.393:mode=forward",
		]);
		expect(
			effectStackVignetteAmount([
				effect("vignette", { amount: 0.3 }),
				effect("vignette", { amount: 0.8, enabled: false }),
			])
		).toBe(0.3);
		expect(effectStackCss([effect("grayscale", { amount: 0.5 })])).toEqual([
			"grayscale(0.5)",
		]);
	});
});

describe("effect library filters", () => {
	test("every effect has a label and a filter snapshot at half amount", () => {
		const snapshot: Record<string, string[]> = {};
		for (const type of effectTypeSchema.options) {
			expect(effectLabels[type]).toBeTruthy();
			const filters = effectStackFilters(
				[effect(type, { amount: 0.5, seed: 3 })],
				{ label: "fxA" }
			);
			expect(filters.length).toBeGreaterThan(0);
			snapshot[type] = filters;
		}
		expect(snapshot).toMatchSnapshot();
	});

	test("the plan's core filters are used", () => {
		const one = (type: EffectType, amount = 1) =>
			effectStackFilters([effect(type, { amount })], { label: "L" }).join(",");
		expect(one("denoise")).toBe("hqdn3d=4:3:6:4.5");
		expect(one("grain", 0.5)).toBe(
			"noise=c0s=20:c0f=t+u:c1s=20:c1f=t+u:c2s=20:c2f=t+u"
		);
		expect(one("invert")).toBe("negate");
		expect(one("clarity")).toBe("unsharp=13:13:1.5");
		expect(one("rgb-split")).toBe("rgbashift=rh=-8:bh=8");
		expect(one("motion-blur")).toBe("tmix=frames=8");
		expect(one("echo")).toBe("lagfun=decay=0.99");
		expect(one("mosaic")).toBe("pixelize=w=32:h=32");
		expect(one("hue-cycle")).toBe("hue=h='t*90'");
		expect(one("glow")).toContain("blend=all_mode=screen");
		expect(one("edge-detect")).toContain("edgedetect");
		expect(one("mirror")).toContain("hflip");
		expect(one("letterbox")).toContain("drawbox=x=0:y=0:w=iw:h=ih*0.12");
		expect(one("glitch")).toContain("enable='lt(mod(t+0,1.3),0.18)'");
		expect(one("light-leak")).toContain("blend=all_mode=screen");
		expect(one("relight")).toContain("blend=all_mode=softlight");
		// The default relight is the original key light, unchanged.
		expect(one("relight")).toContain("x0='w*(0.3)':y0='h*(0.25)'");
		expect(one("relight")).toContain(
			"lutrgb=r='70+val*0.725':g='68+val*0.7':b='63+val*0.64'"
		);
		const neon = effectStackFilters(
			[effect("relight", { light: { preset: "neon", x: 0.1 } })],
			{ label: "L" }
		).join(",");
		expect(neon).toContain("x0='w*(0.1)':y0='h*(0.3)'");
		expect(neon).toContain(
			"lutrgb=r='78+val*0.72':g='40+val*0.4':b='78+val*0.72'"
		);
		expect(one("skin-smooth")).toContain("smartblur");
		expect(one("skin-smooth")).toContain("maskedmerge");
		expect(one("shake")).toMatch(/^crop=.*sin\(t\*31/);
	});

	test("partial invert and edge detect cross-fade with the dry frame", () => {
		const invert = effectStackFilters([effect("invert", { amount: 0.25 })], {
			label: "L",
		}).join(",");
		expect(invert).toBe(
			"format=rgba,format=gbrap,split[L_0xd][L_0xw];[L_0xw]negate,format=gbrap[L_0xm];[L_0xm][L_0xd]blend=all_mode=normal:all_opacity=0.25:c3_opacity=0"
		);
	});

	test("seeds change grain and glitch phase", () => {
		expect(
			effectStackFilters([effect("grain", { seed: 42 })]).join(",")
		).toContain(":all_seed=42");
		expect(
			effectStackFilters([effect("glitch", { seed: 42 })]).join(",")
		).not.toBe(effectStackFilters([effect("glitch")]).join(","));
	});

	test("disabled effects and amount 0 emit nothing", () => {
		for (const type of effectTypeSchema.options) {
			expect(
				effectStackFilters([
					effect(type, { enabled: false }),
					effect(type, { amount: 0 }),
				])
			).toEqual([]);
			expect(effectStackCss([effect(type, { enabled: false })])).toEqual([]);
		}
	});

	test("the stack holds at most 16 effects", () => {
		expect(MAX_EFFECT_STACK).toBe(16);
		const full = Array.from({ length: 16 }, () => effect("grain"));
		expect(effectStackSchema.safeParse(full).success).toBe(true);
		expect(
			effectStackSchema.safeParse([...full, effect("grain")]).success
		).toBe(false);
	});

	test("branch labels are unique across a stack and between clips", () => {
		const stack = [
			effect("glow"),
			effect("mirror"),
			effect("invert", { amount: 0.5 }),
			effect("edge-detect"),
			effect("light-leak"),
			effect("skin-smooth"),
			effect("relight"),
			effect("glow"),
		];
		const a = labelCounts(effectStackFilters(stack, { label: "fxA" }));
		const b = labelCounts(effectStackFilters(stack, { label: "fxB" }));
		expect(a.size).toBeGreaterThan(10);
		// Every link is produced once and consumed once.
		for (const [label, count] of a) {
			expect(count).toBe(2);
			expect(label.startsWith("fxA_")).toBe(true);
			expect(b.has(label)).toBe(false);
		}
		expect(effectLabelPrefix("0000-ab_c")).toBe("fx0000abc");
	});
});

describe("keyframed amounts", () => {
	test("expression effects animate in the filter itself", () => {
		const segment = clip({
			effects: [effect("hue-cycle", { id: EFFECT_ID })],
			keyframes: amountKeyframes([
				[0, 0],
				[2, 1],
			]),
		});
		expect(effectStackFilters(segment.effects, { segment })).toEqual([
			"hue=h='t*90*(clip(if(lt(t,2),0+(1)*max(0,(t-0))/2,1),0,1))'",
		]);
	});

	test("stepped effects emit one timeline window per held amount", () => {
		const segment = clip({
			effects: [effect("mosaic", { id: EFFECT_ID })],
			keyframes: amountKeyframes([
				[0, 0],
				[1, 0],
				[1.2, 0.1],
				[3, 0.1],
			]),
		});
		const steps = effectAmountSteps(segment, EFFECT_ID);
		expect(steps).toEqual([
			{ end: 1, start: 0, value: 0 },
			{ end: 1.2, start: 1, value: 0.05 },
			{ start: 1.2, value: 0.1 },
		]);
		// The zero window is skipped: the frame passes through unchanged.
		expect(effectStackFilters(segment.effects, { segment })).toEqual([
			"pixelize=w=4:h=4:enable='gte(t,1)*lt(t,1.2)'",
			"pixelize=w=5:h=5:enable='gte(t,1.2)'",
		]);
	});

	test("long ramps sample at most eight steps per span", () => {
		const segment = clip({
			effects: [effect("denoise", { id: EFFECT_ID })],
			keyframes: amountKeyframes([
				[0, 0],
				[4, 1],
			]),
		});
		const steps = effectAmountSteps(segment, EFFECT_ID);
		// Eight midpoint samples of the ramp, then the final value held.
		expect(steps).toHaveLength(9);
		expect(steps[0]).toEqual({ end: 0.5, start: 0, value: 0.05 });
		expect(steps[7]).toEqual({ end: 4, start: 3.5, value: 0.95 });
		expect(steps[8]).toEqual({ start: 4, value: 1 });
		const filters = effectStackFilters(segment.effects, { segment });
		expect(filters).toHaveLength(9);
		expect(filters[1]).toBe(
			"hqdn3d=0.8:0.6:1.2:0.9:enable='gte(t,0.5)*lt(t,1)'"
		);
	});

	test("too many steps fall back to a peak-strength cross-fade", () => {
		const points: [number, number][] = Array.from(
			{ length: MAX_EFFECT_STEPS + 2 },
			(_, index) => [index * 0.5, index % 2]
		);
		const segment = clip({
			effects: [effect("grain", { id: EFFECT_ID })],
			keyframes: amountKeyframes(points),
		});
		const [filter] = effectStackFilters(segment.effects, {
			label: "L",
			segment,
		});
		expect(filter).toContain("[L_0kw]noise=c0s=40");
		expect(filter).toContain("blend=all_expr='A*(clip((");
		expect(filter).toContain(":c3_expr='B'");
	});

	test("branching effects mix their peak look by the curve", () => {
		const segment = clip({
			effects: [effect("glow", { id: EFFECT_ID })],
			keyframes: amountKeyframes([
				[0, 0],
				[1, 0.5],
			]),
		});
		const [filter] = effectStackFilters(segment.effects, {
			label: "L",
			segment,
		});
		expect(filter).toContain("gblur=sigma=12");
		expect(filter).toContain("all_opacity=0.5");
		expect(filter).toContain("/0.5,0,1))");
	});

	test("keyframed shake switches static branches, dry at amount 0", () => {
		const segment = clip({
			effects: [effect("shake", { id: EFFECT_ID })],
			keyframes: amountKeyframes([
				[0, 0],
				[0.4, 0],
				[0.6, 1],
				[1, 1],
				[1.2, 0],
			]),
		});
		const [filter, ...rest] = effectStackFilters(segment.effects, {
			label: "L",
			segment,
		});
		expect(rest).toEqual([]);
		// No branch covers the amount-0 spans, so the zoom cannot leak there.
		expect(filter).not.toContain("lt(t,0.4)'");
		expect(filter).toContain("scale2ref=w=iw:h=ih");
		expect(filter).toContain("blend=all_mode=normal:all_opacity=0:enable='");
		// Each held amount crops by its own size, not the peak's.
		expect(filter).toContain("iw*0.996/2");
		expect(filter).toContain("iw*0.92/2");
		// The final blend continues the chain unlabeled.
		expect(filter).toMatch(/enable='[^']*'$/);
		const branches = filter?.match(/scale2ref/g) ?? [];
		expect(branches.length).toBeGreaterThan(1);
		expect(filter).toMatchSnapshot();
	});

	test("a shake curve with too many steps cross-fades an exact-size peak", () => {
		const points: [number, number][] = Array.from(
			{ length: MAX_EFFECT_STEPS + 2 },
			(_, index) => [index * 0.5, index % 2]
		);
		const segment = clip({
			effects: [effect("shake", { id: EFFECT_ID })],
			keyframes: amountKeyframes(points),
		});
		const [filter] = effectStackFilters(segment.effects, {
			label: "L",
			segment,
		});
		expect(filter).toContain("scale2ref=w=iw:h=ih");
		expect(filter).toContain("blend=all_expr='A*(1-(clip((");
		expect(filter?.match(/scale2ref/g)).toHaveLength(1);
	});

	test("a curve that never rises above zero emits nothing", () => {
		const segment = clip({
			effects: [effect("glow", { id: EFFECT_ID })],
			keyframes: amountKeyframes([
				[0, 0],
				[1, 0],
			]),
		});
		expect(effectStackFilters(segment.effects, { segment })).toEqual([]);
	});

	test("keyframes for another effect leave the static amount", () => {
		const segment = clip({
			effects: [effect("denoise", { amount: 0.5, id: EFFECT_ID })],
			keyframes: amountKeyframes(
				[
					[0, 0],
					[1, 1],
				],
				"00000000-0000-4000-9000-000000000002"
			),
		});
		expect(effectStackFilters(segment.effects, { segment })).toEqual([
			"hqdn3d=2:1.5:3:2.25",
		]);
		expect(effectsAt(segment, 0.5)).toEqual(segment.effects);
	});

	test("effectsAt resolves keyframed amounts for the preview", () => {
		const segment = clip({
			effects: [effect("invert", { id: EFFECT_ID }), effect("grain")],
			keyframes: amountKeyframes([
				[0, 0],
				[2, 1],
			]),
		});
		const resolved = effectsAt(segment, 0.5);
		expect(resolved[0]?.amount).toBeCloseTo(0.25);
		expect(resolved[1]?.amount).toBe(1);
	});
});

describe("preview CSS", () => {
	test("CSS-capable effects map to filter functions", () => {
		expect(effectStackCss([effect("invert", { amount: 0.5 })])).toEqual([
			"invert(0.5)",
		]);
		expect(effectStackCss([effect("hue-cycle")], 2)).toEqual([
			"hue-rotate(180deg)",
		]);
		expect(effectStackCss([effect("hue-cycle")], 5)).toEqual([
			"hue-rotate(90deg)",
		]);
		expect(effectStackCss([effect("dehaze")])).toEqual([
			"contrast(1.3) saturate(1.25) brightness(0.96)",
		]);
		expect(effectStackCss([effect("denoise", { amount: 0.5 })])).toEqual([
			"blur(0.3px)",
		]);
	});

	test("GL-drawn and temporal effects add no CSS", () => {
		for (const type of [
			"glow",
			"grain",
			"rgb-split",
			"mosaic",
			"edge-detect",
			"light-leak",
			"skin-smooth",
			"relight",
			"shake",
			"letterbox",
			"mirror",
			"glitch",
			"motion-blur",
			"echo",
		] as const) {
			expect(effectStackCss([effect(type)])).toEqual([]);
		}
	});
});
