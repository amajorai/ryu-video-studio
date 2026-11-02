import { describe, expect, test } from "bun:test";
import {
	copyKeyframes,
	pasteKeyframes,
	pasteKeyframesBetweenClips,
	pasteKeyframesRequestSchema,
} from "./keyframe-clipboard.ts";
import {
	type Keyframe,
	newProject,
	newSegment,
	type Segment,
	updateTrackSetting,
} from "./project.ts";

const source = {
	createdAt: new Date().toISOString(),
	duration: 20,
	hasAudio: true,
	height: 360,
	id: crypto.randomUUID(),
	kind: "video" as const,
	name: "Clip",
	width: 640,
};

const effectId = crypto.randomUUID();

/** A clip of `length` seconds starting at `start` on `track`. */
const clipOf = (length: number, start = 0, track = 0): Segment => ({
	...newSegment(source, start, track),
	sourceOut: length,
});

const frame = (keyframe: Omit<Keyframe, "id">): Keyframe => ({
	...keyframe,
	id: crypto.randomUUID(),
});

function animated(start = 0, length = 6): Segment {
	const segment = clipOf(length, start);
	segment.effects = [
		{ amount: 0.5, enabled: true, id: effectId, type: "blur" },
	];
	segment.keyframes = [
		frame({ property: "x", time: 1, value: -0.5, interpolation: "ease-in" }),
		frame({ property: "x", time: 2, value: 0.5 }),
		frame({
			property: "opacity",
			time: 1.5,
			value: 0.2,
			interpolation: "bezier",
			bezier: [0.25, 0.1, 0.25, 1],
		}),
		frame({ property: "effectAmount", target: effectId, time: 3, value: 1 }),
	];
	return segment;
}

describe("copyKeyframes", () => {
	test("offsets start at the earliest copied keyframe", () => {
		const payload = copyKeyframes(animated());
		expect(payload.span).toBe(2);
		expect(payload.items.map((item) => [item.property, item.offset])).toEqual([
			["x", 0],
			["opacity", 0.5],
			["x", 1],
			["effectAmount", 2],
		]);
		expect(payload.items[1]).toMatchObject({
			bezier: [0.25, 0.1, 0.25, 1],
			interpolation: "bezier",
		});
		expect(payload.items[3]?.target).toBe(effectId);
	});

	test("narrows by property, id and time window", () => {
		const segment = animated();
		expect(copyKeyframes(segment, { properties: ["x"] }).items).toHaveLength(2);
		const id = segment.keyframes[2]?.id as string;
		expect(copyKeyframes(segment, { ids: [id] })).toEqual({
			items: [
				{
					bezier: [0.25, 0.1, 0.25, 1],
					interpolation: "bezier",
					offset: 0,
					property: "opacity",
					value: 0.2,
				},
			],
			span: 0,
		});
		expect(
			copyKeyframes(segment, { range: { end: 2, start: 1.5 } }).items.map(
				(item) => item.offset
			)
		).toEqual([0, 0.5]);
		expect(copyKeyframes(clipOf(4))).toEqual({ items: [], span: 0 });
	});
});

describe("pasteKeyframes", () => {
	test("lands the first keyframe at the paste time and keeps curves", () => {
		const target = clipOf(8);
		target.effects = [
			{ amount: 0.5, enabled: true, id: effectId, type: "blur" },
		];
		const result = pasteKeyframes(target, copyKeyframes(animated()), 4);
		expect(result).toMatchObject({ pasted: 4, skipped: 0 });
		expect(
			result.segment.keyframes.map((item) => [item.property, item.time])
		).toEqual([
			["x", 4],
			["opacity", 4.5],
			["x", 5],
			["effectAmount", 6],
		]);
		expect(result.segment.keyframes[0]?.interpolation).toBe("ease-in");
	});

	test("replaces keyframes on the same channel and time", () => {
		const target = animated();
		const existing = target.keyframes[0]?.id;
		const result = pasteKeyframes(
			target,
			copyKeyframes(animated(), { properties: ["x"] }),
			1
		);
		const xFrames = result.segment.keyframes.filter(
			(item) => item.property === "x"
		);
		expect(xFrames).toHaveLength(2);
		expect(xFrames.some((item) => item.id === existing)).toBe(false);
	});

	test("skips keyframes past the end or without their effect", () => {
		const target = clipOf(2);
		const result = pasteKeyframes(target, copyKeyframes(animated()), 1);
		// x at 1 and opacity at 1.5 fit; x at 2 fits on the end; the effect
		// keyframe has no effect on the target.
		expect(result).toMatchObject({ pasted: 3, skipped: 1 });
		const late = pasteKeyframes(target, copyKeyframes(animated()), 1.6);
		expect(late.pasted).toBe(1);
	});

	test("clamps values to the property range", () => {
		const target = clipOf(4);
		const result = pasteKeyframes(
			target,
			{ items: [{ offset: 0, property: "opacity", value: 5 }], span: 0 },
			0
		);
		expect(result.segment.keyframes[0]?.value).toBe(1);
	});
});

describe("pasteKeyframesBetweenClips", () => {
	function setup() {
		const project = newProject("Paste keyframes");
		const from = animated(0, 6);
		const first = clipOf(6, 6);
		first.effects = [
			{ amount: 0.5, enabled: true, id: effectId, type: "blur" },
		];
		const second = { ...clipOf(4), track: 1 };
		project.segments = [from, first, second];
		return { first, from, project, second };
	}

	test("pastes onto several clips as one validated edit", () => {
		const { first, from, project, second } = setup();
		const result = pasteKeyframesBetweenClips(project, [source], {
			at: 0.5,
			properties: ["x", "opacity", "effectAmount"],
			revision: project.revision,
			sourceClipId: from.id,
			targetClipIds: [first.id, second.id],
		});
		expect(result.pasted).toBe(7);
		expect(result.skipped).toBe(1);
		const pasted = result.project.segments.find(
			(segment) => segment.id === first.id
		);
		expect(pasted?.keyframes.map((item) => item.time)).toEqual([
			0.5, 1, 1.5, 2.5,
		]);
	});

	test("refuses locked targets, unknown clips and empty copies", () => {
		const { first, from, project } = setup();
		const input = {
			at: 0,
			revision: project.revision,
			sourceClipId: from.id,
			targetClipIds: [first.id],
		};
		expect(() =>
			pasteKeyframesBetweenClips(
				updateTrackSetting(project, 0, { locked: true }),
				[source],
				input
			)
		).toThrow("Unlock");
		expect(() =>
			pasteKeyframesBetweenClips(project, [source], {
				...input,
				targetClipIds: [crypto.randomUUID()],
			})
		).toThrow("Target clip not found");
		expect(() =>
			pasteKeyframesBetweenClips(project, [source], {
				...input,
				sourceClipId: first.id,
			})
		).toThrow("no matching keyframes");
		expect(() =>
			pasteKeyframesBetweenClips(project, [source], { ...input, at: 7000 })
		).toThrow("No copied keyframe fits");
	});

	test("the request schema is strict and bounded", () => {
		const { first, from, project } = setup();
		const base = {
			at: 0,
			revision: project.revision,
			sourceClipId: from.id,
			targetClipIds: [first.id],
		};
		expect(pasteKeyframesRequestSchema.safeParse(base).success).toBe(true);
		expect(
			pasteKeyframesRequestSchema.safeParse({ ...base, extra: true }).success
		).toBe(false);
		expect(
			pasteKeyframesRequestSchema.safeParse({ ...base, targetClipIds: [] })
				.success
		).toBe(false);
		expect(
			pasteKeyframesRequestSchema.safeParse({
				...base,
				range: { end: 1, start: 2 },
			}).success
		).toBe(false);
	});
});
