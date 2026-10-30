import { describe, expect, test } from "bun:test";
import {
	type Asset,
	newProject,
	newSegment,
	type Project,
	type Segment,
	updateTrackSetting,
} from "./project.ts";
import {
	dropUncoveredRevealTransitions,
	duplicateToNewTrack,
	firstFreeTrack,
	moveToNewTrack,
	moveToNewTrackRequestSchema,
	placementKindOf,
	placeOnNewTrack,
	trackFreeOver,
} from "./track-placement.ts";

function asset(kind: Asset["kind"] = "video", duration = 4): Asset {
	return {
		id: crypto.randomUUID(),
		name: kind,
		kind,
		duration,
		width: kind === "audio" ? 0 : 640,
		height: kind === "audio" ? 0 : 360,
		hasAudio: kind !== "image",
		createdAt: new Date().toISOString(),
	};
}

const clip = (source: Asset, start: number, track = 0): Segment =>
	newSegment(source, start, track);

describe("firstFreeTrack", () => {
	test("returns the lowest track free over the span", () => {
		const base = asset();
		const project = newProject("Free");
		project.segments = [clip(base, 0, 0), clip(base, 2, 1)];
		expect(firstFreeTrack(project, 0, 3)).toBe(2);
		expect(firstFreeTrack(project, 0, 2)).toBe(1);
		expect(firstFreeTrack(project, 4, 6)).toBe(0);
		// Touching edges do not occupy a track.
		expect(firstFreeTrack(project, 6, 8)).toBe(0);
		expect(firstFreeTrack(project, 0, 2, { from: 3 })).toBe(3);
	});

	test("skips locked and hidden tracks", () => {
		const project = updateTrackSetting(
			updateTrackSetting(newProject("Skip"), 0, { locked: true }),
			1,
			{ hidden: true }
		);
		expect(firstFreeTrack(project, 0, 1)).toBe(2);
	});

	test("keeps audio and visual media on separate lanes when assets are given", () => {
		const video = asset("video");
		const audio = asset("audio");
		const project = newProject("Kinds");
		project.segments = [clip(video, 0, 0), clip(audio, 0, 1)];
		const assets = [video, audio];
		expect(firstFreeTrack(project, 10, 12, { assets, kind: "audio" })).toBe(1);
		expect(firstFreeTrack(project, 10, 12, { assets, kind: "image" })).toBe(0);
		expect(firstFreeTrack(project, 10, 12, { kind: "audio" })).toBe(0);
		expect(placementKindOf("image")).toBe("visual");
	});

	test("ignores excluded clips and returns undefined when every track is taken", () => {
		const base = asset();
		const project = newProject("Full");
		project.segments = Array.from({ length: 32 }, (_, track) =>
			clip(base, 0, track)
		);
		expect(firstFreeTrack(project, 1, 2)).toBeUndefined();
		const exclude = new Set([project.segments[5]?.id ?? ""]);
		expect(firstFreeTrack(project, 1, 2, { exclude })).toBe(5);
		expect(trackFreeOver(project, 5, 1, 2, exclude)).toBe(true);
	});
});

describe("move and duplicate to a new track", () => {
	test("moves a clip to the first free track above it", () => {
		const base = asset();
		const project = newProject("Move");
		const moving = clip(base, 0, 0);
		project.segments = [moving, clip(base, 1, 1), clip(base, 10, 2)];
		const result = moveToNewTrack(project, [base], [moving.id]);
		expect(result.trackDelta).toBe(2);
		expect(result.ids).toEqual([moving.id]);
		expect(
			result.project.segments.find((segment) => segment.id === moving.id)?.track
		).toBe(2);
		expect(result.project.segments).toHaveLength(3);
	});

	test("a multi-track selection keeps its stacking", () => {
		const video = asset("video");
		const audio = asset("audio");
		const project = newProject("Stack");
		const group = crypto.randomUUID();
		const pictures = { ...clip(video, 0, 0), linkGroupId: group };
		const sound = { ...clip(audio, 0, 1), linkGroupId: group };
		project.segments = [pictures, sound];
		const moved = moveToNewTrack(
			project,
			[video, audio],
			[pictures.id, sound.id]
		);
		// Its own clips do not block the move: one track up is enough.
		expect(moved.trackDelta).toBe(1);
		expect(moved.project.segments.map((segment) => segment.track)).toEqual([
			1, 2,
		]);
		expect(moved.project.segments[0]?.linkGroupId).toBe(group);
	});

	test("duplicating copies with fresh ids and a re-minted link group", () => {
		const video = asset("video");
		const audio = asset("audio");
		const project = newProject("Duplicate");
		const group = crypto.randomUUID();
		const pictures: Segment = {
			...clip(video, 0, 0),
			keyframes: [
				{ id: crypto.randomUUID(), property: "opacity", time: 1, value: 0.5 },
			],
			linkGroupId: group,
		};
		const sound = { ...clip(audio, 0, 1), linkGroupId: group };
		project.segments = [pictures, sound];
		const copied = duplicateToNewTrack(
			project,
			[video, audio],
			[pictures.id, sound.id]
		);
		expect(copied.trackDelta).toBe(2);
		expect(copied.project.segments).toHaveLength(4);
		const copies = copied.ids.map((id) =>
			copied.project.segments.find((segment) => segment.id === id)
		);
		expect(copies.map((segment) => segment?.track)).toEqual([2, 3]);
		expect(copies[0]?.linkGroupId).toBeDefined();
		expect(copies[0]?.linkGroupId).not.toBe(group);
		expect(copies[0]?.linkGroupId).toBe(copies[1]?.linkGroupId);
		expect(copies[0]?.keyframes[0]?.id).not.toBe(pictures.keyframes[0]?.id);
		// Copying one member alone leaves the copy unlinked.
		const single = duplicateToNewTrack(project, [video, audio], [pictures.id]);
		const copy = single.project.segments.find(
			(segment) => segment.id === single.ids[0]
		);
		expect(copy?.linkGroupId).toBeUndefined();
	});

	test("refuses locked sources and full timelines; validates the request", () => {
		const base = asset();
		const project = newProject("Refuse");
		const moving = clip(base, 0, 0);
		project.segments = [moving];
		const locked = updateTrackSetting(project, 0, { locked: true });
		expect(() => moveToNewTrack(locked, [base], [moving.id])).toThrow(
			"Unlock the clip track"
		);
		expect(duplicateToNewTrack(locked, [base], [moving.id]).trackDelta).toBe(1);
		const top: Project = { ...project, segments: [clip(base, 0, 31)] };
		expect(() =>
			moveToNewTrack(top, [base], [top.segments[0]?.id ?? ""])
		).toThrow("No free");
		expect(() =>
			placeOnNewTrack(project, [base], {
				clipIds: [moving.id, moving.id],
				revision: 0,
			})
		).toThrow("Choose each clip once");
		expect(
			moveToNewTrackRequestSchema.parse({ clipIds: [moving.id], revision: 0 })
				.duplicate
		).toBe(false);
		expect(
			moveToNewTrackRequestSchema.safeParse({
				clipIds: [moving.id],
				revision: 0,
				track: 2,
			}).success
		).toBe(false);
	});

	test("moving a reveal predecessor away drops the uncovered transition", () => {
		const base = asset();
		const project = newProject("Reveal");
		const before = clip(base, 0, 0);
		const after: Segment = {
			...clip(base, 3, 0),
			transitionIn: { duration: 1, softness: 0, type: "dissolve" },
		};
		project.segments = [before, after];
		const moved = moveToNewTrack(project, [base], [before.id]);
		expect(
			moved.project.segments.find((segment) => segment.id === after.id)
				?.transitionIn
		).toBeUndefined();
		expect(dropUncoveredRevealTransitions(project.segments)).toEqual(
			project.segments
		);
	});
});

describe("duplicate to a new track with reveal transitions", () => {
	test("drops a reveal transition the copy has no predecessor for", () => {
		const base = asset("video", 10);
		const project = newProject("Reveal");
		const before = clip(base, 0);
		const after: Segment = {
			...clip(base, 9),
			transitionIn: { duration: 1, softness: 0, type: "dissolve" },
		};
		project.segments = [before, after];
		const moved = moveToNewTrack(project, [base], [after.id]);
		expect(
			moved.project.segments.find((segment) => segment.id === after.id)
				?.transitionIn
		).toBeUndefined();
		const duplicated = duplicateToNewTrack(project, [base], [after.id]);
		const [copyId] = duplicated.ids;
		const copy = duplicated.project.segments.find(
			(segment) => segment.id === copyId
		);
		expect(copy?.track).toBe(1);
		expect(copy?.transitionIn).toBeUndefined();
		// The original keeps its transition over its own predecessor.
		expect(
			duplicated.project.segments.find((segment) => segment.id === after.id)
				?.transitionIn
		).toEqual({ duration: 1, softness: 0, type: "dissolve" });
	});
});

describe("move and duplicate to a new track keep media classes apart", () => {
	test("audio skips a free span on a video lane", () => {
		const audio = asset("audio", 3);
		const video = asset("video", 10);
		const project = newProject("Kinds move");
		const sound = clip(audio, 0, 0);
		project.segments = [sound, clip(video, 5, 1)];
		const moved = moveToNewTrack(project, [audio, video], [sound.id]);
		expect(moved.trackDelta).toBe(2);
		expect(
			moved.project.segments.find((segment) => segment.id === sound.id)?.track
		).toBe(2);
		const copied = duplicateToNewTrack(project, [audio, video], [sound.id]);
		expect(copied.trackDelta).toBe(2);
	});

	test("visual clips skip audio lanes, and a clip's own track does not count", () => {
		const audio = asset("audio", 10);
		const image = asset("image", 2);
		const project = newProject("Kinds visual");
		const still = clip(image, 0, 0);
		project.segments = [still, clip(audio, 5, 1), clip(image, 5, 2)];
		expect(moveToNewTrack(project, [audio, image], [still.id]).trackDelta).toBe(
			2
		);
	});
});
