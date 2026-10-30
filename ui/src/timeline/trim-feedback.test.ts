import { describe, expect, test } from "bun:test";
import {
	type Asset,
	newProject,
	newSegment,
	type Project,
	type Segment,
} from "../../../shared/project.ts";
import { createEditorStore } from "../editor/store.ts";
import { testVideo } from "../editor/test-runtime.ts";
import {
	createTrimFeedbackStore,
	FILMSTRIP_SEEK_END_GUARD,
	firstFrameTime,
	lastFrameTime,
	TRIM_FRAME_HEIGHT,
	trimFeedbackFrames,
	trimFeedbackStoreFor,
	trimFramePlan,
	trimFrameTile,
	trimProposalForToolDrag,
} from "./trim-feedback.ts";

const FPS = 30;

/** Two butted clips on track 0, each with source handles on both sides. */
function fixture() {
	const asset = testVideo("long.mp4", 60);
	const first: Segment = {
		...newSegment(asset, 0),
		sourceIn: 10,
		sourceOut: 20,
	};
	const second: Segment = {
		...newSegment(asset, 10),
		sourceIn: 30,
		sourceOut: 40,
	};
	const project: Project = {
		...newProject("Trim feedback"),
		fps: FPS,
		segments: [first, second],
	};
	return { asset, assets: [asset] as Asset[], first, project, second };
}

const frame = 1 / FPS;

describe("frame times", () => {
	test("first is source in, last is one timeline frame before source out", () => {
		const { first } = fixture();
		expect(firstFrameTime(first)).toBe(10);
		expect(lastFrameTime(first, FPS)).toBeCloseTo(20 - frame, 5);
	});

	test("the last frame steps by speed and never precedes source in", () => {
		const { first } = fixture();
		expect(lastFrameTime({ ...first, speed: 2 }, FPS)).toBeCloseTo(
			20 - 2 * frame,
			5
		);
		expect(
			lastFrameTime({ ...first, sourceIn: 10, sourceOut: 10.01 }, FPS)
		).toBe(10);
	});
});

describe("trimFeedbackFrames: slip", () => {
	test("shows the first and last frames of the slipped source range", () => {
		const { assets, first, project } = fixture();
		const feedback = trimFeedbackFrames(project, assets, {
			clipId: first.id,
			delta: 2,
			mode: "slip",
		});
		expect(feedback?.mode).toBe("slip");
		expect(feedback?.frames.map((f) => f.role)).toEqual(["first", "last"]);
		expect(feedback?.frames.every((f) => f.assetId === first.assetId)).toBe(
			true
		);
		expect(feedback?.frames[0]?.time ?? 0).toBeCloseTo(12, 5);
		expect(feedback?.frames[1]?.time ?? 0).toBeCloseTo(22 - frame, 5);
	});

	test("clamps to the source handles like the committed slip", () => {
		const { assets, first, project } = fixture();
		const feedback = trimFeedbackFrames(project, assets, {
			clipId: first.id,
			delta: -50,
			mode: "slip",
		});
		expect(feedback?.frames[0]?.time ?? -1).toBeCloseTo(0, 5);
		expect(feedback?.frames[1]?.time ?? -1).toBeCloseTo(10 - frame, 5);
	});

	test("quantizes to whole frames", () => {
		const { assets, first, project } = fixture();
		const feedback = trimFeedbackFrames(project, assets, {
			clipId: first.id,
			delta: 0.51,
			mode: "slip",
		});
		expect(feedback?.frames[0]?.time ?? 0).toBeCloseTo(
			10 + Math.round(0.51 * FPS) / FPS,
			5
		);
	});

	test("returns null for a still, which has no source to slip", () => {
		const image: Asset = { ...testVideo("still.png", 0), kind: "image" };
		const still = newSegment(image, 0);
		const project = { ...newProject("Still"), segments: [still] };
		expect(
			trimFeedbackFrames(project, [image], {
				clipId: still.id,
				delta: 1,
				mode: "slip",
			})
		).toBeNull();
	});

	test("returns null for a missing clip", () => {
		const { assets, project } = fixture();
		expect(
			trimFeedbackFrames(project, assets, {
				clipId: crypto.randomUUID(),
				delta: 1,
				mode: "slip",
			})
		).toBeNull();
	});
});

describe("trimFeedbackFrames: roll", () => {
	test("shows the outgoing last frame and incoming first frame at the new edit point", () => {
		const { assets, first, project, second } = fixture();
		const feedback = trimFeedbackFrames(project, assets, {
			delta: 1,
			inClipId: second.id,
			mode: "roll",
			outClipId: first.id,
		});
		expect(feedback?.mode).toBe("roll");
		expect(feedback?.frames.map((f) => [f.role, f.clipId])).toEqual([
			["outgoing", first.id],
			["incoming", second.id],
		]);
		expect(feedback?.frames[0]?.time ?? 0).toBeCloseTo(21 - frame, 5);
		expect(feedback?.frames[1]?.time ?? 0).toBeCloseTo(31, 5);
	});

	test("rolling left reveals earlier incoming source", () => {
		const { assets, first, project, second } = fixture();
		const feedback = trimFeedbackFrames(project, assets, {
			delta: -2,
			inClipId: second.id,
			mode: "roll",
			outClipId: first.id,
		});
		expect(feedback?.frames[0]?.time ?? 0).toBeCloseTo(18 - frame, 5);
		expect(feedback?.frames[1]?.time ?? 0).toBeCloseTo(28, 5);
	});

	test("returns null when the clips do not meet", () => {
		const { assets, first, project, second } = fixture();
		const apart = {
			...project,
			segments: [first, { ...second, start: 12 }],
		};
		expect(
			trimFeedbackFrames(apart, assets, {
				delta: 1,
				inClipId: second.id,
				mode: "roll",
				outClipId: first.id,
			})
		).toBeNull();
	});
});

describe("trimFeedbackFrames: ripple", () => {
	test("an end ripple shows the trimmed clip's new last frame and the next clip's first", () => {
		const { assets, first, project, second } = fixture();
		const feedback = trimFeedbackFrames(project, assets, {
			clipId: first.id,
			delta: -3,
			edge: "end",
			mode: "ripple",
		});
		expect(feedback?.mode).toBe("ripple");
		expect(feedback?.frames.map((f) => [f.role, f.clipId])).toEqual([
			["outgoing", first.id],
			["incoming", second.id],
		]);
		expect(feedback?.frames[0]?.time ?? 0).toBeCloseTo(17 - frame, 5);
		expect(feedback?.frames[1]?.time ?? 0).toBeCloseTo(30, 5);
	});

	test("a start ripple shows the previous clip's last frame and the new first frame", () => {
		const { assets, first, project, second } = fixture();
		const feedback = trimFeedbackFrames(project, assets, {
			clipId: second.id,
			delta: 2,
			edge: "start",
			mode: "ripple",
		});
		expect(feedback?.frames.map((f) => [f.role, f.clipId])).toEqual([
			["outgoing", first.id],
			["incoming", second.id],
		]);
		expect(feedback?.frames[0]?.time ?? 0).toBeCloseTo(20 - frame, 5);
		expect(feedback?.frames[1]?.time ?? 0).toBeCloseTo(32, 5);
	});

	test("an edge with no butted neighbour shows only the trimmed frame", () => {
		const { assets, first, project } = fixture();
		const feedback = trimFeedbackFrames(project, assets, {
			clipId: first.id,
			delta: 1,
			edge: "start",
			mode: "ripple",
		});
		expect(feedback?.frames.map((f) => f.role)).toEqual(["incoming"]);
		expect(feedback?.frames[0]?.time ?? 0).toBeCloseTo(11, 5);
	});
});

describe("trimProposalForToolDrag", () => {
	test("slip uses the committed request's source delta (drag left reveals later source)", () => {
		const { first, project } = fixture();
		expect(trimProposalForToolDrag(project, "slip", first, "move", -1)).toEqual(
			{ clipId: first.id, delta: 1, mode: "slip" }
		);
	});

	test("roll finds the neighbour at the dragged edge", () => {
		const { first, project, second } = fixture();
		expect(trimProposalForToolDrag(project, "roll", first, "end", 0.5)).toEqual(
			{ delta: 0.5, inClipId: second.id, mode: "roll", outClipId: first.id }
		);
		expect(
			trimProposalForToolDrag(project, "roll", second, "start", 0.5)
		).toEqual({
			delta: 0.5,
			inClipId: second.id,
			mode: "roll",
			outClipId: first.id,
		});
	});

	test("ripple keeps the edge", () => {
		const { first, project } = fixture();
		expect(
			trimProposalForToolDrag(project, "ripple", first, "end", -1)
		).toEqual({ clipId: first.id, delta: -1, edge: "end", mode: "ripple" });
	});

	test("pointer, slide, and impossible rolls show no viewer", () => {
		const { first, project } = fixture();
		expect(
			trimProposalForToolDrag(project, "pointer", first, "move", 1)
		).toBeNull();
		expect(
			trimProposalForToolDrag(project, "slide", first, "move", 1)
		).toBeNull();
		expect(
			trimProposalForToolDrag(project, "roll", first, "start", 1)
		).toBeNull();
	});
});

describe("trimFramePlan", () => {
	/** Source time the route samples for the plan's last tile. */
	const lastTileSample = (plan: {
		count: number;
		end: number;
		start: number;
	}) => plan.end - (plan.end - plan.start) / plan.count / 2;

	test("samples one millisecond into the frame's source time", () => {
		const { asset } = fixture();
		expect(trimFramePlan({ assetId: asset.id, time: 12.5 }, asset)).toEqual({
			assetId: asset.id,
			count: 1,
			end: 12.502,
			height: TRIM_FRAME_HEIGHT,
			start: 12.5,
		});
		expect(trimFrameTile({ count: 1 })).toBe(0);
	});

	test("rounds the start down so FFmpeg's seek never skips the frame", () => {
		const { asset } = fixture();
		const plan = trimFramePlan({ assetId: asset.id, time: 2.5 - frame }, asset);
		expect(plan?.start).toBe(2.466);
		expect(plan?.end).toBe(2.468);
	});

	test("the sample never reaches the next frame of fast media", () => {
		const { asset } = fixture();
		// 240 fps media: frames are ~4.17 ms apart.
		for (let index = 0; index < 240; index += 1) {
			const time = 5 + index / 240;
			const plan = trimFramePlan({ assetId: asset.id, time }, asset);
			if (!plan) {
				throw new Error("expected a plan");
			}
			const sample = lastTileSample(plan);
			expect(sample).toBeGreaterThan(time);
			expect(sample).toBeLessThan(time + 1 / 240);
		}
	});

	test("never starts inside the route's end seek guard", () => {
		const { asset } = fixture();
		// Regression: 60 fps media, last frame at 59.983333 sits inside the
		// final 50 ms; the route would clamp a later seek and show an earlier frame.
		for (const time of [59.95, 59.966_667, 59.983_333, 59.99, 60]) {
			const plan = trimFramePlan({ assetId: asset.id, time }, asset);
			if (!plan) {
				throw new Error("expected a plan");
			}
			expect(plan.start).toBeLessThanOrEqual(60 - FILMSTRIP_SEEK_END_GUARD);
			expect(plan.end).toBeLessThanOrEqual(60);
			expect(plan.count).toBeLessThanOrEqual(60);
			expect(trimFrameTile(plan)).toBe(plan.count - 1);
			const sample = lastTileSample(plan);
			const target = Math.min(time, 59.998);
			expect(sample).toBeGreaterThan(target - 1e-9);
			expect(sample).toBeLessThan(target + 0.002);
		}
		expect(
			trimFramePlan({ assetId: asset.id, time: 59.983_333 }, asset)
		).toEqual({
			assetId: asset.id,
			count: 2,
			end: 60,
			height: TRIM_FRAME_HEIGHT,
			start: 59.936,
		});
	});

	test("short media is read from its start", () => {
		const short = { ...testVideo("short.mp4", 0.04) };
		const plan = trimFramePlan({ assetId: short.id, time: 0.02 }, short);
		expect(plan?.start).toBe(0);
		expect(plan?.end).toBe(0.04);
	});

	test("audio has no picture; a still always shows its image", () => {
		const audio = { ...testVideo("a.wav", 4), kind: "audio" as const };
		const image = { ...testVideo("i.png", 4), kind: "image" as const };
		expect(trimFramePlan({ assetId: audio.id, time: 1 }, audio)).toBe(null);
		expect(trimFramePlan({ assetId: image.id, time: 3 }, image)).toMatchObject({
			count: 1,
			end: 1,
			start: 0,
		});
		expect(trimFramePlan({ assetId: "x", time: 1 }, undefined)).toBe(null);
	});
});

describe("trim feedback channel", () => {
	test("notifies only on real changes and clears", () => {
		const channel = createTrimFeedbackStore();
		let calls = 0;
		const unsubscribe = channel.subscribe(() => {
			calls += 1;
		});
		const proposal = { clipId: "a", delta: 1, mode: "slip" as const };
		channel.set(proposal);
		channel.set({ ...proposal });
		expect(calls).toBe(1);
		expect(channel.get()).toEqual(proposal);
		channel.clear();
		expect(channel.get()).toBeNull();
		expect(calls).toBe(2);
		unsubscribe();
		channel.set(proposal);
		expect(calls).toBe(2);
	});

	test("is one channel per editor store", () => {
		const store = createEditorStore();
		expect(trimFeedbackStoreFor(store)).toBe(trimFeedbackStoreFor(store));
		expect(trimFeedbackStoreFor(store)).not.toBe(
			trimFeedbackStoreFor(createEditorStore())
		);
		expect(trimFeedbackStoreFor(null)).toBe(trimFeedbackStoreFor(undefined));
	});
});
