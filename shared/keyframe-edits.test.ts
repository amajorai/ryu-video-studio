import { expect, test } from "bun:test";
import { setKeyframes, setKeyframesRequestSchema } from "./keyframe-edits.ts";
import { newProject, newSegment, updateTrackSetting } from "./project.ts";

function setup() {
	const source = {
		createdAt: new Date().toISOString(),
		duration: 8,
		hasAudio: true,
		height: 360,
		id: crypto.randomUUID(),
		kind: "video" as const,
		name: "Clip",
		width: 640,
	};
	const project = newProject("Keyframe edits");
	const clip = newSegment(source);
	const effectId = crypto.randomUUID();
	clip.effects = [{ amount: 0.4, enabled: true, id: effectId, type: "blur" }];
	project.segments = [clip];
	return { clip, effectId, project, source };
}

test("setKeyframes stores interpolation and Bezier controls", () => {
	const { clip, project, source } = setup();
	const result = setKeyframes(project, [source], {
		clipId: clip.id,
		keyframes: [
			{ time: 0, value: 0, interpolation: "ease-in-out" },
			{
				time: 1,
				value: 0.5,
				interpolation: "bezier",
				bezier: [0.25, 0.1, 0.25, 1],
			},
			{ time: 2, value: 1, interpolation: "hold" },
		],
		property: "brightness",
		revision: project.revision,
	});
	expect(result.segments[0]?.keyframes).toMatchObject([
		{ interpolation: "ease-in-out", property: "brightness", time: 0 },
		{ bezier: [0.25, 0.1, 0.25, 1], interpolation: "bezier", time: 1 },
		{ interpolation: "hold", time: 2 },
	]);
});

test("setKeyframes accepts every new property within its range", () => {
	const { clip, project, source } = setup();
	for (const [property, value] of [
		["scaleX", 2],
		["cropLeft", 0.3],
		["contrast", 2],
		["exposure", -2],
		["temperature", 0.5],
		["pan", -1],
	] as const) {
		const result = setKeyframes(project, [source], {
			clipId: clip.id,
			keyframes: [{ time: 0.5, value }],
			property,
			revision: project.revision,
		});
		expect(result.segments[0]?.keyframes).toMatchObject([
			{ property, time: 0.5, value },
		]);
	}
});

test("setKeyframes rejects values outside the property range", () => {
	const { clip, project } = setup();
	for (const [property, value] of [
		["cropLeft", 0.95],
		["opacity", 2],
		["exposure", 4],
	] as const) {
		expect(
			setKeyframesRequestSchema.safeParse({
				clipId: clip.id,
				keyframes: [{ time: 0, value }],
				property,
				revision: project.revision,
			}).success
		).toBe(false);
	}
});

test("Bezier controls are required for, and only for, bezier keyframes", () => {
	const { clip, project } = setup();
	const parse = (keyframe: object) =>
		setKeyframesRequestSchema.safeParse({
			clipId: clip.id,
			keyframes: [{ time: 0, value: 0, ...keyframe }],
			property: "x",
			revision: project.revision,
		}).success;
	expect(parse({ interpolation: "bezier" })).toBe(false);
	expect(parse({ bezier: [0.2, 0, 0.8, 1] })).toBe(false);
	expect(parse({ bezier: [1.2, 0, 0.8, 1], interpolation: "bezier" })).toBe(
		false
	);
	expect(parse({ bezier: [0.2, 0, 0.8, 1], interpolation: "bezier" })).toBe(
		true
	);
});

test("targeted channels replace only their own target", () => {
	const { clip, effectId, project, source } = setup();
	const otherEffect = crypto.randomUUID();
	clip.effects.push({
		amount: 0.2,
		enabled: true,
		id: otherEffect,
		type: "blur",
	});
	clip.keyframes = [
		{
			id: crypto.randomUUID(),
			property: "effectAmount",
			target: otherEffect,
			time: 0,
			value: 0.1,
		},
		{ id: crypto.randomUUID(), property: "x", time: 0, value: 0.2 },
	];
	const result = setKeyframes(project, [source], {
		clipId: clip.id,
		keyframes: [{ time: 1, value: 0.9 }],
		property: "effectAmount",
		target: effectId,
		revision: project.revision,
	});
	const frames = result.segments[0]?.keyframes ?? [];
	expect(frames).toHaveLength(3);
	expect(frames.find((frame) => frame.target === effectId)?.value).toBe(0.9);
	expect(frames.find((frame) => frame.target === otherEffect)?.value).toBe(0.1);
	const cleared = setKeyframes(result, [source], {
		clipId: clip.id,
		keyframes: [],
		property: "effectAmount",
		target: effectId,
		revision: result.revision,
	});
	expect(cleared.segments[0]?.keyframes).toHaveLength(2);
});

test("targets are required exactly for effect and mask channels", () => {
	const { clip, effectId, project, source } = setup();
	const base = {
		clipId: clip.id,
		keyframes: [{ time: 0, value: 0.5 }],
		revision: project.revision,
	};
	expect(
		setKeyframesRequestSchema.safeParse({ ...base, property: "effectAmount" })
			.success
	).toBe(false);
	expect(
		setKeyframesRequestSchema.safeParse({
			...base,
			property: "x",
			target: effectId,
		}).success
	).toBe(false);
	expect(() =>
		setKeyframes(project, [source], {
			...base,
			property: "maskX",
			target: crypto.randomUUID(),
		})
	).toThrow("Invalid or duplicate animation keyframe.");
});

test("setKeyframes refuses locked tracks and duplicate times", () => {
	const { clip, project, source } = setup();
	expect(() =>
		setKeyframes(project, [source], {
			clipId: clip.id,
			keyframes: [
				{ time: 1, value: 0 },
				{ time: 1, value: 1 },
			],
			property: "x",
			revision: project.revision,
		})
	).toThrow("Choose each keyframe time once.");
	const locked = updateTrackSetting(project, 0, { locked: true });
	expect(() =>
		setKeyframes(locked, [source], {
			clipId: clip.id,
			keyframes: [],
			property: "x",
			revision: locked.revision,
		})
	).toThrow("Unlock");
});
