import { expect, test } from "bun:test";
import {
	changeMulticamAngles,
	createMulticamGroup,
	ungroupMulticam,
} from "./multicam.ts";
import { newProject } from "./project.ts";

function asset(name: string, kind: "audio" | "video" = "video") {
	return {
		createdAt: new Date().toISOString(),
		duration: 6,
		hasAudio: true,
		height: kind === "audio" ? 0 : 360,
		id: crypto.randomUUID(),
		kind,
		name,
		width: kind === "audio" ? 0 : 640,
	};
}

test("multicam groups create ordinary angle clips and a program-audio layer", () => {
	const wide = asset("Wide");
	const close = asset("Close");
	const mic = asset("Recorder", "audio");
	const project = newProject("Multicam");
	const result = createMulticamGroup(project, [wide, close, mic], {
		action: "create",
		members: [
			{ assetId: wide.id, kind: "angle", label: "Wide" },
			{ assetId: close.id, kind: "angle", label: "Close" },
			{ assetId: mic.id, kind: "mic", label: "Recorder" },
		],
		name: "Interview angles",
		revision: project.revision,
	});
	expect(result.group.name).toBe("Interview angles");
	expect(result.group.duration).toBe(6);
	expect(result.group.switches).toEqual([{ angle: "Wide", end: 6, start: 0 }]);
	expect(result.project.segments).toHaveLength(2);
	expect(
		result.project.segments.map((segment) => [segment.track, segment.volume])
	).toEqual([
		[0, 0],
		[1, 1],
	]);
});

test("multicam angle changes split the program into source-bounded switches", () => {
	const wide = asset("Wide");
	const close = asset("Close");
	const mic = asset("Recorder", "audio");
	const project = newProject("Switches");
	const created = createMulticamGroup(project, [wide, close, mic], {
		action: "create",
		members: [
			{ assetId: wide.id, kind: "angle" },
			{ assetId: close.id, kind: "angle" },
			{ assetId: mic.id, kind: "mic" },
		],
		revision: project.revision,
	});
	const changed = changeMulticamAngles(created.project, [wide, close, mic], {
		action: "change",
		entries: [{ angle: "Close", end: 4, start: 2 }],
		groupId: created.group.id,
		revision: created.project.revision,
	});
	expect(changed.group.switches).toEqual([
		{ angle: "Wide", end: 2, start: 0 },
		{ angle: "Close", end: 4, start: 2 },
		{ angle: "Wide", end: 6, start: 4 },
	]);
	expect(
		changed.project.segments.filter((segment) => segment.track === 0)
	).toHaveLength(3);
	expect(
		changed.project.segments.filter((segment) => segment.track === 1)
	).toHaveLength(1);
});

test("ungrouping removes multicam metadata and leaves the generated clips in place", () => {
	const wide = asset("Wide");
	const close = asset("Close");
	const mic = asset("Recorder", "audio");
	const project = newProject("Ungroup");
	const created = createMulticamGroup(project, [wide, close, mic], {
		action: "create",
		members: [
			{ assetId: wide.id, kind: "angle" },
			{ assetId: close.id, kind: "angle" },
			{ assetId: mic.id, kind: "mic" },
		],
		revision: project.revision,
	});
	const ungrouped = ungroupMulticam(created.project, [wide, close, mic], {
		action: "ungroup",
		groupId: created.group.id,
		revision: created.project.revision,
	});
	expect(ungrouped.multicamGroups).toEqual([]);
	expect(ungrouped.segments).toHaveLength(created.project.segments.length);
});
