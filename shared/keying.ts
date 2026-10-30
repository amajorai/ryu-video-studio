/**
 * Keying (W2-V4): chroma, RGB color, hue (HSV) and luma keys with optional
 * spill suppression, shared by the render stage
 * (`sidecar/src/render-stages/key.ts`), the WebGL preview pass
 * (`ui/src/preview/gl/passes/key.ts`) and the inspector.
 *
 * The stored `segment.key` keeps every tuning field optional (no schema
 * defaults), so `resolvedKeyOf` fills the per-type defaults here. Every
 * function is pure and deterministic.
 *
 * Render mapping (FFmpeg). The frame entering a YUV key is 8-bit
 * limited-range BT.601 (`format=yuva444p`), so the preview math
 * (`keyedPixel`) works on the same limited-range Y/U/V values:
 * - chroma: `format=yuva444p,chromakey=color=0xYYUUVV:…:yuv=1`, the key
 *           colour given as the limited-range U/V a pixel of that colour has
 * - color:  `format=rgba,colorkey=color=0xRRGGBB:similarity:blend`
 * - hsv:    `format=yuva444p`, then `hsvkey=hue=H:sat=-1:val=-1:…` (hue only)
 *           combined by `lut2` with a saturation gate (`hsvkey=…:sat=0`) so
 *           grey, white and black pixels, whose hue is undefined, stay
 *           opaque. `H` is converted to FFmpeg's internal hue angle, which
 *           is never 0 (FFmpeg treats `hue=0` as "match every hue").
 * - luma:   `format=yuva444p,lumakey=threshold:tolerance:softness`, with
 *           the `lumaLow..lumaHigh` band and the blend converted to
 *           limited-range luma (black 16, white 235)
 * - spill:  `despill=type=green|blue:mix=0.5:expand=0:green=…:blue=…`, the
 *           key channel scaled by `-spill`, so 0 leaves colour untouched and
 *           1 clamps the key channel to the average of the other two.
 *
 * `hsvkey`, `lut2` and `despill` are optional FFmpeg filters. `keyFilterPlan`
 * falls back (HSV renders as a chroma key; the grey gate or spill is skipped)
 * and reports why, and
 * `keyCapabilityIssues` gives the same reasons to the inspector.
 */
import { z } from "zod";
import type { Asset } from "./project.ts";
import { type Key, type KeyType, keyTypeSchema } from "./schema/key.ts";

export type { Key, KeyType } from "./schema/key.ts";

/** Every key type, in menu order. */
export const keyTypes: readonly KeyType[] = keyTypeSchema.options;

export const keyTypeLabels: Record<KeyType, string> = {
	chroma: "Chroma key",
	color: "Color key (RGB)",
	hsv: "Hue key (HSV)",
	luma: "Luma key",
};

export type Rgb = readonly [number, number, number];

/** A key with every tuning value resolved. */
export interface ResolvedKey {
	blend: number;
	/** `#rrggbb`; luma keys ignore it. */
	color: string;
	lumaHigh: number;
	lumaLow: number;
	similarity: number;
	spill: number;
	type: KeyType;
}

/** The colour a fresh chroma, colour or HSV key starts from (green screen). */
export const DEFAULT_KEY_COLOR = "#00ff00";

const defaultSimilarity: Record<KeyType, number> = {
	chroma: 0.15,
	color: 0.2,
	hsv: 0.35,
	luma: 0.15,
};
const DEFAULT_BLEND = 0.08;
const DEFAULT_LUMA_LOW = 0;
const DEFAULT_LUMA_HIGH = 0.1;
const MIN_SIMILARITY = 0.01;

const clamp = (value: number, min: number, max: number) =>
	Math.min(max, Math.max(min, value));
const round = (value: number) => Number(value.toFixed(4));

/**
 * The effective key. For an HSV key without an explicit `similarity`, the
 * `hueRange` (degrees either side of the key hue) sets it. `hsvkey` measures
 * a hue difference Δ as the chord `2·sin(Δ/2)`, so similarity is that chord;
 * similarity tops out at 1, which is 60° either side.
 */
export function resolvedKeyOf(key: Key): ResolvedKey {
	const fromHueRange =
		key.type === "hsv" && key.hueRange !== undefined
			? clamp(
					round(2 * Math.sin((clamp(key.hueRange, 0, 180) * Math.PI) / 360)),
					MIN_SIMILARITY,
					1
				)
			: undefined;
	return {
		blend: key.blend ?? DEFAULT_BLEND,
		color: (key.color ?? DEFAULT_KEY_COLOR).toLowerCase(),
		lumaHigh: key.lumaHigh ?? DEFAULT_LUMA_HIGH,
		lumaLow: key.lumaLow ?? DEFAULT_LUMA_LOW,
		similarity: key.similarity ?? fromHueRange ?? defaultSimilarity[key.type],
		spill: key.spill ?? 0,
		type: key.type,
	};
}

/**
 * A new key of `type`, keeping the colour of the previous key when there is
 * one. Tuning values stay unset so they follow the per-type defaults.
 */
export function newKey(type: KeyType, previous?: Key): Key {
	if (type === "luma") {
		return { type };
	}
	return { color: previous?.color ?? DEFAULT_KEY_COLOR, type };
}

/** `#rrggbb` → 0..255 channels. */
export function hexToRgb(hex: string): Rgb {
	const match = /^#?([0-9a-f]{6})$/i.exec(hex);
	if (!match?.[1]) {
		throw new Error("Use a #rrggbb key color.");
	}
	const value = Number.parseInt(match[1], 16);
	return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

/** 0..255 channels → `#rrggbb` (rounded and clamped). */
export function rgbToHex([r, g, b]: Rgb): string {
	return `#${[r, g, b]
		.map((channel) =>
			Math.round(clamp(channel, 0, 255))
				.toString(16)
				.padStart(2, "0")
		)
		.join("")}`;
}

/** HSV of 0..255 channels: hue in degrees 0..360, saturation and value 0..1. */
export function rgbToHsv([r, g, b]: Rgb): {
	hue: number;
	saturation: number;
	value: number;
} {
	const red = r / 255;
	const green = g / 255;
	const blue = b / 255;
	const max = Math.max(red, green, blue);
	const min = Math.min(red, green, blue);
	const delta = max - min;
	let hue = 0;
	if (delta > 0) {
		if (max === red) {
			hue = ((green - blue) / delta) % 6;
		} else if (max === green) {
			hue = (blue - red) / delta + 2;
		} else {
			hue = (red - green) / delta + 4;
		}
		hue *= 60;
		if (hue < 0) {
			hue += 360;
		}
	}
	return { hue, saturation: max === 0 ? 0 : delta / max, value: max };
}

export type SpillChannel = "green" | "blue";

/**
 * Which screen colour spill suppression removes: green when green dominates
 * the key colour, blue when blue does. Luma keys and other colours have no
 * spill channel (FFmpeg's `despill` only knows green and blue screens).
 */
export function spillChannelOf(key: Key): SpillChannel | null {
	if (key.type === "luma") {
		return null;
	}
	const [r, g, b] = hexToRgb(key.color ?? DEFAULT_KEY_COLOR);
	if (g > r && g >= b) {
		return "green";
	}
	if (b > r && b > g) {
		return "blue";
	}
	return null;
}

/** Optional FFmpeg filters a key may need. */
export const KEY_FILTERS = [
	"chromakey",
	"colorkey",
	"hsvkey",
	"lumakey",
	"lut2",
	"despill",
] as const;
export type KeyFilter = (typeof KEY_FILTERS)[number];

/** Filter availability; a filter that is not listed counts as available. */
export type KeyFilterAvailability = Readonly<
	Partial<Record<KeyFilter | string, boolean>>
>;

const available = (filters: KeyFilterAvailability, name: KeyFilter) =>
	filters[name] !== false;

const ffmpegColor = (hex: string) => `0x${hex.slice(1).toUpperCase()}`;

/** `name=value` pairs with fixed rounding so filter strings are stable. */
const options = (pairs: [string, number | string][]) =>
	pairs
		.map(
			([name, value]) =>
				`${name}=${typeof value === "number" ? round(value) : value}`
		)
		.join(":");

const keyFilterOf: Record<KeyType, KeyFilter> = {
	chroma: "chromakey",
	color: "colorkey",
	hsv: "hsvkey",
	luma: "lumakey",
};

const hex2 = (value: number) =>
	Math.round(clamp(value, 0, 255))
		.toString(16)
		.padStart(2, "0")
		.toUpperCase();

/**
 * The FFmpeg `hsvkey` `hue` option that makes its internal key angle equal
 * `angle` (radians, the `hueAngleOf` scale). FFmpeg stores
 * `π·fmod(526 − hue, 360)/180` for a positive `hue` and ignores the pixel
 * hue entirely for `hue <= 0`, so the result is always in (0, 360].
 */
export function hsvKeyHueOption(angle: number): number {
	const degrees = (angle * 180) / Math.PI;
	const option = round((((526 - degrees) % 360) + 360) % 360);
	return option <= 0 ? 360 : option;
}

/** Saturation below which the hue key leaves a pixel opaque (grey gate). */
export const HUE_GATE_SIMILARITY = 0.03;
/** Saturation span over which the grey gate fades out. */
export const HUE_GATE_BLEND = 0.03;

/**
 * A hue-only `hsvkey`, combined by `lut2` (alpha = max(hue alpha, 255 −
 * saturation alpha)) with a saturation key that keeps near-grey pixels
 * opaque. The branch labels start with `label`.
 */
function hueKeyGraph(
	key: ResolvedKey,
	angle: number,
	label: string,
	gate: boolean
): string[] {
	const hueKey = `hsvkey=${options([
		["hue", hsvKeyHueOption(angle)],
		["sat", -1],
		["val", -1],
		["similarity", key.similarity],
		["blend", key.blend],
	])}`;
	if (!gate) {
		return ["format=yuva444p", hueKey];
	}
	const satKey = `hsvkey=${options([
		["hue", 1],
		["sat", 0],
		["val", -1],
		["similarity", HUE_GATE_SIMILARITY],
		["blend", HUE_GATE_BLEND],
	])}`;
	return [
		"format=yuva444p",
		[
			`split=2[${label}h][${label}s]`,
			`[${label}h]${hueKey}[${label}hk]`,
			`[${label}s]${satKey}[${label}sk]`,
			`[${label}hk][${label}sk]lut2=c0=x:c1=x:c2=x:c3='max(x,255-y)'`,
		].join(";"),
	];
}

function primaryKeyFilters(
	key: ResolvedKey,
	label: string,
	gate: boolean
): string[] {
	switch (key.type) {
		case "chroma": {
			const { u, v, y } = limitedYuvOf(unitRgbOf(key.color));
			return [
				"format=yuva444p",
				`chromakey=${options([
					["color", `0x${hex2(y)}${hex2(u)}${hex2(v)}`],
					["similarity", key.similarity],
					["blend", key.blend],
					["yuv", 1],
				])}`,
			];
		}
		case "color":
			return [
				"format=rgba",
				`colorkey=${options([
					["color", ffmpegColor(key.color)],
					["similarity", key.similarity],
					["blend", key.blend],
				])}`,
			];
		case "hsv": {
			const angle = hueAngleOf(key.color);
			return angle === null ? [] : hueKeyGraph(key, angle, label, gate);
		}
		default: {
			const band = lumaKeyBandOf(key);
			return [
				"format=yuva444p",
				`lumakey=${options([
					["threshold", band.threshold],
					["tolerance", band.tolerance],
					["softness", band.softness],
				])}`,
			];
		}
	}
}

/** `despill` scaled so `spill` is the fraction of the spill map removed. */
export function despillFilter(channel: SpillChannel, spill: number): string {
	const amount = round(-clamp(spill, 0, 1));
	return `despill=${options([
		["type", channel],
		["mix", 0.5],
		["expand", 0],
		["green", channel === "green" ? amount : 0],
		["blue", channel === "blue" ? amount : 0],
	])}`;
}

export interface KeyFilterPlan {
	filters: string[];
	/** Why the render differs from the requested key (missing filters). */
	issues: string[];
}

/**
 * FFmpeg filters for a key given the filters this FFmpeg build provides.
 * Missing `hsvkey` falls back to a chroma key on the same colour; missing
 * `lut2` drops the hue key's grey gate; missing `despill` skips spill
 * suppression; a missing primary filter (chromakey, colorkey or lumakey)
 * leaves the clip unkeyed. Each fallback is reported. A hue key whose colour
 * is grey has no hue to match and renders unkeyed.
 *
 * `label` prefixes the filter labels a hue key's branch creates; it must be
 * unique per filtergraph (the render stage uses the segment id).
 */
export function keyFilterPlan(
	key: Key | undefined,
	filters: KeyFilterAvailability = {},
	label = "key"
): KeyFilterPlan {
	if (!key) {
		return { filters: [], issues: [] };
	}
	const resolved = resolvedKeyOf(key);
	const issues: string[] = [];
	let effective = resolved;
	if (resolved.type === "hsv" && !available(filters, "hsvkey")) {
		effective = { ...resolved, type: "chroma" };
		issues.push(
			"This FFmpeg build has no hsvkey filter, so the hue key renders as a chroma key."
		);
	}
	if (!available(filters, keyFilterOf[effective.type])) {
		issues.push(
			`This FFmpeg build has no ${keyFilterOf[effective.type]} filter, so the clip renders unkeyed.`
		);
		return { filters: [], issues };
	}
	if (effective.type === "hsv" && hueAngleOf(effective.color) === null) {
		issues.push(
			"The hue key color is grey, so it has no hue to match; pick a saturated color."
		);
		return { filters: [], issues };
	}
	const gate = available(filters, "lut2");
	if (effective.type === "hsv" && !gate) {
		issues.push(
			"This FFmpeg build has no lut2 filter, so the hue key may also remove grey, white and black pixels."
		);
	}
	const chain = primaryKeyFilters(effective, label, gate);
	const channel = spillChannelOf(key);
	if (resolved.spill > 0 && channel) {
		if (available(filters, "despill")) {
			chain.push(despillFilter(channel, resolved.spill));
		} else {
			issues.push(
				"This FFmpeg build has no despill filter, so spill suppression is skipped."
			);
		}
	}
	return { filters: chain, issues };
}

/**
 * Reasons the inspector disables part of a key on this FFmpeg build (empty
 * when everything renders as configured). `filters` comes from
 * `GET /capabilities`.
 */
export function keyCapabilityIssues(
	key: Key | undefined,
	filters: KeyFilterAvailability
): string[] {
	return keyFilterPlan(key, filters).issues;
}

/** Whether a key type can render at all on this build (HSV falls back). */
export function keyTypeAvailable(
	type: KeyType,
	filters: KeyFilterAvailability
): boolean {
	return available(filters, keyFilterOf[type]);
}

// --- Reference math, mirrored by the WebGL preview pass. ---------------------

/** `#rrggbb` → 0..1 channels. */
export function unitRgbOf(hex: string): Rgb {
	const [r, g, b] = hexToRgb(hex);
	return [r / 255, g / 255, b / 255];
}

/**
 * 8-bit limited-range BT.601 Y, U and V of 0..1 RGB: the values FFmpeg's
 * `format=yuva444p` gives the YUV keys (black Y 16, white Y 235, grey U/V 128).
 */
export function limitedYuvOf([r, g, b]: Rgb): {
	u: number;
	v: number;
	y: number;
} {
	return {
		u: Math.round(128 - 37.797 * r - 74.203 * g + 112 * b),
		v: Math.round(128 + 112 * r - 93.786 * g - 18.214 * b),
		y: Math.round(16 + 65.481 * r + 128.553 * g + 24.966 * b),
	};
}

/** `hsvkey`'s pixel saturation of 8-bit U/V (0 for grey, about 0.66 for pure green). */
export function hsvSaturationOf(u: number, v: number): number {
	const du = u - 127.5;
	const dv = v - 127.5;
	return Math.sqrt((du * du + dv * dv) / (127.5 * 127.5 * 2));
}

/** `hsvkey`'s pixel hue of 8-bit U/V, in radians 0..2π. */
export const hsvHueOf = (u: number, v: number) =>
	Math.atan2(u - 127.5, v - 127.5) + Math.PI;

/**
 * The hue angle (`hsvHueOf` scale) a hue key matches for its colour, or
 * null when the colour is too grey to have a hue (it would sit inside the
 * grey gate).
 */
export function hueAngleOf(hex: string): number | null {
	const { u, v } = limitedYuvOf(unitRgbOf(hex));
	if (hsvSaturationOf(u, v) < HUE_GATE_SIMILARITY + HUE_GATE_BLEND) {
		return null;
	}
	return hsvHueOf(u, v);
}

/**
 * The luma band in FFmpeg's limited-range luma: `lumakey` options, plus the
 * 8-bit `black`/`white` limits and `soft` ramp FFmpeg derives from them. The
 * band is widened by half a level so its ends survive FFmpeg's truncation.
 */
export function lumaKeyBandOf(
	key: Pick<ResolvedKey, "blend" | "lumaHigh" | "lumaLow">
): {
	black: number;
	soft: number;
	softness: number;
	threshold: number;
	tolerance: number;
	white: number;
} {
	const level = (value: number) => 16 + 219 * clamp(value, 0, 1);
	const low = (level(Math.min(key.lumaLow, key.lumaHigh)) - 0.5) / 255;
	const high = (level(Math.max(key.lumaLow, key.lumaHigh)) + 0.5) / 255;
	const threshold = round((low + high) / 2);
	const tolerance = round((high - low) / 2);
	const softness = round((clamp(key.blend, 0, 1) * 219) / 255);
	const byte = (value: number) => clamp(Math.trunc(value * 255), 0, 255);
	return {
		black: byte(threshold - tolerance),
		soft: Math.trunc(softness * 255),
		softness,
		threshold,
		tolerance,
		white: byte(threshold + tolerance),
	};
}

/** Opacity from a key distance: hard below `similarity`, ramped over `blend`. */
export function keyRamp(
	distance: number,
	similarity: number,
	blend: number
): number {
	if (blend > 0.0001) {
		return clamp((distance - similarity) / blend, 0, 1);
	}
	return distance > similarity ? 1 : 0;
}

/** `lumakey`'s opacity for 8-bit limited-range luma `y`. */
export function lumaKeyAlpha(
	y: number,
	band: { black: number; soft: number; white: number }
): number {
	const { black, soft, white } = band;
	if (y >= black && y <= white) {
		return 0;
	}
	if (y > black - soft && y < white + soft) {
		return y < black ? (black - y) / soft : (y - white) / soft;
	}
	return 1;
}

/**
 * The distance a chroma, colour or hue key measures for a 0..1 RGB pixel
 * (0 = exactly the key), on the scale FFmpeg compares with `similarity`:
 * chroma is the limited-range U/V distance (`chromakey`), colour the RGB
 * distance (`colorkey`), hue the chord `2·sin(Δ/2)` between hue angles
 * (`hsvkey`). Luma keys have a band, not a distance (`lumaKeyAlpha`).
 */
export function keyDistance(key: ResolvedKey, pixel: Rgb): number {
	const target = unitRgbOf(key.color);
	switch (key.type) {
		case "color": {
			const dr = pixel[0] - target[0];
			const dg = pixel[1] - target[1];
			const db = pixel[2] - target[2];
			return Math.sqrt((dr * dr + dg * dg + db * db) / 3);
		}
		case "hsv": {
			const angle = hueAngleOf(key.color);
			if (angle === null) {
				return Number.POSITIVE_INFINITY;
			}
			const { u, v } = limitedYuvOf(pixel);
			const delta = angle - hsvHueOf(u, v);
			return Math.sqrt(Math.max(2 - 2 * Math.cos(delta), 0));
		}
		default: {
			const a = limitedYuvOf(pixel);
			const b = limitedYuvOf(target);
			const du = a.u - b.u;
			const dv = a.v - b.v;
			return Math.sqrt((du * du + dv * dv) / (255 * 255 * 2));
		}
	}
}

/** `hsvkey`'s ramp: below `similarity` keyed, then linear over `blend`. */
function hsvRamp(distance: number, similarity: number, blend: number): number {
	if (distance < similarity) {
		return 0;
	}
	return blend > 0 ? clamp((distance - similarity) / blend, 0, 1) : 1;
}

function keyAlpha(key: ResolvedKey, pixel: Rgb): number {
	if (key.type === "luma") {
		return lumaKeyAlpha(limitedYuvOf(pixel).y, lumaKeyBandOf(key));
	}
	const { similarity } = key;
	if (key.type !== "hsv") {
		return keyRamp(keyDistance(key, pixel), similarity, key.blend);
	}
	if (hueAngleOf(key.color) === null) {
		return 1;
	}
	const hue = hsvRamp(keyDistance(key, pixel), similarity, key.blend);
	const { u, v } = limitedYuvOf(pixel);
	const grey =
		1 - hsvRamp(hsvSaturationOf(u, v), HUE_GATE_SIMILARITY, HUE_GATE_BLEND);
	return Math.max(hue, grey);
}

/**
 * The preview's keyed pixel for 0..1 RGB input: the key's opacity (matching
 * the FFmpeg filter `keyFilterPlan` emits, with every filter available) plus
 * spill-suppressed colour.
 */
export function keyedPixel(key: Key, pixel: Rgb): { alpha: number; rgb: Rgb } {
	const resolved = resolvedKeyOf(key);
	const alpha = keyAlpha(resolved, pixel);
	const channel = spillChannelOf(key);
	if (!channel || resolved.spill <= 0) {
		return { alpha, rgb: pixel };
	}
	const [r, g, b] = pixel;
	if (channel === "green") {
		const excess = Math.max(0, g - (r + b) / 2);
		return { alpha, rgb: [r, g - excess * resolved.spill, b] };
	}
	const excess = Math.max(0, b - (r + g) / 2);
	return { alpha, rgb: [r, g, b - excess * resolved.spill] };
}

// --- Static-background cutout derivative. -----------------------------------

/** Longest source the cutout derivative processes. */
export const MAX_CUTOUT_SECONDS = 600;

/**
 * Derivative codecs. Only ProRes 4444: VP9 alpha is not decoded by the
 * renderer, so VP9 is not offered.
 */
export const cutoutCodecSchema = z.enum(["prores-4444"]);
export type CutoutCodec = z.infer<typeof cutoutCodecSchema>;

/**
 * `POST /assets/:id/cutout`. The clean plate is a frame of the same static
 * shot with nobody in it; `backgroundkey` makes every pixel that matches it
 * transparent. `threshold` is FFmpeg's scene-change limit: a frame differing
 * from the plate by more than that fraction re-captures the background, so
 * the default stays high for shots where the subject fills much of the frame.
 */
export const cutoutRequestSchema = z
	.object({
		cleanPlateTime: z.number().finite().min(0).max(MAX_CUTOUT_SECONDS),
		threshold: z.number().finite().min(0).max(1).default(0.5),
		similarity: z.number().finite().min(0).max(1).default(0.1),
		blend: z.number().finite().min(0).max(1).default(0.05),
		codec: cutoutCodecSchema.optional(),
		name: z.string().trim().min(1).max(200).optional(),
	})
	.strict();
export type CutoutRequest = z.infer<typeof cutoutRequestSchema>;
export type CutoutInput = z.input<typeof cutoutRequestSchema>;

/**
 * Asserts this FFmpeg build can write the derivative. Only ProRes 4444 is
 * written: the renderer opens VP9 with FFmpeg's built-in decoder, which
 * drops VP9 alpha, so a VP9 cutout would export fully opaque.
 */
export function cutoutCodecFor(
	encoders: Readonly<Partial<Record<string, boolean>>>
): CutoutCodec {
	if (encoders.prores_ks !== true) {
		throw new Error(
			"This FFmpeg build has no prores_ks encoder, so it cannot write a cutout with transparency (ProRes 4444)."
		);
	}
	return "prores-4444";
}

/**
 * Planning size of the ProRes 4444 derivative in bytes per pixel per frame.
 * Clean synthetic shots measure about 0.3; camera footage runs higher
 * (ProRes 4444 targets about 0.66 before alpha).
 */
export const CUTOUT_BYTES_PER_PIXEL_FRAME = 0.75;
/** Disk the cutout may use at its peak: every chunk plus the joined file. */
export const CUTOUT_PEAK_BYTES = 10 * 1024 * 1024 * 1024;
const CUTOUT_FALLBACK_FPS = 30;

type CutoutSize = Pick<Asset, "duration" | "height" | "width"> &
	Partial<Pick<Asset, "frameRate" | "timecodeFrameRate">>;

/** Estimated bytes of the finished derivative. */
export function cutoutOutputBytes(asset: CutoutSize): number {
	const fps = asset.frameRate ?? asset.timecodeFrameRate ?? CUTOUT_FALLBACK_FPS;
	return Math.ceil(
		Math.max(1, asset.width) *
			Math.max(1, asset.height) *
			fps *
			CUTOUT_BYTES_PER_PIXEL_FRAME *
			asset.duration
	);
}

/**
 * Longest source the cutout accepts at this resolution and frame rate: the
 * chunks and the joined file (twice the derivative) must fit the peak
 * budget, and never more than `MAX_CUTOUT_SECONDS`.
 */
export function cutoutMaxSeconds(asset: Omit<CutoutSize, "duration">): number {
	const perSecond = cutoutOutputBytes({ ...asset, duration: 1 });
	return Math.min(
		MAX_CUTOUT_SECONDS,
		Math.floor(CUTOUT_PEAK_BYTES / (2 * perSecond))
	);
}

/** `backgroundkey` with the request's tuning. */
export function backgroundKeyFilter(
	request: Pick<CutoutRequest, "blend" | "similarity" | "threshold">
): string {
	return `backgroundkey=${options([
		["threshold", request.threshold],
		["similarity", request.similarity],
		["blend", request.blend],
	])}`;
}

/**
 * The source time of a clip's frame under the playhead, clamped inside the
 * clip, for "use this frame as the clean plate".
 */
export function sourceTimeUnderPlayhead(
	segment: {
		sourceIn: number;
		sourceOut: number;
		speed: number;
		start: number;
	},
	time: number
): number {
	const offset = Math.max(0, time - segment.start) * segment.speed;
	return Number(
		Math.min(segment.sourceOut, segment.sourceIn + offset).toFixed(3)
	);
}
