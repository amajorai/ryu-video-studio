import { describe, expect, test } from "bun:test";
import { MAX_TRACK_INDEX } from "../../../shared/limits.ts";
import {
	type Asset,
	newProject,
	newSegment,
	type Project,
} from "../../../shared/project.ts";
import { pictureTrack, placeRecording, voiceoverTrack } from "./place.ts";

const asset = (kind: Asset["kind"], duration = 4, id = crypto.randomUUID()) =>
	({
		createdAt: new Date(0).toISOString(),
		duration,
		hasAudio: kind !== "image",
		height: kind === "audio" ? 0 : 360,
		id,
		kind,
		name: `${kind}.bin`,
		width: kind === "audio" ? 0 : 640,
	}) satisfies Asset;

function projectWith(
	...clips: { asset: Asset; start: number; track: number }[]
): Project {
	return {
		...newProject("Recorder test"),
		segments: clips.map((clip) =>
			newSegment(clip.asset, clip.start, clip.track)
		),
	};
}

describe("voiceoverTrack", () => {
	test("uses the first empty track above the main track on an empty timeline", () => {
		expect(voiceoverTrack(projectWith(), [], 0, 3)).toBe(1);
	});

	test("prefers a track that already holds only audio", () => {
		const video = asset("video", 20);
		const music = asset("audio", 2);
		const project = projectWith(
			{ asset: video, start: 0, track: 0 },
			{ asset: video, start: 0, track: 1 },
			{ asset: music, start: 30, track: 3 }
		);
		expect(voiceoverTrack(project, [video, music], 5, 3)).toBe(3);
	});

	test("skips tracks busy in the span and locked or muted tracks", () => {
		const music = asset("audio", 10);
		const project: Project = {
			...projectWith({ asset: music, start: 0, track: 1 }),
			trackSettings: [
				{ locked: true, muted: false, name: "Locked", solo: false, track: 2 },
				{ locked: false, muted: true, name: "Muted", solo: false, track: 3 },
			],
		};
		expect(voiceoverTrack(project, [music], 2, 3)).toBe(4);
		// Outside the music clip, its audio-only track is free again.
		expect(voiceoverTrack(project, [music], 12, 3)).toBe(1);
	});

	test("falls back to a free mixed track, and null when every track is taken", () => {
		const video = asset("video", 100);
		const all = Array.from({ length: MAX_TRACK_INDEX + 1 }, (_, track) => ({
			asset: video,
			start: 0,
			track,
		}));
		expect(voiceoverTrack(projectWith(...all), [video], 1, 2)).toBeNull();
		// Every track holds video, but a gap at 200 s frees them all.
		expect(voiceoverTrack(projectWith(...all), [video], 200, 2)).toBe(1);
	});
});

describe("audibility", () => {
	const solo = (track: number) => ({
		locked: false,
		muted: false,
		name: `Track ${track}`,
		solo: true,
		track,
	});

	test("a voiceover goes on a free soloed track while solo is active", () => {
		const project: Project = { ...projectWith(), trackSettings: [solo(2)] };
		expect(voiceoverTrack(project, [], 0, 5)).toBe(2);
		const placed = placeRecording(project, [], asset("audio", 5), 0);
		expect(placed.segment.track).toBe(2);
		expect(placed.warning).toBeUndefined();
	});

	test("falls back to a silenced track with a warning when the soloed track is busy", () => {
		const music = asset("audio", 10);
		const project: Project = {
			...projectWith({ asset: music, start: 0, track: 2 }),
			trackSettings: [solo(2)],
		};
		expect(voiceoverTrack(project, [music], 0, 5)).toBe(1);
		const placed = placeRecording(project, [music], asset("audio", 5), 0);
		expect(placed.segment.track).toBe(1);
		expect(placed.warning).toContain("silent");
	});

	test("a recording with sound skips muted tracks above the picture", () => {
		const video = asset("video", 10);
		const project: Project = {
			...projectWith({ asset: video, start: 0, track: 0 }),
			trackSettings: [
				{ locked: false, muted: true, name: "Muted", solo: false, track: 1 },
			],
		};
		expect(pictureTrack(project, [video], 0, 5, true)).toBe(2);
		// Silent screen captures may still use the muted track.
		expect(pictureTrack(project, [video], 0, 5, false)).toBe(1);
		const placed = placeRecording(project, [video], asset("video", 5), 0);
		expect(placed.segment.track).toBe(2);
		expect(placed.warning).toBeUndefined();
	});

	test("warns when a recording with sound can only land on a muted track", () => {
		const video = asset("video", 10);
		const settings = Array.from({ length: MAX_TRACK_INDEX }, (_, index) => ({
			locked: false,
			muted: true,
			name: `Track ${index + 1}`,
			solo: false,
			track: index + 1,
		}));
		const project: Project = {
			...projectWith({ asset: video, start: 0, track: 0 }),
			trackSettings: settings,
		};
		const placed = placeRecording(project, [video], asset("video", 5), 0);
		expect(placed.segment.track).toBe(1);
		expect(placed.warning).toContain("muted");
	});
});

describe("pictureTrack", () => {
	test("uses track 0 on an empty timeline and stacks above visible clips", () => {
		const video = asset("video", 10);
		const music = asset("audio", 10);
		expect(pictureTrack(projectWith(), [], 0, 5)).toBe(0);
		const project = projectWith(
			{ asset: video, start: 0, track: 0 },
			{ asset: music, start: 0, track: 4 }
		);
		expect(pictureTrack(project, [video, music], 2, 5)).toBe(1);
		const stacked = projectWith(
			{ asset: video, start: 0, track: 0 },
			{ asset: video, start: 0, track: 2 }
		);
		expect(pictureTrack(stacked, [video], 2, 5)).toBe(3);
	});
});

describe("placeRecording", () => {
	test("places a voiceover at the playhead on a free audio track", () => {
		const video = asset("video", 20);
		const voice = asset("audio", 3.5);
		const project = projectWith({ asset: video, start: 0, track: 0 });
		const result = placeRecording(project, [video], voice, 6.25);
		expect(result.segment).toMatchObject({
			assetId: voice.id,
			sourceIn: 0,
			sourceOut: 3.5,
			start: 6.25,
			track: 1,
		});
		expect(result.project.segments).toHaveLength(2);
		expect(project.segments).toHaveLength(1);
	});

	test("places a screen recording above the picture", () => {
		const video = asset("video", 20);
		const screen = asset("video", 8);
		const project = projectWith({ asset: video, start: 0, track: 0 });
		expect(placeRecording(project, [video], screen, 2).segment.track).toBe(1);
	});

	test("clamps a negative or invalid playhead to zero", () => {
		const voice = asset("audio", 1);
		expect(placeRecording(projectWith(), [], voice, -4).segment.start).toBe(0);
		expect(
			placeRecording(projectWith(), [], voice, Number.NaN).segment.start
		).toBe(0);
	});

	test("refuses empty takes, images, and a full timeline", () => {
		expect(() =>
			placeRecording(projectWith(), [], asset("audio", 0), 0)
		).toThrow("empty");
		expect(() => placeRecording(projectWith(), [], asset("image"), 0)).toThrow(
			"audio or video"
		);
		const video = asset("video", 100);
		const all = Array.from({ length: MAX_TRACK_INDEX + 1 }, (_, track) => ({
			asset: video,
			start: 0,
			track,
		}));
		expect(() =>
			placeRecording(projectWith(...all), [video], asset("audio", 2), 1)
		).toThrow("Every track is busy");
	});
});
