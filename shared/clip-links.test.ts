import { expect, test } from "bun:test";
import { manageClipLinks } from "./clip-links.ts";
import { newProject, newSegment, rippleDeleteRange } from "./project.ts";
import { moveClip, removeClips } from "./timeline-edits.ts";

function videoAsset() {
	return {
		createdAt: new Date().toISOString(),
		duration: 8,
		hasAudio: true,
		height: 360,
		id: crypto.randomUUID(),
		kind: "video" as const,
		name: "Camera",
		width: 640,
	};
}

function audioAsset() {
	return {
		createdAt: new Date().toISOString(),
		duration: 8,
		hasAudio: true,
		height: 0,
		id: crypto.randomUUID(),
		kind: "audio" as const,
		name: "Mic",
		width: 0,
	};
}

test("links audio and video clips, moves them together, and unlinks cleanly", () => {
	const video = videoAsset();
	const audio = audioAsset();
	const videoClip = newSegment(video, 0, 0);
	videoClip.sourceOut = 4;
	const audioClip = newSegment(audio, 0, 1);
	audioClip.sourceOut = 5;
	const project = {
		...newProject("Linked clips"),
		segments: [videoClip, audioClip],
	};

	const linked = manageClipLinks(project, [video, audio], {
		action: "link",
		clipIds: [videoClip.id, audioClip.id],
		revision: project.revision,
	});
	const groupId = linked.segments[0]?.linkGroupId;
	expect(groupId).toBeTruthy();
	expect(
		linked.segments.every((segment) => segment.linkGroupId === groupId)
	).toBe(true);

	const moved = moveClip(linked, [video, audio], {
		clipId: videoClip.id,
		revision: linked.revision,
		start: 2.01,
		track: 0,
	});
	expect(moved.segments.map((segment) => segment.start)).toEqual([2, 2]);

	const unlinked = manageClipLinks(moved, [video, audio], {
		action: "unlink",
		clipIds: [videoClip.id],
		revision: moved.revision,
	});
	expect(
		unlinked.segments.every((segment) => segment.linkGroupId === undefined)
	).toBe(true);
});

test("removing one linked clip removes the complete audio/video group", () => {
	const video = videoAsset();
	const audio = audioAsset();
	const videoClip = newSegment(video);
	const audioClip = newSegment(audio, 0, 1);
	const project = {
		...newProject("Remove linked"),
		segments: [videoClip, audioClip],
	};
	const linked = manageClipLinks(project, [video, audio], {
		action: "link",
		clipIds: [videoClip.id, audioClip.id],
		revision: project.revision,
	});
	const removed = removeClips(linked, [video, audio], {
		clipIds: [videoClip.id],
		revision: linked.revision,
	});
	expect(removed.segments).toEqual([]);
});

test("ripple deletion dissolves a link when only one member remains", () => {
	const video = videoAsset();
	const audio = audioAsset();
	const videoClip = newSegment(video);
	videoClip.sourceOut = 2;
	const audioClip = newSegment(audio, 0, 1);
	audioClip.sourceOut = 5;
	const project = {
		...newProject("Ripple linked"),
		segments: [videoClip, audioClip],
	};
	const linked = manageClipLinks(project, [video, audio], {
		action: "link",
		clipIds: [videoClip.id, audioClip.id],
		revision: project.revision,
	});
	const next = rippleDeleteRange(linked, [video, audio], 0, 3);
	expect(next.segments).toHaveLength(1);
	expect(next.segments[0]?.linkGroupId).toBeUndefined();
});
