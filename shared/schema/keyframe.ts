import { z } from "zod";
import { MAX_CLIP_OFFSET } from "../limits.ts";
import { bounded, hexColorSchema, idSchema, timeSchema } from "./primitives.ts";

/** The original six clip properties, in their historical order. */
export const legacyKeyframeProperties = [
	"x",
	"y",
	"scale",
	"rotation",
	"opacity",
	"volume",
] as const;
export type LegacyKeyframeProperty = (typeof legacyKeyframeProperties)[number];

/** Every keyframable property; the legacy six come first. */
export const keyframePropertySchema = z.enum([
	...legacyKeyframeProperties,
	"scaleX",
	"scaleY",
	"cropLeft",
	"cropRight",
	"cropTop",
	"cropBottom",
	"brightness",
	"contrast",
	"saturation",
	"exposure",
	"temperature",
	"blur",
	"effectAmount",
	"pan",
	"maskX",
	"maskY",
	"maskWidth",
	"maskHeight",
	"maskRotation",
	"maskFeather",
	"fontSize",
	"letterSpacing",
	"lineHeight",
	"backgroundPadding",
	"backgroundRadius",
	"strokeWidth",
	"cornerRadius",
	"innerRadius",
	"color",
	"backgroundColor",
	"fill",
	"stroke",
]);
export type KeyframeProperty = z.infer<typeof keyframePropertySchema>;
export const keyframeProperties = keyframePropertySchema.options;

export const keyframeInterpolationSchema = z.enum([
	"linear",
	"hold",
	"ease-in",
	"ease-out",
	"ease-in-out",
	"bezier",
]);
export type KeyframeInterpolation = z.infer<typeof keyframeInterpolationSchema>;

/** CSS-style cubic Bezier control points `(x1, y1, x2, y2)`. */
export const keyframeBezierSchema = z.tuple([
	bounded(0, 1),
	bounded(-1, 2),
	bounded(0, 1),
	bounded(-1, 2),
]);
export type KeyframeBezier = z.infer<typeof keyframeBezierSchema>;

/**
 * Color channels. Their keyframes carry a `#rrggbb` `color` (interpolated per
 * RGB channel) and a `value` of 0.
 */
export const colorKeyframeProperties: ReadonlySet<KeyframeProperty> = new Set([
	"color",
	"backgroundColor",
	"fill",
	"stroke",
]);
export const isColorKeyframeProperty = (property: KeyframeProperty): boolean =>
	colorKeyframeProperties.has(property);

/** Title text-style channels (font size, spacing, box) and text colors. */
export const titleStyleKeyframeProperties = [
	"fontSize",
	"letterSpacing",
	"lineHeight",
	"backgroundPadding",
	"backgroundRadius",
] as const satisfies readonly KeyframeProperty[];
export const titleColorKeyframeProperties = [
	"color",
	"backgroundColor",
] as const satisfies readonly KeyframeProperty[];

/** Graphic shape-parameter channels and paint colors. */
export const graphicShapeKeyframeProperties = [
	"scale",
	"strokeWidth",
	"cornerRadius",
	"innerRadius",
] as const satisfies readonly KeyframeProperty[];
export const graphicColorKeyframeProperties = [
	"fill",
	"stroke",
] as const satisfies readonly KeyframeProperty[];

/** Which owner a keyframe channel animates. */
export type KeyframeOwnerKind = "clip" | "graphic" | "title";

const titleOnly: ReadonlySet<KeyframeProperty> = new Set([
	...titleStyleKeyframeProperties,
	...titleColorKeyframeProperties,
]);
const graphicOnly: ReadonlySet<KeyframeProperty> = new Set([
	"strokeWidth",
	"cornerRadius",
	"innerRadius",
	...graphicColorKeyframeProperties,
]);

/**
 * Whether `owner` may carry keyframes of `property`. Clips keep their
 * original channels; title style and graphic shape channels belong to
 * their owner only. (Titles and graphics still accept the clip channels
 * they ignore, as they always have.)
 */
export function keyframePropertyAllowed(
	owner: KeyframeOwnerKind,
	property: KeyframeProperty
): boolean {
	if (titleOnly.has(property)) {
		return owner === "title";
	}
	if (graphicOnly.has(property)) {
		return owner === "graphic";
	}
	return true;
}

/**
 * A clip-relative keyframe. `interpolation` shapes the curve from this
 * keyframe to the next one (absent means linear). `target` names the effect
 * or mask id that `effectAmount`/`mask*` keyframes drive. Color channels
 * (`colorKeyframeProperties`) carry `color` and a zero `value`.
 */
export const keyframeSchema = z
	.object({
		id: idSchema,
		time: timeSchema,
		property: keyframePropertySchema,
		value: z.number().finite().min(-180).max(180),
		interpolation: keyframeInterpolationSchema.optional(),
		bezier: keyframeBezierSchema.optional(),
		target: z.string().trim().min(1).max(64).optional(),
		color: hexColorSchema.optional(),
	})
	.strict();
export type Keyframe = z.infer<typeof keyframeSchema>;

/** Properties whose keyframes must name an effect (`effectAmount`) or mask. */
export const targetedKeyframeProperties: ReadonlySet<KeyframeProperty> =
	new Set([
		"effectAmount",
		"maskX",
		"maskY",
		"maskWidth",
		"maskHeight",
		"maskRotation",
		"maskFeather",
	]);
export const maskKeyframeProperties: ReadonlySet<KeyframeProperty> = new Set([
	"maskX",
	"maskY",
	"maskWidth",
	"maskHeight",
	"maskRotation",
	"maskFeather",
]);

const bounds: Record<KeyframeProperty, readonly [number, number]> = {
	x: [-MAX_CLIP_OFFSET, MAX_CLIP_OFFSET],
	y: [-MAX_CLIP_OFFSET, MAX_CLIP_OFFSET],
	scale: [0.1, 4],
	rotation: [-180, 180],
	opacity: [0, 1],
	volume: [0, 4],
	scaleX: [0.1, 4],
	scaleY: [0.1, 4],
	cropLeft: [0, 0.9],
	cropRight: [0, 0.9],
	cropTop: [0, 0.9],
	cropBottom: [0, 0.9],
	brightness: [-1, 1],
	contrast: [0, 3],
	saturation: [0, 3],
	exposure: [-3, 3],
	temperature: [-1, 1],
	blur: [0, 1],
	effectAmount: [0, 1],
	pan: [-1, 1],
	maskX: [-1, 1],
	maskY: [-1, 1],
	maskWidth: [0, 2],
	maskHeight: [0, 2],
	maskRotation: [-180, 180],
	maskFeather: [0, 1],
	fontSize: [0.02, 0.2],
	letterSpacing: [-0.1, 0.5],
	lineHeight: [0.8, 3],
	backgroundPadding: [0, 0.05],
	backgroundRadius: [0, 0.5],
	strokeWidth: [0, 0.08],
	cornerRadius: [0, 0.5],
	innerRadius: [0.1, 0.95],
	color: [0, 0],
	backgroundColor: [0, 0],
	fill: [0, 0],
	stroke: [0, 0],
};

/** The inclusive value range a keyframe of `property` may hold. */
export function keyframeValueBounds(
	property: KeyframeProperty
): readonly [number, number] {
	return bounds[property];
}

/** `#rrggbb` between two colors at `fraction`, per RGB channel. */
export function mixKeyframeColor(
	from: string,
	to: string,
	fraction: number
): string {
	const channels = (hex: string) =>
		[1, 3, 5].map((offset) =>
			Number.parseInt(hex.slice(offset, offset + 2), 16)
		);
	const a = channels(from);
	const b = channels(to);
	const t = Math.min(1, Math.max(0, fraction));
	return `#${a
		.map((channel, index) =>
			Math.round(channel + ((b[index] ?? channel) - channel) * t)
				.toString(16)
				.padStart(2, "0")
		)
		.join("")}`;
}
