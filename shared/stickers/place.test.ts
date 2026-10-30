import { describe, expect, test } from "bun:test";
import { MAX_TRACK_INDEX } from "../limits.ts";
import {
	type Asset,
	newProject,
	newSegment,
	type Project,
	updateTrackSetting,
	validateProject,
} from "../project.ts";
import {
	placeSticker,
	STICKER_ANIMATION_PRESETS,
	STICKER_CLIP_SCALE,
	STICKER_CLIP_SECONDS,
	stickerAnimation,
	stickerTrack,
} from "./place.ts";

const asset = (kind: Asset["kind"], name: string): Asset => ({
	createdAt: new Date(0).toISOString(),
	duration: kind === "image" ? 0 : 30,
	hasAudio: kind !== "image",
	height: kind === "audio" ? 0 : 1024,
	id: crypto.randomUUID(),
	kind,
	name,
	width: kind === "audio" ? 0 : 1024,
});

const video = asset("video", "video");
const music = asset("audio", "music");
const sticker = asset("image", "sticker");

function project(segments: Project["segments"]): Project {
	return { ...newProject("Stickers"), segments };
}

describe("stickerTrack", () => {
	test("goes above the picture on the first free track", () => {
		const base = project([newSegment(video, 0, 0)]);
		expect(stickerTrack(base, [video], 2, 4)).toBe(1);
		const stacked = project([newSegment(video, 0, 0), newSegment(video, 0, 2)]);
		expect(stickerTrack(stacked, [video], 2, 4)).toBe(3);
	});

	test("never uses track 0, skips audio-occupied and locked tracks", () => {
		expect(stickerTrack(project([]), [], 0, 4)).toBe(1);
		const withMusic = project([newSegment(music, 0, 1)]);
		expect(stickerTrack(withMusic, [music], 0, 4)).toBe(2);
		const locked = updateTrackSetting(project([]), 1, { locked: true });
		expect(stickerTrack(locked, [], 0, 4)).toBe(2);
	});

	test("clips outside the span do not block a track", () => {
		const later = project([{ ...newSegment(video, 10, 1), sourceOut: 2 }]);
		expect(stickerTrack(later, [video], 0, 4)).toBe(1);
		const touching = project([{ ...newSegment(video, 0, 1), sourceOut: 2 }]);
		expect(stickerTrack(touching, [video], 2, 4)).toBe(1);
	});

	test("null when every track is busy", () => {
		const top = project([newSegment(video, 0, MAX_TRACK_INDEX)]);
		expect(stickerTrack(top, [video], 1, 4)).toBeNull();
	});
});

describe("placeSticker", () => {
	test("adds a scaled, animated image clip at the playhead", () => {
		const base = project([newSegment(video, 0, 0)]);
		const { project: next, segment } = placeSticker(
			base,
			[video],
			sticker,
			3.5,
			"bounce"
		);
		expect(next.segments).toHaveLength(2);
		expect(segment).toMatchObject({
			assetId: sticker.id,
			scale: STICKER_CLIP_SCALE,
			sourceIn: 0,
			sourceOut: STICKER_CLIP_SECONDS,
			start: 3.5,
			track: 1,
		});
		expect(segment.animation).toEqual(stickerAnimation("bounce"));
		expect(() => validateProject(next, [video, sticker])).not.toThrow();
	});

	test("no animation leaves the field unset", () => {
		const { segment } = placeSticker(project([]), [], sticker, -2, "none");
		expect(segment.start).toBe(0);
		expect(segment).not.toHaveProperty("animation");
	});

	test("refuses non-image assets and full timelines", () => {
		expect(() => placeSticker(project([]), [], video, 0)).toThrow(
			"image clips"
		);
		const full = project([newSegment(video, 0, MAX_TRACK_INDEX)]);
		expect(() => placeSticker(full, [video], sticker, 0)).toThrow(
			"Every track is busy"
		);
	});

	test("every preset is valid for the V10 animation schema", () => {
		for (const preset of STICKER_ANIMATION_PRESETS) {
			const { project: next } = placeSticker(
				project([]),
				[],
				sticker,
				0,
				preset
			);
			expect(() => validateProject(next, [sticker])).not.toThrow();
		}
	});
});
