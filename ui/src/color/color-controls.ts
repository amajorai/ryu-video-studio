/**
 * Pure editing helpers behind the advanced color controls (curves, wheels,
 * HSL bands). Every result is schema-valid: curves keep 2-16 points with
 * strictly increasing `x`, wheel and band values stay within -1..1.
 */
import type {
	ColorGrade,
	ColorWheel,
	CurvePoint,
	HslBand,
} from "../../../shared/schema/color.ts";

export const MAX_CURVE_POINTS = 16;
/** Smallest horizontal gap kept between neighbouring curve points. */
export const MIN_POINT_GAP = 0.01;

const clamp = (value: number, min: number, max: number) =>
	Math.min(max, Math.max(min, value));
// `+ 0` folds -0 into 0.
const round = (value: number) => Number(value.toFixed(4)) + 0;

export const identityCurve = (): CurvePoint[] => [
	{ x: 0, y: 0 },
	{ x: 1, y: 1 },
];

/** Move one point, keeping it between its neighbours and inside 0..1. */
export function moveCurvePoint(
	points: readonly CurvePoint[],
	index: number,
	target: CurvePoint
): CurvePoint[] {
	const before = points[index - 1];
	const after = points[index + 1];
	const min = before ? before.x + MIN_POINT_GAP : 0;
	const max = after ? after.x - MIN_POINT_GAP : 1;
	return points.map((point, position) =>
		position === index
			? {
					x: round(clamp(target.x, min, max)),
					y: round(clamp(target.y, 0, 1)),
				}
			: point
	);
}

/**
 * Insert a point in x order. Returns the new points and its index, or null
 * when the curve is full or the point would sit on a neighbour.
 */
export function insertCurvePoint(
	points: readonly CurvePoint[],
	target: CurvePoint
): { index: number; points: CurvePoint[] } | null {
	if (points.length >= MAX_CURVE_POINTS) {
		return null;
	}
	const point = {
		x: round(clamp(target.x, 0, 1)),
		y: round(clamp(target.y, 0, 1)),
	};
	if (points.some((item) => Math.abs(item.x - point.x) < MIN_POINT_GAP)) {
		return null;
	}
	const index = points.filter((item) => item.x < point.x).length;
	return {
		index,
		points: [...points.slice(0, index), point, ...points.slice(index)],
	};
}

/** Remove a point; `minimum` points always remain. */
export function removeCurvePoint(
	points: readonly CurvePoint[],
	index: number,
	minimum = 2
): CurvePoint[] {
	if (points.length <= minimum || index < 0 || index >= points.length) {
		return [...points];
	}
	return points.filter((_, position) => position !== index);
}

/** Channel hue angles on the wheel, in degrees (red at the top-right). */
const channelAngles = { b: 240, g: 120, r: 0 } as const;

/**
 * A wheel from a puck offset inside the unit disc (x right, y up): each
 * channel moves by the offset's projection onto its hue direction.
 */
export function wheelFromOffset(
	x: number,
	y: number,
	master: number
): ColorWheel {
	const length = Math.hypot(x, y);
	const scale = length > 1 ? 1 / length : 1;
	const px = x * scale;
	const py = y * scale;
	const channel = (angle: number) => {
		const radians = (angle * Math.PI) / 180;
		return round(clamp(px * Math.cos(radians) + py * Math.sin(radians), -1, 1));
	};
	return {
		b: channel(channelAngles.b),
		g: channel(channelAngles.g),
		master: round(clamp(master, -1, 1)),
		r: channel(channelAngles.r),
	};
}

/** The puck offset that `wheelFromOffset` maps back to `wheel` (least squares). */
export function offsetFromWheel(wheel: ColorWheel | undefined): {
	x: number;
	y: number;
} {
	if (!wheel) {
		return { x: 0, y: 0 };
	}
	let x = 0;
	let y = 0;
	for (const key of ["r", "g", "b"] as const) {
		const radians = (channelAngles[key] * Math.PI) / 180;
		x += wheel[key] * Math.cos(radians);
		y += wheel[key] * Math.sin(radians);
	}
	// Three unit directions 120° apart: the projection sum is 1.5 × offset.
	return { x: round(x / 1.5), y: round(y / 1.5) };
}

export const neutralWheel = (): ColorWheel => ({ b: 0, g: 0, master: 0, r: 0 });

export function isNeutralWheel(wheel: ColorWheel | undefined): boolean {
	return !(wheel?.r || wheel?.g || wheel?.b || wheel?.master);
}

/** Set (or clear, when neutral) one HSL band; bands keep a stable order. */
export function setHslBand(
	bands: readonly HslBand[] | undefined,
	band: HslBand["band"],
	patch: Partial<Omit<HslBand, "band">>
): HslBand[] | undefined {
	const current = bands?.find((item) => item.band === band) ?? {
		band,
		hue: 0,
		lightness: 0,
		saturation: 0,
	};
	const next: HslBand = {
		...current,
		...Object.fromEntries(
			Object.entries(patch).map(([key, value]) => [
				key,
				round(clamp(value ?? 0, -1, 1)),
			])
		),
	};
	const others = (bands ?? []).filter((item) => item.band !== band);
	const neutral = !(next.hue || next.saturation || next.lightness);
	const result = neutral ? others : [...others, next];
	return result.length ? result : undefined;
}

/** Fields the advanced section owns (the basic four stay). */
const advancedKeys = [
	"highlights",
	"shadows",
	"whites",
	"blacks",
	"lift",
	"gamma",
	"gain",
	"curves",
	"hsl",
	"hueVsSat",
	"look",
] as const;

const omit = (grade: ColorGrade, keys: ReadonlySet<string>): ColorGrade =>
	Object.fromEntries(
		Object.entries(grade).filter(([key]) => !keys.has(key))
	) as ColorGrade;

/** Clear every advanced control except the LUT. */
export function resetAdvancedGrade(grade: ColorGrade): ColorGrade {
	return omit(grade, new Set(advancedKeys));
}

/**
 * Set an optional grade field (`undefined` removes it). A hand edit of any
 * control but the LUT also clears `look`, since the clip no longer shows the
 * named look as applied.
 */
export function withGradeField<Key extends keyof ColorGrade>(
	grade: ColorGrade,
	key: Key,
	value: ColorGrade[Key] | undefined
): ColorGrade {
	const dropped = new Set<string>(key === "lut" ? [key] : [key, "look"]);
	const base = omit(grade, dropped);
	return value === undefined ? base : { ...base, [key]: value };
}
