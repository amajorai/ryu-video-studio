import { describe, expect, test } from "bun:test";
import { animatedValue } from "./animation.ts";
import { groupTrim } from "./group-edits.ts";
import {
	type Asset,
	type Avatar,
	newProject,
	newSegment,
	type Project,
	rippleDeleteRange,
	type Segment,
	segmentDuration,
	trimSegment,
	validateProject,
} from "./project.ts";
import { resetSpeedRamp, speedRamp } from "./speed-ramp.ts";
import { trimEdit } from "./trim-modes.ts";

/**
 * Regression tests for edits from W1 (trim modes, group trim, ripple, speed
 * ramp ripple) meeting W2/W3 clip fields (edge transitions, mask and color
 * keyframes, adjustment layers, lip-sync links).
 */

function media(kind: Asset["kind"] = "video", duration = 20): Asset {
	return {
		createdAt: new Date(0).toISOString(),
		duration,
		hasAudio: kind !== "image",
		height: kind === "audio" ? 0 : 360,
		id: crypto.randomUUID(),
		kind,
		name: kind,
		width: kind === "audio" ? 0 : 640,
	};
}

function clip(
	source: Asset,
	start: number,
	sourceIn: number,
	sourceOut: number,
	extra: Partial<Segment> = {}
): Segment {
	return { ...newSegment(source, start, 0), sourceIn, sourceOut, ...extra };
}

function timeline(
	assets: Asset[],
	segments: Segment[],
	extra: Partial<Project> = {}
): Project {
	return validateProject(
		{ ...newProject("Integration"), segments, ...extra },
		assets
	);
}

const find = (project: Project, id: string) => {
	const found = project.segments.find((segment) => segment.id === id);
	if (!found) {
		throw new Error("missing clip");
	}
	return found;
};

const reveal = { duration: 1, softness: 0, type: "wipe-left" as const };

function maskedClip(source: Asset, start: number, length: number) {
	const maskId = crypto.randomUUID();
	return {
		maskId,
		segment: clip(source, start, 0, length, {
			keyframes: [
				{
					id: crypto.randomUUID(),
					property: "maskX",
					target: maskId,
					time: 0,
					value: -0.5,
				},
				{
					id: crypto.randomUUID(),
					property: "maskX",
					target: maskId,
					time: length,
					value: 0.5,
				},
				{ id: crypto.randomUUID(), property: "brightness", time: 0, value: 0 },
				{
					id: crypto.randomUUID(),
					property: "brightness",
					time: length,
					value: 0.4,
				},
				{
					id: crypto.randomUUID(),
					interpolation: "ease-in-out",
					property: "opacity",
					time: 0,
					value: 0,
				},
				{
					id: crypto.randomUUID(),
					property: "opacity",
					time: length,
					value: 1,
				},
			],
			masks: [
				{
					feather: 0,
					height: 0.5,
					id: maskId,
					invert: false,
					opacity: 1,
					rotation: 0,
					shape: "rectangle",
					width: 0.5,
					x: 0,
					y: 0,
				},
			],
		}),
	};
}

function avatar(assetId: string, segmentId?: string): Avatar {
	return {
		accent: "#f97316",
		animation: "none",
		depth: 0.45,
		end: 6,
		entryDuration: 0,
		height: 0.6,
		id: crypto.randomUUID(),
		lipSync: { assetId, segmentId, sensitivity: 0.5, smoothing: 0.5 },
		outfit: "#4f46e5",
		pose: "neutral",
		skin: "#f4c7a1",
		start: 0,
		width: 0.3,
		x: 0.5,
		y: 0.2,
	};
}

const adjustment = (start: number, end: number) => ({
	brightness: 0.3,
	end,
	id: crypto.randomUUID(),
	label: "Grade",
	opacity: 1,
	start,
	track: 1,
});

describe("trim modes fit edge transitions", () => {
	test("a ripple trim below the exit duration clamps the exit", () => {
		const video = media();
		const a = clip(video, 0, 0, 4, {
			exitDuration: 3,
			exitTransition: "crossfade",
		});
		const result = trimEdit(timeline([video], [a]), [video], {
			clipId: a.id,
			delta: -2,
			edge: "end",
			mode: "ripple",
			revision: 0,
		});
		expect(result.applied).toBe(-2);
		expect(find(result.project, a.id).exitDuration).toBe(2);
	});

	test("a roll that shortens a clip with an exit clamps the exit", () => {
		const video = media();
		const a = clip(video, 0, 0, 4, {
			exitDuration: 3,
			exitTransition: "crossfade",
		});
		const b = clip(video, 4, 5, 9);
		const result = trimEdit(timeline([video], [a, b]), [video], {
			delta: -2,
			inClipId: b.id,
			mode: "roll",
			outClipId: a.id,
			revision: 0,
		});
		expect(result.applied).toBe(-2);
		expect(find(result.project, a.id).exitDuration).toBe(2);
	});

	test("a ripple trim that uncovers a reveal drops it, as the group trim does", () => {
		const video = media();
		const a = clip(video, 0, 0, 5);
		const b = clip(video, 4, 5, 9, { transitionIn: reveal });
		const start = timeline([video], [a, b]);
		const rippled = trimEdit(start, [video], {
			clipId: a.id,
			delta: -0.5,
			edge: "end",
			mode: "ripple",
			revision: 0,
		});
		const grouped = groupTrim(start, [video], {
			clipIds: [a.id],
			delta: -0.5,
			edge: "end",
			revision: 0,
		});
		expect(rippled.applied).toBe(-0.5);
		expect(find(rippled.project, b.id).transitionIn).toBeUndefined();
		expect(find(grouped.project, b.id).transitionIn).toBeUndefined();
	});

	test("a ripple trim moves adjustment layers with the clips after it", () => {
		const video = media();
		const a = clip(video, 0, 0, 4);
		const b = clip(video, 4, 4, 8);
		const result = trimEdit(
			timeline([video], [a, b], { adjustmentLayers: [adjustment(4, 8)] }),
			[video],
			{ clipId: a.id, delta: -2, edge: "end", mode: "ripple", revision: 0 }
		);
		expect(find(result.project, b.id).start).toBe(2);
		expect(result.project.adjustmentLayers?.[0]).toMatchObject({
			end: 6,
			start: 2,
		});
	});
});

describe("group trim keeps animation and fits reveals", () => {
	test("an end trim keeps eased and mask curves up to the new end", () => {
		const video = media();
		const { maskId, segment } = maskedClip(video, 0, 8);
		const result = groupTrim(timeline([video], [segment]), [video], {
			clipIds: [segment.id],
			delta: -4,
			edge: "end",
			revision: 0,
		});
		const trimmed = find(result.project, segment.id);
		for (const at of [1, 2.5, 3.9]) {
			expect(animatedValue(trimmed, "opacity", at)).toBeCloseTo(
				animatedValue(segment, "opacity", at),
				4
			);
			expect(animatedValue(trimmed, "maskX", at, maskId)).toBeCloseTo(
				animatedValue(segment, "maskX", at, maskId),
				6
			);
			expect(animatedValue(trimmed, "brightness", at)).toBeCloseTo(
				animatedValue(segment, "brightness", at),
				6
			);
		}
	});

	test("trimSegment's end branch adds a boundary keyframe", () => {
		const video = media();
		const { segment } = maskedClip(video, 0, 8);
		const trimmed = trimSegment(segment, video.duration, "end", -4);
		expect(animatedValue(trimmed, "brightness", 4)).toBeCloseTo(0.2, 6);
		expect(
			trimmed.keyframes.every((frame) => frame.time <= segmentDuration(trimmed))
		).toBe(true);
	});

	test("shortening a revealed clip below its reveal fits the reveal", () => {
		const video = media();
		const a = clip(video, 0, 0, 5);
		const b = clip(video, 4, 5, 9, { transitionIn: reveal });
		const result = groupTrim(timeline([video], [a, b]), [video], {
			clipIds: [b.id],
			delta: -3.5,
			edge: "end",
			revision: 0,
		});
		expect(result.applied).toBe(-3.5);
		expect(find(result.project, b.id).transitionIn?.duration).toBe(0.5);
	});
});

describe("speed ramps carry W2 clip fields", () => {
	test("a revealed clip ramps, and only its first step keeps the reveal", () => {
		const video = media();
		const a = clip(video, 0, 0, 5);
		const b = clip(video, 4, 5, 13, { transitionIn: reveal });
		const ramped = speedRamp(timeline([video], [a, b]), [video], {
			clipId: b.id,
			preset: "montage",
			revision: 0,
		});
		const steps = ramped.segments.filter((segment) => segment.id !== a.id);
		expect(steps).toHaveLength(12);
		expect(steps.filter((step) => step.transitionIn)).toHaveLength(1);
		expect(find(ramped, b.id).transitionIn?.type).toBe("wipe-left");
	});

	test("only the last step keeps the exit, clamped to the step", () => {
		const video = media();
		const c = clip(video, 0, 0, 8, {
			animation: { in: "fade", loop: "pulse", out: "zoom" },
			exitDuration: 2,
			exitTransition: "crossfade",
		});
		const ramped = speedRamp(timeline([video], [c]), [video], {
			clipId: c.id,
			preset: "montage",
			revision: 0,
		});
		const steps = [...ramped.segments].sort((x, y) => x.start - y.start);
		const last = steps.at(-1);
		expect(steps.filter((step) => step.exitTransition)).toHaveLength(1);
		expect(last?.exitTransition).toBe("crossfade");
		expect(last?.exitDuration).toBeLessThanOrEqual(
			segmentDuration(last as Segment)
		);
		expect(steps[0]?.animation).toEqual({ in: "fade", loop: "pulse" });
		expect(steps[5]?.animation).toEqual({ loop: "pulse" });
		expect(last?.animation).toEqual({ loop: "pulse", out: "zoom" });
		const reset = resetSpeedRamp(ramped, [video], {
			clipId: c.id,
			revision: 0,
		});
		expect(reset.segments).toHaveLength(1);
		expect(reset.segments[0]).toMatchObject({
			animation: { in: "fade", loop: "pulse", out: "zoom" },
			exitTransition: "crossfade",
		});
	});

	test("mask, color and eased keyframes survive on their source moments", () => {
		const video = media();
		const { maskId, segment } = maskedClip(video, 0, 8);
		const ramped = speedRamp(timeline([video], [segment]), [video], {
			clipId: segment.id,
			preset: "montage",
			revision: 0,
		});
		const steps = [...ramped.segments].sort((x, y) => x.start - y.start);
		const properties = new Set(
			steps.flatMap((step) => step.keyframes.map((frame) => frame.property))
		);
		expect(properties.has("maskX")).toBe(true);
		expect(properties.has("brightness")).toBe(true);
		for (const step of steps) {
			// Each step starts at the original curve's value at its source moment.
			const sourceMoment = step.sourceIn - segment.sourceIn;
			expect(animatedValue(step, "maskX", 0, maskId)).toBeCloseTo(
				animatedValue(segment, "maskX", sourceMoment, maskId),
				5
			);
			expect(animatedValue(step, "brightness", 0)).toBeCloseTo(
				animatedValue(segment, "brightness", sourceMoment),
				5
			);
			expect(animatedValue(step, "opacity", 0)).toBeCloseTo(
				animatedValue(segment, "opacity", sourceMoment),
				4
			);
		}
	});

	test("a timeline ripple moves adjustment layers and respects pinned markers", () => {
		const video = media();
		const a = clip(video, 0, 0, 4);
		const b = clip(video, 4, 4, 8);
		const ramped = speedRamp(
			timeline([video], [a, b], {
				adjustmentLayers: [adjustment(4, 8)],
				markers: [
					{ color: "#ffffff", id: crypto.randomUUID(), label: "M", time: 6 },
				],
				rippleMarkers: false,
			}),
			[video],
			{ clipId: a.id, preset: "montage", revision: 0, ripple: "timeline" }
		);
		const moved = find(ramped, b.id).start;
		expect(moved).not.toBe(4);
		expect(ramped.adjustmentLayers?.[0]?.start).toBeCloseTo(moved, 6);
		expect(ramped.markers[0]?.time).toBe(6);
	});
});

describe("ripple edits keep lip-sync links valid", () => {
	test("a range delete that removes the linked clip unpins the link", () => {
		const voice = media("audio");
		const a = clip(voice, 0, 0, 4);
		const b = clip(voice, 4, 4, 10);
		const linked = { ...avatar(voice.id, a.id), end: 9, start: 5 };
		const result = rippleDeleteRange(
			timeline([voice], [a, b], { avatars: [linked] }),
			[voice],
			0,
			4
		);
		expect(result.avatars[0]?.lipSync).toEqual({
			assetId: voice.id,
			sensitivity: 0.5,
			smoothing: 0.5,
		});
	});

	test("resetting a ramp moves a link to a step onto the merged clip", () => {
		const voice = media("audio");
		const a = clip(voice, 0, 0, 6);
		const ramped = speedRamp(timeline([voice], [a]), [voice], {
			clipId: a.id,
			preset: "montage",
			revision: 0,
		});
		const step = [...ramped.segments].sort((x, y) => x.start - y.start)[3];
		const linked = validateProject(
			{ ...ramped, avatars: [avatar(voice.id, step?.id)] },
			[voice]
		);
		const reset = resetSpeedRamp(linked, [voice], {
			clipId: a.id,
			revision: 0,
		});
		expect(reset.avatars[0]?.lipSync?.segmentId).toBe(a.id);
	});
});
