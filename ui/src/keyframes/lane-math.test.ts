import { describe, expect, test } from "bun:test";
import { setKeyframesRequestSchema } from "../../../shared/keyframe-edits.ts";
import {
	type Asset,
	type Keyframe,
	newSegment,
	type Segment,
} from "../../../shared/project.ts";
import { SNAP_PRIORITY } from "../../../shared/timeline-snap.ts";
import {
	channelRequest,
	curvePoints,
	dragDiamond,
	draggedKeyframeTime,
	fractionValue,
	GRAPH_ROW_PX,
	keyframeSnapTargets,
	LANE_INSET_PX,
	laneChannels,
	nudgeKeyframe,
	nudgeValue,
	timeAtOffset,
	VOLUME_CEILING_DB,
	VOLUME_FLOOR_DB,
	valueFraction,
	valueToY,
	withoutKeyframe,
	yToValue,
} from "./lane-math.ts";

const asset: Asset = {
	createdAt: new Date(0).toISOString(),
	duration: 20,
	hasAudio: true,
	height: 360,
	id: crypto.randomUUID(),
	kind: "video",
	name: "lane.mp4",
	width: 640,
};

const frame = (
	property: Keyframe["property"],
	time: number,
	value: number,
	extra: Partial<Keyframe> = {}
): Keyframe => ({
	id: crypto.randomUUID(),
	property,
	time,
	value,
	...extra,
});

function clip(keyframes: Keyframe[] = []): Segment {
	return { ...newSegment(asset, 2), keyframes, sourceOut: 6 };
}

describe("value mapping", () => {
	test("linear properties map their schema range onto the lane", () => {
		expect(valueFraction("opacity", 0)).toBe(0);
		expect(valueFraction("opacity", 1)).toBe(1);
		expect(valueFraction("rotation", 0)).toBe(0.5);
		expect(valueToY("opacity", 1, GRAPH_ROW_PX)).toBe(LANE_INSET_PX);
		expect(valueToY("opacity", 0, GRAPH_ROW_PX)).toBe(
			GRAPH_ROW_PX - LANE_INSET_PX
		);
		for (const value of [0, 0.25, 0.5, 0.8, 1]) {
			const y = valueToY("opacity", value, GRAPH_ROW_PX);
			expect(yToValue("opacity", y, GRAPH_ROW_PX)).toBeCloseTo(value, 3);
		}
	});

	test("volume uses a decibel scale from the floor to the clip gain ceiling", () => {
		expect(valueFraction("volume", 0)).toBe(0);
		expect(valueFraction("volume", 4)).toBeCloseTo(1, 9);
		// 0 dB (unity) sits at the scale's 0 dB position, not halfway in gain.
		const unity = -VOLUME_FLOOR_DB / (VOLUME_CEILING_DB - VOLUME_FLOOR_DB);
		expect(valueFraction("volume", 1)).toBeCloseTo(unity, 9);
		expect(fractionValue("volume", unity)).toBeCloseTo(1, 2);
		// The bottom mutes; values clamp to the gain range.
		expect(fractionValue("volume", 0)).toBe(0);
		expect(fractionValue("volume", 2)).toBe(4);
		// A y beyond the lane clamps rather than overflowing.
		expect(yToValue("volume", -50, GRAPH_ROW_PX)).toBe(4);
		expect(yToValue("volume", 500, GRAPH_ROW_PX)).toBe(0);
	});

	test("volume values round to a tenth of a decibel", () => {
		const value = fractionValue("volume", 0.5);
		const db = 20 * Math.log10(value);
		expect(Math.round(db * 10) / 10).toBeCloseTo(db, 4);
	});
});

describe("drag-to-keyframe mapping", () => {
	const base = {
		duration: 6,
		fps: 30,
		snapTargets: [],
		snapping: false,
		zoom: 100,
	};

	test("horizontal travel moves time by pixels over zoom, frame-quantized", () => {
		expect(draggedKeyframeTime({ ...base, dxPx: 50, startTime: 1 })).toBe(1.5);
		const quantized = draggedKeyframeTime({ ...base, dxPx: 51, startTime: 1 });
		expect(quantized * 30).toBeCloseTo(Math.round(quantized * 30), 6);
		expect(quantized).toBeCloseTo(1.5, 6);
	});

	test("a drag stays a frame inside its neighbours and inside the clip", () => {
		expect(
			draggedKeyframeTime({
				...base,
				dxPx: 500,
				next: 3,
				startTime: 1,
			})
		).toBeCloseTo(3 - 1 / 30, 6);
		expect(
			draggedKeyframeTime({
				...base,
				dxPx: -500,
				previous: 0.5,
				startTime: 1,
			})
		).toBeCloseTo(0.5 + 1 / 30, 6);
		expect(draggedKeyframeTime({ ...base, dxPx: -500, startTime: 1 })).toBe(0);
		expect(draggedKeyframeTime({ ...base, dxPx: 5000, startTime: 1 })).toBe(6);
	});

	test("with snapping on, a nearby target captures the keyframe", () => {
		const snapTargets = [
			{
				kind: "playhead" as const,
				priority: SNAP_PRIORITY.playhead,
				time: 2.013,
			},
		];
		// 1 + 104px/100 = 2.04 is 2.7 px from the playhead at zoom 100.
		expect(
			draggedKeyframeTime({
				...base,
				dxPx: 104,
				snapping: true,
				snapTargets,
				startTime: 1,
			})
		).toBe(2.013);
		// Snapping off ignores the target.
		expect(
			draggedKeyframeTime({ ...base, dxPx: 104, snapTargets, startTime: 1 })
		).toBeCloseTo(2.033_333, 5);
	});

	test("dragDiamond changes time in the lanes view and value in the graph view", () => {
		const frames = [
			frame("opacity", 0, 1),
			frame("opacity", 2, 0.5),
			frame("opacity", 4, 0),
		];
		const id = frames[1]?.id as string;
		const lanes = dragDiamond({
			...base,
			dxPx: 50,
			dyPx: 30,
			frames,
			height: GRAPH_ROW_PX,
			id,
			property: "opacity",
			vertical: false,
		});
		expect(lanes[1]).toMatchObject({ id, time: 2.5, value: 0.5 });
		expect(lanes[0]).toBe(frames[0] as Keyframe);
		const graph = dragDiamond({
			...base,
			dxPx: 0,
			dyPx: -(GRAPH_ROW_PX - 2 * LANE_INSET_PX) / 4,
			frames,
			height: GRAPH_ROW_PX,
			id,
			property: "opacity",
			vertical: true,
		});
		expect(graph[1]?.time).toBe(2);
		expect(graph[1]?.value).toBeCloseTo(0.75, 4);
	});

	test("snap targets are clip-relative and skip the dragged channel", () => {
		const own = frame("opacity", 1, 1);
		const other = frame("scale", 3, 1.5);
		const segment = clip([own, other]);
		const targets = keyframeSnapTargets(segment, {
			excludeIds: new Set([own.id]),
			markerTimes: [4, 40],
			playhead: 3.5,
		});
		expect(targets.map((target) => [target.kind, target.time])).toEqual([
			["clip-start", 0],
			["clip-end", 6],
			["playhead", 1.5],
			["marker", 2],
			["keyframe", 3],
		]);
	});

	test("nudges move by whole frames and value hundredths", () => {
		const frames = [frame("opacity", 1, 0.5), frame("opacity", 2, 1)];
		const id = frames[0]?.id as string;
		expect(nudgeKeyframe(frames, id, 3, 30, 6)[0]?.time).toBeCloseTo(1.1, 6);
		expect(nudgeKeyframe(frames, id, 300, 30, 6)[0]?.time).toBeCloseTo(
			2 - 1 / 30,
			6
		);
		expect(nudgeValue(frames, id, "opacity", 10)[0]?.value).toBeCloseTo(0.6, 6);
		expect(nudgeValue(frames, id, "opacity", 100)[0]?.value).toBe(1);
		expect(withoutKeyframe(frames, id)).toHaveLength(1);
	});

	test("timeAtOffset maps a pointer offset to a frame inside the clip", () => {
		expect(timeAtOffset(150, 100, 30, 6)).toBe(1.5);
		expect(timeAtOffset(-10, 100, 30, 6)).toBe(0);
		expect(timeAtOffset(10_000, 100, 30, 6)).toBe(6);
	});
});

describe("lanes and saves", () => {
	test("one lane per animated channel, in property order", () => {
		const segment = clip([
			frame("volume", 1, 0.5),
			frame("opacity", 2, 0.4),
			frame("opacity", 0, 1),
			frame("effectAmount", 1, 0.2, { target: "fx-1" }),
		]);
		const lanes = laneChannels(segment);
		expect(lanes.map((lane) => lane.key)).toEqual([
			"opacity",
			"volume",
			"effectAmount:fx-1",
		]);
		expect(lanes[0]?.frames.map((item) => item.time)).toEqual([0, 2]);
		expect(lanes[0]?.label).toBe("Opacity");
	});

	test("the channel request carries interpolation and Bezier controls", () => {
		const segment = clip();
		const frames = [
			frame("opacity", 2, 0, {}),
			frame("opacity", 0, 1, {
				bezier: [0.34, 1.56, 0.64, 1],
				interpolation: "bezier",
			}),
		];
		const request = channelRequest(segment, { property: "opacity" }, frames, 7);
		expect(request).toEqual({
			clipId: segment.id,
			keyframes: [
				{
					bezier: [0.34, 1.56, 0.64, 1],
					interpolation: "bezier",
					time: 0,
					value: 1,
				},
				{ time: 2, value: 0 },
			],
			property: "opacity",
			revision: 7,
		});
		expect(setKeyframesRequestSchema.safeParse(request).success).toBe(true);
		const targeted = channelRequest(
			segment,
			{ property: "effectAmount", target: "fx-1" },
			[frame("effectAmount", 1, 0.5, { target: "fx-1" })],
			0
		);
		expect(targeted.target).toBe("fx-1");
	});

	test("the drawn curve passes through each keyframe", () => {
		const segment = clip([frame("opacity", 1, 0), frame("opacity", 3, 1)]);
		const points = curvePoints(
			segment,
			{ property: "opacity" },
			{
				height: GRAPH_ROW_PX,
				width: 600,
				zoom: 100,
			}
		)
			.split(" ")
			.map((pair) => pair.split(",").map(Number));
		const at = (x: number) => points.find(([px]) => px === x)?.[1];
		expect(at(100)).toBeCloseTo(valueToY("opacity", 0, GRAPH_ROW_PX), 2);
		expect(at(300)).toBeCloseTo(valueToY("opacity", 1, GRAPH_ROW_PX), 2);
		expect(at(600)).toBeCloseTo(valueToY("opacity", 1, GRAPH_ROW_PX), 2);
	});
});
