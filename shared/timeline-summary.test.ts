import { expect, test } from "bun:test";
import { newProject, newSegment, updateTrackSetting } from "./project.ts";
import { timelineSummary } from "./timeline-summary.ts";

function asset(kind: "video" | "audio", name: string, duration: number) {
	return {
		createdAt: new Date().toISOString(),
		duration,
		hasAudio: true,
		height: kind === "audio" ? 0 : 180,
		id: crypto.randomUUID(),
		kind,
		name,
		width: kind === "audio" ? 0 : 320,
	};
}

test("timelineSummary reports stable tracks, clip ranges, and gaps", () => {
	const video = asset("video", "Camera", 2);
	const audio = asset("audio", "Room mic", 8);
	let project = newProject("Timeline summary");
	const first = newSegment(video, 0, 0);
	first.sourceOut = 2;
	const second = newSegment(audio, 4, 1);
	project = updateTrackSetting(project, 1, {
		muted: true,
		name: "Room audio",
	});
	project.segments = [first, second];
	const summary = timelineSummary(project, [video, audio]);
	expect(summary).toMatchObject({
		duration: 12,
		fps: 30,
		totalFrames: 360,
		title: "Timeline summary",
	});
	expect(summary.tracks).toHaveLength(2);
	expect(summary.tracks[0]).toMatchObject({
		gaps: [{ end: 12, start: 2 }],
		track: 0,
		trackId: "track-0",
	});
	expect(summary.tracks[1]).toMatchObject({
		clips: [{ assetName: "Room mic", end: 12, start: 4 }],
		gaps: [{ end: 4, start: 0 }],
		muted: true,
		name: "Room audio",
		trackId: "track-1",
	});
});
