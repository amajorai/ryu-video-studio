import { describe, expect, test } from "bun:test";
import {
	copyClipSettings,
	KEYFRAME_GROUP,
	pasteSettings,
	pasteSettingsFromClip,
	SETTINGS_EXCLUDED_FIELDS,
	SETTINGS_GROUP_FIELDS,
	SETTINGS_GROUPS,
	SETTINGS_META_FIELDS,
	setClipProperties,
	swapClipMedia,
} from "./clip-edits.ts";
import {
	newProject,
	newSegment,
	type Segment,
	segmentSchema,
	updateTrackSetting,
} from "./project.ts";
import { keyframeProperties } from "./schema/keyframe.ts";

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

test("copyClipSettings copies the audio chain and clears it on targets when absent", () => {
	const source = asset("Source");
	const targetAsset = asset("Target");
	const project = newProject("Copy audio");
	const from = newSegment(source, 0, 0);
	from.audioCleanup = { denoise: 0.5, enhance: 0.2, normalize: true };
	from.audioEffects = [
		{ amount: 0.4, enabled: true, id: crypto.randomUUID(), type: "echo" },
	];
	from.pan = -0.5;
	from.channelMode = "mono";
	const to = newSegment(targetAsset, 4, 1);
	project.segments = [from, to];
	const changed = copyClipSettings(project, [source, targetAsset], {
		revision: project.revision,
		sourceClipId: from.id,
		targetClipIds: [to.id],
	});
	expect(changed.segments[1]).toMatchObject({
		audioCleanup: from.audioCleanup,
		channelMode: "mono",
		pan: -0.5,
	});
	expect(changed.segments[1]?.audioEffects?.[0]).toMatchObject({
		amount: 0.4,
		type: "echo",
	});
	expect(changed.segments[1]?.audioEffects?.[0]?.id).not.toBe(
		from.audioEffects[0]?.id
	);
	const cleared = copyClipSettings(changed, [source, targetAsset], {
		revision: changed.revision,
		sourceClipId: to.id,
		targetClipIds: [from.id],
	});
	expect(cleared.segments[0]?.pan).toBe(-0.5);
	const plain = newSegment(source, 0, 2);
	const reset = copyClipSettings(
		{ ...changed, segments: [...changed.segments, plain] },
		[source, targetAsset],
		{
			revision: changed.revision,
			sourceClipId: plain.id,
			targetClipIds: [changed.segments[1]?.id ?? ""],
		}
	);
	expect(reset.segments[1]?.pan).toBeUndefined();
	expect(reset.segments[1]?.audioEffects).toBeUndefined();
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

/** A source clip with every optional treatment field set off its default. */
function treatedClip(source: ReturnType<typeof asset>, start: number) {
	const maskId = crypto.randomUUID();
	const effectId = crypto.randomUUID();
	const clip: Segment = {
		...newSegment(source, start, 0),
		sourceOut: 6,
		animation: { in: "pop", inDuration: 0.4 },
		audioCleanup: { denoise: 0.5, normalize: true },
		audioEffects: [{ amount: 0.4, enabled: true, type: "echo" }],
		background: { color: "#123456", type: "color" },
		blendMode: "screen",
		brightness: 0.1,
		channelMode: "mono",
		color: "teal",
		effects: [{ amount: 0.5, enabled: true, id: effectId, type: "blur" }],
		exitDuration: 0.6,
		exitTransition: "zoom-out",
		fit: "fill",
		flipH: true,
		flipV: true,
		frameInterpolation: "blend",
		key: { color: "#00ff00", type: "chroma" },
		keyframes: [
			{ id: crypto.randomUUID(), property: "x", time: 0, value: 0.2 },
			{ id: crypto.randomUUID(), property: "brightness", time: 1, value: 0.3 },
			{ id: crypto.randomUUID(), property: "volume", time: 1, value: 2 },
			{
				id: crypto.randomUUID(),
				property: "effectAmount",
				target: effectId,
				time: 1,
				value: 0.5,
			},
			{
				id: crypto.randomUUID(),
				property: "maskX",
				target: maskId,
				time: 1,
				value: 0.25,
			},
		],
		label: "Hero",
		masks: [
			{
				feather: 0.1,
				height: 1,
				id: maskId,
				invert: false,
				opacity: 1,
				rotation: 0,
				shape: "ellipse",
				width: 1,
				x: 0,
				y: 0,
			},
		],
		pan: -0.5,
		scaleX: 1.5,
		scaleY: 0.5,
		transitionIn: { duration: 0.5, softness: 0.2, type: "wipe-left" },
		volume: 1.5,
	};
	return clip;
}

/** The clip without its reveal transition (which needs a predecessor). */
function withoutReveal({ transitionIn: _reveal, ...clip }: Segment): Segment {
	return clip;
}

describe("settings groups", () => {
	test("every segment field is copied by exactly one group, meta, or excluded", () => {
		const listed = [
			...SETTINGS_GROUPS.flatMap((group) => SETTINGS_GROUP_FIELDS[group]),
			...SETTINGS_META_FIELDS,
			...SETTINGS_EXCLUDED_FIELDS,
			"keyframes",
		];
		expect(new Set(listed).size).toBe(listed.length);
		expect([...listed].sort()).toEqual(Object.keys(segmentSchema.shape).sort());
	});

	test("every keyframe property belongs to a settings group", () => {
		for (const property of keyframeProperties) {
			expect(SETTINGS_GROUPS).toContain(KEYFRAME_GROUP[property]);
		}
	});

	test("copyClipSettings copies every treatment field and re-mints masks", () => {
		const source = asset("Source", 20);
		const project = newProject("Copy all");
		const predecessor = { ...newSegment(source, 0, 1), sourceOut: 6 };
		const from = withoutReveal(treatedClip(source, 0));
		const to = { ...newSegment(source, 5, 1), sourceOut: 4 };
		project.segments = [from, predecessor, to];
		const changed = copyClipSettings(project, [source], {
			revision: project.revision,
			sourceClipId: from.id,
			targetClipIds: [to.id],
		});
		const copied = changed.segments.find((segment) => segment.id === to.id);
		const fields = [
			...SETTINGS_GROUPS.flatMap((group) => SETTINGS_GROUP_FIELDS[group]),
			...SETTINGS_META_FIELDS,
		].filter((field) => field !== "masks" && field !== "audioEffects");
		for (const field of fields) {
			expect([field, copied?.[field]]).toEqual([field, from[field]]);
		}
		// Audio effects are copied with fresh instance ids.
		expect(
			copied?.audioEffects?.map(({ id: _id, ...effect }) => effect)
		).toEqual(from.audioEffects?.map(({ id: _id, ...effect }) => effect));
		expect(copied?.audioEffects?.[0]?.id).not.toBe(from.audioEffects?.[0]?.id);
		expect(copied?.masks?.[0]?.id).not.toBe(from.masks?.[0]?.id);
		expect({ ...copied?.masks?.[0], id: "" }).toEqual({
			...from.masks?.[0],
			id: "",
		});
		const maskFrame = copied?.keyframes.find(
			(frame) => frame.property === "maskX"
		);
		expect(maskFrame?.target).toBe(copied?.masks?.[0]?.id);
		expect(copied?.keyframes).toHaveLength(5);
		// Identity and placement stay the target's.
		expect(copied).toMatchObject({ start: 5, track: 1 });
	});

	test("a reveal transition is copied when the target has a covering predecessor", () => {
		const source = asset("Source", 20);
		const project = newProject("Reveal");
		const from = treatedClip(source, 4);
		const before = { ...newSegment(source, 0, 0), sourceOut: 6 };
		const coveredTarget = { ...newSegment(source, 5, 1), sourceOut: 4 };
		const coverer = { ...newSegment(source, 0, 1), sourceOut: 6 };
		const loneTarget = { ...newSegment(source, 0, 2), sourceOut: 4 };
		project.segments = [before, from, coverer, coveredTarget, loneTarget];
		const changed = copyClipSettings(project, [source], {
			revision: project.revision,
			sourceClipId: from.id,
			targetClipIds: [coveredTarget.id, loneTarget.id],
		});
		const find = (id: string) =>
			changed.segments.find((segment) => segment.id === id);
		expect(find(coveredTarget.id)?.transitionIn).toEqual(from.transitionIn);
		expect(find(loneTarget.id)?.transitionIn).toBeUndefined();
		expect(find(loneTarget.id)).not.toHaveProperty("transitionIn");
	});

	test("absent source fields are removed from the target, not set to undefined", () => {
		const source = asset("Source", 20);
		const project = newProject("Absent");
		const plain = { ...newSegment(source, 0, 0), sourceOut: 4 };
		const treated = { ...withoutReveal(treatedClip(source, 0)), track: 1 };
		project.segments = [plain, treated];
		const changed = copyClipSettings(project, [source], {
			revision: project.revision,
			sourceClipId: plain.id,
			targetClipIds: [treated.id],
		});
		const copied = changed.segments.find(
			(segment) => segment.id === treated.id
		);
		expect(copied).not.toHaveProperty("blendMode");
		expect(copied).not.toHaveProperty("masks");
		expect(copied).not.toHaveProperty("label");
		expect(JSON.parse(JSON.stringify(copied))).toEqual(copied);
	});

	test("pasteSettings copies only the chosen groups and their keyframes", () => {
		const source = asset("Source", 20);
		const project = newProject("Paste groups");
		const snapshot = withoutReveal(treatedClip(source, 0));
		const target: Segment = {
			...newSegment(source, 0, 1),
			keyframes: [
				{ id: crypto.randomUUID(), property: "x", time: 0.5, value: -0.4 },
				{ id: crypto.randomUUID(), property: "volume", time: 0, value: 0.5 },
			],
			sourceOut: 4,
		};
		project.segments = [target];
		const changed = pasteSettings(project, [source], snapshot, [target.id], {
			groups: ["color", "audio"],
		});
		const pasted = changed.segments[0];
		expect(pasted).toMatchObject({
			brightness: 0.1,
			channelMode: "mono",
			pan: -0.5,
			volume: 1.5,
		});
		expect(pasted).not.toHaveProperty("blendMode");
		expect(pasted).not.toHaveProperty("masks");
		expect(pasted?.x).toBe(0);
		const frames = pasted?.keyframes
			.map((frame) => `${frame.property}=${frame.value}`)
			.sort();
		expect(frames).toEqual(["brightness=0.3", "volume=2", "x=-0.4"]);
	});

	test("pasteSettings fits fades and exit to a shorter target and skips keys on audio", () => {
		const video = asset("Video", 20);
		const audio = { ...asset("Audio", 20), kind: "audio" as const };
		const project = newProject("Fit");
		const snapshot = {
			...withoutReveal(treatedClip(video, 0)),
			exitDuration: 3,
			fadeIn: 2,
			fadeOut: 2,
		};
		const short = { ...newSegment(video, 0, 0), sourceOut: 3 };
		const voice = { ...newSegment(audio, 0, 1), sourceOut: 3 };
		project.segments = [short, voice];
		const changed = pasteSettings(
			project,
			[video, audio],
			snapshot,
			[short.id, voice.id],
			{ groups: ["animation", "masks"] }
		);
		expect(changed.segments[0]).toMatchObject({
			exitDuration: 3,
			fadeIn: 2,
			fadeOut: 1,
		});
		expect(changed.segments[0]?.key).toEqual(snapshot.key);
		expect(changed.segments[1]).not.toHaveProperty("key");
	});

	test("pasteSettings refuses empty groups, locked targets, and source-only targets", () => {
		const source = asset("Source", 20);
		const project = newProject("Refusals");
		const snapshot = treatedClip(source, 0);
		const target = { ...newSegment(source, 0, 1), sourceOut: 4 };
		project.segments = [snapshot, target];
		expect(() =>
			pasteSettings(project, [source], snapshot, [target.id], { groups: [] })
		).toThrow("at least one");
		expect(() =>
			pasteSettings(project, [source], snapshot, [snapshot.id], {
				groups: ["color"],
			})
		).toThrow("other clip");
		const locked = updateTrackSetting(project, 1, { locked: true });
		locked.segments = project.segments;
		expect(() =>
			pasteSettings(locked, [source], snapshot, [target.id], {
				groups: ["color"],
			})
		).toThrow("Unlock");
	});

	test("pasteSettingsFromClip reads the source from the timeline", () => {
		const source = asset("Source", 20);
		const project = newProject("Route form");
		const from = withoutReveal(treatedClip(source, 0));
		const target = { ...newSegment(source, 0, 1), sourceOut: 4 };
		project.segments = [from, target];
		const changed = pasteSettingsFromClip(project, [source], {
			groups: ["transform"],
			revision: project.revision,
			sourceClipId: from.id,
			targetClipIds: [target.id],
		});
		expect(changed.segments[1]).toMatchObject({
			blendMode: "screen",
			flipH: true,
			scaleX: 1.5,
		});
		expect(() =>
			pasteSettingsFromClip(project, [source], {
				groups: ["transform", "transform"],
				revision: project.revision,
				sourceClipId: from.id,
				targetClipIds: [target.id],
			})
		).toThrow();
		expect(() =>
			pasteSettingsFromClip(project, [source], {
				groups: ["transform"],
				revision: project.revision,
				sourceClipId: from.id,
				targetClipIds: [from.id],
			})
		).toThrow("source clip");
	});
});

test("copyClipSettings copies the W2 visual treatment and fits exit to the target", () => {
	const source = asset("Source");
	const targetAsset = asset("Target");
	const project = newProject("Copy visual settings");
	const from = newSegment(source, 0, 0);
	from.sourceOut = 4;
	from.blendMode = "screen";
	from.flipH = true;
	from.flipV = true;
	from.scaleX = 1.5;
	from.scaleY = 0.5;
	from.fit = "fill";
	from.exitTransition = "crossfade";
	from.exitDuration = 3;
	from.label = "Interview";
	const to = newSegment(targetAsset, 4, 0);
	to.sourceOut = 1;
	to.label = "B-roll";
	project.segments = [from, to];
	const changed = copyClipSettings(project, [source, targetAsset], {
		revision: project.revision,
		sourceClipId: from.id,
		targetClipIds: [to.id],
	});
	expect(changed.segments[1]).toMatchObject({
		blendMode: "screen",
		exitDuration: 1,
		exitTransition: "crossfade",
		fit: "fill",
		flipH: true,
		flipV: true,
		// "Copy all settings" carries the clip label (SETTINGS_META_FIELDS).
		label: "Interview",
		scaleX: 1.5,
		scaleY: 0.5,
	});
	expect(changed.segments[1]?.transitionIn).toBeUndefined();
});

test("copyClipSettings from a keyed video clip leaves an audio target unkeyed", () => {
	const source = asset("Keyed video");
	const audio = {
		...asset("Voice"),
		height: 0,
		kind: "audio" as const,
		width: 0,
	};
	const visual = asset("Second video");
	const project = newProject("Copy key to audio");
	const from = newSegment(source, 0, 1);
	from.key = { color: "#00ff00", type: "chroma" };
	const toAudio = newSegment(audio, 0, 2);
	const toVisual = newSegment(visual, 4, 1);
	project.segments = [from, toAudio, toVisual];
	const changed = copyClipSettings(project, [source, audio, visual], {
		revision: project.revision,
		sourceClipId: from.id,
		targetClipIds: [toAudio.id, toVisual.id],
	});
	expect(changed.segments[1]?.key).toBeUndefined();
	expect(changed.segments[2]?.key).toMatchObject({
		color: "#00ff00",
		type: "chroma",
	});
});
