import { expect, test } from "bun:test";
import {
	copyClipSettings,
	setClipProperties,
	swapClipMedia,
} from "./clip-edits.ts";
import { newProject, newSegment, updateTrackSetting } from "./project.ts";

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

test("setClipProperties applies bounded inspector fields and honors track locks", () => {
	const source = asset("Source");
	const project = newProject("Properties");
	const segment = newSegment(source);
	project.segments = [segment];
	const changed = setClipProperties(project, [source], {
		clipId: segment.id,
		patch: {
			colorGrade: { exposure: 1, temperature: 0.2, tint: -0.1, vibrance: 0.4 },
			crop: { bottom: 0.1, left: 0.2, right: 0.1, top: 0.05 },
			rotation: 24,
			visualEffect: "sepia",
		},
		revision: project.revision,
	});
	expect(changed.segments[0]).toMatchObject({
		colorGrade: { exposure: 1, temperature: 0.2, tint: -0.1, vibrance: 0.4 },
		crop: { bottom: 0.1, left: 0.2, right: 0.1, top: 0.05 },
		rotation: 24,
		visualEffect: "sepia",
	});
	const locked = updateTrackSetting(project, 0, { locked: true });
	locked.segments = [segment];
	expect(() =>
		setClipProperties(locked, [source], {
			clipId: segment.id,
			patch: { rotation: 10 },
			revision: locked.revision,
		})
	).toThrow("Unlock");
});

test("copyClipSettings copies treatment and compatible keyframes", () => {
	const source = asset("Source");
	const targetAsset = asset("Target");
	const project = newProject("Copy settings");
	const from = newSegment(source, 0, 0);
	from.sourceOut = 8;
	from.speed = 2;
	from.edgeRounding = 0.18;
	from.edgeSoftness = 6;
	from.rotation = 30;
	from.visualEffect = "grayscale";
	from.keyframes = [
		{ id: crypto.randomUUID(), property: "rotation", time: 0, value: 30 },
		{ id: crypto.randomUUID(), property: "rotation", time: 3, value: 60 },
	];
	const to = newSegment(targetAsset, 4, 1);
	to.sourceOut = 1;
	to.speed = 0.5;
	project.segments = [from, to];
	const changed = copyClipSettings(project, [source, targetAsset], {
		revision: project.revision,
		sourceClipId: from.id,
		targetClipIds: [to.id],
	});
	expect(changed.segments[1]).toMatchObject({
		edgeRounding: 0.18,
		edgeSoftness: 6,
		rotation: 30,
		visualEffect: "grayscale",
		speed: 0.5,
	});
	expect(changed.segments[1]?.keyframes).toHaveLength(1);
});

test("swapClipMedia preserves the timeline slot and clamps source bounds", () => {
	const source = asset("Source");
	const replacement = asset("Replacement", 3);
	const project = newProject("Swap media");
	const segment = newSegment(source, 2);
	segment.sourceIn = 2;
	segment.sourceOut = 6;
	project.segments = [segment];
	const changed = swapClipMedia(project, [source, replacement], {
		assetId: replacement.id,
		clipId: segment.id,
		revision: project.revision,
	});
	expect(changed.segments[0]).toMatchObject({
		assetId: replacement.id,
		start: 2,
		sourceIn: 2,
		sourceOut: 3,
	});
	const grouped = {
		...project,
		segments: [{ ...segment, multicamGroupId: crypto.randomUUID() }],
	};
	expect(() =>
		swapClipMedia(grouped, [source, replacement], {
			assetId: replacement.id,
			clipId: segment.id,
			revision: grouped.revision,
		})
	).toThrow("multicam");
});
