import { describe, expect, test } from "bun:test";
import { MAX_TRACK_INDEX, MAX_TRACKS } from "./limits.ts";
import {
	type Asset,
	newProject,
	newSegment,
	type Project,
	trackSettingFor,
	updateTrackSetting,
} from "./project.ts";
import {
	addTrack,
	addTrackRequestSchema,
	removeTrack,
	removeTrackRequestSchema,
	reorderTracks,
	trackOrderFor,
} from "./track-edits.ts";

function asset(kind: "video" | "audio" = "video"): Asset {
	return {
		createdAt: new Date(0).toISOString(),
		duration: 10,
		hasAudio: true,
		height: kind === "audio" ? 0 : 360,
		id: crypto.randomUUID(),
		kind,
		name: kind,
		width: kind === "audio" ? 0 : 640,
	};
}

/** Clips on tracks 0, 1, and 2; track 1 is renamed and track 2 keeps a default name. */
function threeTracks() {
	const video = asset();
	const audio = asset("audio");
	const linkGroupId = crypto.randomUUID();
	const base = { ...newSegment(video, 0, 0), linkGroupId };
	const overlay = newSegment(video, 0, 1);
	const music = { ...newSegment(audio, 0, 2), linkGroupId };
	let project: Project = {
		...newProject("Tracks"),
		segments: [base, overlay, music],
	};
	project = updateTrackSetting(project, 1, { name: "B-roll" });
	project = updateTrackSetting(project, 2, { muted: true });
	return { assets: [video, audio], base, music, overlay, project };
}

const trackOf = (project: Project, id: string) =>
	project.segments.find((segment) => segment.id === id)?.track;

describe("addTrack", () => {
	test("inserts an empty track and moves tracks at or above it up", () => {
		const { assets, base, music, overlay, project } = threeTracks();
		const next = addTrack(project, assets, 1);
		expect(trackOf(next, base.id)).toBe(0);
		expect(trackOf(next, overlay.id)).toBe(2);
		expect(trackOf(next, music.id)).toBe(3);
		expect(trackOrderFor(next)).toEqual([0, 1, 2, 3]);
		expect(trackSettingFor(next, 1).name).toBe("Track 2");
		expect(trackSettingFor(next, 2).name).toBe("B-roll");
		expect(trackSettingFor(next, 3)).toMatchObject({
			muted: true,
			name: "Track 4",
		});
	});

	test("adding above the top track lists the new empty lane", () => {
		const { assets, project } = threeTracks();
		const next = addTrack(project, assets, 3);
		expect(trackOrderFor(next)).toEqual([0, 1, 2, 3]);
		expect(next.segments).toEqual(project.segments);
	});

	test("adjustment layers keep covering the same clips", () => {
		const { assets, project } = threeTracks();
		const layer = {
			end: 2,
			id: crypto.randomUUID(),
			label: "Grade",
			opacity: 1,
			start: 0,
			track: 1,
		};
		const next = addTrack({ ...project, adjustmentLayers: [layer] }, assets, 0);
		expect(next.adjustmentLayers?.[0]?.track).toBe(2);
	});

	test("refuses positions outside the timeline and a full timeline", () => {
		const { assets, project } = threeTracks();
		expect(() => addTrack(project, assets, 5)).toThrow("position");
		expect(() => addTrack(project, assets, -1)).toThrow("position");
		const full = updateTrackSetting(project, MAX_TRACK_INDEX, {});
		expect(trackOrderFor(full)).toHaveLength(MAX_TRACKS);
		expect(() => addTrack(full, assets, 0)).toThrow(`${MAX_TRACKS} tracks`);
	});

	test("add then remove restores the timeline", () => {
		const { assets, project } = threeTracks();
		const restored = removeTrack(addTrack(project, assets, 1), assets, 1);
		expect(restored.segments).toEqual(project.segments);
		expect(restored.trackSettings).toEqual(project.trackSettings);
	});
});

describe("removeTrack", () => {
	test("removes an empty track and moves tracks above it down", () => {
		const { assets, music, project } = threeTracks();
		const withEmpty = addTrack(project, assets, 2);
		const next = removeTrack(withEmpty, assets, 2);
		expect(trackOf(next, music.id)).toBe(2);
		expect(trackSettingFor(next, 2)).toMatchObject({
			muted: true,
			name: "Track 3",
		});
	});

	test("refuses a non-empty track unless forced", () => {
		const { assets, base, music, overlay, project } = threeTracks();
		expect(() => removeTrack(project, assets, 1)).toThrow("B-roll has 1 clip");
		const next = removeTrack(project, assets, 1, { force: true });
		expect(next.segments.map((segment) => segment.id)).toEqual([
			base.id,
			music.id,
		]);
		expect(trackOf(next, music.id)).toBe(1);
		expect(next.segments.some((segment) => segment.id === overlay.id)).toBe(
			false
		);
	});

	test("forcing a track with a linked clip dissolves the orphaned link", () => {
		const { assets, base, project } = threeTracks();
		const next = removeTrack(project, assets, 2, { force: true });
		expect(
			next.segments.find((segment) => segment.id === base.id)?.linkGroupId
		).toBeUndefined();
	});

	test("forcing drops multicam and template references to removed clips", () => {
		const { assets, base, overlay, project } = threeTracks();
		const withRefs: Project = {
			...project,
			template: {
				slots: [
					{
						fixedDuration: false,
						id: "slot",
						kind: "video",
						label: "Overlay",
						segmentId: overlay.id,
					},
				],
			},
		};
		const next = removeTrack(withRefs, assets, 1, { force: true });
		expect(next.template?.slots).toEqual([]);
		expect(next.segments.map((segment) => segment.id)).toContain(base.id);
	});

	test("refuses a locked track or one off the timeline", () => {
		const { assets, project } = threeTracks();
		const locked = updateTrackSetting(project, 1, { locked: true });
		expect(() => removeTrack(locked, assets, 1, { force: true })).toThrow(
			"Unlock B-roll"
		);
		expect(() => removeTrack(project, assets, 9)).toThrow("not on this");
	});

	test("an adjustment layer over the removed track covers the tracks below", () => {
		const { assets, project } = threeTracks();
		const layer = {
			end: 2,
			id: crypto.randomUUID(),
			label: "Grade",
			opacity: 1,
			start: 0,
			track: 1,
		};
		const above = { ...layer, id: crypto.randomUUID(), track: 2 };
		const next = removeTrack(
			{ ...project, adjustmentLayers: [layer, above] },
			assets,
			1,
			{ force: true }
		);
		expect(next.adjustmentLayers?.map((item) => item.track)).toEqual([0, 1]);
	});
});

describe("track request schemas", () => {
	test("are strict and bound the track index", () => {
		expect(
			addTrackRequestSchema.safeParse({ at: 0, revision: 0 }).success
		).toBe(true);
		expect(
			addTrackRequestSchema.safeParse({ at: MAX_TRACK_INDEX + 1, revision: 0 })
				.success
		).toBe(false);
		expect(
			removeTrackRequestSchema.safeParse({ extra: 1, revision: 0, track: 0 })
				.success
		).toBe(false);
	});
});

test("reorderTracks still moves settings with their clips", () => {
	const { base, overlay, project } = threeTracks();
	const next = reorderTracks(project, [1, 0, 2]);
	expect(trackOf(next, base.id)).toBe(1);
	expect(trackOf(next, overlay.id)).toBe(0);
	expect(trackSettingFor(next, 0).name).toBe("B-roll");
});
