import { describe, expect, test } from "bun:test";
import {
	analysisSize,
	applySmoothSlowMotion,
	assertDerivableVideo,
	assertInterpolationBounds,
	boundedInterpolationFilter,
	cumulativeTrajectory,
	type DerivativeFilterSupport,
	defaultInterpolateMode,
	derivationOf,
	derivativeLabel,
	derivativeName,
	displayedSize,
	downsampleFrame,
	enhanceUpscaleFilter,
	estimateTranslation,
	findDerivative,
	type GrayFrame,
	interpolateFilter,
	interpolateRequestSchema,
	interpolationRoot,
	planSmoothSlowMotion,
	smoothSlowMotionFps,
	smoothSlowMotionRequestSchema,
	smoothTrajectory,
	stabilizeCorrections,
	stabilizeCropCommands,
	stabilizeCropWindow,
	stabilizeMethod,
	stabilizeRequestSchema,
	translateAnalysisFilter,
	translateApplyFilter,
	vidstabDetectFilter,
	vidstabTransformFilter,
} from "./derivatives.ts";
import { type Asset, newProject, type Segment } from "./project.ts";
import {
	upscaleDimensions,
	upscaleEdgeLimit,
	upscaleRequestSchema,
} from "./upscale.ts";

const full: DerivativeFilterSupport = {
	cas: true,
	minterpolate: true,
	nlmeans: true,
	vidstab: true,
};
const bare: DerivativeFilterSupport = {
	cas: false,
	minterpolate: false,
	nlmeans: false,
	vidstab: false,
};

/** Deterministic textured frame: smooth blobs plus hashed detail. */
function texture(width: number, height: number, offsetX = 0, offsetY = 0) {
	const data = new Uint8Array(width * height);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const u = x - offsetX;
			const v = y - offsetY;
			const value =
				128 +
				60 * Math.sin(u * 0.21) * Math.cos(v * 0.17) +
				40 * Math.sin((u + 2 * v) * 0.09);
			data[y * width + x] = Math.max(0, Math.min(255, Math.round(value)));
		}
	}
	return { data, height, width } satisfies GrayFrame;
}

function asset(overrides: Partial<Asset> = {}): Asset {
	return {
		createdAt: "2026-01-01T00:00:00.000Z",
		duration: 10,
		frameRate: 30,
		hasAudio: true,
		height: 720,
		id: crypto.randomUUID(),
		kind: "video",
		name: "Shot",
		width: 1280,
		...overrides,
	} as Asset;
}

function clipOn(source: Asset, overrides: Partial<Segment> = {}) {
	const project = newProject();
	const clip = {
		assetId: source.id,
		brightness: 0,
		contrast: 1,
		fadeIn: 0,
		fadeOut: 0,
		id: crypto.randomUUID(),
		opacity: 1,
		saturation: 1,
		scale: 1,
		sourceIn: 1,
		sourceOut: 3,
		speed: 0.5,
		start: 0,
		track: 0,
		volume: 1,
		x: 0,
		y: 0,
		effects: [],
		...overrides,
	};
	return {
		clip,
		project: { ...project, segments: [clip] } as unknown as typeof project,
	};
}

describe("request schemas", () => {
	test("stabilize defaults to medium and stays strict", () => {
		expect(stabilizeRequestSchema.parse({})).toEqual({ level: "medium" });
		expect(() => stabilizeRequestSchema.parse({ level: "max" })).toThrow();
		expect(() => stabilizeRequestSchema.parse({ zoom: 2 })).toThrow();
	});
	test("interpolate bounds the target rate", () => {
		expect(interpolateRequestSchema.parse({ fps: 60 })).toEqual({ fps: 60 });
		expect(() => interpolateRequestSchema.parse({ fps: 0 })).toThrow();
		expect(() => interpolateRequestSchema.parse({ fps: 241 })).toThrow();
		expect(() => interpolateRequestSchema.parse({})).toThrow();
	});
	test("smooth slow motion needs a clip and revision", () => {
		expect(() =>
			smoothSlowMotionRequestSchema.parse({ clipId: crypto.randomUUID() })
		).toThrow();
	});
	test("upscale accepts enhance and lifts the edge only when enhancing", () => {
		expect(upscaleRequestSchema.parse({ enhance: true })).toEqual({
			enhance: true,
			factor: 2,
		});
		expect(upscaleEdgeLimit(undefined)).toBe(3840);
		expect(upscaleEdgeLimit(true)).toBe(8192);
		expect(upscaleDimensions(3000, 2000, 4, upscaleEdgeLimit(true))).toEqual({
			height: 5460,
			width: 8192,
		});
		expect(upscaleDimensions(3000, 2000, 4)).toEqual({
			height: 2560,
			width: 3840,
		});
	});
});

describe("stabilize argument builders", () => {
	test("method follows libvidstab availability", () => {
		expect(stabilizeMethod(full)).toBe("vidstab");
		expect(stabilizeMethod(bare)).toBe("translate");
	});
	test("vidstab passes carry the level's smoothing and zoom", () => {
		expect(vidstabDetectFilter("low")).toBe(
			"vidstabdetect=shakiness=4:accuracy=15:result=transforms.trf"
		);
		expect(vidstabTransformFilter("low")).toBe(
			"vidstabtransform=input=transforms.trf:smoothing=10:zoom=8:optzoom=0:interpol=bicubic"
		);
		expect(vidstabTransformFilter("medium")).toContain("smoothing=20:zoom=12");
		expect(vidstabTransformFilter("high")).toContain("smoothing=30:zoom=16");
	});
	test("analysis frames are small, even and source-bounded", () => {
		expect(analysisSize(1920, 1080)).toEqual({ height: 90, width: 160 });
		expect(analysisSize(99, 51)).toEqual({ height: 50, width: 98 });
		expect(() => analysisSize(0, 0)).toThrow();
	});
	test("crop window zooms by the level margin", () => {
		expect(stabilizeCropWindow(640, 360, "medium")).toEqual({
			height: 318,
			marginX: 38,
			marginY: 21,
			width: 564,
		});
	});
	test("tracker filters force a constant rate and drive crop by sendcmd", () => {
		expect(translateAnalysisFilter(29.97, { height: 90, width: 160 })).toBe(
			"setpts=PTS-STARTPTS,fps=30000/1001,scale=160:90:flags=area,format=gray"
		);
		expect(
			translateApplyFilter({
				fps: 30,
				height: 360,
				level: "medium",
				width: 640,
			})
		).toBe(
			"setpts=PTS-STARTPTS,fps=30,format=yuv444p,sendcmd=f=crop.cmd,crop=w=564:h=318:x=38:y=21:exact=1,scale=640:360:flags=lanczos,format=yuv420p"
		);
	});
	test("crop commands invert the correction and skip repeats", () => {
		const text = stabilizeCropCommands(
			[
				{ x: 0, y: 0 },
				{ x: 0, y: 0 },
				{ x: 2, y: -1 },
				{ x: 100, y: -100 },
			],
			{ fps: 10, marginX: 10, marginY: 8, scale: 2 }
		);
		expect(text).toBe(
			"0.000000 crop x 10, crop y 8;\n0.175000 crop x 6, crop y 10;\n0.275000 crop x 0, crop y 16;\n"
		);
	});
});

describe("motion tracking", () => {
	test("downsampling averages 2x2 blocks", () => {
		const frame = { data: Uint8Array.from([0, 4, 8, 12]), height: 1, width: 4 };
		expect(downsampleFrame(frame).width).toBe(2);
		const square = {
			data: Uint8Array.from([0, 4, 8, 12, 0, 4, 8, 12]),
			height: 2,
			width: 4,
		};
		expect([...downsampleFrame(square).data]).toEqual([2, 10]);
	});
	test("estimates integer and sub-pixel translation", () => {
		const base = texture(160, 90);
		for (const [dx, dy] of [
			[0, 0],
			[3, -2],
			[-7, 5],
			[12, 9],
		] as const) {
			const moved = texture(160, 90, dx, dy);
			const found = estimateTranslation(base, moved, 20);
			expect(Math.abs(found.x - dx)).toBeLessThan(0.35);
			expect(Math.abs(found.y - dy)).toBeLessThan(0.35);
		}
		const half = estimateTranslation(base, texture(160, 90, 2.5, -1.5), 20);
		expect(Math.abs(half.x - 2.5)).toBeLessThan(0.35);
		expect(Math.abs(half.y + 1.5)).toBeLessThan(0.35);
	});
	test("a flat frame reads as still", () => {
		const flat = {
			data: new Uint8Array(64 * 36).fill(90),
			height: 36,
			width: 64,
		};
		expect(estimateTranslation(flat, flat, 8)).toEqual({ x: 0, y: 0 });
	});
	test("refuses frames of different sizes", () => {
		expect(() =>
			estimateTranslation(texture(64, 36), texture(66, 36), 4)
		).toThrow();
	});
	test("trajectory, smoothing and clamped corrections", () => {
		const motions = [
			{ x: 9, y: 9 },
			{ x: 2, y: 0 },
			{ x: -2, y: 1 },
			{ x: 2, y: -1 },
		];
		expect(cumulativeTrajectory(motions)).toEqual([
			{ x: 0, y: 0 },
			{ x: 2, y: 0 },
			{ x: 0, y: 1 },
			{ x: 2, y: 0 },
		]);
		const smooth = smoothTrajectory(cumulativeTrajectory(motions), 1);
		expect(smooth[0]).toEqual({ x: 2 / 3, y: 0 });
		expect(smooth[1]).toEqual({ x: 2 / 3, y: 1 / 3 });
		const corrections = stabilizeCorrections(motions, 1, { x: 1, y: 0.25 });
		expect(corrections[1]).toEqual({ x: -1, y: 0.25 });
		expect(corrections[2]).toEqual({ x: 1, y: -0.25 });
	});
	test("a steady pan is preserved while jitter is removed", () => {
		const motions = Array.from({ length: 41 }, (_value, index) => ({
			x: index === 0 ? 0 : 1 + (index % 2 ? 3 : -3),
			y: 0,
		}));
		const corrections = stabilizeCorrections(motions, 10, { x: 50, y: 50 });
		const path = cumulativeTrajectory(motions);
		const stabilized = path.map(
			(point, index) => point.x + (corrections[index]?.x ?? 0)
		);
		const steps = stabilized
			.slice(12, 28)
			.map((value, index) => value - (stabilized[11 + index] ?? 0));
		for (const step of steps) {
			expect(Math.abs(step - 1)).toBeLessThan(0.35);
		}
	});
});

describe("displayed frame size", () => {
	test("odd quarter turns swap the coded size", () => {
		expect(displayedSize(320, 180, 90)).toEqual({ height: 320, width: 180 });
		expect(displayedSize(320, 180, -90)).toEqual({ height: 320, width: 180 });
		expect(displayedSize(320, 180, 270)).toEqual({ height: 320, width: 180 });
	});
	test("no rotation, half turns and junk keep the coded size", () => {
		expect(displayedSize(320, 180)).toEqual({ height: 180, width: 320 });
		expect(displayedSize(320, 180, 180)).toEqual({ height: 180, width: 320 });
		expect(displayedSize(320, 180, Number.NaN)).toEqual({
			height: 180,
			width: 320,
		});
	});
	test("the tracker crop fits a rotated frame", () => {
		const frame = displayedSize(320, 180, 90);
		const crop = stabilizeCropWindow(frame.width, frame.height, "medium");
		expect(crop.width).toBeLessThanOrEqual(frame.width);
		expect(crop.height).toBeLessThanOrEqual(frame.height);
	});
});

describe("interpolation", () => {
	test("bounded interpolation pads the tail and trims to the source", () => {
		expect(
			boundedInterpolationFilter("minterpolate=fps=30", {
				duration: 2,
				fps: 10,
			})
		).toBe(
			"tpad=stop_mode=clone:stop_duration=0.200000,minterpolate=fps=30,trim=duration=2.000000"
		);
		expect(() =>
			boundedInterpolationFilter("framerate=fps=30", { duration: 0, fps: 10 })
		).toThrow("measured video duration");
	});

	test("optical flow uses minterpolate when available", () => {
		expect(interpolateFilter(60, "optical-flow", full)).toEqual({
			filter: "minterpolate=fps=60:mi_mode=mci:mc_mode=aobmc:vsbmc=1",
			method: "minterpolate",
			mode: "optical-flow",
		});
	});
	test("optical flow falls back to blending without minterpolate", () => {
		expect(interpolateFilter(59.94, "optical-flow", bare)).toEqual({
			filter: "framerate=fps=60000/1001",
			method: "framerate",
			mode: "blend",
		});
		expect(interpolateFilter(48, "blend", full).method).toBe("framerate");
	});
	test("default mode follows capability", () => {
		expect(defaultInterpolateMode(full)).toBe("optical-flow");
		expect(defaultInterpolateMode(bare)).toBe("blend");
	});
	test("bounds duration and synthesized frames", () => {
		expect(() => assertInterpolationBounds(10, 120)).not.toThrow();
		expect(() => assertInterpolationBounds(601, 30)).toThrow();
		expect(() => assertInterpolationBounds(600, 240)).toThrow();
		expect(() => assertInterpolationBounds(0, 30)).toThrow();
	});
	test("smooth slow motion targets project fps over speed", () => {
		expect(smoothSlowMotionFps(30, 0.5)).toBe(60);
		expect(smoothSlowMotionFps(24, 0.3)).toBe(80);
		expect(smoothSlowMotionFps(30, 0.1)).toBe(240);
		expect(smoothSlowMotionFps(29.97, 0.25)).toBe(120);
		expect(() => smoothSlowMotionFps(30, 0)).toThrow();
	});
});

describe("smooth slow motion plan and swap", () => {
	test("plans from the clip's interpolation mode", () => {
		const source = asset();
		const { clip, project } = clipOn(source, { frameInterpolation: "blend" });
		const plan = planSmoothSlowMotion(project, [source], { clipId: clip.id });
		expect(plan).toMatchObject({ fps: 60, mode: "blend" });
		expect(plan.source.id).toBe(source.id);
	});
	test("requires slow speed, a mode and enough missing frames", () => {
		const source = asset();
		const fast = clipOn(source, { frameInterpolation: "blend", speed: 1 });
		expect(() =>
			planSmoothSlowMotion(fast.project, [source], { clipId: fast.clip.id })
		).toThrow("slower than 1x");
		const none = clipOn(source, { frameInterpolation: "none" });
		expect(() =>
			planSmoothSlowMotion(none.project, [source], { clipId: none.clip.id })
		).toThrow("Choose blend");
		const highRate = asset({ frameRate: 120 });
		const enough = clipOn(highRate);
		expect(() =>
			planSmoothSlowMotion(enough.project, [highRate], {
				clipId: enough.clip.id,
				mode: "optical-flow",
			})
		).toThrow("already has 120 fps");
		const still = asset({ kind: "image" });
		const image = clipOn(still);
		expect(() =>
			planSmoothSlowMotion(image.project, [still], {
				clipId: image.clip.id,
				mode: "blend",
			})
		).toThrow("video clips");
	});
	test("re-plans from the original when the clip already uses a derivative", () => {
		const source = asset();
		const derivative = asset({
			derivation: "interpolate",
			derivedFromAssetId: source.id,
			frameRate: 60,
		});
		expect(interpolationRoot(derivative, [source, derivative]).id).toBe(
			source.id
		);
		const { clip, project } = clipOn(derivative, { speed: 0.25 });
		const plan = planSmoothSlowMotion(project, [source, derivative], {
			clipId: clip.id,
			mode: "optical-flow",
		});
		expect(plan).toMatchObject({ fps: 120, mode: "optical-flow" });
		expect(plan.source.id).toBe(source.id);
	});
	test("swaps media and keeps speed and source range", () => {
		const source = asset();
		const derivative = asset({
			derivation: "interpolate",
			derivedFromAssetId: source.id,
			duration: 9.98,
			frameRate: 60,
		});
		const { clip, project } = clipOn(source, { sourceOut: 10 });
		const next = applySmoothSlowMotion(project, [source, derivative], {
			assetId: derivative.id,
			clipId: clip.id,
			mode: "blend",
		});
		expect(next.segments[0]).toMatchObject({
			assetId: derivative.id,
			frameInterpolation: "blend",
			sourceIn: 1,
			sourceOut: 9.98,
			speed: 0.5,
		});
	});
	test("refuses an unrelated derivative", () => {
		const source = asset();
		const other = asset({
			derivation: "interpolate",
			derivedFromAssetId: crypto.randomUUID(),
		});
		const { clip, project } = clipOn(source);
		expect(() =>
			applySmoothSlowMotion(project, [source, other], {
				assetId: other.id,
				clipId: clip.id,
				mode: "blend",
			})
		).toThrow("does not belong");
	});
	test("refuses locked tracks", () => {
		const source = asset();
		const { clip, project } = clipOn(source, { frameInterpolation: "blend" });
		const locked = {
			...project,
			trackSettings: [{ track: 0, locked: true }],
		} as typeof project;
		expect(() =>
			planSmoothSlowMotion(locked, [source], { clipId: clip.id })
		).toThrow("Unlock");
	});
});

describe("enhance filter", () => {
	test("denoise, Lanczos, then sharpen", () => {
		expect(
			enhanceUpscaleFilter({ height: 720, width: 1280 }, "video", full)
		).toBe("hqdn3d=2:1.5:4:3,scale=1280:720:flags=lanczos,cas=strength=0.5");
		expect(enhanceUpscaleFilter({ height: 8, width: 16 }, "image", full)).toBe(
			"nlmeans=s=1.5:p=7:r=9,scale=16:8:flags=lanczos,cas=strength=0.5"
		);
		expect(enhanceUpscaleFilter({ height: 8, width: 16 }, "image", bare)).toBe(
			"hqdn3d=2:1.5:4:3,scale=16:8:flags=lanczos,unsharp=5:5:0.8:5:5:0.0"
		);
	});
});

describe("derivative metadata", () => {
	test("derivations, labels and names", () => {
		expect(derivationOf({ kind: "stabilize", level: "high" })).toBe(
			"stabilize"
		);
		expect(derivationOf({ fps: 60, kind: "interpolate", mode: "blend" })).toBe(
			"interpolate"
		);
		expect(derivationOf({ factor: 2, kind: "enhance" })).toBe("enhance");
		expect(
			derivativeLabel({ fps: 59.94, kind: "interpolate", mode: "optical-flow" })
		).toBe("59.94 fps optical flow");
		expect(derivativeName("Clip", { kind: "stabilize", level: "low" })).toBe(
			"Clip · stabilized (low)"
		);
		expect(
			derivativeName("x".repeat(300), { factor: 4, kind: "enhance" }).length
		).toBeLessThanOrEqual(200);
	});
	test("finds a reusable derivative by source, derivation and label", () => {
		const source = asset();
		const stabilized = asset({
			derivation: "stabilize",
			derivedFromAssetId: source.id,
			name: "Shot · stabilized (medium)",
		});
		const assets = [source, stabilized];
		expect(
			findDerivative(assets, source.id, { kind: "stabilize", level: "medium" })
				?.id
		).toBe(stabilized.id);
		expect(
			findDerivative(assets, source.id, { kind: "stabilize", level: "high" })
		).toBeUndefined();
		expect(
			findDerivative(assets, crypto.randomUUID(), {
				kind: "stabilize",
				level: "medium",
			})
		).toBeUndefined();
	});
	test("derivable video excludes stills, sequences, proxies and long media", () => {
		expect(() => assertDerivableVideo(asset(), "stabilized")).not.toThrow();
		expect(() =>
			assertDerivableVideo(asset({ kind: "audio" }), "stabilized")
		).toThrow();
		expect(() =>
			assertDerivableVideo(
				asset({ sequenceProjectId: crypto.randomUUID() }),
				"stabilized"
			)
		).toThrow();
		expect(() =>
			assertDerivableVideo(asset({ derivation: "proxy" }), "stabilized")
		).toThrow();
		expect(() =>
			assertDerivableVideo(asset({ duration: 601 }), "stabilized")
		).toThrow();
	});
});
