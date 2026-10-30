import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
	hexToRgb,
	type Key,
	keyedPixel,
	keyFilterPlan,
} from "../../../shared/keying.ts";
import {
	type Asset,
	newProject,
	newSegment,
	type Segment,
	segmentSchema,
} from "../../../shared/project.ts";
import { mediaBinary } from "../media.ts";
import { segmentVideoFilters } from "../render-segment-video.ts";
import {
	keyFilterAvailability,
	keyFilters,
	setKeyFilterAvailability,
} from "./key.ts";

const video: Asset = {
	createdAt: "2026-01-01T00:00:00.000Z",
	duration: 4,
	hasAudio: false,
	height: 360,
	id: "00000000-0000-4000-8000-000000000001",
	kind: "video",
	name: "Screen",
	width: 640,
};

const keyed = (key: Segment["key"]): Segment =>
	segmentSchema.parse({ ...newSegment(video), key });

afterEach(() => setKeyFilterAvailability(undefined));

describe("keyFilters", () => {
	test("unkeyed clips add nothing", () => {
		setKeyFilterAvailability({});
		expect(keyFilters(newSegment(video))).toEqual([]);
	});

	test("each key type renders its FFmpeg filter", () => {
		setKeyFilterAvailability({});
		expect(keyFilters(keyed({ color: "#00ff00", type: "chroma" }))).toEqual([
			"format=yuva444p",
			"chromakey=color=0x913622:similarity=0.15:blend=0.08:yuv=1",
		]);
		expect(keyFilters(keyed({ color: "#0000ff", type: "color" }))).toEqual([
			"format=rgba",
			"colorkey=color=0x0000FF:similarity=0.2:blend=0.08",
		]);
		const hsv = keyed({ color: "#0000ff", type: "hsv" });
		const label = `key${hsv.id.replaceAll("-", "")}`;
		expect(keyFilters(hsv)).toEqual([
			"format=yuva444p",
			[
				`split=2[${label}h][${label}s]`,
				`[${label}h]hsvkey=hue=247.1582:sat=-1:val=-1:similarity=0.35:blend=0.08[${label}hk]`,
				`[${label}s]hsvkey=hue=1:sat=0:val=-1:similarity=0.03:blend=0.03[${label}sk]`,
				`[${label}hk][${label}sk]lut2=c0=x:c1=x:c2=x:c3='max(x,255-y)'`,
			].join(";"),
		]);
		expect(keyFilters(keyed({ type: "luma" }))).toEqual([
			"format=yuva444p",
			"lumakey=threshold=0.1057:tolerance=0.0449:softness=0.0687",
		]);
	});

	test("missing hsvkey and despill fall back instead of failing", () => {
		setKeyFilterAvailability({ despill: false, hsvkey: false });
		expect(
			keyFilters(keyed({ color: "#00ff00", spill: 0.5, type: "hsv" }))
		).toEqual([
			"format=yuva444p",
			"chromakey=color=0x913622:similarity=0.35:blend=0.08:yuv=1",
		]);
	});

	test("the real FFmpeg probe lists the key filters", () => {
		const probed = keyFilterAvailability();
		expect(probed.chromakey).toBe(true);
		expect(probed.lumakey).toBe(true);
	});
});

describe("key stage placement", () => {
	test("the key runs right after source timing, before color", () => {
		setKeyFilterAvailability({});
		const project = { ...newProject("Key"), height: 360, width: 640 };
		const s = keyed({ color: "#00ff00", spill: 0.4, type: "chroma" });
		const { filters } = segmentVideoFilters({
			base: "base",
			context: {
				inputIndex: (offset) => offset + 2,
				lutPath: () => "",
				mediaPath: () => "",
			},
			length: 4,
			n: 1,
			p: project,
			s,
			visualize: false,
		});
		const chain = filters[0] ?? "";
		expect(chain).toContain(
			`fps=${project.fps},format=yuva444p,chromakey=color=0x913622:similarity=0.15:blend=0.08:yuv=1,despill=type=green:mix=0.5:expand=0:green=-0.4:blue=0,`
		);
		expect(chain.indexOf("despill")).toBeLessThan(chain.indexOf("eq="));
	});
});

/** FFmpeg's alpha (0..255) for the centre of a solid `hex` frame under `key`. */
function ffmpegAlpha(key: Key, hex: string): number {
	const size = 16;
	const graph = `[0:v]format=rgb24,${keyFilterPlan(key).filters.join(",")},format=rgba[out]`;
	const result = spawnSync(
		mediaBinary("ffmpeg"),
		[
			"-hide_banner",
			"-v",
			"error",
			"-f",
			"lavfi",
			"-i",
			`color=c=0x${hex.slice(1)}:s=${size}x${size}`,
			"-filter_complex",
			graph,
			"-map",
			"[out]",
			"-frames:v",
			"1",
			"-f",
			"rawvideo",
			"-",
		],
		{ maxBuffer: 1024 * 1024 }
	);
	// The centre pixel: chromakey averages a 3×3 neighbourhood, and pixels
	// outside the frame count as the key colour at the edges.
	const centre = ((size / 2) * size + size / 2) * 4 + 3;
	const alpha = result.stdout?.[centre];
	if (result.status !== 0 || alpha === undefined) {
		throw new Error(`ffmpeg failed: ${String(result.stderr)}`);
	}
	return alpha;
}

describe("preview and export agree (real FFmpeg)", () => {
	const colors = [
		"#00ff00",
		"#ff0000",
		"#0000ff",
		"#ffff00",
		"#ff00ff",
		"#ffffff",
		"#808080",
		"#141414",
		"#000000",
		"#28c828",
		"#008000",
		"#00c864",
		"#7f8a7f",
		"#f0f0f0",
		"#3355ee",
		"#c03070",
	];
	const keys: Key[] = [
		{ color: "#00ff00", type: "chroma" },
		{ blend: 0.1, color: "#0000ff", similarity: 0.2, type: "chroma" },
		{ color: "#00ff00", type: "color" },
		{ color: "#00ff00", type: "hsv" },
		{ blend: 0.1, color: "#ff0000", similarity: 0.1, type: "hsv" },
		{ color: "#ff00ff", similarity: 0.25, type: "hsv" },
		{ color: "#ff00ff", similarity: 0.5, type: "hsv" },
		{ type: "luma" },
		{ blend: 0, lumaHigh: 1, lumaLow: 0.95, type: "luma" },
		{ blend: 0, lumaHigh: 0.05, lumaLow: 0, type: "luma" },
	];
	for (const key of keys) {
		test(`${key.type} ${key.color ?? ""} ${key.similarity ?? ""}`, () => {
			for (const color of colors) {
				const [r, g, b] = hexToRgb(color);
				const preview = Math.round(
					keyedPixel(key, [r / 255, g / 255, b / 255]).alpha * 255
				);
				// Swscale's RGB→YUV rounding differs by a level, which moves a
				// pixel a few steps along a soft ramp; hard edges agree.
				expect({
					color,
					delta: Math.abs(ffmpegAlpha(key, color) - preview) <= 16,
				}).toEqual({ color, delta: true });
			}
		});
	}

	test("a red hue key keeps every other colour and grey in the export", () => {
		const key: Key = {
			blend: 0.1,
			color: "#ff0000",
			similarity: 0.1,
			type: "hsv",
		};
		expect(ffmpegAlpha(key, "#ff0000")).toBe(0);
		for (const color of ["#00ff00", "#ffffff", "#0000ff", "#141414"]) {
			expect(ffmpegAlpha(key, color)).toBe(255);
		}
	});

	test("a magenta hue key keeps white, grey and black in the export", () => {
		const key: Key = { color: "#ff00ff", similarity: 0.25, type: "hsv" };
		expect(ffmpegAlpha(key, "#ff00ff")).toBe(0);
		for (const color of ["#ffffff", "#808080", "#141414", "#000000"]) {
			expect(ffmpegAlpha(key, color)).toBe(255);
		}
	});

	test("luma bands at the extremes key pure white and pure black", () => {
		expect(
			ffmpegAlpha(
				{ blend: 0, lumaHigh: 1, lumaLow: 0.95, type: "luma" },
				"#ffffff"
			)
		).toBe(0);
		expect(
			ffmpegAlpha(
				{ blend: 0, lumaHigh: 0.05, lumaLow: 0, type: "luma" },
				"#000000"
			)
		).toBe(0);
	});
});
