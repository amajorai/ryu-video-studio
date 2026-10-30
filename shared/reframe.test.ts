import { describe, expect, test } from "bun:test";
import { animatedValue } from "./animation.ts";
import { MAX_CLIP_OFFSET } from "./limits.ts";
import {
	type Asset,
	newProject,
	newSegment,
	type Project,
	type Segment,
	segmentDuration,
	trimSegment,
} from "./project.ts";
import {
	applyDeadZone,
	applyReframe,
	detectCutIndices,
	type LumaFrame,
	panKeyframes,
	panPlan,
	reframeAspects,
	reframeCanvas,
	reframedWindowCenter,
	reframeGeometry,
	reframeRequestSchema,
	reframeTargets,
	reframeToSubjects,
	type SubjectTrack,
	saliencyCentroid,
	saliencyMap,
	saliencyPath,
	savitzkyGolay,
	shotRanges,
	simplifyPath,
	smoothShotPath,
	staticReframe,
	trackedReframe,
} from "./reframe.ts";

const WIDTH = 160;
const HEIGHT = 90;

/** Deterministic pseudo-random sequence (LCG), 0..1. */
function random(seed: number) {
	let state = seed >>> 0;
	return () => {
		state = (state * 1_664_525 + 1_013_904_223) >>> 0;
		return state / 2 ** 32;
	};
}

/** A frame with a white `size` square centred at `(cx, cy)` over a background. */
function squareFrame(
	cx: number,
	cy: number,
	options: {
		background?: number;
		noise?: number;
		seed?: number;
		size?: number;
	} = {}
): LumaFrame {
	const size = options.size ?? 16;
	const next = random(options.seed ?? 1);
	const data = new Uint8Array(WIDTH * HEIGHT);
	for (let y = 0; y < HEIGHT; y++) {
		for (let x = 0; x < WIDTH; x++) {
			const inside =
				Math.abs(x + 0.5 - cx) <= size / 2 &&
				Math.abs(y + 0.5 - cy) <= size / 2;
			const noise = (next() - 0.5) * 2 * (options.noise ?? 0);
			data[y * WIDTH + x] = inside
				? 255
				: Math.round(
						Math.min(255, Math.max(0, (options.background ?? 0) + noise))
					);
		}
	}
	return { data, height: HEIGHT, width: WIDTH };
}

const video = (width = 1920, height = 1080, duration = 10): Asset => ({
	createdAt: "2026-01-01T00:00:00.000Z",
	duration,
	hasAudio: false,
	height,
	id: crypto.randomUUID(),
	kind: "video",
	name: "clip.mp4",
	width,
});

const counter = () => {
	let next = 0;
	return () => {
		next++;
		return `00000000-0000-4000-8000-${String(next).padStart(12, "0")}`;
	};
};

describe("saliency", () => {
	test("a moving square is tracked within 5% of the frame width", () => {
		const centers = Array.from({ length: 24 }, (_, index) => 14 + index * 5.5);
		const frames = centers.map((cx, index) =>
			squareFrame(cx, 30 + index, {
				background: 60,
				noise: 12,
				seed: index + 1,
			})
		);
		const path = saliencyPath(frames, []);
		for (const [index, point] of path.entries()) {
			const expected = (centers[index] ?? 0) / WIDTH;
			expect(Math.abs(point.x - expected)).toBeLessThan(0.05);
			expect(point.weight).toBeGreaterThan(0);
		}
	});

	test("an empty frame falls back to the center with no weight", () => {
		const blank: LumaFrame = {
			data: new Uint8Array(WIDTH * HEIGHT).fill(80),
			height: HEIGHT,
			width: WIDTH,
		};
		expect(saliencyCentroid(saliencyMap(blank, blank), WIDTH, HEIGHT)).toEqual({
			weight: 0,
			x: 0.5,
			y: 0.5,
		});
	});

	test("motion outweighs static texture", () => {
		const previous = squareFrame(30, 45, {
			background: 90,
			noise: 25,
			seed: 7,
		});
		const frame = squareFrame(130, 45, { background: 90, noise: 25, seed: 7 });
		// The square left x=30 and arrived at x=130: the centroid lies between
		// the two, nowhere near the center prior's pull alone.
		const point = saliencyCentroid(saliencyMap(frame, previous), WIDTH, HEIGHT);
		expect(point.x).toBeGreaterThan(0.45);
		expect(point.y).toBeCloseTo(0.5, 1);
	});

	test("hard cuts are detected from frame differences", () => {
		const frames = [
			...Array.from({ length: 6 }, (_, index) => squareFrame(40 + index, 45)),
			...Array.from({ length: 6 }, (_, index) =>
				squareFrame(100 + index, 45, { background: 200 })
			),
		];
		expect(detectCutIndices(frames)).toEqual([6]);
		expect(shotRanges(12, [6])).toEqual([
			[0, 6],
			[6, 12],
		]);
		expect(shotRanges(4, [0, 4, 9])).toEqual([[0, 4]]);
	});
});

describe("smoothing", () => {
	const jittery = Array.from(
		{ length: 80 },
		(_, index) => 0.3 + index * 0.004 + (index % 2 === 0 ? 0.02 : -0.02)
	);

	test("stays inside the input range and reduces variation", () => {
		const variation = (values: readonly number[]) =>
			values
				.slice(1)
				.reduce(
					(sum, value, index) => sum + Math.abs(value - (values[index] ?? 0)),
					0
				);
		for (const strength of [0.1, 0.5, 1]) {
			const smoothed = smoothShotPath(jittery, strength, 4);
			expect(smoothed).toHaveLength(jittery.length);
			expect(Math.min(...smoothed)).toBeGreaterThanOrEqual(
				Math.min(...jittery)
			);
			expect(Math.max(...smoothed)).toBeLessThanOrEqual(Math.max(...jittery));
			expect(variation(smoothed)).toBeLessThan(variation(jittery) / 2);
		}
	});

	test("smoothing 0 keeps the raw path", () => {
		expect(smoothShotPath([0.2, 0.7, 0.4], 0, 4)).toEqual([0.2, 0.7, 0.4]);
		expect(smoothShotPath([], 1, 4)).toEqual([]);
	});

	test("the quadratic fit reproduces a parabola exactly", () => {
		const parabola = Array.from(
			{ length: 15 },
			(_, t) => 0.1 + 0.01 * t + 0.002 * t * t
		);
		for (const [index, value] of savitzkyGolay(parabola, 3).entries()) {
			expect(value).toBeCloseTo(parabola[index] ?? 0, 9);
		}
	});

	test("the dead zone holds through small motion and trails large motion", () => {
		expect(applyDeadZone([0.5, 0.52, 0.48, 0.51], 0.03)).toEqual([
			0.5, 0.5, 0.5, 0.5,
		]);
		const trailed = applyDeadZone([0.5, 0.6, 0.7], 0.03);
		expect(trailed[1]).toBeCloseTo(0.57, 9);
		expect(trailed[2]).toBeCloseTo(0.67, 9);
	});
});

describe("geometry", () => {
	test("canvas keeps the short edge", () => {
		const landscape = { height: 1080, width: 1920 };
		expect(reframeCanvas(landscape, "9:16")).toEqual({
			height: 1920,
			width: 1080,
		});
		expect(reframeCanvas(landscape, "1:1")).toEqual({
			height: 1080,
			width: 1080,
		});
		expect(reframeCanvas(landscape, "4:5")).toEqual({
			height: 1350,
			width: 1080,
		});
		expect(reframeCanvas({ height: 1920, width: 1080 }, "16:9")).toEqual({
			height: 1080,
			width: 1920,
		});
		expect(reframeCanvas(landscape, "4:3")).toEqual({
			height: 1080,
			width: 1440,
		});
		expect(reframeCanvas(landscape, "3:4")).toEqual({
			height: 1440,
			width: 1080,
		});
		expect(reframeCanvas(landscape, "2.35:1")).toEqual({
			height: 1080,
			width: 2538,
		});
		expect(reframeCanvas(landscape, "21:9")).toEqual({
			height: 1080,
			width: 2520,
		});
		for (const aspect of reframeAspects) {
			const canvas = reframeCanvas({ height: 4320, width: 7680 }, aspect);
			expect(canvas.width % 2).toBe(0);
			expect(canvas.height % 2).toBe(0);
			expect(Math.max(canvas.width, canvas.height)).toBeLessThanOrEqual(8192);
		}
	});

	test("pan axis and cover ratio", () => {
		const landscape = { height: 1080, width: 1920 };
		expect(reframeGeometry(landscape, { height: 1920, width: 1080 }).axis).toBe(
			"x"
		);
		expect(
			reframeGeometry(landscape, { height: 1920, width: 1080 }).coverRatio
		).toBeCloseTo(256 / 81, 6);
		expect(reframeGeometry({ height: 1920, width: 1080 }, landscape).axis).toBe(
			"y"
		);
		expect(reframeGeometry(landscape, landscape)).toEqual({
			axis: null,
			coverRatio: 1,
		});
	});

	test("a pan stays within the x bounds and the crop schema", () => {
		const plan = panPlan([0.05, 0.5, 0.95], {
			axis: "x",
			coverRatio: 256 / 81,
		});
		// 16:9 into 9:16 now pans across the whole source width.
		expect(plan.boxScale).toBeCloseTo(256 / 81, 5);
		expect(plan.bandSize).toBe(1);
		expect(plan.bandStart).toBe(0);
		for (const value of plan.values) {
			expect(Math.abs(value)).toBeLessThanOrEqual(MAX_CLIP_OFFSET);
		}
		// The subject at the far left edge is framed at the box's left edge.
		expect(plan.values[0]).toBeCloseTo(256 / 81 - 1, 3);
		expect(plan.values[2]).toBeCloseTo(-(256 / 81 - 1), 3);
		const wide = panPlan([0.05, 0.95], { axis: "x", coverRatio: 6 });
		expect(wide.boxScale).toBeLessThanOrEqual(4);
		expect(wide.bandSize).toBeCloseTo(4 / 6, 5);
		const narrow = panPlan([0.5, 0.5], { axis: "x", coverRatio: 20 });
		expect(narrow.bandStart).toBeLessThanOrEqual(0.9);
		expect(1 - narrow.bandStart - narrow.bandSize).toBeLessThanOrEqual(0.9);
	});
});

describe("keyframes", () => {
	test("simplification keeps corners within tolerance", () => {
		const samples = Array.from({ length: 21 }, (_, index) => ({
			time: index,
			value: index <= 10 ? index * 0.1 : 1 - (index - 10) * 0.1,
		}));
		expect(simplifyPath(samples, 0.001).map((sample) => sample.time)).toEqual([
			0, 10, 20,
		]);
	});

	test("shots hold at their last keyframe and the budget is respected", () => {
		const samples = Array.from({ length: 40 }, (_, index) => ({
			time: index * 0.25,
			value: index < 20 ? -0.5 + index * 0.05 : 0.6 - (index - 20) * 0.02,
		}));
		const plan = {
			axis: "x" as const,
			bandSize: 0.6,
			bandStart: 0.2,
			boxScale: 1.9,
			samples,
			shotStarts: [0, 20],
		};
		const { keyframes } = panKeyframes(plan, 200, counter());
		const holds = keyframes.filter((frame) => frame.interpolation === "hold");
		expect(holds).toHaveLength(1);
		expect(holds[0]?.time).toBeCloseTo(4.75, 6);
		expect(keyframes.some((frame) => frame.time === 5)).toBe(true);
		const limited = panKeyframes(
			{
				...plan,
				samples: samples.map((sample, index) => ({
					...sample,
					value: Math.sin(index) * 0.8,
				})),
				shotStarts: [0],
			},
			6,
			counter()
		);
		expect(limited.keyframes.length).toBeLessThanOrEqual(6);
	});

	test("a still path writes no keyframes", () => {
		const plan = {
			axis: "y" as const,
			bandSize: 1,
			bandStart: 0,
			boxScale: 1.5,
			samples: [0, 1, 2].map((time) => ({ time, value: 0.25 })),
			shotStarts: [0],
		};
		expect(panKeyframes(plan, 200, counter())).toEqual({
			keyframes: [],
			value: 0.25,
		});
	});
});

function trackFor(
	centers: readonly number[],
	cuts: number[] = []
): SubjectTrack {
	const frames = centers.map((cx, index) =>
		squareFrame(cx * WIDTH, 45, { background: 30, noise: 8, seed: index + 3 })
	);
	return { cuts, points: saliencyPath(frames, cuts), sampleRate: 4 };
}

describe("tracked reframe", () => {
	test("the framed window follows the subject (16:9 to 9:16)", () => {
		const asset = video();
		const segment: Segment = { ...newSegment(asset), sourceOut: 6 };
		const centers = Array.from(
			{ length: 24 },
			(_, index) => 0.35 + index * 0.012
		);
		const result = trackedReframe(
			segment,
			asset,
			{ height: 1920, width: 1080 },
			trackFor(centers),
			0,
			counter()
		);
		expect(result.axis).toBe("x");
		expect(result.segment.fit).toBe("fill");
		expect(result.segment.scaleX).toBeLessThanOrEqual(2);
		expect(result.keyframes).toBeGreaterThan(1);
		for (const [index, center] of centers.entries()) {
			const offset = animatedValue(result.segment, "x", index / 4);
			const shown = reframedWindowCenter(result.segment, "x", offset);
			expect(Math.abs(shown - center)).toBeLessThan(0.05);
		}
	});

	test("portrait sources pan vertically into 16:9", () => {
		const asset = video(1080, 1920);
		const segment = newSegment(asset);
		const points = Array.from({ length: 8 }, (_, index) => ({
			weight: 1,
			x: 0.5,
			y: 0.3 + index * 0.05,
		}));
		const result = trackedReframe(
			{ ...segment, sourceOut: 2 },
			asset,
			{ height: 1080, width: 1920 },
			{ cuts: [], points, sampleRate: 4 },
			0.2,
			counter()
		);
		expect(result.axis).toBe("y");
		expect(result.segment.scaleY).toBeGreaterThan(1);
		expect(result.segment.scaleX).toBeUndefined();
		expect(result.segment.crop.left).toBe(0);
		expect(
			result.segment.keyframes.every((frame) => frame.property === "y")
		).toBe(true);
	});

	test("a mirrored clip pans to the subject, not its mirror image", () => {
		const asset = video();
		const canvas = { height: 1920, width: 1080 };
		// One shot with the subject at 0.25 of the source, then one at 0.75.
		const points = Array.from({ length: 16 }, (_, index) => ({
			weight: 1,
			x: index < 8 ? 0.25 : 0.75,
			y: 0.5,
		}));
		const track: SubjectTrack = { cuts: [8], points, sampleRate: 4 };
		const segment = { ...newSegment(asset), sourceOut: 4 };
		/** Source share at the canvas centre, from the box geometry alone. */
		const shownCenter = (framed: Segment, time: number) => {
			const box = framed.scaleX ?? 1;
			const offset = animatedValue(framed, "x", time);
			const along = (1 - offset / box) / 2; // canvas centre within the box
			const within = framed.flipH ? 1 - along : along; // flip mirrors the band
			const bandSize = 1 - framed.crop.left - framed.crop.right;
			return framed.crop.left + within * bandSize;
		};
		const half = 1 / reframeGeometry(asset, canvas).coverRatio / 2;
		for (const flipH of [false, true]) {
			const result = trackedReframe(
				{ ...segment, flipH },
				asset,
				canvas,
				track,
				0,
				counter()
			);
			expect(result.segment.flipH).toBe(flipH);
			for (const [time, subject] of [
				[0.5, 0.25],
				[3, 0.75],
			] as const) {
				const center = shownCenter(result.segment, time);
				expect(Math.abs(center - subject)).toBeLessThan(half);
				expect(Math.sign(center - 0.5)).toBe(Math.sign(subject - 0.5));
				const offset = animatedValue(result.segment, "x", time);
				expect(reframedWindowCenter(result.segment, "x", offset)).toBeCloseTo(
					center,
					6
				);
			}
		}
	});

	test("a new shot's framing starts at the exact cut time", () => {
		const asset = video();
		const points = Array.from({ length: 12 }, (_, index) => ({
			weight: 1,
			x: index < 5 ? 0.3 : 0.7,
			y: 0.5,
		}));
		const result = trackedReframe(
			{ ...newSegment(asset), sourceOut: 3 },
			asset,
			{ height: 1080, width: 1080 },
			{ cutTimes: [1.1], cuts: [5], points, sampleRate: 4 },
			0,
			counter()
		);
		const times = result.segment.keyframes.map((frame) => [
			frame.time,
			frame.interpolation ?? "linear",
		]);
		expect(times).toContainEqual([1, "hold"]);
		expect(times).toContainEqual([1.1, "linear"]);
		const before = animatedValue(result.segment, "x", 1.09);
		const after = animatedValue(result.segment, "x", 1.1);
		expect(before).toBe(animatedValue(result.segment, "x", 0));
		expect(after).toBe(animatedValue(result.segment, "x", 2.5));
		expect(before).not.toBe(after);
	});

	test("trims keep pan keyframes, holds and cuts on their source moments", () => {
		const asset = video();
		const points = Array.from({ length: 12 }, (_, index) => ({
			weight: 1,
			x: index < 5 ? 0.3 + index * 0.01 : 0.7 - (index - 5) * 0.01,
			y: 0.5,
		}));
		for (const speed of [1, 2]) {
			const framed = trackedReframe(
				{ ...newSegment(asset), sourceOut: 3 * speed, speed },
				asset,
				{ height: 1080, width: 1080 },
				{ cutTimes: [1.1], cuts: [5], points, sampleRate: 4 },
				0,
				counter()
			).segment;
			expect(
				framed.keyframes.some((frame) => frame.interpolation === "hold")
			).toBe(true);
			const trims = [
				...[0.3, 0.52, 1.05 / speed, 1.12 / speed].map(
					(delta) => ["start", delta] as const
				),
				...[-0.4, -1.9 / speed, -1.95 / speed].map(
					(delta) => ["end", delta] as const
				),
			];
			for (const [edge, delta] of trims) {
				const trimmed = trimSegment(framed, 10, edge, delta);
				const shift = trimmed.start - framed.start;
				for (let time = 0; time <= segmentDuration(trimmed); time += 0.01) {
					expect(animatedValue(trimmed, "x", time)).toBeCloseTo(
						animatedValue(framed, "x", time + shift),
						3
					);
				}
			}
		}
	});

	test("matching aspects only switch to fill", () => {
		const asset = video();
		const result = trackedReframe(
			{ ...newSegment(asset), x: 0.3, scale: 1.2 },
			asset,
			{ height: 1080, width: 1920 },
			trackFor([0.5, 0.6]),
			0.5,
			counter()
		);
		expect(result.keyframes).toBe(0);
		expect(result.segment).toMatchObject({ fit: "fill", scale: 1, x: 0, y: 0 });
	});
});

function projectWith(segments: Segment[]): Project {
	return { ...newProject("Reframe"), segments };
}

describe("applyReframe", () => {
	const asset = video();
	const audio: Asset = {
		...video(),
		hasAudio: true,
		height: 0,
		kind: "audio",
		width: 0,
	};
	const base = { ...newSegment(asset), sourceOut: 4 };
	const inset = {
		...newSegment(asset, 0, 1),
		scale: 0.3,
		sourceOut: 4,
		x: 0.6,
	};
	const upper = { ...newSegment(asset, 0, 2), sourceOut: 4 };
	const music = newSegment(audio, 0, 3);
	const project = projectWith([base, inset, upper, music]);
	const assets = [asset, audio];

	test("default targets skip insets and audio", () => {
		expect(
			reframeTargets(project, assets).map((segment) => segment.id)
		).toEqual([base.id, upper.id]);
		expect(() => reframeTargets(project, assets, [music.id])).toThrow(
			"Only video and image clips"
		);
		expect(() =>
			reframeTargets(project, assets, [crypto.randomUUID()])
		).toThrow("not on the timeline");
	});

	test("default targets skip split-screen cells", () => {
		const left = { ...base, scaleX: 0.5, x: -0.5 };
		const right = { ...upper, scaleX: 0.5, x: 0.5 };
		const split = projectWith([left, right]);
		expect(reframeTargets(split, assets)).toEqual([]);
		const result = applyReframe(
			split,
			assets,
			{ aspect: "9:16", mode: "center", revision: 0 },
			new Map()
		);
		expect(result.clips).toEqual([]);
		expect(result.project.segments).toEqual([left, right]);
		// An oversized clip moved off centre still covers the canvas.
		const zoomed = projectWith([{ ...base, scale: 1.5, x: 0.4 }]);
		expect(reframeTargets(zoomed, assets)).toHaveLength(1);
	});

	test("clips on locked tracks are never reframed", () => {
		const locked: Project = {
			...project,
			trackSettings: [
				{ locked: true, muted: false, name: "Track 1", solo: false, track: 0 },
			],
		};
		expect(reframeTargets(locked, assets).map((segment) => segment.id)).toEqual(
			[upper.id]
		);
		const result = applyReframe(
			locked,
			assets,
			{ aspect: "9:16", mode: "center", revision: 0 },
			new Map()
		);
		expect(result.clips.map((clip) => clip.clipId)).toEqual([upper.id]);
		expect(
			result.project.segments.find((segment) => segment.id === base.id)
		).toEqual(base);
		expect(() =>
			applyReframe(
				locked,
				assets,
				{ aspect: "9:16", clipIds: [base.id], mode: "center", revision: 0 },
				new Map()
			)
		).toThrow("Unlock");
	});

	test("center mode changes the canvas and fills", () => {
		const result = applyReframe(
			project,
			assets,
			{ aspect: "9:16", mode: "center", revision: 0 },
			new Map()
		);
		expect(result.project).toMatchObject({ height: 1920, width: 1080 });
		const byId = new Map(
			result.project.segments.map((segment) => [segment.id, segment])
		);
		expect(byId.get(base.id)?.fit).toBe("fill");
		expect(byId.get(inset.id)).toEqual(inset);
		expect(result.clips.map((clip) => clip.mode)).toEqual(["center", "center"]);
		expect(result.project.background).toBeUndefined();
	});

	test("blur-fill fits clips over a blur canvas", () => {
		const result = applyReframe(
			project,
			assets,
			{ aspect: "1:1", mode: "blur-fill", revision: 0 },
			new Map()
		);
		expect(result.project.background?.type).toBe("blur");
		const byId = new Map(
			result.project.segments.map((segment) => [segment.id, segment])
		);
		expect(byId.get(base.id)?.fit).toBeUndefined();
		expect(byId.get(base.id)?.background).toBeUndefined();
		expect(byId.get(upper.id)?.background?.type).toBe("blur");
	});

	test("track mode keyframes tracked clips and falls back without a track", () => {
		const centers = Array.from(
			{ length: 16 },
			(_, index) => 0.3 + index * 0.02
		);
		const result = applyReframe(
			project,
			assets,
			{
				aspect: "9:16",
				clipIds: [base.id, upper.id],
				mode: "track",
				revision: 0,
				smoothing: 0.3,
			},
			new Map([[base.id, trackFor(centers)]]),
			counter()
		);
		const [tracked, fallback] = result.clips;
		expect(tracked).toMatchObject({
			axis: "x",
			clipId: base.id,
			mode: "track",
		});
		expect(tracked?.keyframes).toBeGreaterThan(0);
		expect(fallback).toMatchObject({ clipId: upper.id, mode: "center" });
		expect(fallback?.note).toContain("centred crop");
	});

	test("existing framing keyframes are replaced, others kept", () => {
		const keyed: Segment = {
			...base,
			keyframes: [
				{ id: crypto.randomUUID(), property: "x", time: 0, value: 0.2 },
				{ id: crypto.randomUUID(), property: "opacity", time: 1, value: 0.5 },
			],
		};
		const next = staticReframe(keyed, "center");
		expect(next.keyframes.map((frame) => frame.property)).toEqual(["opacity"]);
	});

	test("request schema is strict", () => {
		expect(
			reframeRequestSchema.safeParse({
				aspect: "9:16",
				extra: 1,
				mode: "track",
				revision: 0,
			}).success
		).toBe(false);
		expect(
			reframeRequestSchema.safeParse({
				aspect: "5:4",
				mode: "track",
				revision: 0,
			}).success
		).toBe(false);
		for (const aspect of ["4:3", "3:4", "2.35:1", "21:9"]) {
			expect(
				reframeRequestSchema.safeParse({ aspect, mode: "center", revision: 0 })
					.success
			).toBe(true);
		}
		expect(
			reframeRequestSchema.safeParse({
				aspect: "4:5",
				mode: "track",
				revision: 0,
				smoothing: 2,
			}).success
		).toBe(false);
	});
});

describe("reframeToSubjects", () => {
	test("built clips follow their tracks; untracked ones keep their crop", () => {
		const asset = video();
		const tracked = {
			...newSegment(asset),
			fit: "fill" as const,
			sourceOut: 6,
		};
		const untracked = {
			...newSegment(asset, 6),
			fit: "fill" as const,
			sourceOut: 2,
		};
		const other = { ...newSegment(asset, 0, 1), scale: 0.3, sourceOut: 2 };
		const project: Project = {
			...projectWith([tracked, untracked, other]),
			height: 1920,
			trackSettings: [
				{ locked: true, muted: false, name: "Locked", solo: false, track: 0 },
			],
			width: 1080,
		};
		const centers = Array.from(
			{ length: 24 },
			(_, index) => 0.2 + index * 0.01
		);
		const result = reframeToSubjects(
			project,
			[asset],
			[tracked.id, untracked.id],
			new Map([[tracked.id, trackFor(centers)]]),
			{ createId: counter(), smoothing: 0 }
		);
		expect(result.clips.map((clip) => [clip.clipId, clip.mode])).toEqual([
			[tracked.id, "track"],
			[untracked.id, "center"],
		]);
		const [followed, kept, left] = result.project.segments;
		expect(followed?.keyframes.some((frame) => frame.property === "x")).toBe(
			true
		);
		if (followed) {
			for (const [index, center] of centers.entries()) {
				const offset = animatedValue(followed, "x", index / 4);
				expect(
					Math.abs(reframedWindowCenter(followed, "x", offset) - center)
				).toBeLessThan(0.08);
			}
		}
		expect(kept).toEqual(untracked);
		expect(left).toEqual(other);
	});
});
