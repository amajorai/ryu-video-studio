import { describe, expect, test } from "bun:test";
import {
	cutsInside,
	cutTargets,
	splitClips,
	splitClipsRequestSchema,
	splitInputFromRequest,
	trimToPlayhead,
	trimToPlayheadRequestSchema,
} from "./cut-ops.ts";
import {
	type Asset,
	newProject,
	newSegment,
	type Project,
	type Segment,
	segmentDuration,
	updateTrackSetting,
} from "./project.ts";

function media(kind: Asset["kind"], duration = 30): Asset {
	return {
		createdAt: new Date(0).toISOString(),
		duration,
		hasAudio: true,
		height: kind === "audio" ? 0 : 360,
		id: crypto.randomUUID(),
		kind,
		name: `${kind} source`,
		width: kind === "audio" ? 0 : 640,
	};
}

const video = media("video");
const audio = media("audio");
const assets = [video, audio];

function clip(
	asset: Asset,
	start: number,
	length: number,
	track: number,
	extra: Partial<Segment> = {}
): Segment {
	return {
		...newSegment(asset, start, track),
		sourceIn: 0,
		sourceOut: length,
		...extra,
	};
}

function project(segments: Segment[], patch: Partial<Project> = {}): Project {
	return { ...newProject("Cut ops"), segments, ...patch };
}

const end = (segment: Segment) => segment.start + segmentDuration(segment);
const onTrack = (value: Project, track: number) =>
	value.segments
		.filter((segment) => segment.track === track)
		.sort((a, b) => a.start - b.start);

describe("split request", () => {
	test("the legacy single-clip body still parses", () => {
		const id = crypto.randomUUID();
		const parsed = splitClipsRequestSchema.parse({
			clipId: id,
			revision: 2,
			time: 3,
		});
		expect(splitInputFromRequest(parsed)).toEqual({
			clipIds: [id],
			times: [3],
		});
	});

	test("multi-time bodies parse without clip ids", () => {
		const parsed = splitClipsRequestSchema.parse({
			revision: 0,
			times: [1, 2],
		});
		expect(splitInputFromRequest(parsed)).toEqual({ times: [1, 2] });
	});

	test("time and times are mutually exclusive and one is required", () => {
		expect(
			splitClipsRequestSchema.safeParse({ revision: 0, time: 1, times: [1] })
				.success
		).toBe(false);
		expect(splitClipsRequestSchema.safeParse({ revision: 0 }).success).toBe(
			false
		);
	});

	test("bounds: at most 64 times and 200 clip ids, strict keys", () => {
		expect(
			splitClipsRequestSchema.safeParse({
				revision: 0,
				times: Array.from({ length: 65 }, (_, index) => index),
			}).success
		).toBe(false);
		expect(
			splitClipsRequestSchema.safeParse({
				clipIds: Array.from({ length: 201 }, () => crypto.randomUUID()),
				revision: 0,
				times: [1],
			}).success
		).toBe(false);
		expect(
			splitClipsRequestSchema.safeParse({ extra: 1, revision: 0, times: [1] })
				.success
		).toBe(false);
	});
});

describe("splitClips", () => {
	test("splits three clips on three tracks at one time in one result", () => {
		const a = clip(video, 0, 10, 0);
		const b = clip(video, 2, 10, 1);
		const c = clip(audio, 1, 10, 2);
		const before = project([a, b, c]);
		const result = splitClips(before, assets, { times: [5] });
		expect(result.splitCount).toBe(3);
		expect(result.project.segments).toHaveLength(6);
		for (const track of [0, 1, 2]) {
			const [left, right] = onTrack(result.project, track);
			expect(left && end(left)).toBeCloseTo(5, 9);
			expect(right?.start).toBeCloseTo(5, 9);
		}
		expect(result.project.revision).toBe(before.revision);
	});

	test("keeps the original id on the left piece and reports new right ids", () => {
		const a = clip(video, 0, 10, 0);
		const result = splitClips(project([a]), assets, { times: [4] });
		const [left, right] = onTrack(result.project, 0);
		expect(left?.id).toBe(a.id);
		expect(result.newIds).toEqual([right?.id ?? ""]);
		expect(right?.sourceIn).toBeCloseTo(4, 9);
	});

	test("linked audio and video both split and the right side gets a new group", () => {
		const group = crypto.randomUUID();
		const picture = clip(video, 0, 8, 0, { linkGroupId: group });
		const sound = clip(audio, 0, 8, 1, { linkGroupId: group });
		const result = splitClips(project([picture, sound]), assets, {
			clipIds: [picture.id],
			times: [3],
		});
		const [videoLeft, videoRight] = onTrack(result.project, 0);
		const [audioLeft, audioRight] = onTrack(result.project, 1);
		expect(videoLeft?.linkGroupId).toBe(group);
		expect(audioLeft?.linkGroupId).toBe(group);
		expect(videoRight?.linkGroupId).toBeDefined();
		expect(videoRight?.linkGroupId).not.toBe(group);
		expect(audioRight?.linkGroupId).toBe(videoRight?.linkGroupId);
	});

	test("a partner that starts after the cut moves to the right-hand group", () => {
		const group = crypto.randomUUID();
		const picture = clip(video, 0, 8, 0, { linkGroupId: group });
		const early = clip(audio, 0, 2, 1, { linkGroupId: group });
		const late = clip(audio, 5, 3, 1, { linkGroupId: group });
		const result = splitClips(project([picture, early, late]), assets, {
			clipIds: [picture.id],
			times: [4],
		});
		const [videoLeft, videoRight] = onTrack(result.project, 0);
		const lateAfter = result.project.segments.find(
			(segment) => segment.id === late.id
		);
		const earlyAfter = result.project.segments.find(
			(segment) => segment.id === early.id
		);
		expect(earlyAfter?.linkGroupId).toBe(videoLeft?.linkGroupId ?? "");
		expect(lateAfter?.linkGroupId).toBe(videoRight?.linkGroupId ?? "");
		expect(lateAfter?.linkGroupId).not.toBe(group);
	});

	test("a side left with a single member loses its link group", () => {
		const group = crypto.randomUUID();
		const picture = clip(video, 0, 8, 0, { linkGroupId: group });
		const sound = clip(audio, 0, 3, 1, { linkGroupId: group });
		const result = splitClips(project([picture, sound]), assets, {
			clipIds: [picture.id],
			times: [5],
		});
		const [, right] = onTrack(result.project, 0);
		expect(right?.linkGroupId).toBeUndefined();
		expect(
			result.project.segments.find((segment) => segment.id === sound.id)
				?.linkGroupId
		).toBe(group);
	});

	test("locked tracks are untouched by a playhead split", () => {
		const a = clip(video, 0, 10, 0);
		const b = clip(video, 0, 10, 1);
		const locked = updateTrackSetting(project([a, b]), 1, { locked: true });
		const result = splitClips(locked, assets, { times: [5] });
		expect(onTrack(result.project, 0)).toHaveLength(2);
		expect(onTrack(result.project, 1)).toEqual([b]);
	});

	test("a link group with a member on a locked track is skipped by a playhead split", () => {
		const group = crypto.randomUUID();
		const picture = clip(video, 0, 10, 0, { linkGroupId: group });
		const sound = clip(audio, 0, 10, 1, { linkGroupId: group });
		const other = clip(video, 0, 10, 2);
		const locked = updateTrackSetting(project([picture, sound, other]), 1, {
			locked: true,
		});
		const result = splitClips(locked, assets, { times: [5] });
		expect(onTrack(result.project, 0)).toEqual([picture]);
		expect(onTrack(result.project, 2)).toHaveLength(2);
	});

	test("explicit clips on a locked track or with a locked partner throw", () => {
		const group = crypto.randomUUID();
		const picture = clip(video, 0, 10, 0, { linkGroupId: group });
		const sound = clip(audio, 0, 10, 1, { linkGroupId: group });
		const locked = updateTrackSetting(project([picture, sound]), 1, {
			locked: true,
		});
		expect(() =>
			splitClips(locked, assets, { clipIds: [picture.id], times: [5] })
		).toThrow("Unlock every linked clip track");
	});

	test("multiple times cut one clip into several pieces in one edit", () => {
		const a = clip(video, 0, 10, 0);
		const result = splitClips(project([a]), assets, {
			clipIds: [a.id],
			times: [2, 8, 5],
		});
		const pieces = onTrack(result.project, 0);
		expect(pieces.map((piece) => piece.start)).toEqual([0, 2, 5, 8]);
		expect(pieces[0]?.id).toBe(a.id);
		expect(result.newIds).toEqual(pieces.slice(1).map((piece) => piece.id));
	});

	test("times outside every clip throw, and edges within 0.04 s are not cut", () => {
		const a = clip(video, 0, 10, 0);
		expect(() => splitClips(project([a]), assets, { times: [12] })).toThrow(
			"no unlocked clip"
		);
		expect(() =>
			splitClips(project([a]), assets, { clipIds: [a.id], times: [9.99] })
		).toThrow("Place the playhead inside the clip");
		expect(cutsInside(a, 0.04)).toBe(true);
		expect(cutsInside(a, 0.02)).toBe(false);
	});

	test("selected clips only: unselected clips under the time stay whole", () => {
		const a = clip(video, 0, 10, 0);
		const b = clip(video, 0, 10, 1);
		const result = splitClips(project([a, b]), assets, {
			clipIds: [b.id],
			times: [5],
		});
		expect(onTrack(result.project, 0)).toEqual([a]);
		expect(onTrack(result.project, 1)).toHaveLength(2);
	});

	test("the new piece joins its multicam group", () => {
		const a = clip(video, 0, 10, 0);
		const b = clip(audio, 0, 10, 1);
		const groupId = crypto.randomUUID();
		const before = project([a, b], {
			multicamGroups: [
				{
					duration: 10,
					id: groupId,
					masterAssetId: video.id,
					members: [
						{ assetId: video.id, kind: "angle", label: "A", offsetSeconds: 0 },
						{ assetId: audio.id, kind: "mic", label: "M", offsetSeconds: 0 },
					],
					name: "Group",
					segmentIds: [a.id, b.id],
					start: 0,
					switches: [{ angle: "A", end: 10, start: 0 }],
				},
			],
		});
		const result = splitClips(before, assets, { clipIds: [a.id], times: [4] });
		expect(result.project.multicamGroups[0]?.segmentIds).toEqual([
			a.id,
			b.id,
			...result.newIds,
		]);
	});

	test("cutTargets brings linked partners even when they are not under the time", () => {
		const group = crypto.randomUUID();
		const picture = clip(video, 0, 10, 0, { linkGroupId: group });
		const sound = clip(audio, 6, 2, 1, { linkGroupId: group });
		const targets = cutTargets(project([picture, sound]), 3, {
			verb: "splitting",
		});
		expect(targets.map((segment) => segment.id)).toEqual([
			picture.id,
			sound.id,
		]);
	});
});

describe("trimToPlayhead", () => {
	test("request schema is strict and requires ripple", () => {
		expect(
			trimToPlayheadRequestSchema.safeParse({
				edge: "start",
				revision: 0,
				time: 1,
			}).success
		).toBe(false);
		expect(
			trimToPlayheadRequestSchema.safeParse({
				edge: "start",
				revision: 0,
				ripple: true,
				time: 1,
			}).success
		).toBe(true);
	});

	test("Q (ripple start trim) removes the head and shifts later clips", () => {
		const a = clip(video, 0, 10, 0);
		const next = clip(video, 10, 5, 0);
		const result = trimToPlayhead(project([a, next]), assets, {
			edge: "start",
			ripple: true,
			time: 4,
		});
		const [trimmed, after] = onTrack(result.project, 0);
		expect(trimmed?.id).toBe(a.id);
		expect(trimmed?.start).toBe(0);
		expect(trimmed?.sourceIn).toBeCloseTo(4, 9);
		expect(after?.id).toBe(next.id);
		expect(after?.start).toBeCloseTo(6, 9);
		expect(result.playhead).toBe(0);
		expect(result.limited).toBe(0);
	});

	test("W (ripple end trim) removes the tail and shifts later clips", () => {
		const a = clip(video, 0, 10, 0);
		const next = clip(video, 10, 5, 0);
		const result = trimToPlayhead(project([a, next]), assets, {
			edge: "end",
			ripple: true,
			time: 7,
		});
		const [trimmed, after] = onTrack(result.project, 0);
		expect(trimmed?.id).toBe(a.id);
		expect(trimmed && end(trimmed)).toBeCloseTo(7, 9);
		expect(after?.start).toBeCloseTo(7, 9);
	});

	test("Alt+Q leaves a gap and keeps later clips in place", () => {
		const a = clip(video, 0, 10, 0);
		const next = clip(video, 10, 5, 0);
		const result = trimToPlayhead(project([a, next]), assets, {
			edge: "start",
			ripple: false,
			time: 4,
		});
		const [trimmed, after] = onTrack(result.project, 0);
		expect(trimmed?.start).toBeCloseTo(4, 9);
		expect(trimmed?.sourceIn).toBeCloseTo(4, 9);
		expect(after?.start).toBe(10);
		expect(result.playhead).toBe(4);
	});

	test("Alt+W leaves a gap and clamps fades to the new length", () => {
		const a = clip(video, 0, 10, 0, { fadeIn: 3, fadeOut: 3 });
		const result = trimToPlayhead(project([a]), assets, {
			edge: "end",
			ripple: false,
			time: 2,
		});
		const [trimmed] = onTrack(result.project, 0);
		expect(trimmed && end(trimmed)).toBeCloseTo(2, 9);
		expect((trimmed?.fadeIn ?? 0) + (trimmed?.fadeOut ?? 0)).toBeCloseTo(2, 9);
		expect(trimmed?.fadeIn).toBeCloseTo(1, 9);
	});

	test("trims every unlocked clip under the playhead, linked partners included", () => {
		const group = crypto.randomUUID();
		const picture = clip(video, 0, 10, 0, { linkGroupId: group });
		const sound = clip(audio, 0, 10, 1, { linkGroupId: group });
		const lockedClip = clip(video, 0, 10, 2);
		const before = updateTrackSetting(
			project([picture, sound, lockedClip]),
			2,
			{ locked: true }
		);
		const result = trimToPlayhead(before, assets, {
			edge: "end",
			ripple: false,
			time: 6,
		});
		expect(result.trimmedIds).toEqual([picture.id, sound.id]);
		expect(onTrack(result.project, 2)).toEqual([lockedClip]);
		const linked = result.project.segments.filter(
			(segment) => segment.linkGroupId === group
		);
		expect(linked).toHaveLength(2);
	});

	test("a ripple that would cut a clip on a locked track leaves the gap open", () => {
		const a = clip(video, 0, 10, 0);
		const lockedClip = clip(video, 2, 6, 1);
		const later = clip(video, 12, 2, 1);
		const before = updateTrackSetting(project([a, lockedClip, later]), 1, {
			locked: true,
		});
		const result = trimToPlayhead(before, assets, {
			edge: "start",
			ripple: true,
			time: 4,
		});
		expect(onTrack(result.project, 1)).toEqual([lockedClip, later]);
		const [trimmed] = onTrack(result.project, 0);
		expect(trimmed?.sourceIn).toBeCloseTo(4, 9);
		expect(trimmed?.start).toBeCloseTo(4, 9);
		expect(result.limited).toBe(1);
		expect(result.playhead).toBe(4);
	});

	test("a ripple keeps a linked partner on a locked track in sync", () => {
		const group = crypto.randomUUID();
		const a = clip(video, 0, 10, 0);
		const next = clip(video, 10, 2, 0, { linkGroupId: group });
		const nextSound = clip(audio, 10, 2, 1, { linkGroupId: group });
		const before = updateTrackSetting(project([a, next, nextSound]), 1, {
			locked: true,
		});
		const result = trimToPlayhead(before, assets, {
			edge: "start",
			ripple: true,
			time: 4,
		});
		const find = (id: string) =>
			result.project.segments.find((segment) => segment.id === id);
		expect(find(next.id)?.start).toBeCloseTo(6, 9);
		expect(find(nextSound.id)?.start).toBeCloseTo(6, 9);
	});

	test("ripple start trims on two tracks close one shared span", () => {
		const a = clip(video, 0, 10, 0);
		const b = clip(video, 5, 10, 1);
		const afterA = clip(video, 10, 2, 0);
		const afterB = clip(video, 15, 2, 1);
		const result = trimToPlayhead(project([a, b, afterA, afterB]), assets, {
			edge: "start",
			ripple: true,
			time: 7,
		});
		const find = (id: string) =>
			result.project.segments.find((segment) => segment.id === id);
		expect(find(a.id)?.start).toBeCloseTo(0, 9);
		expect(find(a.id)?.sourceIn).toBeCloseTo(7, 9);
		expect(find(b.id)?.start).toBeCloseTo(0, 9);
		expect(find(b.id)?.sourceIn).toBeCloseTo(2, 9);
		expect(find(afterA.id)?.start).toBeCloseTo(3, 9);
		expect(find(afterB.id)?.start).toBeCloseTo(8, 9);
		expect(result.playhead).toBeCloseTo(0, 9);
		expect(result.limited).toBe(0);
	});

	test("a ripple end trim moves sync-locked tracks without a target with the markers", () => {
		const a = clip(video, 0, 10, 0);
		const a2 = clip(video, 10, 5, 0);
		const music = clip(audio, 12, 5, 2);
		const marker = { id: crypto.randomUUID(), label: "Beat", time: 12 };
		const result = trimToPlayhead(
			project([a, a2, music], { markers: [marker] }),
			assets,
			{ edge: "end", ripple: true, time: 6 }
		);
		const find = (id: string) =>
			result.project.segments.find((segment) => segment.id === id);
		expect(find(a2.id)?.start).toBeCloseTo(6, 9);
		expect(find(music.id)?.start).toBeCloseTo(8, 9);
		expect(result.project.markers[0]?.time).toBeCloseTo(8, 9);
	});

	test("ripple end trims on two tracks shift every track and marker once, by the same amount", () => {
		const a = clip(video, 0, 10, 0);
		const a2 = clip(video, 10, 20, 0);
		const b = clip(video, 4, 10, 1);
		const b2 = clip(video, 14, 20, 1);
		const marker = { id: crypto.randomUUID(), label: "Hit", time: 25 };
		const result = trimToPlayhead(
			project([a, a2, b, b2], { markers: [marker] }),
			assets,
			{ edge: "end", ripple: true, time: 6 }
		);
		const find = (id: string) =>
			result.project.segments.find((segment) => segment.id === id);
		const shiftA = a2.start - (find(a2.id)?.start ?? 0);
		const shiftB = b2.start - (find(b2.id)?.start ?? 0);
		const shiftMarker = marker.time - (result.project.markers[0]?.time ?? 0);
		expect(shiftA).toBeCloseTo(4, 9);
		expect(shiftB).toBeCloseTo(4, 9);
		expect(shiftMarker).toBeCloseTo(4, 9);
		// b's tail past a2's start stays open rather than cutting a2.
		expect(result.limited).toBe(1);
		expect(result.project.segments).toHaveLength(4);
	});

	test("a ripple trim on a track out of sync lock still closes its own span", () => {
		const a = clip(video, 0, 10, 0);
		const a2 = clip(video, 10, 5, 0);
		const other = clip(video, 12, 2, 1);
		const before = updateTrackSetting(project([a, a2, other]), 0, {
			syncLocked: false,
		});
		const result = trimToPlayhead(before, assets, {
			edge: "end",
			ripple: true,
			time: 6,
		});
		const find = (id: string) =>
			result.project.segments.find((segment) => segment.id === id);
		expect(find(a2.id)?.start).toBeCloseTo(6, 9);
		expect(find(other.id)?.start).toBeCloseTo(8, 9);
	});

	test("a ripple end trim never removes clips after a shorter target", () => {
		const group = crypto.randomUUID();
		const picture = clip(video, 0, 6, 0, { linkGroupId: group });
		const sound = clip(audio, 0, 6, 1, { linkGroupId: group });
		const broll = clip(video, 6, 3, 0);
		const music = clip(audio, 0, 9, 2);
		const result = trimToPlayhead(
			project([picture, sound, broll, music]),
			assets,
			{ edge: "end", ripple: true, time: 4 }
		);
		const find = (id: string) =>
			result.project.segments.find((segment) => segment.id === id);
		expect(find(broll.id)?.start).toBeCloseTo(4, 9);
		const trimmedMusic = find(music.id);
		expect(trimmedMusic && end(trimmedMusic)).toBeCloseTo(4, 9);
		expect(result.project.segments).toHaveLength(4);
	});

	test("a ripple trim cut short by a neighbour is reported as limited", () => {
		const group = crypto.randomUUID();
		const picture = clip(video, 0, 10, 0, { linkGroupId: group });
		// The linked sound is shorter, so it limits how far the end can move.
		const sound = clip(audio, 5, 1, 1, { linkGroupId: group });
		const result = trimToPlayhead(project([picture, sound]), assets, {
			clipIds: [picture.id],
			edge: "end",
			ripple: true,
			time: 3,
		});
		expect(result.limited).toBe(1);
	});

	test("explicit clip ids trim only that clip and its partners", () => {
		const a = clip(video, 0, 10, 0);
		const b = clip(video, 0, 10, 1);
		const result = trimToPlayhead(project([a, b]), assets, {
			clipIds: [b.id],
			edge: "start",
			ripple: false,
			time: 3,
		});
		expect(onTrack(result.project, 0)).toEqual([a]);
		expect(onTrack(result.project, 1)[0]?.start).toBeCloseTo(3, 9);
	});

	test("nothing under the playhead throws", () => {
		const a = clip(video, 0, 10, 0);
		expect(() =>
			trimToPlayhead(project([a]), assets, {
				edge: "start",
				ripple: true,
				time: 20,
			})
		).toThrow("no unlocked clip under the playhead");
	});

	test("ripple trim keeps keyframes relative to the surviving media", () => {
		const a = clip(video, 0, 10, 0, {
			keyframes: [
				{ id: crypto.randomUUID(), property: "opacity", time: 6, value: 0.5 },
			],
		});
		const result = trimToPlayhead(project([a]), assets, {
			edge: "start",
			ripple: true,
			time: 4,
		});
		const [trimmed] = onTrack(result.project, 0);
		expect(
			trimmed?.keyframes.some(
				(frame) =>
					frame.property === "opacity" && Math.abs(frame.time - 2) < 1e-6
			)
		).toBe(true);
	});
});
