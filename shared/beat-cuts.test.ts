import { describe, expect, test } from "bun:test";
import {
	beatCutsRequestSchema,
	beatGrid,
	cutGrid,
	musicClipBeats,
	snapCutsToBeats,
	timelineBeats,
} from "./beat-cuts.ts";
import {
	newProject,
	newSegment,
	type Segment,
	segmentDuration,
} from "./project.ts";

function asset(id: string, kind: "video" | "audio" = "video", duration = 10) {
	return {
		id,
		name: id,
		kind,
		duration,
		width: kind === "audio" ? 0 : 640,
		height: kind === "audio" ? 0 : 360,
		hasAudio: true,
		createdAt: new Date().toISOString(),
	};
}

/** Three back-to-back 2 s clips with 1 s handles on each side. */
function fixture() {
	const video = asset(crypto.randomUUID());
	const clips = [0, 2, 4].map((start) => ({
		...newSegment(video, start, 0),
		sourceIn: 1,
		sourceOut: 3,
	}));
	const project = { ...newProject("Beat"), segments: clips };
	return { clips, project, video };
}

const byId = (segments: readonly Segment[], id: string) =>
	segments.find((segment) => segment.id === id) as Segment;

describe("beat helpers", () => {
	test("maps source beats through a music clip and thins the grid", () => {
		const music = { ...newSegment(asset(crypto.randomUUID(), "audio"), 4) };
		music.sourceIn = 1;
		music.sourceOut = 9;
		music.speed = 2;
		expect(timelineBeats(music, [0.5, 1, 3, 9.5])).toEqual([4, 5]);
		expect(beatGrid([3, 1, 2, 2.01, 4, 5], 2)).toEqual([1, 3, 5]);
	});

	test("maps a music clip's beats, with downbeats only when detected", () => {
		const music = { ...newSegment(asset(crypto.randomUUID(), "audio"), 2) };
		music.sourceIn = 700;
		music.sourceOut = 702;
		expect(
			musicClipBeats(music, {
				bpm: 120,
				detected: true,
				downbeats: [700, 702],
				times: [699.5, 700, 700.5, 701, 701.5, 702],
			})
		).toEqual({ beats: [2, 2.5, 3, 3.5, 4], downbeats: [2, 4] });
		expect(
			musicClipBeats(music, { detected: false, times: [700, 701] })
		).toEqual({ beats: [2, 3] });
	});
});

describe("snap edits to beats", () => {
	test("rolls edit points within tolerance only", () => {
		const { clips, project, video } = fixture();
		const next = snapCutsToBeats(project, [video], {
			beats: [2.2, 4.5],
			mode: "snap-edits",
			tolerance: 0.25,
			track: 0,
			revision: project.revision,
		});
		const [first, second, third] = clips as [Segment, Segment, Segment];
		expect(byId(next.segments, first.id).sourceOut).toBeCloseTo(3.2, 6);
		expect(byId(next.segments, second.id).start).toBeCloseTo(2.2, 6);
		expect(byId(next.segments, second.id).sourceIn).toBeCloseTo(1.2, 6);
		expect(byId(next.segments, third.id).start).toBe(4);
	});

	test("respects handles", () => {
		const { clips, project, video } = fixture();
		const [first] = clips as [Segment];
		project.segments = [
			{ ...first, sourceIn: 8, sourceOut: 10 },
			...clips.slice(1),
		];
		const next = snapCutsToBeats(project, [video], {
			beats: [2.2, 3.8],
			mode: "snap-edits",
			track: 0,
			revision: project.revision,
		});
		expect(byId(next.segments, first.id).sourceOut).toBe(10);
		expect(byId(next.segments, clips[2]?.id ?? "").start).toBeCloseTo(3.8, 6);
	});

	test("refuses a locked track", () => {
		const { project, video } = fixture();
		project.trackSettings = [
			{ locked: true, muted: false, name: "V1", solo: false, track: 0 },
		];
		expect(() =>
			snapCutsToBeats(project, [video], {
				beats: [2.1, 4.1],
				mode: "snap-edits",
				track: 0,
				revision: project.revision,
			})
		).toThrow("Unlock");
	});
});

describe("fill a sequence to the beat", () => {
	test("durations equal beat intervals and clips play their middle", () => {
		const { clips, project, video } = fixture();
		const next = snapCutsToBeats(project, [video], {
			beats: [0, 0.5, 1.5, 2, 2.5],
			every: 1,
			mode: "fill-sequence",
			track: 0,
			revision: project.revision,
		});
		const laid = next.segments
			.filter((segment) => segment.track === 0)
			.sort((a, b) => a.start - b.start);
		expect(laid.slice(0, 3).map(segmentDuration)).toEqual([0.5, 1, 0.5]);
		expect(laid.slice(0, 3).map((segment) => segment.start)).toEqual([
			0, 0.5, 1.5,
		]);
		expect(laid[0]?.sourceIn).toBeCloseTo(1.75, 6);
		expect(laid).toHaveLength(3);
		expect(laid.map((segment) => segment.id)).toEqual(
			clips.map((segment) => segment.id)
		);
	});

	test("stops or cycles when there are fewer clips than slots", () => {
		const { clips, project, video } = fixture();
		const beats = [0, 1, 2, 3, 4, 5];
		const stopped = snapCutsToBeats(project, [video], {
			beats,
			clipIds: clips.slice(0, 2).map((segment) => segment.id),
			mode: "fill-sequence",
			track: 1,
			revision: project.revision,
		});
		expect(
			stopped.segments.filter((segment) => segment.track === 1)
		).toHaveLength(2);
		const cycled = snapCutsToBeats(project, [video], {
			beats,
			clipIds: clips.slice(0, 2).map((segment) => segment.id),
			mode: "fill-sequence",
			track: 1,
			whenClipsRunOut: "cycle",
			revision: project.revision,
		});
		const laid = cycled.segments.filter((segment) => segment.track === 1);
		expect(laid).toHaveLength(5);
		expect(laid.map((segment) => segment.assetId)).toEqual(
			Array.from({ length: 5 }, () => video.id)
		);
		expect(new Set(laid.map((segment) => segment.id)).size).toBe(5);
	});

	test("chooses the loudest window when energy is supplied", () => {
		const { clips, project, video } = fixture();
		const waveform = Array.from({ length: 100 }, (_, index) =>
			index >= 25 && index < 30 ? 1 : 0.1
		);
		const next = snapCutsToBeats(
			project,
			[video],
			{
				beats: [0, 0.5],
				clipIds: [clips[0]?.id ?? ""],
				mode: "fill-sequence",
				track: 1,
				revision: project.revision,
			},
			{ energyFor: () => ({ duration: 10, waveform }) }
		);
		const laid = next.segments.find((segment) => segment.track === 1);
		expect(laid?.sourceIn).toBeCloseTo(2.5, 6);
	});

	test("keeps linked audio in sync", () => {
		const { clips, video } = fixture();
		const audio = asset(crypto.randomUUID(), "audio");
		const groupId = crypto.randomUUID();
		const picture = { ...(clips[0] as Segment), linkGroupId: groupId };
		const sound = {
			...newSegment(audio, 0, 2),
			linkGroupId: groupId,
			sourceIn: 1,
			sourceOut: 3,
		};
		const project = {
			...newProject("Linked beat"),
			segments: [picture, sound],
		};
		const next = snapCutsToBeats(project, [video, audio], {
			beats: [1, 2],
			clipIds: [picture.id],
			mode: "fill-sequence",
			track: 0,
			revision: project.revision,
		});
		const movedPicture = byId(next.segments, picture.id);
		const movedSound = byId(next.segments, sound.id);
		expect(movedSound.start).toBe(movedPicture.start);
		expect(movedSound.sourceIn).toBe(movedPicture.sourceIn);
		expect(segmentDuration(movedSound)).toBe(1);
	});

	test("refuses to overwrite other clips on the target track", () => {
		const { clips, project, video } = fixture();
		expect(() =>
			snapCutsToBeats(project, [video], {
				beats: [0, 1, 2],
				clipIds: [clips[2]?.id ?? ""],
				mode: "fill-sequence",
				track: 0,
				revision: project.revision,
			})
		).toThrow("Clear track 1");
	});

	test("cycles a linked clip alone when links are ignored", () => {
		const { clips, video } = fixture();
		const audio = asset(crypto.randomUUID(), "audio");
		const groupId = crypto.randomUUID();
		const picture = { ...(clips[0] as Segment), linkGroupId: groupId };
		const sound = {
			...newSegment(audio, 0, 1),
			linkGroupId: groupId,
			sourceIn: 1,
			sourceOut: 3,
		};
		const project = {
			...newProject("Unlinked beat"),
			segments: [picture, sound],
		};
		const next = snapCutsToBeats(project, [video, audio], {
			beats: [10, 11, 12, 13],
			ignoreLinks: true,
			mode: "fill-sequence",
			track: 0,
			whenClipsRunOut: "cycle",
			revision: project.revision,
		});
		expect(next.segments.filter((segment) => segment.track === 0)).toHaveLength(
			3
		);
		expect(next.segments.every((segment) => !segment.linkGroupId)).toBe(true);
		expect(byId(next.segments, sound.id).start).toBe(0);
	});

	test("never lays a clip shorter than the minimum on tight beats", () => {
		const video = asset(crypto.randomUUID());
		for (let index = 0; index < 50; index++) {
			const sourceIn = 1 + index * 0.0137;
			const start = 2 + index * 0.0731;
			const clip = {
				...newSegment(video, 0, 0),
				sourceIn,
				sourceOut: sourceIn + 2.3,
				speed: 1.3,
			};
			const project = { ...newProject("Tight"), segments: [clip] };
			const beats = [start, start + 0.04, start + 0.0401];
			try {
				const next = snapCutsToBeats(project, [video], {
					beats,
					mode: "fill-sequence",
					track: 0,
					revision: project.revision,
				});
				const laid = byId(next.segments, clip.id);
				expect(segmentDuration(laid)).toBeGreaterThanOrEqual(0.04);
			} catch (error) {
				expect(String(error)).toContain("at least two beats");
			}
		}
	});

	test("refuses a slot longer than the clip's whole media", () => {
		const video = asset(crypto.randomUUID(), "video", 0.97);
		const clip = { ...newSegment(video, 0, 0), sourceIn: 0, sourceOut: 0.97 };
		const project = { ...newProject("Short media"), segments: [clip] };
		expect(() =>
			snapCutsToBeats(project, [video], {
				beats: [2, 3],
				mode: "fill-sequence",
				track: 0,
				revision: project.revision,
			})
		).toThrow("shorter than one beat interval");
	});
});

describe("beat, downbeat and every-n snapping", () => {
	const beats = [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4];

	test("every-n is the default and honours every", () => {
		expect(cutGrid({ beats, every: 2 })).toEqual([0, 1, 2, 3, 4]);
		expect(cutGrid({ beats, every: 2, snap: "every-n" })).toEqual([
			0, 1, 2, 3, 4,
		]);
	});

	test("beat ignores every", () => {
		expect(cutGrid({ beats, every: 4, snap: "beat" })).toEqual(beats);
	});

	test("downbeat uses detected bar starts, else every fourth beat", () => {
		expect(
			cutGrid({ beats, downbeats: [0.5, 2.5], every: 1, snap: "downbeat" })
		).toEqual([0.5, 2.5]);
		expect(cutGrid({ beats, every: 1, snap: "downbeat" })).toEqual([0, 2, 4]);
		expect(
			cutGrid({ beats, downbeats: [0.5], every: 1, snap: "downbeat" })
		).toEqual([0, 2, 4]);
	});

	test("request schema keeps snap optional and strict", () => {
		const base = {
			beats: [0, 1],
			mode: "snap-edits",
			revision: 0,
			track: 0,
		} as const;
		expect(beatCutsRequestSchema.parse(base).snap).toBeUndefined();
		expect(
			beatCutsRequestSchema.parse({ ...base, snap: "downbeat" }).snap
		).toBe("downbeat");
		expect(() =>
			beatCutsRequestSchema.parse({ ...base, snap: "bar" })
		).toThrow();
	});

	test("snap-edits to downbeats only moves edits near a bar start", () => {
		const { clips, project, video } = fixture();
		const next = snapCutsToBeats(project, [video], {
			beats: [0, 1.1, 2.1, 3.1, 4.1],
			downbeats: [0, 4.2],
			mode: "snap-edits",
			snap: "downbeat",
			tolerance: 0.25,
			track: 0,
			revision: project.revision,
		});
		const [, second, third] = clips as [Segment, Segment, Segment];
		expect(byId(next.segments, second.id).start).toBe(2);
		expect(byId(next.segments, third.id).start).toBeCloseTo(4.2, 6);
	});

	test("fill-sequence lays one clip per detected bar", () => {
		const { project, video } = fixture();
		const next = snapCutsToBeats(project, [video], {
			beats: [0, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2],
			downbeats: [0, 1, 2],
			mode: "fill-sequence",
			snap: "downbeat",
			track: 0,
			revision: project.revision,
		});
		const laid = next.segments
			.filter((segment) => segment.track === 0)
			.sort((a, b) => a.start - b.start);
		expect(laid.slice(0, 2).map(segmentDuration)).toEqual([1, 1]);
	});
});
