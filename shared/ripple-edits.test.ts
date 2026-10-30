import { describe, expect, test } from "bun:test";
import {
	type Asset,
	newProject,
	newSegment,
	type Project,
	type Segment,
	segmentDuration,
	updateTrackSetting,
} from "./project.ts";
import {
	gapAt,
	mergeTimeSpans,
	rippleDeleteGap,
	rippleDeleteGapRequestSchema,
	rippleMoveClips,
	rippleRemoveClips,
} from "./ripple-edits.ts";
import {
	removeClips,
	removeClipsRequestSchema,
	withoutClips,
} from "./timeline-edits.ts";

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
	return { ...newProject("Ripple edits"), segments, ...patch };
}

const starts = (value: Project, track: number) =>
	value.segments
		.filter((segment) => segment.track === track)
		.sort((a, b) => a.start - b.start)
		.map((segment) => Number(segment.start.toFixed(6)));

describe("mergeTimeSpans", () => {
	test("sorts and merges overlapping and touching spans", () => {
		expect(
			mergeTimeSpans([
				{ end: 9, start: 7 },
				{ end: 2, start: 0 },
				{ end: 4, start: 2 },
				{ end: 3, start: 1 },
			])
		).toEqual([
			{ end: 4, start: 0 },
			{ end: 9, start: 7 },
		]);
	});
});

describe("rippleRemoveClips", () => {
	test("removes a clip and closes its span on the track", () => {
		const a = clip(video, 0, 4, 0);
		const b = clip(video, 4, 3, 0);
		const c = clip(video, 7, 3, 0);
		const result = rippleRemoveClips(project([a, b, c]), assets, [b.id]);
		expect(starts(result.project, 0)).toEqual([0, 4]);
		expect(result.closed).toEqual([{ end: 7, start: 4 }]);
	});

	test("a non-contiguous selection closes each span, latest first", () => {
		const a = clip(video, 0, 2, 0);
		const b = clip(video, 2, 2, 0);
		const c = clip(video, 4, 2, 0);
		const d = clip(video, 6, 2, 0);
		const e = clip(video, 8, 2, 0);
		const result = rippleRemoveClips(project([a, b, c, d, e]), assets, [
			b.id,
			d.id,
		]);
		expect(starts(result.project, 0)).toEqual([0, 2, 4]);
		expect(result.project.segments.map((segment) => segment.id)).toEqual([
			a.id,
			c.id,
			e.id,
		]);
		expect(result.closed).toEqual([
			{ end: 8, start: 6 },
			{ end: 4, start: 2 },
		]);
	});

	test("adjacent selected clips close as one span", () => {
		const a = clip(video, 0, 2, 0);
		const b = clip(video, 2, 2, 0);
		const c = clip(video, 4, 2, 0);
		const result = rippleRemoveClips(project([a, b, c]), assets, [a.id, b.id]);
		expect(result.closed).toEqual([{ end: 4, start: 0 }]);
		expect(starts(result.project, 0)).toEqual([0]);
	});

	test("linked partners are removed with the selection", () => {
		const group = crypto.randomUUID();
		const picture = clip(video, 0, 3, 0, { linkGroupId: group });
		const sound = clip(audio, 0, 3, 1, { linkGroupId: group });
		const later = clip(video, 3, 3, 0);
		const result = rippleRemoveClips(project([picture, sound, later]), assets, [
			picture.id,
		]);
		expect(result.project.segments.map((segment) => segment.id)).toEqual([
			later.id,
		]);
		expect(starts(result.project, 0)).toEqual([0]);
	});

	test("a span at the end of the timeline needs no closing", () => {
		const a = clip(video, 0, 3, 0);
		const b = clip(video, 3, 3, 0);
		const result = rippleRemoveClips(project([a, b]), assets, [b.id]);
		expect(result.closed).toEqual([]);
		expect(result.project.segments).toHaveLength(1);
	});

	test("markers and titles after the span move left", () => {
		const a = clip(video, 0, 4, 0);
		const b = clip(video, 4, 4, 0);
		const before = project([a, b], {
			markers: [
				{ color: "#ffffff", id: crypto.randomUUID(), label: "Late", time: 6 },
			],
		});
		const result = rippleRemoveClips(before, assets, [a.id]);
		expect(result.project.markers[0]?.time).toBe(2);
	});

	test("locked clips refuse the ripple delete", () => {
		const a = clip(video, 0, 4, 0);
		const locked = updateTrackSetting(project([a]), 0, { locked: true });
		expect(() => rippleRemoveClips(locked, assets, [a.id])).toThrow(
			"Unlock every affected clip track"
		);
	});

	test("a span still covered by a clip on another track stays open", () => {
		const a = clip(video, 0, 4, 0);
		const b = clip(video, 4, 4, 0);
		const bed = clip(audio, 0, 8, 1);
		const result = rippleRemoveClips(project([a, b, bed]), assets, [a.id]);
		expect(result.unclosed).toBe(1);
		expect(result.closed).toEqual([]);
		expect(starts(result.project, 0)).toEqual([4]);
		expect(starts(result.project, 1)).toEqual([0]);
	});

	test("clips on tracks opted out of sync lock do not hold a span open", () => {
		const a = clip(video, 0, 4, 0);
		const b = clip(video, 4, 4, 0);
		const bed = clip(audio, 0, 8, 1);
		const free = updateTrackSetting(project([a, b, bed]), 1, {
			syncLocked: false,
		});
		const result = rippleRemoveClips(free, assets, [a.id]);
		expect(result.closed).toEqual([{ end: 4, start: 0 }]);
		expect(starts(result.project, 0)).toEqual([0]);
	});

	test("an unselected clip on an edited track outside sync lock holds the merged span open", () => {
		const a = clip(video, 0, 10, 0);
		const b = clip(video, 5, 10, 1);
		const c = clip(video, 10, 10, 0);
		let free = updateTrackSetting(project([a, b, c]), 0, {
			syncLocked: false,
		});
		free = updateTrackSetting(free, 1, { syncLocked: false });
		const result = rippleRemoveClips(free, assets, [a.id, b.id]);
		expect(result.unclosed).toBe(1);
		// C is never cut or re-minted: it keeps its id, place and media.
		expect(result.project.segments).toEqual([c]);
	});

	test("a ripple that would cut a locked clip outside sync lock is refused", () => {
		const a = clip(video, 0, 4, 0);
		const b = clip(video, 4, 4, 0);
		const bed = clip(audio, 0, 8, 1);
		const locked = updateTrackSetting(project([a, b, bed]), 1, {
			locked: true,
			syncLocked: false,
		});
		expect(() => rippleRemoveClips(locked, assets, [a.id])).toThrow(
			"Unlock track 2"
		);
	});

	test("unknown ids throw", () => {
		const a = clip(video, 0, 4, 0);
		expect(() =>
			rippleRemoveClips(project([a]), assets, [crypto.randomUUID()])
		).toThrow("Clip not found");
	});

	test("template slots and multicam membership of removed clips are dropped", () => {
		const a = clip(video, 0, 4, 0);
		const b = clip(video, 4, 4, 0);
		const before = project([a, b], {
			template: {
				slots: [
					{
						fixedDuration: false,
						id: crypto.randomUUID(),
						kind: "video",
						label: "Opening",
						segmentId: a.id,
					},
				],
			},
		});
		const result = rippleRemoveClips(before, assets, [a.id]);
		expect(result.project.template?.slots).toEqual([]);
	});
});

describe("remove route schema", () => {
	test("ripple is an optional flag on the remove body", () => {
		const id = crypto.randomUUID();
		expect(
			removeClipsRequestSchema.parse({
				clipIds: [id],
				revision: 0,
				ripple: true,
			}).ripple
		).toBe(true);
		expect(
			removeClipsRequestSchema.parse({ clipIds: [id], revision: 0 }).ripple
		).toBeUndefined();
	});

	test("plain remove leaves the gap", () => {
		const a = clip(video, 0, 4, 0);
		const b = clip(video, 4, 4, 0);
		const result = removeClips(project([a, b]), assets, {
			clipIds: [a.id],
			revision: 0,
		});
		expect(starts(result, 0)).toEqual([4]);
	});

	test("withoutClips dissolves link groups left with one member", () => {
		const group = crypto.randomUUID();
		const x = clip(video, 0, 4, 0, { linkGroupId: group });
		const y = clip(audio, 0, 4, 1, { linkGroupId: group });
		const next = withoutClips(project([x, y]), new Set([x.id]));
		expect(next.segments[0]?.linkGroupId).toBeUndefined();
	});
});

describe("gapAt", () => {
	const a = clip(video, 1, 2, 0);
	const b = clip(video, 5, 2, 0);
	const overlapping = clip(video, 4, 2, 0);
	const value = project([a, b]);

	test("finds the gap between two clips", () => {
		expect(gapAt(value, 0, 4)).toEqual({ end: 5, start: 3 });
	});

	test("finds the leading gap from the timeline start", () => {
		expect(gapAt(value, 0, 0.5)).toEqual({ end: 1, start: 0 });
	});

	test("is null on a clip, after the last clip, or on an empty track", () => {
		expect(gapAt(value, 0, 2)).toBeNull();
		expect(gapAt(value, 0, 9)).toBeNull();
		expect(gapAt(value, 3, 1)).toBeNull();
	});

	test("overlapping clips on the track narrow the gap", () => {
		const crowded = project([a, b, overlapping]);
		expect(gapAt(crowded, 0, 3.5)).toEqual({ end: 4, start: 3 });
		expect(gapAt(crowded, 0, 4.5)).toBeNull();
	});

	test("clips on other tracks do not count", () => {
		const other = clip(video, 2, 4, 1);
		expect(gapAt(project([a, b, other]), 0, 4)).toEqual({ end: 5, start: 3 });
	});
});

describe("rippleDeleteGap", () => {
	test("request schema is strict", () => {
		expect(
			rippleDeleteGapRequestSchema.safeParse({ revision: 0, time: 1, track: 0 })
				.success
		).toBe(true);
		expect(
			rippleDeleteGapRequestSchema.safeParse({
				extra: true,
				revision: 0,
				time: 1,
				track: 0,
			}).success
		).toBe(false);
	});

	test("closes the gap and shifts later clips", () => {
		const a = clip(video, 0, 2, 0);
		const b = clip(video, 5, 2, 0);
		const result = rippleDeleteGap(project([a, b]), assets, {
			time: 3,
			track: 0,
		});
		expect(result.gap).toEqual({ end: 5, start: 2 });
		expect(starts(result.project, 0)).toEqual([0, 2]);
		expect(segmentDuration(result.project.segments[1] as Segment)).toBe(2);
	});

	test("later clips on other sync-locked tracks move too", () => {
		const a = clip(video, 0, 2, 0);
		const b = clip(video, 5, 2, 0);
		const music = clip(audio, 6, 2, 1);
		const result = rippleDeleteGap(project([a, b, music]), assets, {
			time: 3,
			track: 0,
		});
		expect(starts(result.project, 1)).toEqual([3]);
	});

	test("clips on another track inside the gap refuse the edit", () => {
		const a = clip(video, 0, 2, 0);
		const b = clip(video, 5, 2, 0);
		const bed = clip(audio, 0, 8, 1);
		expect(() =>
			rippleDeleteGap(project([a, b, bed]), assets, { time: 3, track: 0 })
		).toThrow("Track 2 has clips inside this gap");
	});

	test("a locked track refuses, and no gap throws", () => {
		const a = clip(video, 0, 2, 0);
		const b = clip(video, 5, 2, 0);
		const locked = updateTrackSetting(project([a, b]), 0, { locked: true });
		expect(() =>
			rippleDeleteGap(locked, assets, { time: 3, track: 0 })
		).toThrow("Unlock this track");
		expect(() =>
			rippleDeleteGap(project([a, b]), assets, { time: 1, track: 0 })
		).toThrow("no gap");
	});

	test("gaps shorter than 0.04 s are refused with guidance", () => {
		const a = clip(video, 0, 2, 0);
		const b = clip(video, 2.02, 2, 0);
		expect(() =>
			rippleDeleteGap(project([a, b]), assets, { time: 2.01, track: 0 })
		).toThrow("shorter than 0.04 seconds");
	});
});

describe("ripple edits on a track out of sync lock", () => {
	test("Ripple Delete Gap closes the gap on the edited track itself", () => {
		const a = clip(video, 0, 4, 0);
		const b = clip(video, 8, 4, 0);
		const c = clip(video, 10, 4, 1);
		const before = updateTrackSetting(project([a, b, c]), 0, {
			syncLocked: false,
		});
		const result = rippleDeleteGap(before, assets, { time: 6, track: 0 });
		expect(starts(result.project, 0)).toEqual([0, 4]);
		expect(starts(result.project, 1)).toEqual([6]);
	});

	test("ripple remove closes the removed span on the clip's own track", () => {
		const a = clip(video, 0, 4, 0);
		const b = clip(video, 4, 4, 0);
		const before = updateTrackSetting(project([a, b]), 0, {
			syncLocked: false,
		});
		const result = rippleRemoveClips(before, assets, [a.id]);
		expect(result.closed).toEqual([{ end: 4, start: 0 }]);
		expect(starts(result.project, 0)).toEqual([0]);
	});

	test("other tracks out of sync lock stay put", () => {
		const a = clip(video, 0, 4, 0);
		const b = clip(video, 4, 4, 0);
		const pinned = clip(video, 6, 2, 1);
		const before = updateTrackSetting(project([a, b, pinned]), 1, {
			syncLocked: false,
		});
		const result = rippleRemoveClips(before, assets, [a.id]);
		expect(starts(result.project, 0)).toEqual([0]);
		expect(starts(result.project, 1)).toEqual([6]);
	});
});

describe("rippleMoveClips", () => {
	test("extracts the clip, closes its gap, and inserts it at an edit point", () => {
		const a = clip(video, 0, 2, 0);
		const b = clip(video, 2, 3, 0);
		const c = clip(video, 5, 1, 0);
		const moved = rippleMoveClips(project([a, b, c]), assets, {
			clipIds: [a.id],
			delta: 5.8,
			trackDelta: 0,
		});
		// a drops near the end of c (5.8 - 2 = 3.8 in the closed timeline; c is 3..4).
		expect(moved.at).toBe(4);
		expect(starts(moved.project, 0)).toEqual([0, 3, 4]);
		expect(moved.project.segments.find((s) => s.id === a.id)?.start).toBe(4);
	});

	test("linked partners move with the clip and sync-locked tracks make room", () => {
		const group = crypto.randomUUID();
		const a = clip(video, 0, 2, 0, { linkGroupId: group });
		const aAudio = clip(audio, 0, 2, 1, { linkGroupId: group });
		const b = clip(video, 2, 2, 0);
		const music = clip(audio, 2, 2, 2);
		const moved = rippleMoveClips(project([a, aAudio, b, music]), assets, {
			clipIds: [a.id],
			delta: 3,
			trackDelta: 0,
		});
		expect(moved.at).toBe(2);
		expect(moved.project.segments.find((s) => s.id === aAudio.id)?.start).toBe(
			2
		);
		expect(starts(moved.project, 0)).toEqual([0, 2]);
		// The sync-locked music track closed the gap at 0 with the extraction;
		// it ends at the insertion point, so the insertion leaves it there.
		expect(moved.project.segments.find((s) => s.id === music.id)?.start).toBe(
			0
		);
		expect(
			moved.project.segments.reduce(
				(sum, segment) => sum + segmentDuration(segment),
				0
			)
		).toBe(8);
	});
});
