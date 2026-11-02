import { describe, expect, test } from "bun:test";
import { animatedValue } from "../../../shared/animation.ts";
import { gainToDb } from "../../../shared/decibels.ts";
import {
	type Asset,
	type Keyframe,
	newSegment,
	type Segment,
} from "../../../shared/project.ts";
import { valueToY } from "./lane-math.ts";
import {
	addVolumeKeyframe,
	draggedVolume,
	hitsVolumeLine,
	lineDragDeltaDb,
	offsetVolumeFrames,
	VOLUME_LINE_HEIGHT,
	volumeAtY,
	volumeLineDrag,
	volumeLinePoints,
	volumeLineY,
	volumeStepEdit,
} from "./volume-line.ts";

const asset: Asset = {
	createdAt: new Date(0).toISOString(),
	duration: 20,
	hasAudio: true,
	height: 0,
	id: crypto.randomUUID(),
	kind: "audio",
	name: "voice.wav",
	width: 0,
};

const volumeFrame = (
	time: number,
	value: number,
	extra: Partial<Keyframe> = {}
): Keyframe => ({
	id: crypto.randomUUID(),
	property: "volume",
	time,
	value,
	...extra,
});

function clip(keyframes: Keyframe[] = [], volume = 1): Segment {
	return { ...newSegment(asset, 0), keyframes, sourceOut: 4, volume };
}

describe("volume line", () => {
	test("the line sits at the clip volume on the decibel scale", () => {
		const segment = clip([], 0.5);
		expect(volumeLineY(segment, 1)).toBe(
			valueToY("volume", 0.5, VOLUME_LINE_HEIGHT)
		);
		expect(hitsVolumeLine(segment, 1, volumeLineY(segment, 1) + 3)).toBe(true);
		expect(hitsVolumeLine(segment, 1, volumeLineY(segment, 1) + 9)).toBe(false);
	});

	test("dB position maps back to volume", () => {
		for (const volume of [0.25, 0.5, 1, 2]) {
			const y = valueToY("volume", volume, VOLUME_LINE_HEIGHT);
			expect(gainToDb(volumeAtY(y))).toBeCloseTo(gainToDb(volume), 0);
		}
		expect(volumeAtY(VOLUME_LINE_HEIGHT)).toBe(0);
		expect(volumeAtY(0)).toBe(4);
	});

	test("dragging an un-animated line sets the static volume", () => {
		const segment = clip([], 1);
		const edit = volumeLineDrag(segment, -2);
		expect(edit.kind).toBe("static");
		if (edit.kind === "static") {
			expect(edit.volume).toBe(draggedVolume(1, -2));
			expect(gainToDb(edit.volume)).toBeCloseTo(-lineDragDeltaDb(2), 0);
			expect(edit.volume).toBeGreaterThan(1);
		}
		const muted = volumeLineDrag(segment, 100);
		expect(muted).toEqual({ kind: "static", volume: 0 });
	});

	test("dragging an animated line offsets every volume keyframe by the same dB", () => {
		const frames = [volumeFrame(0, 1), volumeFrame(2, 0.5), volumeFrame(3, 0)];
		const segment = clip(frames);
		const edit = volumeLineDrag(segment, 2);
		expect(edit.kind).toBe("keyframes");
		if (edit.kind !== "keyframes") {
			return;
		}
		const delta = lineDragDeltaDb(2);
		expect(delta).toBeLessThan(0);
		for (const [index, moved] of edit.frames.entries()) {
			const before = frames[index] as Keyframe;
			if (before.value === 0) {
				expect(moved.value).toBe(0);
			} else {
				const shift = gainToDb(moved.value) - gainToDb(before.value);
				// Each keyframe lands on the nearest 0.1 dB.
				expect(Math.abs(shift - delta)).toBeLessThanOrEqual(0.051);
			}
		}
		expect(offsetVolumeFrames([volumeFrame(0, 3.9)], 12)[0]?.value).toBe(4);
	});

	test("Cmd-click adds a volume keyframe on the curve and keeps the curve", () => {
		const first = volumeFrame(0, 1, { interpolation: "ease-in" });
		const last = volumeFrame(4, 0.25);
		const segment = clip([first, last]);
		const add = addVolumeKeyframe(segment, 2, 30);
		expect(add.added).toBe(true);
		expect(add.time).toBe(2);
		expect(add.frames.map((frame) => frame.time)).toEqual([0, 2, 4]);
		// The new keyframe takes the value the curve already had there.
		expect(add.value).toBeCloseTo(animatedValue(segment, "volume", 2), 6);
		// Adding splits the eased interval, so both halves stay eased and the
		// audible curve is unchanged.
		expect(add.frames[0]?.interpolation).toBeDefined();
		expect(add.frames[1]?.interpolation).toBeDefined();
		const after = { ...segment, keyframes: add.frames };
		for (const time of [0.5, 1.5, 2.5, 3.5]) {
			expect(animatedValue(after, "volume", time)).toBeCloseTo(
				animatedValue(segment, "volume", time),
				4
			);
		}
	});

	test("Cmd-click on an un-animated clip never changes its loudness", () => {
		const segment = clip([], 1);
		const y = volumeLineY(segment, 1);
		// A click near the edge of the grab tolerance would ask for -16 dB.
		expect(hitsVolumeLine(segment, 1, y + 4.9)).toBe(true);
		expect(gainToDb(volumeAtY(y + 4.9))).toBeLessThan(-15);
		const add = addVolumeKeyframe(segment, 1, 30);
		expect(add.frames.map((frame) => [frame.time, frame.value])).toEqual([
			[1, 1],
		]);
		const after = { ...segment, keyframes: add.frames };
		for (const time of [0, 1, 3]) {
			expect(animatedValue(after, "volume", time)).toBe(1);
		}
	});

	test("Cmd-click within half a frame of a keyframe lands on it", () => {
		// Frame-exact lane times, as an ArrowLeft nudge from 3 s stores them.
		const nudged = Number((3 - 1 / 30).toFixed(6));
		const segment = clip([volumeFrame(1, 1), volumeFrame(nudged, 0.5)]);
		const add = addVolumeKeyframe(segment, nudged, 30);
		expect(add.added).toBe(false);
		expect(add.time).toBe(nudged);
		expect(add.frames.map((frame) => [frame.time, frame.value])).toEqual([
			[1, 1],
			[nudged, 0.5],
		]);
		expect(addVolumeKeyframe(segment, 2.967, 30).added).toBe(false);
		// A new keyframe keeps the lanes' frame-exact 6-decimal time.
		const fresh = addVolumeKeyframe(
			segment,
			Number((2 / 30 + 1).toFixed(6)),
			30
		);
		expect(fresh.added).toBe(true);
		expect(fresh.time).toBe(1.066_667);
		expect(fresh.frames.map((frame) => frame.time)).toEqual([
			1,
			1.066_667,
			nudged,
		]);
	});

	test("the drawn line steps through keyframes", () => {
		const segment = clip([volumeFrame(1, 1), volumeFrame(3, 0.25)]);
		const points = volumeLinePoints(segment, 400, 100)
			.split(" ")
			.map((pair) => pair.split(",").map(Number));
		expect(points[0]?.[0]).toBe(0);
		expect(points.at(-1)?.[0]).toBe(400);
		const at300 = points.find(([x]) => x === 300)?.[1];
		expect(at300).toBeCloseTo(valueToY("volume", 0.25, VOLUME_LINE_HEIGHT), 2);
		expect(volumeLinePoints(segment, 400, 0)).toBe("");
	});

	test("keyboard steps add decibels to the volume or every keyframe", () => {
		expect(volumeStepEdit(clip([], 1), 1)).toEqual({
			kind: "static",
			volume: Number((10 ** (1 / 20)).toFixed(6)),
		});
		// Silence steps up from the floor; stepping to the floor mutes.
		const fromSilence = volumeStepEdit(clip([], 0), 6);
		expect(fromSilence.kind).toBe("static");
		if (fromSilence.kind === "static") {
			expect(gainToDb(fromSilence.volume)).toBeCloseTo(-54, 2);
		}
		expect(volumeStepEdit(clip([], 0.001), -6)).toEqual({
			kind: "static",
			volume: 0,
		});
		const animated = volumeStepEdit(clip([volumeFrame(1, 1)]), -6);
		expect(animated.kind).toBe("keyframes");
		if (animated.kind === "keyframes") {
			expect(gainToDb(animated.frames[0]?.value ?? 0)).toBeCloseTo(-6, 1);
		}
	});
});
