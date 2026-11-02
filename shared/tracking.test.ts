import { describe, expect, test } from "bun:test";
import { animatedValue } from "./animation.ts";
import {
	type Asset,
	type Graphic,
	graphicSchema,
	newProject,
	newSegment,
	type Project,
	type Segment,
	segmentDuration,
	type Title,
	titleSchema,
	trimSegment,
	validateProject,
} from "./project.ts";
import {
	applyTrack,
	type CanvasTrackPoint,
	canvasRegionToSource,
	canvasToSource,
	canvasTrackPath,
	clipSourceTime,
	clipTimelineTime,
	DEFAULT_TRACK_TOLERANCE,
	decimateTrack,
	MAX_TARGET_KEYFRAMES,
	MAX_TRACK_SECONDS,
	pathAt,
	sourceRegionToCanvas,
	sourceToCanvas,
	summarizeTrack,
	type TrackSample,
	trackRequestSchema,
	trackTargetsAt,
	trackWindow,
} from "./tracking.ts";

const CANVAS = { height: 1080, width: 1920 };
const HD = { height: 1080, width: 1920 };

function video(duration = 20, width = 1920, height = 1080): Asset {
	return {
		createdAt: new Date(0).toISOString(),
		duration,
		hasAudio: false,
		height,
		id: crypto.randomUUID(),
		kind: "video",
		name: "subject.mp4",
		width,
	};
}

function counter() {
	let next = 0;
	return () =>
		`00000000-0000-4000-8000-${(next++).toString(16).padStart(12, "0")}`;
}

/** A straight path: the subject moves right and down, growing 20%. */
function linearPath(
	start: number,
	end: number,
	count = 61
): CanvasTrackPoint[] {
	return Array.from({ length: count }, (_, index) => {
		const p = index / (count - 1);
		return {
			scale: 1 + 0.2 * p,
			time: start + (end - start) * p,
			x: 0.3 + 0.2 * p,
			y: 0.4 + 0.1 * p,
		};
	});
}

function title(start: number, end: number): Title {
	return titleSchema.parse({
		color: "#ffffff",
		end,
		fadeIn: 0,
		fadeOut: 0,
		fontSize: 0.05,
		id: crypto.randomUUID(),
		start,
		text: "Follow me",
		x: 0.3,
		y: 0.35,
	});
}

function graphic(start: number, end: number): Graphic {
	return graphicSchema.parse({
		end,
		fill: "#ff0000",
		height: 0.1,
		id: crypto.randomUUID(),
		opacity: 1,
		start,
		width: 0.1,
		x: 0.25,
		y: 0.35,
	});
}

function scene() {
	const source = video();
	const sticker: Asset = { ...video(), id: crypto.randomUUID(), kind: "image" };
	const clip = { ...newSegment(source, 0), sourceOut: 10 };
	const overlay = {
		...newSegment(sticker, 0, 1),
		scale: 0.5,
		sourceOut: 10,
		x: -0.4,
		y: -0.2,
	};
	const project: Project = validateProject(
		{
			...newProject("Tracking"),
			graphics: [graphic(1, 6)],
			segments: [clip, overlay],
			titles: [title(1, 6)],
		},
		[source, sticker]
	);
	return { assets: [source, sticker], clip, overlay, project, source };
}

describe("request contract", () => {
	const base = {
		clipId: crypto.randomUUID(),
		revision: 3,
		roi: { height: 0.2, width: 0.1, x: 0.4, y: 0.3 },
		target: { createRegion: "blur" },
		time: 1,
	};

	test("accepts regions and either target form", () => {
		expect(trackRequestSchema.parse(base).target).toEqual({
			createRegion: "blur",
		});
		expect(
			trackRequestSchema.parse({
				...base,
				roiSpace: "source",
				target: { id: crypto.randomUUID(), kind: "title" },
			}).roiSpace
		).toBe("source");
	});

	test("rejects regions outside the frame, unknown fields and long spans", () => {
		expect(
			trackRequestSchema.safeParse({
				...base,
				roi: { height: 0.2, width: 0.7, x: 0.4, y: 0.3 },
			}).success
		).toBe(false);
		expect(trackRequestSchema.safeParse({ ...base, extra: 1 }).success).toBe(
			false
		);
		expect(
			trackRequestSchema.safeParse({
				...base,
				duration: MAX_TRACK_SECONDS + 1,
			}).success
		).toBe(false);
		expect(
			trackRequestSchema.safeParse({
				...base,
				target: { createRegion: "blur", kind: "title" },
			}).success
		).toBe(false);
	});
});

describe("clip time", () => {
	const segment: Segment = {
		...newSegment(video(), 2),
		sourceIn: 1,
		sourceOut: 9,
		speed: 2,
	};

	test("maps project and source time through speed", () => {
		expect(clipSourceTime(segment, 3)).toBe(3);
		expect(clipTimelineTime(segment, 3)).toBe(3);
		expect(clipTimelineTime(segment, clipSourceTime(segment, 4.5))).toBe(4.5);
	});

	test("the window runs to the clip end or the requested duration", () => {
		expect(trackWindow(segment, 3)).toEqual({
			end: 6,
			sourceEnd: 9,
			sourceStart: 3,
			start: 3,
		});
		expect(trackWindow(segment, 3, 1).end).toBe(4);
		expect(() => trackWindow(segment, 6)).toThrow("inside the clip");
		expect(() => trackWindow(segment, 1)).toThrow("inside the clip");
	});
});

describe("clip geometry", () => {
	const source = video();
	const base = newSegment(source, 0);

	test("a full-frame clip maps source fractions to the same canvas fractions", () => {
		const point = sourceToCanvas(base, HD, CANVAS, { x: 0.25, y: 0.75 }, 0);
		expect(point.x).toBeCloseTo(0.25, 9);
		expect(point.y).toBeCloseTo(0.75, 9);
	});

	test("position, scale, rotation and flips round-trip", () => {
		const moved: Segment = {
			...base,
			flipH: true,
			rotation: 30,
			scale: 0.5,
			x: 0.4,
			y: -0.2,
		};
		const point = { x: 0.2, y: 0.7 };
		const canvas = sourceToCanvas(moved, HD, CANVAS, point, 0);
		const back = canvasToSource(moved, HD, CANVAS, canvas, 0);
		expect(back.x).toBeCloseTo(point.x, 9);
		expect(back.y).toBeCloseTo(point.y, 9);
		const center = sourceToCanvas(moved, HD, CANVAS, { x: 0.5, y: 0.5 }, 0);
		expect(center.x).toBeCloseTo(0.7, 9);
		expect(center.y).toBeCloseTo(0.4, 9);
		// A horizontal flip puts the source's left edge on the right.
		const left = sourceToCanvas(
			{ ...base, flipH: true },
			HD,
			CANVAS,
			{ x: 0, y: 0.5 },
			0
		);
		expect(left.x).toBeCloseTo(1, 9);
	});

	test("a letterboxed portrait clip maps through its fitted box", () => {
		const portrait = { height: 1920, width: 1080 };
		const point = sourceToCanvas(base, portrait, CANVAS, { x: 0, y: 0 }, 0);
		const fittedWidth = 1080 / 1920 / (1920 / 1080);
		expect(point.x).toBeCloseTo(0.5 - fittedWidth / 2, 9);
		expect(point.y).toBeCloseTo(0, 9);
	});

	test("canvas regions convert to source regions and back", () => {
		const half: Segment = { ...base, scale: 0.5 };
		const region = { height: 0.1, width: 0.1, x: 0.4, y: 0.4 };
		const source = canvasRegionToSource(half, HD, CANVAS, region, 0);
		expect(source.x).toBeCloseTo(0.3, 9);
		expect(source.width).toBeCloseTo(0.2, 9);
		const back = sourceRegionToCanvas(half, HD, CANVAS, source, 0);
		expect(back.x).toBeCloseTo(region.x, 9);
		expect(back.height).toBeCloseTo(region.height, 9);
		expect(() =>
			canvasRegionToSource(
				half,
				HD,
				CANVAS,
				{ height: 0.1, width: 0.1, x: 0, y: 0 },
				0
			)
		).toThrow("over the clip");
	});

	test("the canvas path follows the clip's own animated zoom", () => {
		const zooming: Segment = {
			...base,
			keyframes: [
				{ id: crypto.randomUUID(), property: "scale", time: 0, value: 1 },
				{ id: crypto.randomUUID(), property: "scale", time: 2, value: 2 },
			],
		};
		const samples: TrackSample[] = [
			{ confidence: 1, scale: 1, time: 0, x: 0.75, y: 0.5 },
			{ confidence: 1, scale: 1, time: 2, x: 0.75, y: 0.5 },
		];
		const [first, last] = canvasTrackPath(zooming, HD, CANVAS, samples);
		expect(first?.x).toBeCloseTo(0.75, 9);
		expect(last?.x).toBeCloseTo(1, 9);
		expect(last?.scale).toBeCloseTo(2, 9);
	});
});

describe("decimation", () => {
	test("a straight path keeps only its ends", () => {
		const path = linearPath(0, 4);
		const kept = decimateTrack(path, 50);
		expect(kept).toEqual([path[0], path.at(-1)] as CanvasTrackPoint[]);
	});

	test("a curved path stays within tolerance and the budget", () => {
		const path = Array.from({ length: 2000 }, (_, index) => ({
			scale: 1,
			time: index / 30,
			x: 0.5 + 0.3 * Math.sin(index / 40),
			y: 0.5 + 0.2 * Math.cos(index / 23),
		}));
		const kept = decimateTrack(path, 66);
		expect(kept.length).toBeLessThanOrEqual(66);
		expect(kept[0]).toEqual(path[0] as CanvasTrackPoint);
		expect(kept.at(-1)).toEqual(path.at(-1) as CanvasTrackPoint);
		const loose = decimateTrack(path.slice(0, 300), 200);
		for (const point of path.slice(0, 300)) {
			const value = pathAt(loose, point.time);
			expect(Math.abs((value?.x ?? 0) - point.x)).toBeLessThanOrEqual(
				DEFAULT_TRACK_TOLERANCE + 1e-9
			);
		}
	});

	test("needs room for two keyframes", () => {
		expect(() => decimateTrack(linearPath(0, 1), 1)).toThrow("two keyframes");
	});
});

describe("applyTrack", () => {
	test("a title follows the subject with x, y and scale keyframes", () => {
		const { assets, clip, project } = scene();
		const target = project.titles[0];
		if (!target) {
			throw new Error("no title");
		}
		const withOpacity: Project = {
			...project,
			titles: [
				{
					...target,
					keyframes: [
						{ id: crypto.randomUUID(), property: "opacity", time: 0, value: 1 },
						{ id: crypto.randomUUID(), property: "x", time: 0, value: 0.3 },
					],
				},
			],
		};
		const result = applyTrack(
			withOpacity,
			assets,
			{
				path: linearPath(2, 4),
				region: { height: 0.1, width: 0.1, x: 0.25, y: 0.35 },
				segment: clip,
				target: { id: target.id, kind: "title" },
			},
			counter()
		);
		expect(result.target).toEqual({ id: target.id, kind: "title" });
		const frames = result.project.titles[0]?.keyframes ?? [];
		const of = (property: string) =>
			frames.filter((frame) => frame.property === property);
		expect(of("opacity")).toHaveLength(1);
		expect(of("x").map((frame) => [frame.time, frame.value])).toEqual([
			[1, 0.3],
			[3, 0.5],
		]);
		expect(of("y").map((frame) => frame.value)).toEqual([0.35, 0.45]);
		expect(of("scale").map((frame) => frame.value)).toEqual([1, 1.2]);
		expect(result.keyframes).toBe(6);
	});

	test("a path clipped by the target's end ends exactly at the end", () => {
		const { assets, clip, project } = scene();
		const target = project.titles[0];
		if (!target) {
			throw new Error("no title");
		}
		const result = applyTrack(
			project,
			assets,
			{
				path: linearPath(4, 8),
				region: { height: 0.1, width: 0.1, x: 0.25, y: 0.35 },
				segment: clip,
				target: { id: target.id, kind: "title" },
			},
			counter()
		);
		const xs = (result.project.titles[0]?.keyframes ?? []).filter(
			(frame) => frame.property === "x"
		);
		expect(xs.map((frame) => frame.time)).toEqual([3, 5]);
		expect(xs[1]?.value).toBeCloseTo(0.4, 4);
	});

	test("a graphic moves its corner without scale keyframes", () => {
		const { assets, clip, project } = scene();
		const target = project.graphics[0];
		if (!target) {
			throw new Error("no graphic");
		}
		const result = applyTrack(
			project,
			assets,
			{
				path: linearPath(2, 4),
				region: { height: 0.1, width: 0.1, x: 0.25, y: 0.35 },
				segment: clip,
				target: { id: target.id, kind: "graphic" },
			},
			counter()
		);
		const frames = result.project.graphics[0]?.keyframes ?? [];
		expect(new Set(frames.map((frame) => frame.property))).toEqual(
			new Set(["x", "y"])
		);
		expect(
			frames.find((frame) => frame.property === "x" && frame.time === 3)?.value
		).toBe(0.45);
	});

	test("a sticker clip moves in its ±1 coordinates and scales with the subject", () => {
		const { assets, clip, overlay, project } = scene();
		const result = applyTrack(
			project,
			assets,
			{
				path: linearPath(2, 4),
				region: { height: 0.1, width: 0.1, x: 0.25, y: 0.35 },
				segment: clip,
				target: { id: overlay.id, kind: "clip" },
			},
			counter()
		);
		const moved = result.project.segments.find(
			(segment) => segment.id === overlay.id
		);
		const at = (property: string, time: number) =>
			moved?.keyframes.find(
				(frame) => frame.property === property && frame.time === time
			)?.value;
		expect(at("x", 2)).toBe(-0.4);
		expect(at("x", 4)).toBe(0);
		expect(at("y", 4)).toBe(0);
		expect(at("scale", 4)).toBe(0.6);
		expect(() =>
			applyTrack(project, assets, {
				path: linearPath(2, 4),
				region: { height: 0.1, width: 0.1, x: 0.25, y: 0.35 },
				segment: clip,
				target: { id: clip.id, kind: "clip" },
			})
		).toThrow("its own");
	});

	test("a tracked clip's keyframes stay on their source moments when trimmed", () => {
		const { assets, clip, overlay, project } = scene();
		const result = applyTrack(
			project,
			assets,
			{
				path: linearPath(2, 4),
				region: { height: 0.1, width: 0.1, x: 0.25, y: 0.35 },
				segment: clip,
				target: { id: overlay.id, kind: "clip" },
			},
			counter()
		);
		const moved = result.project.segments.find(
			(segment) => segment.id === overlay.id
		);
		if (!moved) {
			throw new Error("no tracked clip");
		}
		for (const [edge, delta] of [
			["start", 2.5],
			["start", 3.2],
			["end", -6.5],
			["end", -7.25],
		] as const) {
			const trimmed = trimSegment(moved, 20, edge, delta);
			const shift = trimmed.start - moved.start;
			for (const property of ["x", "y", "scale"] as const) {
				for (let time = 0; time <= segmentDuration(trimmed); time += 0.05) {
					expect(animatedValue(trimmed, property, time)).toBeCloseTo(
						animatedValue(moved, property, time + shift),
						4
					);
				}
			}
		}
	});

	test("a blur region becomes an adjustment layer with a tracked mask", () => {
		const { assets, clip, project } = scene();
		const long = Array.from({ length: 900 }, (_, index) => ({
			scale: 1 + index / 3000,
			time: 1 + index / 30,
			x: 0.5 + 0.2 * Math.sin(index / 50),
			y: 0.5 + 0.1 * Math.cos(index / 31),
		}));
		const result = applyTrack(
			project,
			assets,
			{
				path: long,
				region: { height: 0.2, width: 0.1, x: 0.45, y: 0.5 },
				segment: clip,
				target: { createRegion: "mosaic" },
			},
			counter()
		);
		const layer = result.project.adjustmentLayers?.[0];
		expect(result.target).toEqual({
			id: layer?.id ?? "",
			kind: "adjustment-layer",
		});
		expect(layer).toMatchObject({
			label: "Tracked mosaic",
			start: 1,
			track: clip.track,
		});
		expect(layer?.end).toBeCloseTo(1 + 899 / 30, 5);
		expect(layer?.effects?.[0]?.type).toBe("mosaic");
		const mask = layer?.masks?.[0];
		expect(mask).toMatchObject({
			height: 0.2,
			shape: "rectangle",
			width: 0.1,
			x: 0,
			y: 0.2,
		});
		const frames = layer?.keyframes ?? [];
		expect(frames.length).toBeLessThanOrEqual(MAX_TARGET_KEYFRAMES);
		expect(frames.every((frame) => frame.target === mask?.id)).toBe(true);
		expect(new Set(frames.map((frame) => frame.property))).toEqual(
			new Set(["maskX", "maskY", "maskWidth", "maskHeight"])
		);
		const firstX = frames.find(
			(frame) => frame.property === "maskX" && frame.time === 0
		);
		expect(firstX?.value).toBe(0);
	});

	test("a target outside the tracked range is refused", () => {
		const { assets, clip, project } = scene();
		const target = project.titles[0];
		if (!target) {
			throw new Error("no title");
		}
		expect(() =>
			applyTrack(project, assets, {
				path: linearPath(7, 9),
				region: { height: 0.1, width: 0.1, x: 0.25, y: 0.35 },
				segment: clip,
				target: { id: target.id, kind: "title" },
			})
		).toThrow("does not overlap");
		expect(() =>
			applyTrack(project, assets, {
				path: linearPath(2, 4),
				region: { height: 0.1, width: 0.1, x: 0.25, y: 0.35 },
				segment: clip,
				target: { id: crypto.randomUUID(), kind: "graphic" },
			})
		).toThrow("not found");
	});
});

describe("review regressions", () => {
	test("a 24 fps path in a 30 fps project holds to the window end", () => {
		const { assets, clip, project } = scene();
		const window = trackWindow(clip, 7);
		// 24 fps analysis grid: the last sample lands 1/24 s before the end.
		const samples: TrackSample[] = Array.from({ length: 72 }, (_, index) => ({
			confidence: 1,
			scale: 1,
			time: 7 + index / 24,
			x: 0.5 + index * 0.001,
			y: 0.5,
		}));
		const path = canvasTrackPath(clip, HD, CANVAS, samples, window.end);
		expect(path.at(-1)?.time).toBe(10);
		expect(path.at(-1)?.x).toBeCloseTo(path.at(-2)?.x ?? 0, 9);
		const result = applyTrack(
			project,
			assets,
			{
				path,
				region: { height: 0.1, width: 0.1, x: 0.45, y: 0.45 },
				segment: clip,
				target: { createRegion: "blur" },
			},
			counter()
		);
		const layer = result.project.adjustmentLayers?.[0];
		expect(layer?.end).toBe(clip.start + segmentDuration(clip));
		// The last project frame (29/30 s before the end) is covered.
		expect((layer?.end ?? 0) >= 10 - 1 / project.fps).toBe(true);
	});

	test("canvasTrackPath adds nothing when the samples reach the end", () => {
		const { clip } = scene();
		const samples: TrackSample[] = [
			{ confidence: 1, scale: 1, time: 1, x: 0.5, y: 0.5 },
			{ confidence: 1, scale: 1, time: 2, x: 0.6, y: 0.5 },
		];
		expect(canvasTrackPath(clip, HD, CANVAS, samples, 2)).toHaveLength(2);
		expect(canvasTrackPath(clip, HD, CANVAS, samples)).toHaveLength(2);
	});

	test("a follower clip on a locked track is refused and not listed", () => {
		const { assets, clip, overlay, project } = scene();
		const locked: Project = {
			...project,
			trackSettings: [
				{
					locked: true,
					muted: false,
					name: "V2",
					solo: false,
					track: overlay.track,
				},
			],
		};
		expect(() =>
			applyTrack(
				locked,
				assets,
				{
					path: linearPath(2, 4),
					region: { height: 0.1, width: 0.1, x: 0.25, y: 0.35 },
					segment: clip,
					target: { id: overlay.id, kind: "clip" },
				},
				counter()
			)
		).toThrow("Unlock the clip track before editing the timeline.");
		expect(
			trackTargetsAt(locked, assets, clip.id, 2).map((item) => item.kind)
		).toEqual(["title", "graphic"]);
	});

	test("a pre-animated title follows from its pose at the reference frame", () => {
		const { assets, clip, project } = scene();
		const target = project.titles[0];
		if (!target) {
			throw new Error("no title");
		}
		// Title spans 1..6; x animates 0.5 -> 0.2 over its first second, scale
		// 1 -> 2, so at the path start (project 2, local 1) it sits at 0.2, 2x.
		const animated: Project = {
			...project,
			titles: [
				{
					...target,
					keyframes: [
						{ id: crypto.randomUUID(), property: "x", time: 0, value: 0.5 },
						{ id: crypto.randomUUID(), property: "x", time: 1, value: 0.2 },
						{ id: crypto.randomUUID(), property: "scale", time: 0, value: 1 },
						{ id: crypto.randomUUID(), property: "scale", time: 1, value: 2 },
					],
					x: 0.5,
				},
			],
		};
		const result = applyTrack(
			animated,
			assets,
			{
				path: linearPath(2, 4),
				region: { height: 0.1, width: 0.1, x: 0.25, y: 0.35 },
				segment: clip,
				target: { id: target.id, kind: "title" },
			},
			counter()
		);
		const frames = result.project.titles[0]?.keyframes ?? [];
		const values = (property: string) =>
			frames
				.filter((frame) => frame.property === property)
				.map((frame) => frame.value);
		expect(values("x")).toEqual([0.2, 0.4]);
		expect(values("scale")).toEqual([2, 2.4]);
	});

	test("a pre-animated graphic follows from its pose at the reference frame", () => {
		const { assets, clip, project } = scene();
		const target = project.graphics[0];
		if (!target) {
			throw new Error("no graphic");
		}
		const animated: Project = {
			...project,
			graphics: [
				{
					...target,
					keyframes: [
						{ id: crypto.randomUUID(), property: "y", time: 0, value: 0.35 },
						{ id: crypto.randomUUID(), property: "y", time: 1, value: 0.15 },
					],
				},
			],
		};
		const result = applyTrack(
			animated,
			assets,
			{
				path: linearPath(2, 4),
				region: { height: 0.1, width: 0.1, x: 0.25, y: 0.35 },
				segment: clip,
				target: { id: target.id, kind: "graphic" },
			},
			counter()
		);
		const ys = (result.project.graphics[0]?.keyframes ?? [])
			.filter((frame) => frame.property === "y")
			.map((frame) => frame.value);
		expect(ys).toEqual([0.15, 0.25]);
	});
});

describe("summaries and target lists", () => {
	test("summarizeTrack counts lost frames and averages confidence", () => {
		expect(
			summarizeTrack(
				[
					{ confidence: 1, scale: 1, time: 0, x: 0, y: 0 },
					{ confidence: 0.2, scale: 1, time: 1, x: 0, y: 0 },
				],
				0.45
			)
		).toEqual({ confidence: 0.6, lostFrames: 1, samples: 2 });
	});

	test("lists on-screen titles, graphics and other visual clips", () => {
		const { assets, clip, project } = scene();
		const kinds = trackTargetsAt(project, assets, clip.id, 2).map(
			(item) => item.kind
		);
		expect(kinds).toEqual(["title", "graphic", "clip"]);
		expect(trackTargetsAt(project, assets, clip.id, 8)).toHaveLength(1);
	});
});
