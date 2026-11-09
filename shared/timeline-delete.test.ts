import { expect, test } from "bun:test";
import {
	type Asset,
	newProject,
	newSegment,
	updateTrackSetting,
} from "./project.ts";
import { timelineDeletion } from "./timeline-delete.ts";

test("linked deletion checks every affected track and keeps unrelated clips", () => {
	const asset: Asset = {
		id: crypto.randomUUID(),
		name: "Take",
		kind: "video",
		duration: 5,
		width: 640,
		height: 360,
		hasAudio: true,
		createdAt: new Date().toISOString(),
	};
	const group = crypto.randomUUID();
	const video = { ...newSegment(asset, 0, 0), linkGroupId: group };
	const audio = { ...newSegment(asset, 0, 1), linkGroupId: group };
	const unrelated = newSegment(asset, 0, 2);
	let project = {
		...newProject("Linked deletion"),
		segments: [video, audio, unrelated],
	};
	project = updateTrackSetting(project, 1, { locked: true });
	const original = structuredClone(project);
	const locked = timelineDeletion(project, [video.id]);
	expect(locked.locked).toBe(true);
	expect([...locked.ids]).toEqual([video.id, audio.id]);
	expect(project).toEqual(original);
	const unlocked = timelineDeletion(
		updateTrackSetting(project, 1, { locked: false }),
		[video.id]
	);
	expect(unlocked.locked).toBe(false);
	expect(
		project.segments.filter((segment) => !unlocked.ids.has(segment.id))
	).toEqual([unrelated]);
	expect(timelineDeletion(project, [unrelated.id]).locked).toBe(false);
	expect(timelineDeletion(project, [audio.id]).locked).toBe(true);
	expect([...timelineDeletion(project, [unrelated.id]).ids]).toEqual([
		unrelated.id,
	]);
	expect(timelineDeletion(project, [video.id, unrelated.id]).locked).toBe(true);
});
