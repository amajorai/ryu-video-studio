/**
 * Named color looks (W2-V5): original grade bundles the editor and the agent
 * apply by id. A look sets every parametric grade control (basic and
 * advanced) and records its id in `colorGrade.look`; an imported LUT on the
 * clip is kept. `intensity` scales the look from neutral (0) to full (1).
 */
import { z } from "zod";
import {
	type ColorGrade,
	type ColorWheel,
	type CurvePoint,
	colorGradeSchema,
	type HslBand,
	hslBandNameSchema,
} from "./schema/color.ts";

export const lookIds = [
	"warm-film",
	"teal-orange",
	"bleach-bypass",
	"noir",
	"faded",
	"vivid",
	"cool-night",
	"golden-hour",
	"clean",
	"matte",
	"cross-process",
	"mono-contrast",
] as const;
export const lookIdSchema = z.enum(lookIds);
export type LookId = z.infer<typeof lookIdSchema>;

/** The grade controls a look owns (everything except the LUT and look id). */
export type LookGrade = Omit<ColorGrade, "lut" | "look">;

export interface ColorLook {
	description: string;
	grade: LookGrade;
	id: LookId;
	name: string;
}

const neutralBasics = { exposure: 0, temperature: 0, tint: 0, vibrance: 0 };

const desaturateAll: HslBand[] = hslBandNameSchema.options.map((band) => ({
	band,
	hue: 0,
	lightness: 0,
	saturation: -1,
}));

const wheel = (r: number, g: number, b: number, master = 0): ColorWheel => ({
	b,
	g,
	master,
	r,
});

const sCurve = (amount: number): CurvePoint[] => [
	{ x: 0, y: 0 },
	{ x: 0.25, y: 0.25 - amount },
	{ x: 0.75, y: 0.75 + amount },
	{ x: 1, y: 1 },
];

export const colorLooks: readonly ColorLook[] = [
	{
		id: "warm-film",
		name: "Warm film",
		description: "Soft warm highlights with gently lifted blacks.",
		grade: {
			...neutralBasics,
			temperature: 0.25,
			gain: wheel(0.1, 0.04, -0.06),
			curves: {
				master: [
					{ x: 0, y: 0.04 },
					{ x: 0.5, y: 0.52 },
					{ x: 1, y: 0.96 },
				],
			},
			hsl: [{ band: "orange", hue: 0, saturation: 0.15, lightness: 0 }],
		},
	},
	{
		id: "teal-orange",
		name: "Teal-orange",
		description: "Teal shadows and warm skin tones.",
		grade: {
			...neutralBasics,
			vibrance: 0.15,
			lift: wheel(-0.1, 0.02, 0.14),
			gain: wheel(0.14, 0.04, -0.1),
			hsl: [
				{ band: "orange", hue: 0, saturation: 0.25, lightness: 0 },
				{ band: "blue", hue: -0.2, saturation: 0.2, lightness: 0 },
			],
		},
	},
	{
		id: "bleach-bypass",
		name: "Bleach bypass",
		description: "Muted colour with hard contrast.",
		grade: {
			...neutralBasics,
			vibrance: -0.6,
			curves: { master: sCurve(0.07) },
			hueVsSat: [{ x: 0, y: 0.3 }],
		},
	},
	{
		id: "noir",
		name: "Noir",
		description: "Black and white with deep shadows.",
		grade: {
			...neutralBasics,
			exposure: -0.15,
			shadows: -0.4,
			curves: { master: sCurve(0.08) },
			hsl: desaturateAll,
		},
	},
	{
		id: "faded",
		name: "Faded",
		description: "Washed-out blacks and soft whites.",
		grade: {
			...neutralBasics,
			vibrance: -0.2,
			curves: {
				master: [
					{ x: 0, y: 0.12 },
					{ x: 0.5, y: 0.5 },
					{ x: 1, y: 0.92 },
				],
			},
		},
	},
	{
		id: "vivid",
		name: "Vivid",
		description: "Punchy saturation and contrast.",
		grade: {
			...neutralBasics,
			vibrance: 0.5,
			curves: { master: sCurve(0.04) },
			hueVsSat: [{ x: 0, y: 0.6 }],
		},
	},
	{
		id: "cool-night",
		name: "Cool night",
		description: "Blue, darker, moonlit tones.",
		grade: {
			...neutralBasics,
			exposure: -0.3,
			temperature: -0.35,
			shadows: -0.2,
			gain: wheel(-0.04, 0, 0.1),
		},
	},
	{
		id: "golden-hour",
		name: "Golden hour",
		description: "Warm sunlight with glowing highlights.",
		grade: {
			...neutralBasics,
			temperature: 0.4,
			tint: 0.05,
			highlights: 0.2,
			gain: wheel(0.12, 0.06, -0.08),
			hsl: [
				{ band: "orange", hue: 0, saturation: 0.2, lightness: 0 },
				{ band: "yellow", hue: 0, saturation: 0.2, lightness: 0 },
			],
		},
	},
	{
		id: "clean",
		name: "Clean",
		description: "Neutral contrast with crisp whites.",
		grade: {
			...neutralBasics,
			vibrance: 0.1,
			whites: 0.15,
			blacks: 0.1,
		},
	},
	{
		id: "matte",
		name: "Matte",
		description: "Lifted blacks and dimmed whites.",
		grade: {
			...neutralBasics,
			blacks: -0.5,
			whites: -0.2,
			curves: { master: sCurve(0.03) },
		},
	},
	{
		id: "cross-process",
		name: "Cross-process",
		description: "Shifted channel curves with green-yellow highlights.",
		grade: {
			...neutralBasics,
			curves: {
				red: sCurve(0.07),
				green: [
					{ x: 0, y: 0 },
					{ x: 0.25, y: 0.3 },
					{ x: 0.75, y: 0.8 },
					{ x: 1, y: 1 },
				],
				blue: [
					{ x: 0, y: 0.15 },
					{ x: 1, y: 0.85 },
				],
			},
		},
	},
	{
		id: "mono-contrast",
		name: "Mono contrast",
		description: "High-contrast black and white.",
		grade: {
			...neutralBasics,
			whites: 0.2,
			blacks: 0.2,
			curves: { master: sCurve(0.06) },
			hsl: desaturateAll,
		},
	},
];

export function colorLook(id: LookId): ColorLook {
	const look = colorLooks.find((item) => item.id === id);
	if (!look) {
		throw new Error("Color look not found.");
	}
	return look;
}

const scaled = (value: number | undefined, intensity: number) =>
	value === undefined ? undefined : Number((value * intensity).toFixed(6));

const scaledWheel = (
	value: ColorWheel | undefined,
	intensity: number
): ColorWheel | undefined =>
	value && {
		b: scaled(value.b, intensity) ?? 0,
		g: scaled(value.g, intensity) ?? 0,
		master: scaled(value.master, intensity) ?? 0,
		r: scaled(value.r, intensity) ?? 0,
	};

/** Pull curve outputs toward `neutral(x)` as intensity falls. */
const scaledCurve = (
	points: CurvePoint[] | undefined,
	intensity: number,
	neutral: (x: number) => number
): CurvePoint[] | undefined =>
	points?.map((point) => ({
		x: point.x,
		y: Number(
			(neutral(point.x) + (point.y - neutral(point.x)) * intensity).toFixed(6)
		),
	}));

const identity = (x: number) => x;
const flatHalf = () => 0.5;

function withoutUndefined<Value extends object>(value: Value): Value {
	return Object.fromEntries(
		Object.entries(value).filter(([, entry]) => entry !== undefined)
	) as Value;
}

/** A look's grade scaled from neutral (0) to full strength (1). */
export function lookGrade(id: LookId, intensity = 1): LookGrade {
	const { grade } = colorLook(id);
	const amount = Math.min(1, Math.max(0, intensity));
	const curves = grade.curves && {
		...withoutUndefined({
			blue: scaledCurve(grade.curves.blue, amount, identity),
			green: scaledCurve(grade.curves.green, amount, identity),
			master: scaledCurve(grade.curves.master, amount, identity),
			red: scaledCurve(grade.curves.red, amount, identity),
		}),
	};
	return withoutUndefined({
		exposure: scaled(grade.exposure, amount) ?? 0,
		temperature: scaled(grade.temperature, amount) ?? 0,
		tint: scaled(grade.tint, amount) ?? 0,
		vibrance: scaled(grade.vibrance, amount) ?? 0,
		highlights: scaled(grade.highlights, amount),
		shadows: scaled(grade.shadows, amount),
		whites: scaled(grade.whites, amount),
		blacks: scaled(grade.blacks, amount),
		lift: scaledWheel(grade.lift, amount),
		gamma: scaledWheel(grade.gamma, amount),
		gain: scaledWheel(grade.gain, amount),
		curves,
		hsl: grade.hsl?.map((band) => ({
			band: band.band,
			hue: scaled(band.hue, amount) ?? 0,
			lightness: scaled(band.lightness, amount) ?? 0,
			saturation: scaled(band.saturation, amount) ?? 0,
		})),
		hueVsSat: scaledCurve(grade.hueVsSat, amount, flatHalf),
	});
}

/**
 * The clip grade after applying a look: every parametric control comes from
 * the look, the clip's LUT stays, and `look` records the id.
 */
export function gradeWithLook(
	current: ColorGrade,
	id: LookId,
	intensity = 1
): ColorGrade {
	return colorGradeSchema.parse({
		...lookGrade(id, intensity),
		...(current.lut ? { lut: current.lut } : {}),
		look: id,
	});
}
