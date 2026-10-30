import { describe, expect, test } from "bun:test";
import {
	type Asset,
	newProject,
	newSegment,
	updateTrackSetting,
} from "../../../../shared/project.ts";
import {
	previewSegmentAudible,
	previewSegmentVisible,
	segmentActiveAt,
} from "./visibility.ts";

const video: Asset = {
	createdAt: new Date(0).toISOString(),
	duration: 10,
	hasAudio: true,
	height: 360,
	id: crypto.randomUUID(),
	kind: "video",
	name: "clip.mp4",
	width: 640,
};

describe("preview visibility", () => {
	const project = newProject("Preview visibility");
	const segment = { ...newSegment(video, 2, 1), sourceOut: 4 };

	test("clips are visible and audible by default", () => {
		expect(previewSegmentVisible(project, segment)).toBe(true);
		expect(previewSegmentAudible(project, segment)).toBe(true);
	});

	test("a hidden clip or hidden track draws no picture", () => {
		expect(previewSegmentVisible(project, { ...segment, hidden: true })).toBe(
			false
		);
		const hiddenTrack = updateTrackSetting(project, 1, { hidden: true });
		expect(previewSegmentVisible(hiddenTrack, segment)).toBe(false);
		expect(previewSegmentVisible(hiddenTrack, { ...segment, track: 0 })).toBe(
			true
		);
	});

	test("a muted clip, muted track, or other solo is silent", () => {
		expect(previewSegmentAudible(project, { ...segment, muted: true })).toBe(
			false
		);
		expect(
			previewSegmentAudible(
				updateTrackSetting(project, 1, { muted: true }),
				segment
			)
		).toBe(false);
		expect(
			previewSegmentAudible(
				updateTrackSetting(project, 0, { solo: true }),
				segment
			)
		).toBe(false);
		expect(
			previewSegmentAudible(
				updateTrackSetting(project, 1, { solo: true }),
				segment
			)
		).toBe(true);
	});

	test("segmentActiveAt covers the clip's half-open span", () => {
		expect(segmentActiveAt(segment, 1.99)).toBe(false);
		expect(segmentActiveAt(segment, 2)).toBe(true);
		expect(segmentActiveAt(segment, 5.99)).toBe(true);
		expect(segmentActiveAt(segment, 6)).toBe(false);
	});
});
