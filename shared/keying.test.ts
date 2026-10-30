import { describe, expect, test } from "bun:test";
import {
	backgroundKeyFilter,
	CUTOUT_PEAK_BYTES,
	cutoutCodecFor,
	cutoutMaxSeconds,
	cutoutOutputBytes,
	cutoutRequestSchema,
	despillFilter,
	hexToRgb,
	hsvKeyHueOption,
	hueAngleOf,
	keyCapabilityIssues,
	keyDistance,
	keyedPixel,
	keyFilterPlan,
	keyRamp,
	keyTypeAvailable,
	limitedYuvOf,
	lumaKeyAlpha,
	lumaKeyBandOf,
	newKey,
	resolvedKeyOf,
	rgbToHex,
	rgbToHsv,
	sourceTimeUnderPlayhead,
	spillChannelOf,
} from "./keying.ts";
import { keySchema } from "./schema/key.ts";

describe("resolvedKeyOf", () => {
	test("fills per-type defaults without touching the stored key", () => {
		const key = keySchema.parse({ color: "#00FF00", type: "chroma" });
		expect(resolvedKeyOf(key)).toEqual({
			blend: 0.08,
			color: "#00ff00",
			lumaHigh: 0.1,
			lumaLow: 0,
			similarity: 0.15,
			spill: 0,
			type: "chroma",
		});
		expect(key).toEqual({ color: "#00FF00", type: "chroma" });
	});

	test("an HSV hue range sets similarity unless similarity is explicit", () => {
		// hsvkey measures hue as a chord: 2·sin(45°/2).
		expect(
			resolvedKeyOf({ color: "#00ff00", hueRange: 45, type: "hsv" }).similarity
		).toBe(0.7654);
		expect(
			resolvedKeyOf({ color: "#00ff00", hueRange: 180, type: "hsv" }).similarity
		).toBe(1);
		expect(
			resolvedKeyOf({
				color: "#00ff00",
				hueRange: 45,
				similarity: 0.4,
				type: "hsv",
			}).similarity
		).toBe(0.4);
	});

	test("newKey keeps the previous colour and drops it for luma", () => {
		expect(newKey("color", { color: "#0000ff", type: "chroma" })).toEqual({
			color: "#0000ff",
			type: "color",
		});
		expect(newKey("chroma")).toEqual({ color: "#00ff00", type: "chroma" });
		expect(newKey("luma", { color: "#0000ff", type: "chroma" })).toEqual({
			type: "luma",
		});
		expect(keySchema.safeParse(newKey("hsv")).success).toBe(true);
		expect(keySchema.safeParse(newKey("luma")).success).toBe(true);
	});
});

describe("colour helpers", () => {
	test("hex round trips and HSV hue", () => {
		expect(hexToRgb("#1a2B3c")).toEqual([26, 43, 60]);
		expect(rgbToHex([26, 43, 60])).toBe("#1a2b3c");
		expect(rgbToHex([-4, 300, 127.6])).toBe("#00ff80");
		expect(() => hexToRgb("green")).toThrow("#rrggbb");
		expect(rgbToHsv([0, 255, 0])).toEqual({
			hue: 120,
			saturation: 1,
			value: 1,
		});
		expect(rgbToHsv([0, 0, 255]).hue).toBe(240);
		expect(rgbToHsv([255, 0, 128]).hue).toBeCloseTo(329.88, 2);
		expect(rgbToHsv([128, 128, 128])).toEqual({
			hue: 0,
			saturation: 0,
			value: 128 / 255,
		});
	});

	test("spill channel follows the dominant screen colour", () => {
		expect(spillChannelOf({ color: "#10e020", type: "chroma" })).toBe("green");
		expect(spillChannelOf({ color: "#2040f0", type: "color" })).toBe("blue");
		expect(spillChannelOf({ color: "#ff0000", type: "chroma" })).toBeNull();
		expect(spillChannelOf({ type: "luma" })).toBeNull();
	});
});

const GATE = "[keyhk][keysk]lut2=c0=x:c1=x:c2=x:c3='max(x,255-y)'";

describe("keyFilterPlan", () => {
	test("chroma keys pass the key as limited-range YUV", () => {
		expect(
			keyFilterPlan({
				blend: 0.1,
				color: "#00ff00",
				similarity: 0.3,
				type: "chroma",
			})
		).toEqual({
			filters: [
				"format=yuva444p",
				// Y 145, U 54, V 34: what yuva444p holds for pure green.
				"chromakey=color=0x913622:similarity=0.3:blend=0.1:yuv=1",
			],
			issues: [],
		});
		expect(limitedYuvOf([0, 1, 0])).toEqual({ u: 54, v: 34, y: 145 });
		expect(limitedYuvOf([1, 1, 1])).toEqual({ u: 128, v: 128, y: 235 });
		expect(limitedYuvOf([0, 0, 0])).toEqual({ u: 128, v: 128, y: 16 });
	});

	test("color keys in RGB", () => {
		expect(
			keyFilterPlan({ color: "#2040f0", similarity: 0.2, type: "color" })
				.filters
		).toEqual([
			"format=rgba",
			"colorkey=color=0x2040F0:similarity=0.2:blend=0.08",
		]);
	});

	test("HSV keys compare hue only, with a grey gate", () => {
		const plan = keyFilterPlan({
			blend: 0,
			color: "#00ff00",
			hueRange: 30,
			type: "hsv",
		});
		expect(plan.issues).toEqual([]);
		expect(plan.filters).toEqual([
			"format=yuva444p",
			[
				"split=2[keyh][keys]",
				"[keyh]hsvkey=hue=127.8292:sat=-1:val=-1:similarity=0.5176:blend=0[keyhk]",
				"[keys]hsvkey=hue=1:sat=0:val=-1:similarity=0.03:blend=0.03[keysk]",
				GATE,
			].join(";"),
		]);
		expect(
			keyFilterPlan({ color: "#00ff00", type: "hsv" }, {}, "key9").filters[1]
		).toStartWith("split=2[key9h][key9s];[key9h]hsvkey=");
	});

	test("a red hue key never emits hue=0, which FFmpeg reads as every hue", () => {
		for (const color of ["#ff0000", "#ff0004", "#ff0400", "#fe0102"]) {
			const filters = keyFilterPlan({ color, type: "hsv" }).filters.join(",");
			const hue = Number(/hsvkey=hue=([\d.]+):sat=-1/.exec(filters)?.[1]);
			expect(hue).toBeGreaterThan(0);
			expect(hue).toBeLessThanOrEqual(360);
		}
		// The FFmpeg option for FFmpeg's internal angle 166° is 360, never 0.
		expect(hsvKeyHueOption((166 * Math.PI) / 180)).toBe(360);
		expect(hsvKeyHueOption((165 * Math.PI) / 180)).toBe(1);
		expect(hsvKeyHueOption(0)).toBe(166);
	});

	test("a grey hue key has no hue and renders unkeyed", () => {
		for (const color of ["#808080", "#ffffff", "#000000", "#141414"]) {
			expect(hueAngleOf(color)).toBeNull();
			const plan = keyFilterPlan({ color, type: "hsv" });
			expect(plan.filters).toEqual([]);
			expect(plan.issues[0]).toContain("grey");
			expect(keyedPixel({ color, type: "hsv" }, [0.5, 0.5, 0.5]).alpha).toBe(1);
			expect(keyedPixel({ color, type: "hsv" }, [0, 1, 0]).alpha).toBe(1);
		}
	});

	test("luma keys convert the band to limited-range luma", () => {
		expect(
			keyFilterPlan({ blend: 0.05, lumaHigh: 1, lumaLow: 0.8, type: "luma" })
				.filters
		).toEqual([
			"format=yuva444p",
			"lumakey=threshold=0.8357:tolerance=0.0878:softness=0.0429",
		]);
		// Full band: limited black 16 to white 235, half a level wider.
		expect(lumaKeyBandOf({ blend: 0, lumaHigh: 1, lumaLow: 0 })).toEqual({
			black: 15,
			soft: 0,
			softness: 0,
			threshold: 0.4922,
			tolerance: 0.4314,
			white: 235,
		});
	});

	test("spill adds a scaled despill on the key channel", () => {
		expect(
			keyFilterPlan({ color: "#00ff00", spill: 0.6, type: "chroma" }).filters
		).toEqual([
			"format=yuva444p",
			"chromakey=color=0x913622:similarity=0.15:blend=0.08:yuv=1",
			"despill=type=green:mix=0.5:expand=0:green=-0.6:blue=0",
		]);
		expect(despillFilter("blue", 2)).toBe(
			"despill=type=blue:mix=0.5:expand=0:green=0:blue=-1"
		);
		expect(
			keyFilterPlan({ color: "#ff0000", spill: 0.6, type: "chroma" }).filters
		).toHaveLength(2);
	});

	test("no key adds no filters", () => {
		expect(keyFilterPlan(undefined)).toEqual({ filters: [], issues: [] });
	});

	test("missing optional filters fall back with a reason", () => {
		const hsv = keyFilterPlan(
			{ color: "#00ff00", spill: 0.5, type: "hsv" },
			{ despill: false, hsvkey: false }
		);
		expect(hsv.filters).toEqual([
			"format=yuva444p",
			"chromakey=color=0x913622:similarity=0.35:blend=0.08:yuv=1",
		]);
		expect(hsv.issues).toEqual([
			"This FFmpeg build has no hsvkey filter, so the hue key renders as a chroma key.",
			"This FFmpeg build has no despill filter, so spill suppression is skipped.",
		]);
		const ungated = keyFilterPlan(
			{ color: "#00ff00", type: "hsv" },
			{ lut2: false }
		);
		expect(ungated.filters).toEqual([
			"format=yuva444p",
			"hsvkey=hue=127.8292:sat=-1:val=-1:similarity=0.35:blend=0.08",
		]);
		expect(ungated.issues[0]).toContain("no lut2 filter");
		const unkeyed = keyFilterPlan(
			{ color: "#00ff00", type: "color" },
			{ colorkey: false }
		);
		expect(unkeyed.filters).toEqual([]);
		expect(unkeyed.issues).toEqual([
			"This FFmpeg build has no colorkey filter, so the clip renders unkeyed.",
		]);
		expect(
			keyCapabilityIssues({ color: "#00ff00", type: "chroma" }, {})
		).toEqual([]);
		expect(keyTypeAvailable("hsv", { hsvkey: false })).toBe(false);
		expect(keyTypeAvailable("luma", { hsvkey: false })).toBe(true);
	});
});

describe("reference key math", () => {
	test("ramp is hard without blend and linear with it", () => {
		expect(keyRamp(0.1, 0.2, 0)).toBe(0);
		expect(keyRamp(0.3, 0.2, 0)).toBe(1);
		expect(keyRamp(0.25, 0.2, 0.1)).toBeCloseTo(0.5, 6);
	});

	test("a green screen keys out and red stays opaque", () => {
		const key = { color: "#00ff00", type: "chroma" } as const;
		expect(keyedPixel(key, [0, 1, 0]).alpha).toBe(0);
		expect(keyedPixel(key, [1, 0, 0]).alpha).toBe(1);
		for (const type of ["color", "hsv"] as const) {
			const other = { color: "#00ff00", type };
			expect(keyedPixel(other, [0, 1, 0]).alpha).toBe(0);
			expect(keyedPixel(other, [1, 0, 0]).alpha).toBe(1);
		}
	});

	test("hue keys ignore brightness", () => {
		const key = resolvedKeyOf({ color: "#00ff00", type: "hsv" });
		expect(keyDistance(key, [0, 0.4, 0])).toBeLessThan(0.05);
		expect(
			keyedPixel({ color: "#00ff00", type: "hsv" }, [0, 0.4, 0]).alpha
		).toBe(0);
	});

	test("a red hue key keys red only", () => {
		const key = {
			blend: 0.1,
			color: "#ff0000",
			similarity: 0.1,
			type: "hsv",
		} as const;
		expect(keyedPixel(key, [1, 0, 0]).alpha).toBe(0);
		expect(keyedPixel(key, [0.6, 0, 0]).alpha).toBe(0);
		for (const pixel of [
			[0, 1, 0],
			[0, 0, 1],
			[1, 1, 0],
			[1, 0, 1],
			[1, 1, 1],
			[0.5, 0.5, 0.5],
			[20 / 255, 20 / 255, 20 / 255],
		] as const) {
			expect(keyedPixel(key, pixel).alpha).toBe(1);
		}
	});

	test("neutral pixels never key under a hue key (the grey gate)", () => {
		const neutrals = [
			[1, 1, 1],
			[0.5, 0.5, 0.5],
			[20 / 255, 20 / 255, 20 / 255],
			[0, 0, 0],
		] as const;
		for (const color of ["#00ff00", "#ff00ff", "#c03070", "#8000ff"]) {
			for (const pixel of neutrals) {
				expect(
					keyedPixel({ color, similarity: 1, type: "hsv" }, pixel).alpha
				).toBe(1);
			}
		}
		// Saturated pixels of the key hue still key, at any brightness.
		expect(keyedPixel({ color: "#ff00ff", type: "hsv" }, [1, 0, 1]).alpha).toBe(
			0
		);
	});

	test("luma keys compare limited-range luma like lumakey", () => {
		const key = {
			blend: 0.1,
			lumaHigh: 0.2,
			lumaLow: 0,
			type: "luma",
		} as const;
		expect(keyedPixel(key, [0, 0, 0]).alpha).toBe(0);
		// Y 71 against white 60 over a 21-level ramp.
		expect(keyedPixel(key, [0.25, 0.25, 0.25]).alpha).toBeCloseTo(11 / 21, 6);
		expect(keyedPixel(key, [1, 1, 1]).alpha).toBe(1);
		// The extremes of the band key pure white and pure black.
		expect(
			keyedPixel(
				{ blend: 0, lumaHigh: 1, lumaLow: 0.95, type: "luma" },
				[1, 1, 1]
			).alpha
		).toBe(0);
		expect(
			keyedPixel(
				{ blend: 0, lumaHigh: 0.05, lumaLow: 0, type: "luma" },
				[0, 0, 0]
			).alpha
		).toBe(0);
		expect(lumaKeyAlpha(100, { black: 90, soft: 0, white: 99 })).toBe(1);
	});

	test("spill pulls the key channel toward the others", () => {
		const key = { color: "#00ff00", spill: 1, type: "chroma" } as const;
		const { rgb } = keyedPixel(key, [0.6, 0.8, 0.4]);
		expect(rgb[1]).toBeCloseTo(0.5, 6);
		const half = keyedPixel({ ...key, spill: 0.5 }, [0.6, 0.8, 0.4]).rgb;
		expect(half[1]).toBeCloseTo(0.65, 6);
		const blue = keyedPixel(
			{ color: "#0000ff", spill: 1, type: "chroma" },
			[0.5, 0.5, 0.9]
		).rgb;
		expect(blue[2]).toBeCloseTo(0.5, 6);
	});
});

describe("cutout", () => {
	test("request defaults keep the background stable", () => {
		expect(cutoutRequestSchema.parse({ cleanPlateTime: 1 })).toEqual({
			blend: 0.05,
			cleanPlateTime: 1,
			similarity: 0.1,
			threshold: 0.5,
		});
		expect(
			cutoutRequestSchema.safeParse({ cleanPlateTime: 1, extra: true }).success
		).toBe(false);
		expect(cutoutRequestSchema.safeParse({ cleanPlateTime: -1 }).success).toBe(
			false
		);
	});

	test("backgroundkey options are stable", () => {
		expect(
			backgroundKeyFilter({ blend: 0.05, similarity: 0.1, threshold: 0.5 })
		).toBe("backgroundkey=threshold=0.5:similarity=0.1:blend=0.05");
	});

	test("only ProRes 4444 is written; VP9 is not offered", () => {
		expect(cutoutCodecFor({ prores_ks: true })).toBe("prores-4444");
		expect(() => cutoutCodecFor({ "libvpx-vp9": true })).toThrow("prores_ks");
		expect(
			cutoutRequestSchema.safeParse({ cleanPlateTime: 1, codec: "vp9" }).success
		).toBe(false);
	});

	test("the longest cutout shrinks with resolution and frame rate", () => {
		expect(cutoutMaxSeconds({ height: 360, width: 640 })).toBe(600);
		expect(cutoutMaxSeconds({ frameRate: 30, height: 1080, width: 1920 })).toBe(
			115
		);
		expect(cutoutMaxSeconds({ frameRate: 60, height: 1080, width: 1920 })).toBe(
			57
		);
		expect(cutoutMaxSeconds({ height: 2160, width: 3840 })).toBe(28);
		// The chunks plus the joined file fit the peak budget.
		const seconds = cutoutMaxSeconds({
			frameRate: 30,
			height: 1080,
			width: 1920,
		});
		expect(
			2 *
				cutoutOutputBytes({
					duration: seconds,
					frameRate: 30,
					height: 1080,
					width: 1920,
				})
		).toBeLessThanOrEqual(CUTOUT_PEAK_BYTES);
	});

	test("clean plate time follows the playhead inside the clip", () => {
		const clip = { sourceIn: 2, sourceOut: 6, speed: 2, start: 10 };
		expect(sourceTimeUnderPlayhead(clip, 11)).toBe(4);
		expect(sourceTimeUnderPlayhead(clip, 5)).toBe(2);
		expect(sourceTimeUnderPlayhead(clip, 30)).toBe(6);
	});
});
