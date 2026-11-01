import { describe, expect, test } from "bun:test";
import { animatedValue } from "./animation.ts";
import {
	fadeBounds,
	groupDuplicate,
	groupMove,
	groupTrim,
	setClipFade,
	trimBounds,
} from "./group-edits.ts";
import { MAX_TRACK_INDEX } from "./limits.ts";
import {
	type Asset,
	newProject,
	newSegment,
	type Project,
	type Segment,
	segmentDuration,
	updateTrackSetting,
} from "./project.ts";

function asset(kind: Asset["kind"], duration = 20): Asset {
	return {
		createdAt: new Date(0).toISOString(),
		duration,
		hasAudio: kind !== "image",
		height: kind === "audio" ? 0 : 360,
		id: crypto.randomUUID(),
		kind,
		name: `${kind}.media`,
		width: kind === "audio" ? 0 : 640,
	};
}

function clip(
	source: Asset,
	start: number,
	track: number,
	extra: Partial<Segment> = {}
): Segment {
	return {
		...newSegment(source, start, track),
		sourceIn: 2,
		sourceOut: 6,
		...extra,
	};
}

/**
 * Track 0: picture [2, 6) linked to sound on track 1 [2, 6), then a neighbour
 * [8, 12). Track 2: b-roll [3, 7).
 */
function fixture() {
	const video = asset("video");
	const audio = asset("audio");
	const still = asset("image", 0);
	const linkGroupId = crypto.randomUUID();
	const picture = clip(video, 2, 0, { linkGroupId });
	const sound = clip(audio, 2, 1, { linkGroupId });
	const neighbour = clip(video, 8, 0);
	const broll = clip(video, 3, 2);
	const project: Project = {
		...newProject("Group edits"),
		segments: [picture, sound, neighbour, broll],
	};
	return {
		assets: [video, audio, still],
		audio,
		broll,
		neighbour,
		picture,
		project,
		sound,
		still,
		video,
	};
}

const byId = (project: Project, id: string) => {
	const found = project.segments.find((segment) => segment.id === id);
	if (!found) {
		throw new Error(`missing ${id}`);
	}
	return found;
};
const endOf = (segment: Segment) => segment.start + segmentDuration(segment);

describe("groupMove", () => {
	test("moves a selected pair across tracks and keeps linked partners in time", () => {
		const { assets, broll, picture, project, sound } = fixture();
		const result = groupMove(project, assets, {
			clipIds: [picture.id, broll.id],
			delta: 1.5,
			revision: project.revision,
			trackDelta: 1,
		});
		expect(result.applied).toBe(1.5);
		expect(result.trackApplied).toBe(1);
		const moved = byId(result.project, picture.id);
		expect(moved).toMatchObject({ start: 3.5, track: 1 });
		expect(byId(result.project, broll.id)).toMatchObject({
			start: 4.5,
			track: 3,
		});
		// The linked audio follows in time but keeps its own lane.
		expect(byId(result.project, sound.id)).toMatchObject({
			start: 3.5,
			track: 1,
		});
	});

	test("clamps the time delta at zero and the track delta at the limits", () => {
		const { assets, broll, picture, project } = fixture();
		const left = groupMove(project, assets, {
			clipIds: [picture.id, broll.id],
			delta: -50,
			revision: 0,
			trackDelta: -5,
		});
		expect(left.applied).toBe(-2);
		expect(left.trackApplied).toBe(0);
		expect(byId(left.project, picture.id).start).toBe(0);
		expect(byId(left.project, broll.id).start).toBe(1);
		const up = groupMove(project, assets, {
			clipIds: [picture.id, broll.id],
			delta: 0,
			revision: 0,
			trackDelta: MAX_TRACK_INDEX,
		});
		expect(up.trackApplied).toBe(MAX_TRACK_INDEX - 2);
		expect(byId(up.project, broll.id).track).toBe(MAX_TRACK_INDEX);
	});

	test("frame-quantizes unless the delta is exact", () => {
		const { assets, broll, project } = fixture();
		const rounded = groupMove(project, assets, {
			clipIds: [broll.id],
			delta: 0.511,
			revision: 0,
		});
		expect(rounded.applied).toBe(0.5);
		const exact = groupMove(project, assets, {
			clipIds: [broll.id],
			delta: 0.511,
			exact: true,
			revision: 0,
		});
		expect(exact.applied).toBe(0.511);
	});

	test("refuses locked source or destination tracks", () => {
		const { assets, picture, project } = fixture();
		const lockedAudio = updateTrackSetting(project, 1, { locked: true });
		expect(() =>
			groupMove(lockedAudio, assets, {
				clipIds: [picture.id],
				delta: 1,
				revision: 0,
			})
		).toThrow("Unlock every linked clip track");
		const lockedDestination = updateTrackSetting(project, 3, { locked: true });
		expect(() =>
			groupMove(lockedDestination, assets, {
				clipIds: [picture.id],
				delta: 0,
				revision: 0,
				trackDelta: 3,
			})
		).toThrow("Unlock the destination track");
	});

	test("a no-op move returns the same project", () => {
		const { assets, broll, project } = fixture();
		const result = groupMove(project, assets, {
			clipIds: [broll.id],
			delta: 0,
			revision: 0,
		});
		expect(result.project).toBe(project);
		expect(() =>
			groupMove(project, assets, {
				clipIds: [crypto.randomUUID()],
				delta: 1,
				revision: 0,
			})
		).toThrow("Clip not found");
	});
});

describe("groupTrim", () => {
	test("an end trim stops at the next clip on the same track", () => {
		const { assets, neighbour, picture, project } = fixture();
		const result = groupTrim(project, assets, {
			clipIds: [picture.id],
			delta: 5,
			edge: "end",
			linked: false,
			revision: 0,
		});
		expect(result.applied).toBe(2);
		expect(endOf(byId(result.project, picture.id))).toBeCloseTo(
			neighbour.start,
			6
		);
	});

	test("a start trim stops at the source head", () => {
		const { assets, broll, project } = fixture();
		const result = groupTrim(project, assets, {
			clipIds: [broll.id],
			delta: -10,
			edge: "start",
			revision: 0,
		});
		expect(result.applied).toBe(-2);
		expect(byId(result.project, broll.id)).toMatchObject({
			sourceIn: 0,
			start: 1,
		});
	});

	test("linked trim moves both partners by the same amount", () => {
		const { assets, picture, project, sound } = fixture();
		const result = groupTrim(project, assets, {
			clipIds: [picture.id],
			delta: 0.5,
			edge: "start",
			revision: 0,
		});
		expect(result.applied).toBe(0.5);
		for (const id of [picture.id, sound.id]) {
			expect(byId(result.project, id)).toMatchObject({
				sourceIn: 2.5,
				start: 2.5,
			});
		}
	});

	test("Alt-trim of one member keeps a J-cut", () => {
		const { assets, picture, project, sound } = fixture();
		const result = groupTrim(project, assets, {
			clipIds: [sound.id],
			delta: -1,
			edge: "start",
			linked: false,
			revision: 0,
		});
		// Audio now leads the picture by one second: a J-cut.
		expect(byId(result.project, sound.id).start).toBe(1);
		expect(byId(result.project, picture.id).start).toBe(2);
		expect(byId(result.project, sound.id).linkGroupId).toBe(
			picture.linkGroupId
		);
	});

	test("the tightest member clamps the whole group", () => {
		const { assets, broll, picture, project } = fixture();
		// picture can grow 2 s (neighbour), b-roll 14 s (source); both get 2 s.
		const result = groupTrim(project, assets, {
			clipIds: [picture.id, broll.id],
			delta: 3,
			edge: "end",
			linked: false,
			revision: 0,
		});
		expect(result.applied).toBe(2);
		expect(endOf(byId(result.project, broll.id))).toBeCloseTo(9, 6);
	});

	test("shortening keeps a minimum length, clamps fades, and re-bases keyframes", () => {
		const { assets, project, broll } = fixture();
		const withFades = {
			...project,
			segments: project.segments.map((segment) =>
				segment.id === broll.id
					? {
							...segment,
							fadeIn: 1,
							fadeOut: 2,
							keyframes: [
								{
									easing: "linear" as const,
									id: crypto.randomUUID(),
									property: "opacity" as const,
									time: 3,
									value: 0.5,
								},
							],
						}
					: segment
			),
		};
		const result = groupTrim(withFades, assets, {
			clipIds: [broll.id],
			delta: -10,
			edge: "end",
			revision: 0,
		});
		const trimmed = byId(result.project, broll.id);
		expect(segmentDuration(trimmed)).toBeCloseTo(0.0667, 3);
		expect(trimmed.fadeIn + trimmed.fadeOut).toBeLessThanOrEqual(
			segmentDuration(trimmed) + 1e-9
		);
		// The keyframe past the new end is replaced by a boundary keyframe that
		// holds the curve's value there, so the fade toward it is kept.
		expect(trimmed.keyframes).toHaveLength(1);
		expect(trimmed.keyframes[0]?.property).toBe("opacity");
		expect(trimmed.keyframes[0]?.time).toBeLessThanOrEqual(
			segmentDuration(trimmed)
		);
		expect(trimmed.keyframes[0]?.value).toBeCloseTo(
			animatedValue(byId(withFades, broll.id), "opacity", 0.066_666),
			5
		);
	});

	test("a still extends its hold in both directions without a source limit", () => {
		const { assets, project, still } = fixture();
		const photo = { ...newSegment(still, 20, 4) };
		const base = { ...project, segments: [...project.segments, photo] };
		const longer = groupTrim(base, assets, {
			clipIds: [photo.id],
			delta: 30,
			edge: "end",
			revision: 0,
		});
		expect(segmentDuration(byId(longer.project, photo.id))).toBe(35);
		const earlier = groupTrim(base, assets, {
			clipIds: [photo.id],
			delta: -4,
			edge: "start",
			revision: 0,
		});
		expect(byId(earlier.project, photo.id)).toMatchObject({
			sourceIn: 0,
			sourceOut: 9,
			start: 16,
		});
	});

	test("bounds report the room on each side", () => {
		const { assets, picture, project } = fixture();
		const video = assets[0] as Asset;
		expect(trimBounds(project, picture, video, "end").high).toBe(2);
		expect(trimBounds(project, picture, video, "start").low).toBe(-2);
	});

	test("refuses a locked track", () => {
		const { assets, picture, project } = fixture();
		expect(() =>
			groupTrim(updateTrackSetting(project, 1, { locked: true }), assets, {
				clipIds: [picture.id],
				delta: 1,
				edge: "end",
				revision: 0,
			})
		).toThrow("Unlock every affected clip track");
	});
});

describe("groupDuplicate", () => {
	test("Alt-drag pastes a linked copy at the dragged offset", () => {
		const { assets, picture, project, sound } = fixture();
		const result = groupDuplicate(project, assets, {
			clipIds: [picture.id],
			delta: 10,
			revision: 0,
			trackDelta: 3,
		});
		expect(result.newIds).toHaveLength(2);
		const copies = result.newIds.map((id) => byId(result.project, id));
		expect(copies.map((copy) => copy.start)).toEqual([12, 12]);
		// Only the dragged clip changes track; its partner's copy keeps track 1.
		expect(copies.map((copy) => copy.track).sort()).toEqual([1, 3]);
		expect(copies[0]?.linkGroupId).toBeDefined();
		expect(copies[0]?.linkGroupId).toBe(copies[1]?.linkGroupId);
		expect(copies[0]?.linkGroupId).not.toBe(picture.linkGroupId);
		// The originals are untouched.
		expect(byId(result.project, picture.id).start).toBe(2);
		expect(byId(result.project, sound.id).start).toBe(2);
	});
	test("a straight-down Alt-drag keeps the originals and the partner track", () => {
		const { assets, broll, neighbour, picture, project, sound } = fixture();
		// delta 0, one row down: the picture copy would land on the sound.
		expect(() =>
			groupDuplicate(project, assets, {
				clipIds: [picture.id],
				delta: 0,
				revision: 0,
				trackDelta: 1,
			})
		).toThrow("Drop the copy clear of the clips it duplicates.");
		// Clear of the source in time, the picture copy moves down a row and
		// the sound copy stays on track 1; the originals survive untouched.
		const result = groupDuplicate(project, assets, {
			clipIds: [picture.id],
			delta: 12,
			revision: 0,
			trackDelta: 2,
		});
		const copies = result.newIds.map((id) => byId(result.project, id));
		expect(
			copies
				.map((copy) => [copy.track, copy.start])
				.sort((a, b) => (a[0] ?? 0) - (b[0] ?? 0))
		).toEqual([
			[1, 14],
			[2, 14],
		]);
		for (const original of [picture, sound, neighbour, broll]) {
			const kept = byId(result.project, original.id);
			expect([kept.track, kept.start, kept.sourceIn, kept.sourceOut]).toEqual([
				original.track,
				original.start,
				original.sourceIn,
				original.sourceOut,
			]);
		}
	});

	test("a drop that overlaps only its own source is refused", () => {
		const { assets, picture, project } = fixture();
		expect(() =>
			groupDuplicate(project, assets, {
				clipIds: [picture.id],
				delta: 1,
				revision: 0,
				trackDelta: 0,
			})
		).toThrow("Drop the copy clear of the clips it duplicates.");
	});

	test("copies that would stack on one track are refused", () => {
		const { assets, picture, project } = fixture();
		// Picture moves down to track 1 where its partner's copy also lands.
		expect(() =>
			groupDuplicate(project, assets, {
				clipIds: [picture.id],
				delta: 10,
				revision: 0,
				trackDelta: 1,
			})
		).toThrow("The copies would overlap each other on one track.");
	});

	test("the copy still overwrites unrelated clips it lands on", () => {
		const { assets, broll, picture, project, sound } = fixture();
		// Picture copy lands on track 2 at [6, 10): b-roll [3, 7) is cut to [3, 6).
		const result = groupDuplicate(project, assets, {
			clipIds: [picture.id],
			delta: 4,
			revision: 0,
			trackDelta: 2,
		});
		const kept = byId(result.project, broll.id);
		expect(endOf(kept)).toBeCloseTo(6, 6);
		expect(byId(result.project, picture.id).start).toBe(2);
		expect(byId(result.project, sound.id).start).toBe(2);
	});
});

describe("clip fades", () => {
	test("fade handles are bounded by the clip and the other fade", () => {
		const { assets, broll, project } = fixture();
		expect(fadeBounds(broll)).toEqual({ in: 4, out: 4 });
		const faded = setClipFade(project, assets, {
			clipId: broll.id,
			fade: "in",
			revision: 0,
			seconds: 3,
		});
		const withIn = byId(faded, broll.id);
		expect(withIn.fadeIn).toBe(3);
		expect(fadeBounds(withIn)).toEqual({ in: 4, out: 1 });
		const capped = setClipFade(faded, assets, {
			clipId: broll.id,
			fade: "out",
			revision: 0,
			seconds: 9,
		});
		expect(byId(capped, broll.id).fadeOut).toBe(1);
		expect(
			setClipFade(capped, assets, {
				clipId: broll.id,
				fade: "out",
				revision: 0,
				seconds: 1,
			})
		).toBe(capped);
	});

	test("fades refuse a locked track", () => {
		const { assets, broll, project } = fixture();
		expect(() =>
			setClipFade(updateTrackSetting(project, 2, { locked: true }), assets, {
				clipId: broll.id,
				fade: "out",
				revision: 0,
				seconds: 1,
			})
		).toThrow("Unlock the clip track");
	});
});
