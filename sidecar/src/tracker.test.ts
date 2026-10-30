import { describe, expect, test } from "bun:test";
import {
	analysisFps,
	analysisSize,
	downsample,
	fromLevel,
	type GrayImage,
	LOST_CONFIDENCE,
	MAX_TRACK_FRAMES,
	ncc,
	normalizePatch,
	regionToPixels,
	samplePatch,
	TemplateTracker,
	toLevel,
	trackFrames,
} from "./tracker.ts";

/** Deterministic PRNG (mulberry32). */
function random(seed: number) {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d_2b_79_f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
	};
}

/** A smooth random texture: bilinear interpolation of a coarse noise grid. */
function texture(seed: number, cell: number, amplitude: number, mean: number) {
	const next = random(seed);
	const size = 64;
	const grid = Array.from({ length: size * size }, () => next());
	return (u: number, v: number) => {
		const gx = u / cell + size / 2;
		const gy = v / cell + size / 2;
		const x0 = Math.floor(gx);
		const y0 = Math.floor(gy);
		const fx = gx - x0;
		const fy = gy - y0;
		const at = (x: number, y: number) =>
			grid[
				(((y % size) + size) % size) * size + (((x % size) + size) % size)
			] ?? 0;
		const top = at(x0, y0) + (at(x0 + 1, y0) - at(x0, y0)) * fx;
		const bottom = at(x0, y0 + 1) + (at(x0 + 1, y0 + 1) - at(x0, y0 + 1)) * fx;
		return mean + amplitude * (top + (bottom - top) * fy - 0.5);
	};
}

const WIDTH = 320;
const HEIGHT = 240;
const PATCH = 40;
const background = texture(7, 9, 40, 110);
const subject = texture(11, 3, 200, 128);

interface Pose {
	cx: number;
	cy: number;
	scale: number;
	visible?: boolean;
}

/** One frame: the background with the subject patch at `pose`. */
function frame(pose: Pose): GrayImage {
	const data = new Uint8Array(WIDTH * HEIGHT);
	const half = (PATCH * pose.scale) / 2;
	for (let y = 0; y < HEIGHT; y++) {
		for (let x = 0; x < WIDTH; x++) {
			const dx = x - pose.cx;
			const dy = y - pose.cy;
			const inside =
				pose.visible !== false && Math.abs(dx) < half && Math.abs(dy) < half;
			const value = inside
				? subject(dx / pose.scale, dy / pose.scale)
				: background(x, y);
			data[y * WIDTH + x] = Math.max(0, Math.min(255, Math.round(value)));
		}
	}
	return { data, height: HEIGHT, width: WIDTH };
}

const regionAt = (pose: Pose) => ({
	cx: pose.cx,
	cy: pose.cy,
	height: PATCH * pose.scale,
	width: PATCH * pose.scale,
});

describe("image helpers", () => {
	test("downsample averages 2x2 blocks", () => {
		const image: GrayImage = {
			data: new Uint8Array([0, 4, 8, 8, 4, 0, 8, 8]),
			height: 2,
			width: 4,
		};
		const half = downsample(image);
		expect(half.width).toBe(2);
		expect(half.height).toBe(1);
		expect([...half.data]).toEqual([2, 8]);
	});

	test("level coordinates round-trip", () => {
		expect(toLevel(0.5, 1)).toBe(0);
		expect(fromLevel(toLevel(37.25, 3), 3)).toBeCloseTo(37.25, 10);
	});

	test("samplePatch interpolates bilinearly and clamps edges", () => {
		const image: GrayImage = {
			data: new Uint8Array([0, 10, 20, 30]),
			height: 2,
			width: 2,
		};
		expect([...samplePatch(image, 0.5, 0.5, 1, 1, 1)]).toEqual([15]);
		expect([...samplePatch(image, -5, -5, 1, 1, 1)]).toEqual([0]);
		expect([...samplePatch(image, 0.5, 0, 2, 1, 1)]).toEqual([0, 10]);
	});

	test("ncc is 1 for a match, -1 for an inverse and 0 for a flat patch", () => {
		const patch = new Float32Array([1, 5, 2, 8, 3, 9]);
		const template = normalizePatch(patch);
		expect(template).not.toBeNull();
		if (!template) {
			return;
		}
		expect(ncc(template, patch)).toBeCloseTo(1, 6);
		expect(
			ncc(
				template,
				patch.map((value) => 2 * value + 7)
			)
		).toBeCloseTo(1, 6);
		expect(
			ncc(
				template,
				patch.map((value) => -value)
			)
		).toBeCloseTo(-1, 6);
		expect(ncc(template, new Float32Array(6).fill(4))).toBe(0);
		expect(normalizePatch(new Float32Array(6).fill(4))).toBeNull();
	});
});

describe("analysis settings", () => {
	test("frames are at most 640 px, even, and never upscaled", () => {
		expect(analysisSize(1920, 1080)).toEqual({ height: 360, width: 640 });
		expect(analysisSize(1080, 1920)).toEqual({ height: 640, width: 360 });
		expect(analysisSize(320, 181)).toEqual({ height: 182, width: 320 });
	});

	test("the frame rate follows the source and drops to fit the budget", () => {
		expect(analysisFps(10, 24)).toBe(24);
		expect(analysisFps(10, 60)).toBe(30);
		expect(analysisFps(10, undefined)).toBe(30);
		expect(analysisFps(1000, 30) * 1000).toBeCloseTo(MAX_TRACK_FRAMES, 6);
	});

	test("regions map to analysis-pixel centers", () => {
		expect(
			regionToPixels(
				{ height: 0.5, width: 0.25, x: 0.5, y: 0.25 },
				{ height: 200, width: 400 }
			)
		).toEqual({ cx: 249.5, cy: 99.5, height: 100, width: 100 });
	});
});

describe("TemplateTracker", () => {
	test("tracks a translating textured patch with under 2 px error", () => {
		const poses: Pose[] = Array.from({ length: 60 }, (_, index) => ({
			cx: 80 + index * 2.7,
			cy: 90 + index * 0.9 + 12 * Math.sin(index / 9),
			scale: 1,
		}));
		const first = poses[0];
		if (!first) {
			throw new Error("no poses");
		}
		const points = trackFrames(poses.map(frame), regionAt(first));
		expect(points).toHaveLength(poses.length);
		let worst = 0;
		points.forEach((point, index) => {
			const pose = poses[index];
			if (pose) {
				worst = Math.max(
					worst,
					Math.hypot(point.cx - pose.cx, point.cy - pose.cy)
				);
			}
			expect(point.lost).toBe(false);
		});
		expect(worst).toBeLessThan(2);
	});

	test("follows sub-pixel motion closely", () => {
		const poses: Pose[] = Array.from({ length: 30 }, (_, index) => ({
			cx: 150 + index * 0.37,
			cy: 120 - index * 0.21,
			scale: 1,
		}));
		const first = poses[0];
		if (!first) {
			throw new Error("no poses");
		}
		const points = trackFrames(poses.map(frame), regionAt(first));
		const last = points.at(-1);
		const truth = poses.at(-1);
		expect(last && truth).toBeTruthy();
		if (last && truth) {
			expect(Math.abs(last.cx - truth.cx)).toBeLessThan(0.75);
			expect(Math.abs(last.cy - truth.cy)).toBeLessThan(0.75);
		}
	});

	test("estimates a growing subject's scale", () => {
		const poses: Pose[] = Array.from({ length: 25 }, (_, index) => ({
			cx: 160 + index,
			cy: 120,
			scale: 1 + index * 0.012,
		}));
		const first = poses[0];
		if (!first) {
			throw new Error("no poses");
		}
		const points = trackFrames(poses.map(frame), regionAt(first));
		const last = points.at(-1);
		const truth = poses.at(-1);
		if (!(last && truth)) {
			throw new Error("no result");
		}
		expect(Math.abs(last.scale - truth.scale) / truth.scale).toBeLessThan(0.06);
		expect(Math.hypot(last.cx - truth.cx, last.cy - truth.cy)).toBeLessThan(2);
	});

	test("holds position while the subject is hidden and re-acquires it", () => {
		const poses: Pose[] = Array.from({ length: 30 }, (_, index) => ({
			cx: 100 + index * 1.5,
			cy: 110,
			scale: 1,
			visible: index < 12 || index >= 17,
		}));
		const first = poses[0];
		if (!first) {
			throw new Error("no poses");
		}
		const points = trackFrames(poses.map(frame), regionAt(first));
		const hidden = points.slice(12, 17);
		expect(hidden.some((point) => point.lost)).toBe(true);
		for (const point of hidden.filter((item) => item.lost)) {
			expect(point.confidence).toBeLessThan(LOST_CONFIDENCE);
		}
		const last = points.at(-1);
		const truth = poses.at(-1);
		if (!(last && truth)) {
			throw new Error("no result");
		}
		expect(last.lost).toBe(false);
		expect(Math.hypot(last.cx - truth.cx, last.cy - truth.cy)).toBeLessThan(2);
	});

	test("refuses tiny or flat regions", () => {
		const flat: GrayImage = {
			data: new Uint8Array(WIDTH * HEIGHT).fill(90),
			height: HEIGHT,
			width: WIDTH,
		};
		expect(
			() => new TemplateTracker(flat, { cx: 50, cy: 50, height: 3, width: 30 })
		).toThrow("too small");
		expect(
			() => new TemplateTracker(flat, { cx: 50, cy: 50, height: 30, width: 30 })
		).toThrow("no visible texture");
	});

	test("large regions use a coarser base level and several pyramid levels", () => {
		const image = frame({ cx: 160, cy: 120, scale: 4 });
		const tracker = new TemplateTracker(image, {
			cx: 160,
			cy: 120,
			height: 160,
			width: 160,
		});
		expect(tracker.base).toBe(2);
		expect(tracker.spacing).toBeCloseTo(1.25, 6);
		expect(tracker.levelCount).toBeGreaterThanOrEqual(1);
	});
});
