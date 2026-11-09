import { describe, expect, test } from "bun:test";
import {
	LOTTIE_MAX_CHUNK_CHARS,
	LOTTIE_MAX_CHUNK_FRAMES,
	LOTTIE_MAX_JSON_BYTES,
	lottieChunkFull,
	lottieFrameRateArgument,
	lottieFramesRequestSchema,
	lottieOutputSize,
	lottiePlayerFrame,
	lottieSourceFrame,
	parseLottieDocument,
	planLottieImport,
} from "./lottie.ts";

const documentText = (overrides: Record<string, unknown> = {}) =>
	JSON.stringify({
		fr: 60,
		h: 512,
		ip: 0,
		layers: [],
		op: 120,
		v: "5.7.4",
		w: 512,
		...overrides,
	});

const meta = {
	fps: 30,
	frameCount: 60,
	height: 512,
	name: "Spinner",
	width: 512,
};

describe("Lottie documents", () => {
	test("parses the fields the import needs and keeps the rest", () => {
		const parsed = parseLottieDocument(documentText({ nm: "Spinner" }));
		expect(parsed).toMatchObject({ fr: 60, op: 120, w: 512, nm: "Spinner" });
	});

	test("refuses invalid, empty, oversized and network-dependent documents", () => {
		expect(() => parseLottieDocument("{")).toThrow("not valid Lottie JSON");
		expect(() => parseLottieDocument("{}")).toThrow("not a Lottie animation");
		expect(() => parseLottieDocument(documentText({ op: 0 }))).toThrow(
			"no frames"
		);
		expect(() =>
			parseLottieDocument(" ".repeat(LOTTIE_MAX_JSON_BYTES + 1))
		).toThrow("5 MB");
		expect(() =>
			parseLottieDocument(
				documentText({
					assets: [{ id: "image_0", p: "img.png", u: "images/", w: 10, h: 10 }],
				})
			)
		).toThrow("external images");
		expect(() =>
			parseLottieDocument(
				documentText({
					fonts: { list: [{ fName: "Inter", fPath: "https://fonts.example" }] },
				})
			)
		).toThrow("remote fonts");
		// Embedded images and precomposition assets are fine.
		expect(
			parseLottieDocument(
				documentText({
					assets: [
						{ id: "comp_0", layers: [] },
						{ e: 1, id: "image_0", p: "data:image/png;base64,AAAA", u: "" },
					],
				})
			).assets
		).toHaveLength(2);
	});
});

describe("Lottie import plans", () => {
	test("retimes to the project frame rate and fits 1920 px with even edges", () => {
		const plan = planLottieImport(
			{ fr: 60, h: 1081, ip: 0, op: 120, w: 3841 },
			30
		);
		expect(plan).toEqual({
			duration: 2,
			fps: 30,
			frameCount: 60,
			height: 540,
			inPoint: 0,
			outPoint: 120,
			sourceFps: 60,
			width: 1920,
		});
		expect(lottieSourceFrame(plan, 0)).toBe(0);
		expect(lottieSourceFrame(plan, 1)).toBe(2);
		// Never past the last real frame.
		expect(lottieSourceFrame(plan, 60)).toBe(119);
	});

	test("player frames count from the in point, as lottie-web's goToAndStop does", () => {
		const plan = planLottieImport(
			{ fr: 30, h: 100, ip: 30, op: 90, w: 100 },
			30
		);
		const frames = [0, 30, 59].map((index) => lottieSourceFrame(plan, index));
		expect(frames).toEqual([30, 60, 89]);
		expect(
			frames.map((frame) => lottiePlayerFrame(plan.inPoint, frame))
		).toEqual([0, 30, 59]);
		// lottie-web draws `value + round(ip)`; never ask for a negative value.
		expect(lottiePlayerFrame(0.6, 0.6)).toBe(0);
		expect(lottiePlayerFrame(0, 12.5)).toBe(12.5);
	});

	test("small canvases are kept and rounded to even pixels", () => {
		expect(lottieOutputSize(301, 199)).toEqual({ height: 200, width: 302 });
		expect(lottieOutputSize(1, 1)).toEqual({ height: 2, width: 2 });
		expect(lottieOutputSize(1080, 1920)).toEqual({ height: 1920, width: 1080 });
	});

	test("refuses animations longer than 600 output frames", () => {
		expect(() =>
			planLottieImport({ fr: 30, h: 10, ip: 0, op: 601, w: 10 }, 30)
		).toThrow("limit is 600");
		expect(
			planLottieImport({ fr: 30, h: 10, ip: 0, op: 600, w: 10 }, 30).frameCount
		).toBe(600);
		expect(() =>
			planLottieImport({ fr: 30, h: 10, ip: 0, op: 10, w: 10 }, 0)
		).toThrow("frame rate");
	});

	test("NTSC frame rates are rational for FFmpeg", () => {
		expect(lottieFrameRateArgument(30)).toBe("30");
		expect(lottieFrameRateArgument(29.97)).toBe("30000/1001");
		expect(lottieFrameRateArgument(59.94)).toBe("60000/1001");
		expect(lottieFrameRateArgument(23.976)).toBe("24000/1001");
	});
});

describe("Lottie frame chunks", () => {
	test("a chunk closes at 50 frames or the byte budget, never empty", () => {
		expect(
			lottieChunkFull({ chars: 0, frames: 0 }, LOTTIE_MAX_CHUNK_CHARS)
		).toBe(false);
		expect(
			lottieChunkFull({ chars: 10, frames: LOTTIE_MAX_CHUNK_FRAMES }, 1)
		).toBe(true);
		expect(
			lottieChunkFull({ chars: LOTTIE_MAX_CHUNK_CHARS - 5, frames: 3 }, 6)
		).toBe(true);
		expect(
			lottieChunkFull({ chars: LOTTIE_MAX_CHUNK_CHARS - 5, frames: 3 }, 5)
		).toBe(false);
	});

	test("the request schema enforces order metadata and size", () => {
		const sessionId = crypto.randomUUID();
		const first = { frames: ["iVBORw0KGgo="], index: 0, meta, sessionId };
		expect(lottieFramesRequestSchema.safeParse(first).success).toBe(true);
		const { meta: _meta, ...withoutMeta } = first;
		expect(lottieFramesRequestSchema.safeParse(withoutMeta).success).toBe(
			false
		);
		expect(
			lottieFramesRequestSchema.safeParse({ ...first, index: 1 }).success
		).toBe(false);
		expect(
			lottieFramesRequestSchema.safeParse({ ...withoutMeta, index: 1 }).success
		).toBe(true);
		expect(
			lottieFramesRequestSchema.safeParse({ ...first, frames: [] }).success
		).toBe(false);
		expect(
			lottieFramesRequestSchema.safeParse({ ...first, frames: ["not base64!"] })
				.success
		).toBe(false);
		expect(
			lottieFramesRequestSchema.safeParse({
				...first,
				frames: Array.from({ length: 51 }, () => "AAAA"),
			}).success
		).toBe(false);
		expect(
			lottieFramesRequestSchema.safeParse({
				...first,
				frames: ["A".repeat(800_000), "A".repeat(800_000)],
			}).success
		).toBe(false);
		expect(
			lottieFramesRequestSchema.safeParse({
				...withoutMeta,
				frames: ["AAAA", "AAAA"],
				index: 599,
			}).success
		).toBe(false);
		expect(
			lottieFramesRequestSchema.safeParse({
				...first,
				meta: { ...meta, width: 513 },
			}).success
		).toBe(false);
	});
});
