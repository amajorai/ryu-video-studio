import { describe, expect, test } from "bun:test";
import {
	type Asset,
	newProject,
	newSegment,
	type Segment,
	segmentDuration,
	updateTrackSetting,
} from "./project.ts";
import { trimEdit } from "./trim-modes.ts";

function asset(kind: "video" | "audio" | "image" = "video"): Asset {
	return {
		createdAt: new Date().toISOString(),
		duration: kind === "image" ? 5 : 10,
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
	track = 0
): Segment {
	return { ...newSegment(source, start, track), sourceIn, sourceOut };
}

function project(segments: Segment[]) {
	return { ...newProject("Trim modes"), segments };
}

function find(next: { segments: Segment[] }, id: string) {
	const found = next.segments.find((segment) => segment.id === id);
	if (!found) {
		throw new Error("missing clip");
	}
	return found;
}

describe("roll", () => {
	test("moves the shared edit point and is reversible without keyframes", () => {
		const media = asset();
		const outgoing = clip(media, 0, 0, 4);
		const incoming = clip(media, 4, 2, 6);
		const start = project([outgoing, incoming]);
		const rolled = trimEdit(start, [media], {
			mode: "roll",
			outClipId: outgoing.id,
			inClipId: incoming.id,
			delta: 1,
			revision: 0,
		});
		expect(rolled.applied).toBe(1);
		expect(find(rolled.project, outgoing.id).sourceOut).toBe(5);
		expect(find(rolled.project, incoming.id)).toMatchObject({
			sourceIn: 3,
			start: 5,
		});
		const restored = trimEdit(rolled.project, [media], {
			mode: "roll",
			outClipId: outgoing.id,
			inClipId: incoming.id,
			delta: -1,
			revision: 0,
		});
		expect(restored.project.segments).toEqual(start.segments);
	});

	test("clamps to the incoming handle and respects clip speed", () => {
		const media = asset();
		const outgoing = clip(media, 0, 0, 4);
		const incoming = { ...clip(media, 4, 2, 6), speed: 2 };
		const next = trimEdit(project([outgoing, incoming]), [media], {
			mode: "roll",
			outClipId: outgoing.id,
			inClipId: incoming.id,
			delta: -3,
			revision: 0,
		});
		expect(next.applied).toBe(-1);
		expect(find(next.project, incoming.id)).toMatchObject({
			sourceIn: 0,
			start: 3,
		});
		expect(find(next.project, outgoing.id).sourceOut).toBe(3);
	});

	test("linked partners follow unless links are ignored", () => {
		const video = asset();
		const audio = asset("audio");
		const firstGroup = crypto.randomUUID();
		const secondGroup = crypto.randomUUID();
		const videoOut = { ...clip(video, 0, 0, 4), linkGroupId: firstGroup };
		const audioOut = { ...clip(audio, 0, 0, 4, 1), linkGroupId: firstGroup };
		const videoIn = { ...clip(video, 4, 4, 8), linkGroupId: secondGroup };
		const audioIn = { ...clip(audio, 4, 4, 8, 1), linkGroupId: secondGroup };
		const start = project([videoOut, audioOut, videoIn, audioIn]);
		const request = {
			mode: "roll" as const,
			outClipId: videoOut.id,
			inClipId: videoIn.id,
			delta: -0.5,
			revision: 0,
		};
		const linked = trimEdit(start, [video, audio], request);
		expect(find(linked.project, audioOut.id).sourceOut).toBe(3.5);
		expect(find(linked.project, audioIn.id).start).toBe(3.5);
		const solo = trimEdit(start, [video, audio], {
			...request,
			ignoreLinks: true,
		});
		expect(find(solo.project, videoIn.id).start).toBe(3.5);
		expect(find(solo.project, audioIn.id).start).toBe(4);
	});

	test("stops a linked partner at an unrelated clip on its track", () => {
		const video = asset();
		const audio = asset("audio");
		const linkGroupId = crypto.randomUUID();
		const videoOut = { ...clip(video, 0, 0, 4), linkGroupId };
		const audioOut = { ...clip(audio, 0, 0, 4, 1), linkGroupId };
		const videoIn = clip(video, 4, 4, 8);
		const audioOther = clip(audio, 4.5, 4, 8, 1);
		const next = trimEdit(
			project([videoOut, audioOut, videoIn, audioOther]),
			[video, audio],
			{
				mode: "roll",
				outClipId: videoOut.id,
				inClipId: videoIn.id,
				delta: 1,
				revision: 0,
			}
		);
		expect(next.applied).toBe(0.5);
		expect(find(next.project, audioOut.id).sourceOut).toBe(4.5);
		expect(find(next.project, audioOther.id).start).toBe(4.5);
	});

	test("drops keyframes past a shortened edge, so rolling back is lossy", () => {
		const media = asset();
		const outgoing = {
			...clip(media, 0, 0, 4),
			keyframes: [
				{
					id: crypto.randomUUID(),
					property: "opacity" as const,
					time: 0,
					value: 0,
				},
				{
					id: crypto.randomUUID(),
					property: "opacity" as const,
					time: 4,
					value: 1,
				},
			],
		};
		const incoming = clip(media, 4, 2, 6);
		const request = {
			mode: "roll" as const,
			outClipId: outgoing.id,
			inClipId: incoming.id,
			revision: 0,
		};
		const shorter = trimEdit(project([outgoing, incoming]), [media], {
			...request,
			delta: -1,
		});
		const restored = trimEdit(shorter.project, [media], {
			...request,
			delta: 1,
		});
		const frames = find(restored.project, outgoing.id).keyframes;
		expect(frames.map((frame) => [frame.time, frame.value])).toEqual([
			[0, 0],
			[3, 0.75],
		]);
	});

	test("rejects clips that do not share an edit point", () => {
		const media = asset();
		const outgoing = clip(media, 0, 0, 2);
		const incoming = clip(media, 4, 2, 6);
		expect(() =>
			trimEdit(project([outgoing, incoming]), [media], {
				mode: "roll",
				outClipId: outgoing.id,
				inClipId: incoming.id,
				delta: 1,
				revision: 0,
			})
		).toThrow("meet at one edit point");
	});
});

describe("slip", () => {
	test("shifts source in and out within the source limits", () => {
		const media = asset();
		const target = clip(media, 3, 2, 6);
		const start = project([target]);
		const later = trimEdit(start, [media], {
			mode: "slip",
			clipId: target.id,
			delta: 10,
			revision: 0,
		});
		expect(later.applied).toBe(4);
		expect(find(later.project, target.id)).toMatchObject({
			sourceIn: 6,
			sourceOut: 10,
			start: 3,
		});
		const earlier = trimEdit(start, [media], {
			mode: "slip",
			clipId: target.id,
			delta: -10,
			revision: 0,
		});
		expect(earlier.applied).toBe(-2);
		expect(find(earlier.project, target.id).sourceIn).toBe(0);
	});

	test("keeps a linked partner at another speed in sync", () => {
		const video = asset();
		const audio = asset("audio");
		const linkGroupId = crypto.randomUUID();
		const target = { ...clip(video, 0, 2, 4), linkGroupId };
		const partner = { ...clip(audio, 0, 4, 8, 1), linkGroupId, speed: 2 };
		const next = trimEdit(project([target, partner]), [video, audio], {
			mode: "slip",
			clipId: target.id,
			delta: 1,
			revision: 0,
		});
		expect(next.applied).toBe(1);
		expect(find(next.project, partner.id)).toMatchObject({
			sourceIn: 6,
			sourceOut: 10,
		});
	});

	test("refuses multicam clips", () => {
		const media = asset();
		const target = {
			...clip(media, 0, 2, 4),
			multicamGroupId: crypto.randomUUID(),
		};
		expect(() =>
			trimEdit(project([target]), [media], {
				mode: "slip",
				clipId: target.id,
				delta: 1,
				revision: 0,
			})
		).toThrow("multicam");
	});
});

describe("slide", () => {
	test("moves the clip while neighbouring edges roll, clamped by handles", () => {
		const media = asset();
		const before = clip(media, 0, 0, 4);
		const target = clip(media, 4, 2, 4);
		const after = clip(media, 6, 2, 6);
		const start = project([before, target, after]);
		const right = trimEdit(start, [media], {
			mode: "slide",
			clipId: target.id,
			delta: 1,
			revision: 0,
		});
		expect(right.applied).toBe(1);
		expect(find(right.project, before.id).sourceOut).toBe(5);
		expect(find(right.project, target.id)).toMatchObject({
			sourceIn: 2,
			start: 5,
		});
		expect(find(right.project, after.id)).toMatchObject({
			sourceIn: 3,
			start: 7,
		});
		const left = trimEdit(start, [media], {
			mode: "slide",
			clipId: target.id,
			delta: -5,
			revision: 0,
		});
		expect(left.applied).toBe(-2);
		expect(find(left.project, after.id)).toMatchObject({
			sourceIn: 0,
			start: 4,
		});
	});

	test("stops a neighbour's partner at an unrelated clip on its track", () => {
		const video = asset();
		const audio = asset("audio");
		const linkGroupId = crypto.randomUUID();
		const before = clip(video, 0, 0, 4);
		const target = clip(video, 4, 2, 4);
		const after = { ...clip(video, 6, 2, 6), linkGroupId };
		const afterAudio = { ...clip(audio, 6, 2, 6, 1), linkGroupId };
		const music = clip(audio, 3, 0, 2.5, 1);
		const next = trimEdit(
			project([before, target, after, afterAudio, music]),
			[video, audio],
			{ mode: "slide", clipId: target.id, delta: -1, revision: 0 }
		);
		expect(next.applied).toBe(-0.5);
		expect(find(next.project, afterAudio.id).start).toBe(5.5);
		expect(find(next.project, music.id).start).toBe(3);
	});
});

describe("ripple", () => {
	test("stops a follower's partner at a stationary clip on its track", () => {
		const video = asset();
		const audio = asset("audio");
		const linkGroupId = crypto.randomUUID();
		const trimmed = clip(video, 0, 0, 4);
		const later = { ...clip(video, 4, 0, 4), linkGroupId };
		const partner = { ...clip(audio, 4, 0, 4, 2), linkGroupId };
		const stationary = clip(audio, 2, 0, 1.5, 2);
		const next = trimEdit(
			project([trimmed, later, partner, stationary]),
			[video, audio],
			{
				mode: "ripple",
				clipId: trimmed.id,
				edge: "end",
				delta: -1,
				revision: 0,
			}
		);
		expect(next.applied).toBe(-0.5);
		expect(find(next.project, later.id).start).toBe(3.5);
		expect(find(next.project, partner.id).start).toBe(3.5);
		expect(find(next.project, stationary.id).start).toBe(2);
	});

	test("clamps to whole frames and keeps later clips butted at any speed", () => {
		const media = asset();
		for (const speed of [0.25, 0.3, 0.7, 1, 3, 3.7]) {
			const target = { ...clip(media, 0, 0, 2), speed };
			const later = clip(media, 2 / speed, 0, 1);
			const next = trimEdit(project([target, later]), [media], {
				mode: "ripple",
				clipId: target.id,
				edge: "end",
				delta: -7200,
				revision: 0,
			});
			const frames = next.applied * next.project.fps;
			expect(Math.abs(frames - Math.round(frames))).toBeLessThan(1e-6);
			const result = find(next.project, target.id);
			expect(segmentDuration(result)).toBeGreaterThanOrEqual(0.04);
			expect(
				Math.abs(find(next.project, later.id).start - segmentDuration(result))
			).toBeLessThanOrEqual(1e-6);
		}
	});

	test("shifts only later clips on affected tracks and later markers", () => {
		const media = asset();
		const trimmed = clip(media, 0, 0, 4);
		const later = clip(media, 4, 0, 4);
		const otherTrack = clip(media, 4, 0, 4, 1);
		const start = {
			...project([trimmed, later, otherTrack]),
			markers: [
				{ id: crypto.randomUUID(), label: "Early", time: 1 },
				{ id: crypto.randomUUID(), label: "Late", time: 6 },
			],
		};
		const next = trimEdit(start, [media], {
			mode: "ripple",
			clipId: trimmed.id,
			edge: "end",
			delta: -1,
			revision: 0,
		});
		expect(next.applied).toBe(-1);
		expect(find(next.project, trimmed.id).sourceOut).toBe(3);
		expect(find(next.project, later.id).start).toBe(3);
		expect(find(next.project, otherTrack.id).start).toBe(4);
		expect(next.project.markers.map((marker) => marker.time)).toEqual([1, 5]);
	});

	test("head trim keeps the clip start and re-bases keyframes", () => {
		const media = asset();
		const trimmed = {
			...clip(media, 0, 1, 5),
			keyframes: [
				{
					id: crypto.randomUUID(),
					property: "volume" as const,
					time: 0,
					value: 0,
				},
				{
					id: crypto.randomUUID(),
					property: "volume" as const,
					time: 2,
					value: 1,
				},
			],
		};
		const later = clip(media, 4, 0, 2);
		const next = trimEdit(project([trimmed, later]), [media], {
			mode: "ripple",
			clipId: trimmed.id,
			edge: "start",
			delta: 1,
			revision: 0,
		});
		const result = find(next.project, trimmed.id);
		expect(result).toMatchObject({ sourceIn: 2, start: 0 });
		expect(result.keyframes.map((frame) => [frame.time, frame.value])).toEqual([
			[0, 0.5],
			[1, 1],
		]);
		expect(find(next.project, later.id).start).toBe(3);
	});

	test("image stills extend past their nominal duration", () => {
		const still = asset("image");
		const target = newSegment(still);
		const next = trimEdit(project([target]), [still], {
			mode: "ripple",
			clipId: target.id,
			edge: "start",
			delta: -2,
			revision: 0,
		});
		expect(next.applied).toBe(-2);
		expect(find(next.project, target.id)).toMatchObject({
			sourceIn: 0,
			sourceOut: 7,
			start: 0,
		});
	});

	test("refuses a ripple that would move a clip on a locked track", () => {
		const video = asset();
		const audio = asset("audio");
		const linkGroupId = crypto.randomUUID();
		const trimmed = clip(video, 0, 0, 4);
		const later = { ...clip(video, 4, 0, 4), linkGroupId };
		const partner = { ...clip(audio, 4, 0, 4, 2), linkGroupId };
		const locked = updateTrackSetting(project([trimmed, later, partner]), 2, {
			locked: true,
		});
		expect(() =>
			trimEdit(locked, [video, audio], {
				mode: "ripple",
				clipId: trimmed.id,
				edge: "end",
				delta: -1,
				revision: 0,
			})
		).toThrow("Unlock");
	});
});
