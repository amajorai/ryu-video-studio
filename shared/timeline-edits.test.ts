import { expect, test } from "bun:test";
import {
	newProject,
	newSegment,
	updateTrackSetting,
	validateProject,
} from "./project.ts";
import {
	addClips,
	moveClip,
	removeClips,
	setKeyframes,
	splitClip,
} from "./timeline-edits.ts";

function asset(name: string, duration = 8) {
	return {
		createdAt: new Date().toISOString(),
		duration,
		hasAudio: true,
		height: 360,
		id: crypto.randomUUID(),
		kind: "video" as const,
		name,
		width: 640,
	};
}

test("addClips places contiguous source ranges without rippling later tracks", () => {
	const first = asset("First");
	const second = asset("Second");
	const project = newProject("Add clips");
	project.segments = [newSegment(first, 6, 0)];
	const result = addClips(project, [first, second], {
		at: 2,
		entries: [
			{ assetId: second.id, sourceIn: 1, sourceOut: 3, speed: 2 },
			{ assetId: first.id, sourceIn: 0, sourceOut: 1 },
		],
		revision: project.revision,
		track: 1,
	});
	expect(
		result.segments.map((segment) => [segment.track, segment.start])
	).toEqual([
		[0, 6],
		[1, 2],
		[1, 3],
	]);
	expect(result.segments[1]?.sourceOut).toBe(3);
});

test("moveClip quantizes the new start and changes tracks", () => {
	const source = asset("Move");
	const project = newProject("Move clip");
	const clip = newSegment(source);
	project.segments = [clip];
	const result = moveClip(project, [source], {
		clipId: clip.id,
		revision: project.revision,
		start: 1.013,
		track: 2,
	});
	expect(result.segments[0]).toMatchObject({ start: 1, track: 2 });
});

test("splitClip preserves the shared segment split contract", () => {
	const source = asset("Split");
	const project = newProject("Split clip");
	const clip = newSegment(source);
	clip.sourceIn = 1;
	clip.sourceOut = 7;
	clip.speed = 2;
	project.segments = [clip];
	const result = splitClip(project, [source], {
		clipId: clip.id,
		revision: project.revision,
		time: 1,
	});
	expect(result.segments).toHaveLength(2);
	expect(result.segments.map((segment) => segment.sourceIn)).toEqual([1, 3]);
});

test("removeClips honors locks and leaves selected multicam metadata valid", () => {
	const source = asset("Remove");
	const project = newProject("Remove clips");
	const first = newSegment(source);
	const second = newSegment(source, 4);
	project.segments = [first, second];
	project.multicamGroups = [
		{
			duration: 8,
			id: crypto.randomUUID(),
			masterAssetId: source.id,
			members: [
				{ assetId: source.id, kind: "angle", label: "A", offsetSeconds: 0 },
				{ assetId: source.id, kind: "angle", label: "B", offsetSeconds: 0 },
			],
			name: "Two angle",
			segmentIds: [first.id, second.id],
			switches: [{ angle: "A", end: 8, start: 0 }],
			start: 0,
		},
	];
	const result = removeClips(project, [source], {
		clipIds: [first.id],
		revision: project.revision,
	});
	expect(result.segments).toHaveLength(1);
	expect(result.multicamGroups[0]?.segmentIds).toEqual([second.id]);
	const locked = updateTrackSetting(project, 0, { locked: true });
	locked.segments = project.segments;
	locked.multicamGroups = project.multicamGroups;
	expect(() =>
		removeClips(locked, [source], {
			clipIds: [first.id],
			revision: locked.revision,
		})
	).toThrow("Unlock");
});

test("setKeyframes replaces only the selected clip-relative property track", () => {
	const source = asset("Keyframes");
	const project = newProject("Set keyframes");
	const clip = newSegment(source);
	clip.keyframes = [
		{ id: crypto.randomUUID(), property: "x", time: 0, value: 0 },
		{ id: crypto.randomUUID(), property: "rotation", time: 0, value: 12 },
	];
	project.segments = [clip];
	const result = setKeyframes(project, [source], {
		clipId: clip.id,
		keyframes: [
			{ time: 1.2, value: 0.2 },
			{ time: 0, value: -0.2 },
		],
		property: "x",
		revision: project.revision,
	});
	expect(result.segments[0]?.keyframes).toHaveLength(3);
	expect(
		result.segments[0]?.keyframes.filter((frame) => frame.property === "x")
	).toMatchObject([
		{ time: 0, value: -0.2 },
		{ time: 1.2, value: 0.2 },
	]);
	expect(
		result.segments[0]?.keyframes.some((frame) => frame.property === "rotation")
	).toBe(true);
});

test("setKeyframes accepts bounded opacity animation", () => {
	const source = asset("Opacity");
	const project = newProject("Opacity keyframes");
	const clip = newSegment(source);
	project.segments = [clip];
	const result = setKeyframes(project, [source], {
		clipId: clip.id,
		keyframes: [
			{ time: 0, value: 0 },
			{ time: 2, value: 1 },
		],
		property: "opacity",
		revision: project.revision,
	});
	expect(result.segments[0]?.keyframes).toMatchObject([
		{ property: "opacity", time: 0, value: 0 },
		{ property: "opacity", time: 2, value: 1 },
	]);
	const invalid = {
		...project,
		segments: [
			{
				...clip,
				keyframes: [
					{
						id: crypto.randomUUID(),
						property: "opacity" as const,
						time: 0,
						value: 1.1,
					},
				],
			},
		],
	};
	expect(() => validateProject(invalid, [source])).toThrow(
		"animation keyframe"
	);
});
