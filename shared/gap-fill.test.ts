import { describe, expect, test } from "bun:test";
import {
	applyGapFill,
	canGapFill,
	DEFAULT_GAP_FILL_DIRECTION,
	DEFAULT_GAP_FILL_ZOOM,
	gapFillBoundaryFrames,
	gapFillFrameTimes,
	gapFillGenerationRequest,
	gapFillMotionRequest,
	gapFillNeighbors,
	gapFillPrompt,
	gapFillRequestSchema,
	LOCAL_MOTION_CLIP_SECONDS,
	localMotionGapRefusal,
	MAX_LOCAL_MOTION_GAP_SECONDS,
	motionBridgeSeconds,
	motionGapRefusal,
	planGapFill,
	planGapFillMotion,
	stampGapFillAsset,
} from "./gap-fill.ts";
import { requestInputImageIds } from "./generation.ts";
import {
	type Asset,
	newProject,
	newSegment,
	type Project,
	type Segment,
	segmentDuration,
	validateProject,
} from "./project.ts";

const ID = (n: number) =>
	`00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function asset(n: number, kind: Asset["kind"], duration = 10): Asset {
	return {
		createdAt: "2026-01-01T00:00:00.000Z",
		duration,
		hasAudio: kind !== "image",
		height: kind === "audio" ? 0 : 720,
		id: ID(n),
		kind,
		name: `Asset ${n}`,
		width: kind === "audio" ? 0 : 1280,
	};
}

const video = asset(1, "video");
const still = {
	...asset(2, "image", 0),
	generation: { kind: "image" as const, prompt: "bridge" },
};
const voice = asset(3, "audio");
const assets = [video, still, voice];

function clip(
	n: number,
	start: number,
	length: number,
	options: Partial<Segment> = {}
): Segment {
	return {
		...newSegment(video, start, 0),
		id: ID(100 + n),
		sourceIn: 0,
		sourceOut: length,
		...options,
	};
}

function project(segments: Segment[], extra: Partial<Project> = {}): Project {
	return validateProject(
		{ ...newProject("Gap fill"), ...extra, segments },
		assets
	);
}

function ids() {
	let next = 900;
	return () => ID(next++);
}

const A = clip(1, 0, 4);
const gapB = clip(2, 6, 4);
const cutB = clip(2, 4, 4);

describe("gapFillNeighbors", () => {
	test("finds the next picture clip on the same track", () => {
		const other = clip(3, 5, 1, { track: 1 });
		const later = clip(4, 12, 2);
		const result = gapFillNeighbors(
			project([later, A, other, gapB]),
			assets,
			A.id
		);
		expect(result.next.id).toBe(gapB.id);
		expect(result.gap).toBe(2);
	});

	test("refuses the last clip, audio clips, and overlapping neighbours", () => {
		expect(() => gapFillNeighbors(project([A]), assets, A.id)).toThrow(
			"following clip"
		);
		const audio = { ...newSegment(voice, 0, 0), id: ID(150), sourceOut: 3 };
		expect(() =>
			gapFillNeighbors(project([audio, gapB]), assets, audio.id)
		).toThrow("not audio");
		const overlapping = clip(2, 3, 4);
		expect(() =>
			gapFillNeighbors({ segments: [A, overlapping] }, assets, A.id)
		).toThrow("already overlap");
		expect(canGapFill(project([A, gapB]), assets, A.id)).toBe(true);
		expect(canGapFill(project([A, gapB]), assets, gapB.id)).toBe(false);
	});
});

describe("planGapFill placement math", () => {
	test("a gap is filled with a default 0.5 s overlap on each side", () => {
		const plan = planGapFill(project([A, gapB]), assets, {
			afterClipId: A.id,
		});
		expect(plan).toEqual({
			dissolveIn: 0.5,
			dissolveOut: 0.5,
			end: 6.5,
			gap: 2,
			mode: "gap",
			nextClipId: gapB.id,
			overlapIn: 0.5,
			overlapOut: 0.5,
			previousClipId: A.id,
			start: 3.5,
			track: 0,
		});
	});

	test("a cut gets a 1 s bridge centred on the cut by default", () => {
		const plan = planGapFill(project([A, cutB]), assets, {
			afterClipId: A.id,
		});
		expect(plan.mode).toBe("cut");
		expect(plan.start).toBe(3.5);
		expect(plan.end).toBe(4.5);
		expect(plan.end - plan.start).toBe(1);
	});

	test("an explicit duration is centred on the gap", () => {
		const plan = planGapFill(project([A, gapB]), assets, {
			afterClipId: A.id,
			duration: 3,
		});
		expect(plan.start).toBe(3.5);
		expect(plan.end).toBe(6.5);
		const longer = planGapFill(project([A, gapB]), assets, {
			afterClipId: A.id,
			duration: 4,
		});
		expect([longer.start, longer.end]).toEqual([3, 7]);
		expect([longer.overlapIn, longer.overlapOut]).toEqual([1, 1]);
	});

	test("default overlaps shrink to fit short neighbours", () => {
		const shortA = clip(1, 0, 0.3);
		const shortB = clip(2, 1, 0.2);
		const plan = planGapFill(project([shortA, shortB]), assets, {
			afterClipId: shortA.id,
		});
		expect(plan.overlapIn).toBeCloseTo(0.26, 6);
		expect(plan.overlapOut).toBeCloseTo(0.2, 6);
		expect(plan.start).toBeGreaterThan(shortA.start);
	});

	test("durations that cannot fit are refused", () => {
		expect(() =>
			planGapFill(project([A, gapB]), assets, {
				afterClipId: A.id,
				duration: 2,
			})
		).toThrow("longer than");
		expect(() =>
			planGapFill(project([A, gapB]), assets, {
				afterClipId: A.id,
				duration: 12,
			})
		).toThrow("shorter duration");
	});
});

describe("applyGapFill", () => {
	test("places the still with dissolves on both sides and a Ken Burns push", () => {
		const base = project([A, gapB]);
		const result = applyGapFill(
			base,
			assets,
			{ afterClipId: A.id, assetId: still.id, revision: base.revision },
			ids()
		);
		expect(result.clipId).toBe(ID(900));
		expect(result.project.segments.map((segment) => segment.id)).toEqual([
			A.id,
			result.clipId,
			gapB.id,
		]);
		const bridge = result.project.segments[1];
		expect(bridge?.assetId).toBe(still.id);
		expect(bridge?.start).toBe(3.5);
		expect(bridge ? segmentDuration(bridge) : 0).toBe(3);
		expect(bridge?.transitionIn).toEqual({
			duration: 0.5,
			softness: 0.1,
			type: "dissolve",
		});
		expect(bridge?.fit).toBe("fill");
		expect(bridge?.keyframes).toEqual([
			{ id: ID(901), property: "scale", time: 0, value: 1 },
			{ id: ID(902), property: "scale", time: 3, value: DEFAULT_GAP_FILL_ZOOM },
		]);
		expect(result.project.segments[2]?.transitionIn).toEqual({
			duration: 0.5,
			softness: 0.1,
			type: "dissolve",
		});
		// Nothing else moved.
		expect(result.project.segments[0]).toEqual(A);
		expect(result.project.segments[2]?.start).toBe(gapB.start);
	});

	test("orders A, bridge, B even when B came before A in the array", () => {
		const other = { ...clip(3, 0, 8), track: 1 };
		const base = project([cutB, other, A]);
		const result = applyGapFill(
			base,
			assets,
			{ afterClipId: A.id, assetId: still.id, revision: base.revision },
			ids()
		);
		expect(result.project.segments.map((segment) => segment.id)).toEqual([
			other.id,
			A.id,
			result.clipId,
			cutB.id,
		]);
		expect(result.project.segments[3]?.transitionIn?.type).toBe("dissolve");
	});

	test("leaves B in place when it already follows A", () => {
		const other = { ...clip(3, 0, 8), track: 1 };
		const base = project([A, other, gapB]);
		const result = applyGapFill(
			base,
			assets,
			{ afterClipId: A.id, assetId: still.id, revision: base.revision },
			ids()
		);
		expect(result.project.segments.map((segment) => segment.id)).toEqual([
			A.id,
			result.clipId,
			other.id,
			gapB.id,
		]);
	});

	test("dissolve settings follow transitionDuration, clamped to the overlap", () => {
		const base = project([A, cutB]);
		const short = applyGapFill(
			base,
			assets,
			{
				afterClipId: A.id,
				assetId: still.id,
				duration: 2,
				revision: 0,
				transitionDuration: 0.25,
				zoom: 1,
			},
			ids()
		);
		const bridge = short.project.segments.find(
			(segment) => segment.id === short.clipId
		);
		expect(bridge?.transitionIn?.duration).toBe(0.25);
		expect(bridge?.keyframes).toEqual([]);
		expect(
			short.project.segments.find((segment) => segment.id === cutB.id)
				?.transitionIn?.duration
		).toBe(0.25);
		const long = applyGapFill(
			base,
			assets,
			{
				afterClipId: A.id,
				assetId: still.id,
				revision: 0,
				transitionDuration: 3,
			},
			ids()
		);
		expect(long.plan.dissolveIn).toBe(0.5);
		expect(long.plan.dissolveOut).toBe(0.5);
	});

	test("refuses locked tracks, non-image media, and unknown stills", () => {
		const locked = project([A, gapB], {
			trackSettings: [
				{ locked: true, muted: false, name: "V1", solo: false, track: 0 },
			],
		});
		const input = { afterClipId: A.id, assetId: still.id, revision: 0 };
		expect(() => applyGapFill(locked, assets, input)).toThrow("Unlock");
		const base = project([A, gapB]);
		expect(() =>
			applyGapFill(base, assets, { ...input, assetId: voice.id })
		).toThrow("still image or a generated motion clip");
		expect(() =>
			applyGapFill(base, assets, { ...input, assetId: ID(77) })
		).toThrow("not in the library");
		expect(() =>
			applyGapFill(base, assets, { ...input, extra: true } as never)
		).toThrow();
	});

	test("is deterministic for the same input and ids", () => {
		const base = project([A, gapB]);
		const input = { afterClipId: A.id, assetId: still.id, revision: 0 };
		expect(applyGapFill(base, assets, input, ids())).toEqual(
			applyGapFill(base, assets, input, ids())
		);
	});
});

describe("generation request and helpers", () => {
	test("sends both frames as input images, outgoing first", () => {
		const request = gapFillGenerationRequest({
			id: ID(500),
			nextFrameAssetId: ID(11),
			previousFrameAssetId: ID(10),
			projectId: ID(400),
		});
		expect(request.kind).toBe("image");
		expect(requestInputImageIds(request)).toEqual([ID(10), ID(11)]);
		expect(request.prompt).toContain(DEFAULT_GAP_FILL_DIRECTION);
		expect(gapFillPrompt("  rain at dusk ")).toContain(
			"Direction: rain at dusk"
		);
	});

	test("frame times sit inside each clip", () => {
		expect(gapFillFrameTimes({ next: gapB, previous: A }, 25)).toEqual({
			next: 6.02,
			previous: 3.96,
		});
	});

	test("stamps only generated media without a derivation", () => {
		expect(stampGapFillAsset(still).derivation).toBe("gap-fill");
		expect(stampGapFillAsset(video)).toBe(video);
		const edited = { ...still, derivation: "ai-edit" as const };
		expect(stampGapFillAsset(edited)).toBe(edited);
	});

	test("the request schema is strict and bounded", () => {
		const valid = { afterClipId: A.id, assetId: still.id, revision: 1 };
		expect(gapFillRequestSchema.parse(valid)).toEqual(valid);
		expect(() => gapFillRequestSchema.parse({ ...valid, zoom: 2 })).toThrow();
		expect(() =>
			gapFillRequestSchema.parse({ ...valid, duration: 0 })
		).toThrow();
	});
});

describe("Generate motion", () => {
	test("boundary frames are A's last shown frame and B's first shown frame", () => {
		const rated = { ...video, frameRate: 25 };
		const a = clip(1, 0, 4, { sourceIn: 1, sourceOut: 3.5 });
		const b = clip(2, 6, 4, { sourceIn: 2.02 });
		const frames = gapFillBoundaryFrames({ next: b, previous: a }, [rated]);
		// sourceOut 3.5 s at 25 fps ends after frame 87; sourceIn 2.02 s is in frame 50.
		expect(frames.previous).toEqual({
			assetId: video.id,
			frame: 87,
			kind: "video",
			sourceTime: 3.48,
		});
		expect(frames.next.frame).toBe(50);
		const onEdge = clip(1, 0, 4, { sourceIn: 0, sourceOut: 2 });
		expect(
			gapFillBoundaryFrames({ next: b, previous: onEdge }, [rated]).previous
				.frame
		).toBe(49);
		const stills = gapFillBoundaryFrames(
			{
				next: { ...newSegment(still, 6, 0), id: ID(5) },
				previous: { ...newSegment(still, 0, 0), id: ID(6) },
			},
			[still]
		);
		expect(stills.previous.frame).toBe(0);
		expect(stills.next.kind).toBe("image");
	});

	test("a motion clip fills the gap exactly, trimmed or slowed to fit", () => {
		const base = project([A, gapB]);
		const long = planGapFillMotion(base, assets, A.id, 5);
		expect(long).toMatchObject({
			end: 6,
			gap: 2,
			sourceOut: 2,
			speed: 1,
			start: 4,
		});
		const short = planGapFillMotion(base, assets, A.id, 1);
		expect(short).toMatchObject({ sourceOut: 1, speed: 0.5 });
		expect(() =>
			planGapFillMotion(project([A, cutB]), assets, A.id, 2)
		).toThrow("still bridge");
		const generated = {
			...asset(9, "video", 3),
			generation: { kind: "video" as const, prompt: "motion" },
		};
		const result = applyGapFill(
			base,
			[...assets, generated],
			{ afterClipId: A.id, assetId: generated.id, revision: 0 },
			ids()
		);
		const bridge = result.project.segments.find(
			(segment) => segment.id === result.clipId
		);
		expect(bridge).toMatchObject({
			sourceIn: 0,
			sourceOut: 2,
			speed: 1,
			start: 4,
		});
		expect(bridge?.transitionIn).toBeUndefined();
		expect(result.plan.dissolveIn).toBe(0);
	});

	test("a motion clip too short for the gap even at minimum speed is refused", () => {
		const farB = clip(2, 64, 4);
		const wide = project([A, farB]);
		// A ends at 4 s, so the gap is 60 s; a 5 s clip at 10% covers only 50 s.
		expect(() => planGapFillMotion(wide, assets, A.id, 5)).toThrow(
			"too short to fill"
		);
		expect(motionGapRefusal(60, 30)).toBeUndefined();
		expect(motionGapRefusal(120, 30)).toContain("up to 100 s");
		expect(() =>
			planGapFillMotion(project([A, clip(2, 130, 4)]), assets, A.id, 10)
		).toThrow("up to 100 s");
		// Exactly 10% fills it.
		expect(planGapFillMotion(wide, assets, A.id, 6)).toMatchObject({
			gap: 60,
			sourceOut: 6,
			speed: 0.1,
		});
	});

	test("a local motion clip caps the gap at its own length slowed to 10%", () => {
		expect(LOCAL_MOTION_CLIP_SECONDS).toBeCloseTo(2.0625);
		expect(MAX_LOCAL_MOTION_GAP_SECONDS).toBeCloseTo(20.625);
		expect(localMotionGapRefusal(20)).toBeUndefined();
		expect(localMotionGapRefusal(MAX_LOCAL_MOTION_GAP_SECONDS)).toBeUndefined();
		expect(localMotionGapRefusal(30)).toContain("fills gaps up to 20.6 s");
		// The widest accepted local gap still places: the clip at exactly 10%.
		const edge = project([A, clip(2, 4 + MAX_LOCAL_MOTION_GAP_SECONDS, 4)]);
		expect(
			planGapFillMotion(edge, assets, A.id, LOCAL_MOTION_CLIP_SECONDS).speed
		).toBeCloseTo(0.1);
	});

	test("the motion request is a first/last-frame task with both neighbours as inputs", () => {
		const request = gapFillMotionRequest({
			durationSeconds: motionBridgeSeconds(0.4),
			id: ID(600),
			model: "fal-ai/wan-flf2v",
			nextAssetId: ID(11),
			previousAssetId: ID(10),
			projectId: ID(400),
			provider: "fal",
			providerInput: {
				end_image_url: "$input_images.1",
				start_image_url: "$input_images.0",
			},
		});
		expect(request).toMatchObject({
			durationSeconds: 1,
			inputAssetIds: [ID(10), ID(11)],
			kind: "video",
			task: "flf",
		});
		expect(motionBridgeSeconds(30)).toBe(10);
	});
});
