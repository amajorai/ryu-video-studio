import { describe, expect, test } from "bun:test";
import {
	ffmpegFrameRate,
	fpsRational,
	fpsValue,
	frameDuration,
	frameQuantize,
	frameRateLabel,
	framesToTime,
	nominalFrameRate,
	PROJECT_FRAME_RATES,
	parseProbeFrameRate,
	projectFpsForRate,
	rationalFrameTime,
	sameFrameRate,
	timeToFrames,
} from "./frame-rate.ts";
import { projectFpsSchema } from "./project.ts";

describe("fpsRational", () => {
	test.each([
		[23.976, 24_000, 1001, true],
		[24, 24, 1, false],
		[25, 25, 1, false],
		[29.97, 30_000, 1001, true],
		[30, 30, 1, false],
		[48, 48, 1, false],
		[50, 50, 1, false],
		[59.94, 60_000, 1001, true],
		[60, 60, 1, false],
		[120, 120, 1, false],
	] as const)("%p fps is %p/%p", (fps, num, den, ntsc) => {
		expect(fpsRational(fps)).toEqual({ den, ntsc, num });
	});

	test("recognises other NTSC rates and rounded labels", () => {
		expect(fpsRational(47.952)).toEqual({ den: 1001, ntsc: true, num: 48_000 });
		expect(fpsRational(119.88)).toEqual({
			den: 1001,
			ntsc: true,
			num: 120_000,
		});
		expect(fpsRational(29.970_03)).toEqual(fpsRational(29.97));
	});

	test("non-NTSC decimals become the closest small fraction", () => {
		expect(fpsRational(12.5)).toEqual({ den: 2, ntsc: false, num: 25 });
		expect(fpsRational(7.5)).toEqual({ den: 2, ntsc: false, num: 15 });
	});

	test("rejects rates that are not positive and finite", () => {
		for (const bad of [0, -24, Number.NaN, Number.POSITIVE_INFINITY, 5000]) {
			expect(() => fpsRational(bad)).toThrow("not a positive rate");
		}
	});

	test("every project rate in the menu is a schema rate", () => {
		for (const fps of PROJECT_FRAME_RATES) {
			expect(projectFpsSchema.safeParse(fps).success).toBe(true);
		}
		expect(PROJECT_FRAME_RATES).toHaveLength(10);
	});
});

describe("FFmpeg and interchange forms", () => {
	test("integer rates stay plain so existing render arguments are unchanged", () => {
		expect(ffmpegFrameRate(30)).toBe("30");
		expect(ffmpegFrameRate(24)).toBe("24");
		expect(ffmpegFrameRate(29.97)).toBe("30000/1001");
		expect(ffmpegFrameRate(23.976)).toBe("24000/1001");
		expect(ffmpegFrameRate(59.94)).toBe("60000/1001");
	});

	test("nominal timebase and frame duration", () => {
		expect(nominalFrameRate(23.976)).toBe(24);
		expect(nominalFrameRate(29.97)).toBe(30);
		expect(nominalFrameRate(59.94)).toBe(60);
		expect(nominalFrameRate(50)).toBe(50);
		expect(frameDuration(29.97)).toBe(1001 / 30_000);
		expect(frameDuration(25)).toBe(0.04);
		expect(fpsValue(29.97)).toBe(30_000 / 1001);
	});

	test("rational frame times share the frameDuration denominator", () => {
		expect(rationalFrameTime(0, 29.97)).toBe("0s");
		expect(rationalFrameTime(1, 29.97)).toBe("1001/30000s");
		expect(rationalFrameTime(30, 29.97)).toBe("30030/30000s");
		expect(rationalFrameTime(48, 24)).toBe("48/24s");
		expect(() => rationalFrameTime(-1, 30)).toThrow("non-negative");
		expect(() => rationalFrameTime(1.5, 30)).toThrow("non-negative");
	});

	test("labels mark NTSC rates", () => {
		expect(frameRateLabel(29.97)).toBe("29.97 fps (NTSC)");
		expect(frameRateLabel(30)).toBe("30 fps");
	});
});

describe("frame quantization", () => {
	test("frames and seconds round-trip on the NTSC grid", () => {
		expect(timeToFrames(1, 29.97)).toBe(30);
		expect(timeToFrames(1001 / 30_000, 29.97)).toBe(1);
		expect(framesToTime(30, 29.97)).toBe(1.001);
		expect(framesToTime(24, 23.976)).toBe(1.001);
		for (let frame = 0; frame < 2000; frame += 37) {
			expect(timeToFrames(framesToTime(frame, 59.94), 59.94)).toBe(frame);
		}
	});

	test("ceil and floor ignore float noise", () => {
		expect(timeToFrames(0.1, 30, "ceil")).toBe(3);
		expect(timeToFrames(0.1, 30, "floor")).toBe(3);
		expect(timeToFrames(0.11, 30, "floor")).toBe(3);
		expect(timeToFrames(0.11, 30, "ceil")).toBe(4);
		expect(timeToFrames(-1, 30)).toBe(0);
	});

	test("frameQuantize snaps to the nearest frame start", () => {
		expect(frameQuantize(1, 29.97)).toBe(1.001);
		expect(frameQuantize(0.52, 25)).toBe(0.52);
		expect(frameQuantize(0.53, 25)).toBe(0.52);
		expect(frameQuantize(0.53, 25, "ceil")).toBe(0.56);
	});

	test("same grid comparisons", () => {
		expect(sameFrameRate(29.97, 29.970_03)).toBe(true);
		expect(sameFrameRate(29.97, 30)).toBe(false);
		expect(sameFrameRate(24, 24)).toBe(true);
	});
});

describe("probe rates", () => {
	test("parses FFprobe fractions into stored media rates", () => {
		expect(parseProbeFrameRate("30000/1001")).toBe(29.97);
		expect(parseProbeFrameRate("24000/1001")).toBe(23.976);
		expect(parseProbeFrameRate("60000/1001")).toBe(59.94);
		expect(parseProbeFrameRate("25/1")).toBe(25);
		expect(parseProbeFrameRate("30")).toBe(30);
	});

	test("rejects missing, zero and out-of-range rates", () => {
		for (const value of [
			undefined,
			"",
			"0/0",
			"30/0",
			"90000/1",
			"1/2",
			"abc",
			"-30/1",
			"30.5/1",
		]) {
			expect(parseProbeFrameRate(value)).toBeUndefined();
		}
	});

	test("maps measured rates to project rates within 0.01 fps", () => {
		expect(projectFpsForRate(29.97)).toBe(29.97);
		expect(projectFpsForRate(29.970_03)).toBe(29.97);
		expect(projectFpsForRate(23.976)).toBe(23.976);
		expect(projectFpsForRate(25)).toBe(25);
		expect(projectFpsForRate(119.88)).toBeUndefined();
		expect(projectFpsForRate(15)).toBeUndefined();
		expect(projectFpsForRate(0)).toBeUndefined();
		expect(projectFpsForRate(Number.NaN)).toBeUndefined();
	});
});
