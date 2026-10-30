import { describe, expect, test } from "bun:test";
import { insertClips } from "./insert.ts";
import { MAX_TRACK_INDEX } from "./limits.ts";
import {
	type Asset,
	newProject,
	newSegment,
	type Project,
	rippleDeleteRange,
	type Segment,
	updateTrackSetting,
} from "./project.ts";
import { removeWordRanges } from "./remove-words.ts";
import { rippleDeleteGap, rippleRemoveClips } from "./ripple-edits.ts";
import {
	affectedTracks,
	clipAudible,
	clipVisible,
	rippleMarkersOf,
	trackHidden,
	trackSyncLocked,
} from "./sync-lock.ts";
import { trimEdit } from "./trim-modes.ts";

function asset(kind: "video" | "audio" = "video", duration = 20): Asset {
	return {
		createdAt: new Date(0).toISOString(),
		duration,
		hasAudio: true,
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
	length: number,
	track: number
): Segment {
	return {
		...newSegment(source, start, track),
		sourceIn: 0,
		sourceOut: length,
	};
}

function find(project: Project, id: string): Segment {
	const found = project.segments.find((segment) => segment.id === id);
	if (!found) {
		throw new Error("missing clip");
	}
	return found;
}

/** Dialogue on track 0 (two clips) and a music bed on track 2. */
function scene() {
	const video = asset();
	const music = asset("audio", 60);
	const first = clip(video, 0, 4, 0);
	const second = clip(video, 4, 4, 0);
	const bed = clip(music, 0, 8, 2);
	const project: Project = {
		...newProject("Sync lock"),
		markers: [{ id: crypto.randomUUID(), label: "Beat", time: 6 }],
		segments: [first, second, bed],
	};
	return { assets: [video, music], bed, first, music, project, second, video };
}

const unlockSync = (project: Project, track: number) =>
	updateTrackSetting(project, track, { syncLocked: false });

describe("affectedTracks", () => {
	test("every track is sync-locked unless explicitly unlocked", () => {
		const project = newProject("Tracks");
		expect(trackSyncLocked(project, 0)).toBe(true);
		expect(affectedTracks(project).size).toBe(MAX_TRACK_INDEX + 1);
	});

	test("edited tracks join the sync-locked tracks", () => {
		const project = unlockSync(unlockSync(newProject("Tracks"), 2), 3);
		const affected = affectedTracks(project, [3]);
		expect(affected.has(2)).toBe(false);
		expect(affected.has(3)).toBe(true);
		expect(affected.has(0)).toBe(true);
		expect(affected.size).toBe(MAX_TRACK_INDEX);
	});
});

describe("rippleMarkersOf", () => {
	test("markers ripple unless the project opts out", () => {
		const project = newProject("Markers");
		expect(rippleMarkersOf(project)).toBe(true);
		expect(rippleMarkersOf({ ...project, rippleMarkers: true })).toBe(true);
		expect(rippleMarkersOf({ ...project, rippleMarkers: false })).toBe(false);
	});
});

describe("clip visibility", () => {
	const project = newProject("Visibility");
	const segment = newSegment(asset(), 0, 1);

	test("a clip is visible and audible by default", () => {
		expect(clipVisible(project, segment)).toBe(true);
		expect(clipAudible(project, segment)).toBe(true);
	});

	test("hiding the clip or its track hides the picture and silences it", () => {
		expect(clipVisible(project, { ...segment, hidden: true })).toBe(false);
		const hiddenTrack = updateTrackSetting(project, 1, { hidden: true });
		expect(trackHidden(hiddenTrack, 1)).toBe(true);
		expect(clipVisible(hiddenTrack, segment)).toBe(false);
		expect(clipAudible(hiddenTrack, segment)).toBe(false);
		expect(clipAudible(project, { ...segment, hidden: true })).toBe(false);
		expect(clipVisible(hiddenTrack, { ...segment, track: 0 })).toBe(true);
	});

	test("muting the clip, muting the track, or soloing another track silences it", () => {
		const muted: Segment = { ...segment, muted: true };
		expect(clipAudible(project, muted)).toBe(false);
		expect(clipVisible(project, muted)).toBe(true);
		expect(
			clipAudible(updateTrackSetting(project, 1, { muted: true }), segment)
		).toBe(false);
		expect(
			clipAudible(updateTrackSetting(project, 0, { solo: true }), segment)
		).toBe(false);
	});
});

describe("rippleDeleteRange with sync lock", () => {
	test("legacy projects ripple every track and the markers", () => {
		const { assets, bed, project, second } = scene();
		const next = rippleDeleteRange(project, assets, 1, 2);
		expect(find(next, second.id).start).toBe(3);
		const bedPieces = next.segments.filter(
			(segment) => segment.assetId === bed.assetId
		);
		expect(bedPieces.map((piece) => [piece.start, piece.sourceIn])).toEqual([
			[0, 0],
			[1, 2],
		]);
		expect(next.markers.map((marker) => marker.time)).toEqual([5]);
	});

	test("a track that is not sync-locked stays in place", () => {
		const { assets, bed, project, second } = scene();
		const next = rippleDeleteRange(unlockSync(project, 2), assets, 1, 2);
		expect(find(next, second.id).start).toBe(3);
		expect(find(next, bed.id)).toEqual(bed);
		expect(next.segments.filter((segment) => segment.track === 2)).toHaveLength(
			1
		);
	});

	test("an edited track ripples even when it is not sync-locked", () => {
		const { assets, bed, project } = scene();
		const unlocked = unlockSync(unlockSync(project, 2), 0);
		const next = rippleDeleteRange(unlocked, assets, 1, 2, { tracks: [2] });
		expect(find(next, bed.id).sourceOut).toBe(1);
		expect(next.segments.filter((segment) => segment.track === 0)).toEqual(
			unlocked.segments.filter((segment) => segment.track === 0)
		);
	});

	test("markers keep their times when rippleMarkers is false", () => {
		const { assets, project } = scene();
		const pinned = { ...project, rippleMarkers: false };
		const next = rippleDeleteRange(pinned, assets, 1, 2);
		expect(next.markers).toEqual(project.markers);
		expect(next.rippleMarkers).toBe(false);
	});
});

describe("insertClips with sync lock", () => {
	test("legacy projects open the gap on every track", () => {
		const { assets, bed, project, second, video } = scene();
		const next = insertClips(project, assets, 4, 0, [
			{ assetId: video.id, sourceIn: 0, sourceOut: 2, speed: 1, volume: 1 },
		]);
		expect(find(next, second.id).start).toBe(6);
		expect(
			next.segments
				.filter((segment) => segment.assetId === bed.assetId)
				.map((piece) => piece.start)
		).toEqual([0, 6]);
		expect(next.markers.map((marker) => marker.time)).toEqual([8]);
	});

	test("a track that is not sync-locked is neither split nor shifted", () => {
		const { assets, bed, project, second, video } = scene();
		const next = insertClips(unlockSync(project, 2), assets, 4, 0, [
			{ assetId: video.id, sourceIn: 0, sourceOut: 2, speed: 1, volume: 1 },
		]);
		expect(find(next, second.id).start).toBe(6);
		expect(find(next, bed.id)).toEqual(bed);
	});

	test("the target track opens the gap even when it is not sync-locked", () => {
		const { assets, project, second, video } = scene();
		const next = insertClips(unlockSync(project, 0), assets, 4, 0, [
			{ assetId: video.id, sourceIn: 0, sourceOut: 2, speed: 1, volume: 1 },
		]);
		expect(find(next, second.id).start).toBe(6);
	});

	test("markers stay when rippleMarkers is false", () => {
		const { assets, project, video } = scene();
		const next = insertClips(
			{ ...project, rippleMarkers: false },
			assets,
			4,
			0,
			[{ assetId: video.id, sourceIn: 0, sourceOut: 2, speed: 1, volume: 1 }]
		);
		expect(next.markers).toEqual(project.markers);
	});

	test("adjustment layers after the insertion point move with the gap", () => {
		const { assets, project, video } = scene();
		const layer = {
			end: 7,
			id: crypto.randomUUID(),
			label: "Grade",
			opacity: 1,
			start: 5,
			track: 2,
		};
		const next = insertClips(
			{ ...project, adjustmentLayers: [layer] },
			assets,
			4,
			0,
			[{ assetId: video.id, sourceIn: 0, sourceOut: 2, speed: 1, volume: 1 }]
		);
		expect(next.adjustmentLayers?.[0]).toMatchObject({ end: 9, start: 7 });
	});
});

describe("gap and clip ripple on a track with sync lock off", () => {
	/** Dialogue on track 0 and music on track 2, each 0-2 and 4-6; track 2 unsynced. */
	function lanes() {
		const video = asset();
		const music = asset("audio", 60);
		const d1 = clip(video, 0, 2, 0);
		const d2 = clip(video, 4, 2, 0);
		const m1 = clip(music, 0, 2, 2);
		const m2 = clip(music, 4, 2, 2);
		const project = unlockSync(
			{ ...newProject("Lanes"), segments: [d1, d2, m1, m2] },
			2
		);
		return { assets: [video, music], d2, m1, m2, project };
	}

	test("closing a gap on the unsynced track moves its own later clips", () => {
		const { assets, d2, m2, project } = lanes();
		const result = rippleDeleteGap(project, assets, { time: 3, track: 2 });
		expect(result.gap).toEqual({ end: 4, start: 2 });
		expect(find(result.project, m2.id).start).toBe(2);
		expect(find(result.project, d2.id).start).toBe(2);
	});

	test("ripple-removing a clip on the unsynced track closes its span there", () => {
		const { assets, d2, m1, m2, project } = lanes();
		const shifted: Project = {
			...project,
			segments: project.segments.map((segment) =>
				segment.id === m1.id ? { ...segment, start: 2 } : segment
			),
		};
		const result = rippleRemoveClips(shifted, assets, [m1.id]);
		expect(result.closed).toHaveLength(1);
		expect(find(result.project, m2.id).start).toBe(2);
		expect(find(result.project, d2.id).start).toBe(2);
	});
});

describe("removeWordRanges with sync lock", () => {
	test("the music track keeps its timing when sync lock is off", () => {
		const { assets, bed, project, second } = scene();
		const next = removeWordRanges(unlockSync(project, 2), assets, {
			ranges: [
				{ end: 2, start: 1 },
				{ end: 5, start: 4.5 },
			],
			revision: project.revision,
		});
		expect(find(next, bed.id)).toEqual(bed);
		const dialogue = next.segments
			.filter((segment) => segment.track === 0)
			.map((segment) => Number(segment.start.toFixed(3)))
			.sort((a, b) => a - b);
		expect(dialogue).toEqual([0, 1, 3, 3.5]);
		expect(find(next, second.id).start).toBe(3);
	});

	test("listed tracks ripple even when they are not sync-locked", () => {
		const { assets, bed, project } = scene();
		const next = removeWordRanges(unlockSync(project, 2), assets, {
			ranges: [{ end: 2, start: 1 }],
			revision: project.revision,
			tracks: [2],
		});
		expect(find(next, bed.id).sourceOut).toBe(1);
	});

	test("rejects a track outside the schema", () => {
		const { assets, project } = scene();
		expect(() =>
			removeWordRanges(project, assets, {
				ranges: [{ end: 2, start: 1 }],
				revision: project.revision,
				tracks: [MAX_TRACK_INDEX + 1],
			})
		).toThrow();
	});
});

describe("ripple trim with sync lock", () => {
	const trimEnd = (project: Project, assets: Asset[], clipId: string) =>
		trimEdit(project, assets, {
			clipId,
			delta: -1,
			edge: "end",
			mode: "ripple",
			revision: 0,
		});

	test("by default only the trimmed track ripples", () => {
		const { assets, first, project, second, video } = scene();
		const other = clip(video, 5, 2, 1);
		const next = trimEnd(
			{ ...project, segments: [...project.segments, other] },
			assets,
			first.id
		);
		expect(find(next.project, second.id).start).toBe(3);
		expect(find(next.project, other.id).start).toBe(5);
	});

	test("syncLock ripples later clips on other sync-locked tracks", () => {
		const { assets, first, project, second, video } = scene();
		const other = clip(video, 5, 2, 1);
		const unsynced = clip(video, 5, 2, 3);
		const start = unlockSync(
			{ ...project, segments: [...project.segments, other, unsynced] },
			3
		);
		const next = trimEdit(start, assets, {
			clipId: first.id,
			delta: -1,
			edge: "end",
			mode: "ripple",
			revision: 0,
			syncLock: true,
		});
		expect(next.applied).toBe(-1);
		expect(find(next.project, second.id).start).toBe(3);
		expect(find(next.project, other.id).start).toBe(4);
		expect(find(next.project, unsynced.id).start).toBe(5);
	});

	test("syncLock refuses to move a clip on a locked sync-locked track", () => {
		const { assets, first, project, video } = scene();
		const other = clip(video, 5, 2, 1);
		const locked = updateTrackSetting(
			{ ...project, segments: [...project.segments, other] },
			1,
			{ locked: true }
		);
		expect(() =>
			trimEdit(locked, assets, {
				clipId: first.id,
				delta: -1,
				edge: "end",
				mode: "ripple",
				revision: 0,
				syncLock: true,
			})
		).toThrow("Unlock");
	});

	test("markers stay when rippleMarkers is false", () => {
		const { assets, first, project } = scene();
		const next = trimEnd(
			{ ...project, rippleMarkers: false },
			assets,
			first.id
		);
		expect(next.project.markers).toEqual(project.markers);
		const rippled = trimEnd(project, assets, first.id);
		expect(rippled.project.markers.map((marker) => marker.time)).toEqual([5]);
	});
});
