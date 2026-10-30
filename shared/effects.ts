import { z } from "zod";
import {
	animatedValue,
	animationExpression,
	animationPoints,
} from "./animation.ts";
import type { Segment } from "./project.ts";

export const visualEffectSchema = z.enum([
	"none",
	"blur",
	"grayscale",
	"sepia",
]);
export type VisualEffect = z.infer<typeof visualEffectSchema>;

export const effectTypeSchema = z.enum([
	"blur",
	"grayscale",
	"sepia",
	"sharpen",
	"vignette",
	"denoise",
	"glow",
	"grain",
	"invert",
	"clarity",
	"dehaze",
	"rgb-split",
	"shake",
	"motion-blur",
	"echo",
	"mosaic",
	"hue-cycle",
	"mirror",
	"edge-detect",
	"letterbox",
	"glitch",
	"light-leak",
	"skin-smooth",
	"relight",
]);
export type EffectType = z.infer<typeof effectTypeSchema>;
export const MAX_EFFECT_STACK = 16;

/**
 * Relight looks: facial (key, front), ambient (top) and rim lights in
 * neutral tones, and creative colored lights.
 */
export const RELIGHT_PRESETS = [
	"key",
	"front",
	"top",
	"rim-left",
	"rim-right",
	"sunset",
	"moonlight",
	"neon",
] as const;
export const relightPresetSchema = z.enum(RELIGHT_PRESETS);
export type RelightPreset = z.infer<typeof relightPresetSchema>;

export const relightPresetLabels: Readonly<Record<RelightPreset, string>> = {
	front: "Facial · front fill",
	key: "Facial · key light",
	moonlight: "Creative · cool moonlight",
	neon: "Creative · neon magenta",
	"rim-left": "Rim · from the left",
	"rim-right": "Rim · from the right",
	sunset: "Creative · warm sunset",
	top: "Ambient · overhead",
};

/** A relight effect's light: a preset and an optional position override. */
export const relightLightSchema = z
	.object({
		preset: relightPresetSchema,
		/** Light center across the frame, 0 (left) to 1 (right). */
		x: z.number().finite().min(0).max(1).optional(),
		/** Light center down the frame, 0 (top) to 1 (bottom). */
		y: z.number().finite().min(0).max(1).optional(),
	})
	.strict();
export type RelightLight = z.infer<typeof relightLightSchema>;

export const effectSchema = z
	.object({
		amount: z.number().finite().min(0).max(1).default(1),
		enabled: z.boolean().default(true),
		type: effectTypeSchema,
		id: z.uuid().optional(),
		seed: z.number().int().min(0).max(9999).optional(),
		/** Relight only: light preset and position (default the key light). */
		light: relightLightSchema.optional(),
	})
	.strict();
export const effectStackSchema = z
	.array(effectSchema)
	.max(MAX_EFFECT_STACK)
	.default([]);
export type Effect = z.infer<typeof effectSchema>;

/** Inspector names, in the order the library lists them. */
export const effectLabels: Readonly<Record<EffectType, string>> = {
	blur: "Blur",
	grayscale: "Grayscale",
	sepia: "Sepia",
	sharpen: "Sharpen",
	vignette: "Vignette",
	denoise: "Denoise",
	glow: "Glow",
	grain: "Film grain",
	invert: "Invert",
	clarity: "Clarity",
	dehaze: "Dehaze",
	"rgb-split": "RGB split",
	shake: "Shake",
	"motion-blur": "Motion blur",
	echo: "Echo trails",
	mosaic: "Mosaic",
	"hue-cycle": "Hue cycle",
	mirror: "Mirror",
	"edge-detect": "Edge detect",
	letterbox: "Letterbox",
	glitch: "Glitch",
	"light-leak": "Light leak",
	"skin-smooth": "Skin smooth",
	relight: "Relight",
};

/** Effects whose look depends on `seed` (noise pattern or motion phase). */
export const seededEffectTypes: ReadonlySet<EffectType> = new Set([
	"grain",
	"glitch",
	"shake",
	"light-leak",
]);

/** Effects the preview cannot show (they need neighbouring frames). */
export const temporalEffectTypes: ReadonlySet<EffectType> = new Set([
	"motion-blur",
	"echo",
]);

export function visualEffectFilters(effect: VisualEffect): string[] {
	switch (effect) {
		case "blur":
			return ["boxblur=luma_radius=2:luma_power=1"];
		case "grayscale":
			return ["hue=s=0"];
		case "sepia":
			return [
				"colorchannelmixer=.393:.769:.189:0:.349:.686:.168:0:.272:.534:.131",
			];
		default:
			return ["null"];
	}
}

/** Compact decimal for filter arguments (`-0` prints as `0`). */
const num = (value: number, digits = 4) => {
	const fixed = Number(value.toFixed(digits));
	return String(Object.is(fixed, -0) ? 0 : fixed);
};

/**
 * Entry into the planar RGB(A) format `blend` and `overlay` work in. Going
 * through packed RGBA first matches the conversion the placement chain
 * makes anyway, so a branch that mixes nothing in is pixel-identical.
 */
const TO_GBRAP = "format=rgba,format=gbrap";

/** Builds unique graph link labels for one effect in one stack. */
type LabelFn = (name: string) => string;

interface BuildInput {
	effect: Effect;
	label: LabelFn;
	/** Seed-derived phase in radians, 0 when the effect has no seed. */
	phase: number;
}

/**
 * How an effect is drawn. `build` takes a constant amount in `(0, 1]`.
 * Keyframed amounts use `expr` when the filters accept a time expression;
 * otherwise `steps` re-emits `build` per held value behind timeline
 * `enable` windows (every filter must support timeline editing), and the
 * rest are drawn at their peak and mixed with the dry frame over time.
 */
interface EffectRecipe {
	build(amount: number, input: BuildInput, enable?: string): string[];
	expr?: (
		amount: (clock: string) => string,
		input: BuildInput,
		peak: number
	) => string[];
	/** Custom keyframed form, used ahead of `expr`/`steps`. */
	keyframed?: (input: BuildInput, segment: Segment, peak: number) => string[];
	steps?: boolean;
}

const withEnable = (filter: string, enable?: string) =>
	enable ? `${filter}:enable='${enable}'` : filter;

/**
 * A white frame darkened by a full-strength `vignette` around a point: a
 * smooth radial falloff to black at half the frame diagonal. LUT and
 * vignette filters keep this cheap at full resolution (no per-pixel `geq`).
 */
const lightSpot = (x0: string, y0: string) =>
	`lutrgb=r=255:g=255:b=255,vignette=angle=PI/2:x0='w*(${x0})':y0='h*(${y0})':eval=frame`;

/** A light layer branched off the frame and blended back over it. */
function lightLayer(
	input: BuildInput,
	layer: string,
	mode: "screen" | "softlight",
	opacity: number
): string[] {
	const dry = input.label("d");
	const light = input.label("l");
	const lit = input.label("o");
	return [
		`${TO_GBRAP},split[${dry}][${light}];[${light}]${layer},format=gbrap[${lit}];[${dry}][${lit}]blend=all_mode=${mode}:all_opacity=${num(opacity)}:c3_mode=normal:c3_opacity=1`,
	];
}

/** A warm spot drifting near the top-left corner (screen-blended). */
function lightLeakLayer(input: BuildInput) {
	const p = num(input.phase);
	return `${lightSpot(`0.18+0.12*sin(t*0.6+${p})`, `0.2+0.1*cos(t*0.45+${p})`)},lutrgb=r='val':g='val*0.59':b='val*0.22'`;
}

/**
 * The light layer of one relight preset: its default center (fractions of
 * the frame) and the per-channel `offset + spot * scale` tint. Soft light
 * brightens where the layer is above mid-gray and darkens below it.
 */
interface RelightRecipe {
	offset: readonly [number, number, number];
	scale: readonly [number, number, number];
	x: number;
	y: number;
}

const RELIGHT_RECIPES: Readonly<Record<RelightPreset, RelightRecipe>> = {
	front: { offset: [66, 66, 64], scale: [0.74, 0.74, 0.72], x: 0.5, y: 0.32 },
	key: { offset: [70, 68, 63], scale: [0.725, 0.7, 0.64], x: 0.3, y: 0.25 },
	moonlight: {
		offset: [50, 60, 82],
		scale: [0.6, 0.66, 0.74],
		x: 0.7,
		y: 0.15,
	},
	neon: { offset: [78, 40, 78], scale: [0.72, 0.4, 0.72], x: 0.75, y: 0.3 },
	"rim-left": {
		offset: [70, 68, 66],
		scale: [0.73, 0.71, 0.69],
		x: 0.02,
		y: 0.4,
	},
	"rim-right": {
		offset: [70, 68, 66],
		scale: [0.73, 0.71, 0.69],
		x: 0.98,
		y: 0.4,
	},
	sunset: { offset: [80, 62, 40], scale: [0.72, 0.6, 0.4], x: 0.2, y: 0.2 },
	top: { offset: [68, 68, 68], scale: [0.72, 0.72, 0.72], x: 0.5, y: 0.02 },
};

/** The resolved light of a relight effect (preset defaults plus overrides). */
export function relightParams(light: RelightLight | undefined): RelightRecipe {
	const recipe = RELIGHT_RECIPES[light?.preset ?? "key"];
	return { ...recipe, x: light?.x ?? recipe.x, y: light?.y ?? recipe.y };
}

/** The relight layer: a light spot at the chosen point, tinted per channel. */
function relightLayer(light: RelightLight | undefined): string {
	const { offset, scale, x, y } = relightParams(light);
	const channel = (index: 0 | 1 | 2) =>
		`'${num(offset[index])}+val*${num(scale[index])}'`;
	return `${lightSpot(num(x), num(y))},lutrgb=r=${channel(0)}:g=${channel(1)}:b=${channel(2)}`;
}

/** Cb/Cr skin-tone ranges (8-bit) for the skin-smooth matte. */
const SKIN_CB = [77, 127] as const;
const SKIN_CR = [133, 173] as const;

/**
 * Edge-preserving blur merged in through a soft skin-tone matte built from
 * chroma LUTs. The matte's alpha plane is zero, so the clip's own alpha is
 * kept.
 */
function skinSmooth(a: number, input: BuildInput) {
	const base = input.label("b");
	const soft = input.label("s");
	const matte = input.label("m");
	const smooth = input.label("t");
	const cb = input.label("u");
	const cr = input.label("v");
	const fill = input.label("k");
	const empty = input.label("e");
	const mask = input.label("q");
	return [
		`format=yuva444p,split=3[${base}][${soft}][${matte}];[${soft}]smartblur=lr=${num(1 + a * 3, 2)}:ls=${num(0.3 + a * 0.6, 2)}:lt=0,format=yuva444p[${smooth}];[${matte}]lutyuv=u='if(between(val,${SKIN_CB[0]},${SKIN_CB[1]}),255,0)':v='if(between(val,${SKIN_CR[0]},${SKIN_CR[1]}),255,0)',extractplanes=u+v[${cb}][${cr}];[${cb}][${cr}]blend=all_mode=multiply,lut=c0='val*${num(a)}',gblur=sigma=2,split[${fill}][${empty}];[${empty}]lut=c0=0[${empty}z];[${fill}][${empty}z]mergeplanes=0x00000010:yuva444p[${mask}];[${base}][${smooth}][${mask}]maskedmerge`,
	];
}

/** Shake: a moving crop scaled back to (about) the source size. */
function shake(fraction: string, peak: number, input: BuildInput) {
	const keep = num(1 - 0.08 * peak);
	const p = num(input.phase);
	const wobble = (rate: number, rate2: number) =>
		`(${fraction})*(0.6*sin(t*${rate}+${p})+0.4*sin(t*${rate2}+${p}*2))`;
	return [
		`crop=w='2*trunc(iw*${keep}/2)':h='2*trunc(ih*${keep}/2)':x='(iw-ow)/2*(1+${wobble(31, 17.3)})':y='(ih-oh)/2*(1+${wobble(27, 13.1)})'`,
		`scale=w='2*trunc(iw/${keep}/2+0.5)':h='2*trunc(ih/${keep}/2+0.5)'`,
	];
}

/**
 * Keyframed shake. The crop size (the zoom) cannot change per frame, so each
 * held amount gets its own static shake branch, resized exactly to the dry
 * frame with `scale2ref` and switched in over its time windows. Outside
 * every window (amount 0) the dry frame passes through untouched. A curve
 * with too many windows mixes the peak shake in by the animated amount.
 */
function keyframedShake(
	input: BuildInput,
	segment: Segment,
	peak: number
): string[] {
	const id = input.effect.id ?? "";
	const steps = effectAmountSteps(segment, id).filter((step) => step.value > 0);
	const windows = new Map<number, string[]>();
	if (steps.length <= MAX_EFFECT_STEPS) {
		for (const step of steps) {
			windows.set(step.value, [
				...(windows.get(step.value) ?? []),
				stepWindow(step),
			]);
		}
	}
	const fraction = `clip((${animationExpression(segment, "effectAmount", "T", id)})/${num(peak)},0,1)`;
	const branches: { amount: number; blend: string }[] =
		steps.length <= MAX_EFFECT_STEPS
			? [...windows].map(([amount, spans]) => ({
					amount,
					blend: `blend=all_mode=normal:all_opacity=0:enable='${spans.length === 1 ? spans[0] : spans.map((span) => `(${span})`).join("+")}'`,
				}))
			: [
					{
						amount: peak,
						blend: `blend=all_expr='A*(1-(${fraction}))+B*(${fraction})'`,
					},
				];
	if (branches.length === 0) {
		return [];
	}
	const current = (index: number) => input.label(`c${index}`);
	const source = (index: number) => input.label(`s${index}`);
	const statements = [
		`${TO_GBRAP},split=${branches.length + 1}[${current(0)}]${branches.map((_b, index) => `[${source(index)}]`).join("")}`,
	];
	for (const [index, branch] of branches.entries()) {
		const zoomed = input.label(`z${index}`);
		const sized = input.label(`e${index}`);
		const ref = input.label(`r${index}`);
		const tail = index === branches.length - 1 ? "" : `[${current(index + 1)}]`;
		statements.push(
			`[${source(index)}]${shake("1", branch.amount, input).join(",")},format=gbrap[${zoomed}]`,
			`[${zoomed}][${current(index)}]scale2ref=w=iw:h=ih[${sized}][${ref}]`,
			`[${ref}][${sized}]${branch.blend}${tail}`
		);
	}
	return [statements.join(";")];
}

function mirror(input: BuildInput): string[] {
	const keep = input.label("a");
	const flip = input.label("f");
	const half = input.label("h");
	return [
		`${TO_GBRAP},split[${keep}][${flip}];[${flip}]hflip,crop=w=iw/2:h=ih:x=iw-ow:y=0[${half}];[${keep}][${half}]overlay=x=W-w:y=0:format=auto`,
	];
}

const EDGE_DETECT = [
	"format=gbrp,edgedetect=mode=colormix:high=0.2:low=0.05",
] as const;

const recipes: Readonly<Record<EffectType, EffectRecipe>> = {
	blur: {
		build: (a, _i, enable) => [
			withEnable(
				`boxblur=luma_radius=${(1 + a * 4).toFixed(2)}:luma_power=1`,
				enable
			),
		],
		steps: true,
	},
	grayscale: {
		build: (a, _i, enable) => [
			withEnable(`hue=s=${(1 - a).toFixed(3)}`, enable),
		],
		steps: true,
	},
	sepia: {
		build: (_a, _i, enable) => [
			withEnable(
				"colorchannelmixer=.393:.769:.189:0:.349:.686:.168:0:.272:.534:.131",
				enable
			),
		],
		steps: true,
	},
	sharpen: {
		build: (a, _i, enable) => [
			withEnable(`unsharp=lx=3:ly=3:la=${(a * 1.5).toFixed(3)}`, enable),
		],
		steps: true,
	},
	vignette: {
		build: (a, _i, enable) => [
			withEnable(
				`vignette=angle=${((Math.PI / 4) * a).toFixed(3)}:mode=forward`,
				enable
			),
		],
		steps: true,
	},
	denoise: {
		build: (a, _i, enable) => [
			withEnable(
				`hqdn3d=${num(a * 4)}:${num(a * 3)}:${num(a * 6)}:${num(a * 4.5)}`,
				enable
			),
		],
		steps: true,
	},
	glow: {
		build: (a, input) => {
			const dry = input.label("d");
			const blur = input.label("g");
			const blurred = input.label("o");
			return [
				`${TO_GBRAP},split[${dry}][${blur}];[${blur}]gblur=sigma=${num(4 + a * 16, 2)}[${blurred}];[${dry}][${blurred}]blend=all_mode=screen:all_opacity=${num(a)}:c3_mode=normal:c3_opacity=1`,
			];
		},
	},
	grain: {
		build: (a, { effect }, enable) => {
			const s = Math.max(1, Math.round(a * 40));
			const seed = effect.seed === undefined ? "" : `:all_seed=${effect.seed}`;
			return [
				withEnable(
					`noise=c0s=${s}:c0f=t+u:c1s=${s}:c1f=t+u:c2s=${s}:c2f=t+u${seed}`,
					enable
				),
			];
		},
		steps: true,
	},
	invert: {
		build: (a, input) =>
			a >= 1 ? ["negate"] : mixFilters(["negate"], num(a), false, input, "x"),
	},
	clarity: {
		build: (a, _i, enable) => [
			withEnable(`unsharp=13:13:${num(a * 1.5)}`, enable),
		],
		steps: true,
	},
	dehaze: {
		build: (a, _i, enable) => [
			withEnable(
				`eq=contrast=${num(1 + a * 0.3)}:saturation=${num(1 + a * 0.25)}:brightness=${num(-a * 0.04)}`,
				enable
			),
			withEnable(
				`curves=master='0/0 0.25/${num(0.25 - a * 0.08)} 1/1'`,
				enable
			),
		],
		steps: true,
	},
	"rgb-split": {
		build: (a, _i, enable) => {
			const shift = Math.max(1, Math.round(a * 8));
			return [withEnable(`rgbashift=rh=-${shift}:bh=${shift}`, enable)];
		},
		steps: true,
	},
	shake: {
		build: (a, input) => shake("1", a, input),
		keyframed: keyframedShake,
	},
	"motion-blur": {
		build: (a, _i, enable) => [
			withEnable(`tmix=frames=${2 + Math.round(a * 6)}`, enable),
		],
		steps: true,
	},
	echo: {
		build: (a, _i, enable) => [
			withEnable(`lagfun=decay=${num(0.9 + a * 0.09)}`, enable),
		],
		steps: true,
	},
	mosaic: {
		build: (a, _i, enable) => {
			const block = 2 + Math.round(a * 30);
			return [withEnable(`pixelize=w=${block}:h=${block}`, enable)];
		},
		steps: true,
	},
	"hue-cycle": {
		build: (a) => [`hue=h='t*${num(a * 90)}'`],
		expr: (amount) => [`hue=h='t*90*(${amount("t")})'`],
	},
	mirror: {
		build: (_a, input) => mirror(input),
	},
	"edge-detect": {
		build: (a, input) => mixFilters(EDGE_DETECT, num(a), false, input, "x"),
	},
	letterbox: {
		build: (a, _i, enable) => {
			const bar = `ih*${num(a * 0.12)}`;
			return [
				withEnable(`drawbox=x=0:y=0:w=iw:h=${bar}:color=black:t=fill`, enable),
				withEnable(
					`drawbox=x=0:y=ih-${bar}:w=iw:h=${bar}:color=black:t=fill`,
					enable
				),
			];
		},
		steps: true,
	},
	glitch: {
		build: (a, { phase }, enable) => {
			const p = num(phase / (2 * Math.PI));
			const burst = `lt(mod(t+${p},1.3),0.18)`;
			const flash = `lt(mod(t+${p}*0.7,0.9),0.08)`;
			const gate = (window: string) =>
				enable ? `(${enable})*${window}` : window;
			const shift = Math.max(1, Math.round(a * 24));
			const drift = Math.max(1, Math.round(a * 10));
			const noise = Math.max(1, Math.round(a * 50));
			return [
				`rgbashift=rh=${shift}:gh=-${drift}:bv=${Math.max(1, Math.round(drift / 2))}:enable='${gate(burst)}'`,
				`noise=c0s=${noise}:c0f=t:enable='${gate(flash)}'`,
			];
		},
		steps: true,
	},
	"light-leak": {
		build: (a, input) => lightLayer(input, lightLeakLayer(input), "screen", a),
	},
	"skin-smooth": {
		build: (a, input) => skinSmooth(a, input),
	},
	relight: {
		build: (a, input) =>
			lightLayer(input, relightLayer(input.effect.light), "softlight", a),
	},
};

/**
 * Cross-fade from the dry frame to `wet` by `amount` (a number, or a `T`
 * expression when `animated`). The dry frame's alpha always wins. `tag`
 * keeps the labels of a mix nested in another mix distinct.
 */
function mixFilters(
	wet: readonly string[],
	amount: string,
	animated: boolean,
	input: BuildInput,
	tag: string
): string[] {
	const dry = input.label(`${tag}d`);
	const branch = input.label(`${tag}w`);
	const mixed = input.label(`${tag}m`);
	const blend = animated
		? `blend=all_expr='A*(${amount})+B*(1-(${amount}))':c3_expr='B'`
		: `blend=all_mode=normal:all_opacity=${amount}:c3_opacity=0`;
	return [
		`${TO_GBRAP},split[${dry}][${branch}];[${branch}]${wet.join(",")},format=gbrap[${mixed}];[${mixed}][${dry}]${blend}`,
	];
}

/** Keyframed amount of one effect, or undefined when it does not animate. */
function animatedAmount(
	effect: Effect,
	segment: Segment | undefined
): { peak: number; points: { time: number; value: number }[] } | undefined {
	if (
		!(
			segment &&
			effect.id &&
			segment.keyframes.some(
				(frame) =>
					frame.property === "effectAmount" && frame.target === effect.id
			)
		)
	) {
		return;
	}
	const points = animationPoints(segment, "effectAmount", effect.id).map(
		(point) => ({ time: point.time, value: clampAmount(point.value) })
	);
	return {
		peak: Math.max(0, ...points.map((point) => point.value)),
		points,
	};
}

const clampAmount = (value: number) => Math.min(1, Math.max(0, value));

/** Most `enable` windows one keyframed effect may emit before it mixes instead. */
export const MAX_EFFECT_STEPS = 32;
/** Amount resolution of stepped (non-expression) keyframed effects. */
export const EFFECT_STEP = 0.05;

export interface EffectStep {
	/** Exclusive end (seconds); undefined holds to the end of the clip. */
	end?: number;
	start: number;
	value: number;
}

/**
 * Held amounts approximating a keyframed curve, quantized to `EFFECT_STEP`,
 * with equal neighbours merged. Each span between keyframes is sampled at
 * up to eight midpoints.
 */
export function effectAmountSteps(
	segment: Segment,
	effectId: string
): EffectStep[] {
	const points = animationPoints(segment, "effectAmount", effectId);
	const quantize = (value: number) =>
		Number(
			(Math.round(clampAmount(value) / EFFECT_STEP) * EFFECT_STEP).toFixed(4)
		);
	const steps: EffectStep[] = [];
	const push = (start: number, value: number) => {
		const last = steps.at(-1);
		if (last && last.value === value) {
			return;
		}
		if (last) {
			last.end = start;
		}
		steps.push({ start, value });
	};
	for (const [index, point] of points.entries()) {
		const next = points[index + 1];
		if (!next || next.time <= point.time) {
			push(point.time, quantize(point.value));
			continue;
		}
		const delta = Math.abs(next.value - point.value);
		const count = Math.min(8, Math.max(1, Math.ceil(delta / EFFECT_STEP)));
		const span = next.time - point.time;
		for (let step = 0; step < count; step++) {
			const start = point.time + (span * step) / count;
			const mid = point.time + (span * (step + 0.5)) / count;
			push(
				Number(start.toFixed(6)),
				quantize(animatedValue(segment, "effectAmount", mid, effectId))
			);
		}
	}
	return steps;
}

const stepWindow = (step: EffectStep) => {
	const from = step.start > 0 ? `gte(t,${num(step.start, 6)})` : "";
	const to = step.end === undefined ? "" : `lt(t,${num(step.end, 6)})`;
	return [from, to].filter(Boolean).join("*") || "1";
};

export interface EffectStackOptions {
	/**
	 * Link-label prefix (letters, digits and `_`) for effects that branch the
	 * graph. It must be unique per stack in one filtergraph.
	 */
	label?: string;
	/** The clip whose `effectAmount` keyframes (by effect id) animate the stack. */
	segment?: Segment;
}

/** Label-safe form of an id (a clip or layer uuid). */
export const effectLabelPrefix = (id: string) =>
	`fx${id.replaceAll(/[^0-9a-zA-Z]/g, "")}`;

/**
 * Phase (radians, 0..2π) an effect's seed gives its motion or noise; 0
 * without a seed. The preview uses the same phase as the render.
 */
export function effectSeedPhase(effect: Pick<Effect, "seed">): number {
	return effect.seed === undefined ? 0 : (effect.seed * 2.399_963) % 6.283_185;
}

function animatedEffectFilters(
	recipe: EffectRecipe,
	input: BuildInput,
	segment: Segment,
	peak: number
): string[] {
	const id = input.effect.id ?? "";
	if (recipe.keyframed) {
		return recipe.keyframed(input, segment, peak);
	}
	if (recipe.expr) {
		return recipe.expr(
			(clock) =>
				`clip(${animationExpression(segment, "effectAmount", clock, id)},0,1)`,
			input,
			peak
		);
	}
	if (recipe.steps) {
		const steps = effectAmountSteps(segment, id);
		if (steps.length <= MAX_EFFECT_STEPS) {
			return steps.flatMap((step) =>
				step.value > 0 ? recipe.build(step.value, input, stepWindow(step)) : []
			);
		}
	}
	const fraction = `clip((${animationExpression(segment, "effectAmount", "T", id)})/${num(peak)},0,1)`;
	return mixFilters(recipe.build(peak, input), fraction, true, input, "k");
}

/**
 * FFmpeg filters for an effect stack, in stack order. Disabled effects and
 * effects whose amount never rises above zero emit nothing. Branching
 * effects (glow, mirror, light leak, ...) embed their own `;` statements
 * with labels from `options.label`, so the result still joins into one
 * comma-separated chain.
 */
export function effectStackFilters(
	effects: readonly Effect[],
	options: EffectStackOptions = {}
): string[] {
	const prefix = options.label ?? "fx";
	return effects.flatMap((effect, index) => {
		if (!effect.enabled) {
			return [];
		}
		const recipe = recipes[effect.type];
		const input: BuildInput = {
			effect,
			label: (name) => `${prefix}_${index}${name}`,
			phase: effectSeedPhase(effect),
		};
		const animation = animatedAmount(effect, options.segment);
		if (animation && options.segment) {
			return animation.peak > 0
				? animatedEffectFilters(recipe, input, options.segment, animation.peak)
				: [];
		}
		return effect.amount > 0 ? recipe.build(effect.amount, input) : [];
	});
}

/** The stack with each keyframed amount resolved at clip time `at`. */
export function effectsAt(segment: Segment, at: number): Effect[] {
	return segment.effects.map((effect) => {
		if (
			!(
				effect.id &&
				segment.keyframes.some(
					(frame) =>
						frame.property === "effectAmount" && frame.target === effect.id
				)
			)
		) {
			return effect;
		}
		return {
			...effect,
			amount: clampAmount(
				animatedValue(segment, "effectAmount", at, effect.id)
			),
		};
	});
}

/**
 * CSS filter functions for the effects CSS can show. `elapsed` is the
 * clip-relative time that drives the hue cycle. The WebGL effects pass
 * (`ui/src/preview/gl/passes/effects.ts`) draws the rest.
 */
export function effectStackCss(
	effects: readonly Effect[],
	elapsed = 0
): string[] {
	return effects.flatMap((effect) => {
		if (!effect.enabled || effect.amount <= 0) {
			return [];
		}
		const a = effect.amount;
		switch (effect.type) {
			case "blur":
				return [`blur(${(a * 2).toFixed(2)}px)`];
			case "grayscale":
				return [`grayscale(${a})`];
			case "sepia":
				return [`sepia(${a})`];
			case "sharpen":
				return [`contrast(${(1 + a * 0.08).toFixed(3)})`];
			case "denoise":
				return [`blur(${num(a * 0.6, 2)}px)`];
			case "invert":
				return [`invert(${num(a)})`];
			case "clarity":
				return [`contrast(${num(1 + a * 0.12, 3)})`];
			case "dehaze":
				return [
					`contrast(${num(1 + a * 0.3, 3)}) saturate(${num(1 + a * 0.25, 3)}) brightness(${num(1 - a * 0.04, 3)})`,
				];
			case "hue-cycle":
				return [`hue-rotate(${num((elapsed * a * 90) % 360, 2)}deg)`];
			default:
				return [];
		}
	});
}

/** Return the strongest enabled vignette for the local preview overlay. */
export function effectStackVignetteAmount(effects: readonly Effect[]): number {
	return effects.reduce(
		(amount, effect) =>
			effect.enabled && effect.type === "vignette"
				? Math.max(amount, effect.amount)
				: amount,
		0
	);
}
