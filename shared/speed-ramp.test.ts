import { describe, expect, test } from "bun:test";
import {
	animatedValue,
	newProject,
	newSegment,
	type Segment,
	segmentDuration,
	splitSegment,
} from "./project.ts";
import {
	planSpeedRamp,
	resetSpeedRamp,
	SPEED_RAMP_PRESETS,
	speedRamp,
	speedRampCurve,
} from "./speed-ramp.ts";

function asset(id: string, kind: "video" | "audio" = "video") {
	return {
		id,
		name: id,
		kind,
		duration: 12,
		width: kind === "audio" ? 0 : 640,
		height: kind === "audio" ? 0 : 360,
		hasAudio: true,
		createdAt: new Date().toISOString(),
	};
}

function fixture() {
	const video = asset(crypto.randomUUID());
	const clip = newSegment(video, 0, 0);
	clip.sourceIn = 1;
	clip.sourceOut = 9;
	const later = newSegment(video, 8, 0);
	later.sourceOut = 2;
	const project = { ...newProject("Ramp"), segments: [clip, later] };
	return { clip, later, project, video };
}

const onTrack = (segments: readonly Segment[], track: number) =>
	segments
		.filter((segment) => segment.track === track)
		.sort((a, b) => a.start - b.start);

describe("speed ramps", () => {
	test("covers the source range with contiguous steps", () => {
		const { clip, project, video } = fixture();
		const next = speedRamp(project, [video], {
			clipId: clip.id,
			preset: "montage",
			steps: 8,
			revision: project.revision,
		});
		const ramp = onTrack(next.segments, 0).slice(0, 8);
		expect(ramp).toHaveLength(8);
		expect(ramp[0]?.id).toBe(clip.id);
		expect(ramp[0]?.sourceIn).toBe(1);
		expect(ramp.at(-1)?.sourceOut).toBe(9);
		for (let index = 1; index < ramp.length; index++) {
			const previous = ramp[index - 1] as Segment;
			const current = ramp[index] as Segment;
			expect(current.sourceIn).toBe(previous.sourceOut);
			expect(current.start).toBeCloseTo(
				previous.start + segmentDuration(previous),
				5
			);
		}
	});

	test("total duration equals the integral and later clips ripple", () => {
		const { clip, later, project, video } = fixture();
		const plan = planSpeedRamp(8, SPEED_RAMP_PRESETS.hero.points, 12);
		const integral = plan.steps.reduce(
			(total, step) =>
				total + (8 * (step.toFraction - step.fromFraction)) / step.speed,
			0
		);
		expect(plan.duration).toBeCloseTo(integral, 9);
		const next = speedRamp(project, [video], {
			clipId: clip.id,
			preset: "hero",
			steps: 12,
			revision: project.revision,
		});
		const moved = next.segments.find((segment) => segment.id === later.id);
		expect(moved?.start).toBeCloseTo(plan.duration, 5);
	});

	test("clamps curve speeds and honours the step count", () => {
		const plan = planSpeedRamp(
			10,
			[
				{ t: 0, speed: 0.25 },
				{ t: 1, speed: 4 },
			],
			4
		);
		expect(plan.steps).toHaveLength(4);
		for (const step of plan.steps) {
			expect(step.speed).toBeGreaterThanOrEqual(0.25);
			expect(step.speed).toBeLessThanOrEqual(4);
		}
		const { clip, project, video } = fixture();
		const next = speedRamp(project, [video], {
			clipId: clip.id,
			preset: "custom",
			points: [
				{ t: 0, speed: 0.25 },
				{ t: 1, speed: 4 },
			],
			steps: 6,
			revision: project.revision,
		});
		expect(next.segments).toHaveLength(7);
		expect(
			next.segments.every(
				(segment) => segment.speed >= 0.25 && segment.speed <= 4
			)
		).toBe(true);
	});

	test("refuses a slower ramp that would overlap when not rippling", () => {
		const { clip, project, video } = fixture();
		expect(() =>
			speedRamp(project, [video], {
				clipId: clip.id,
				preset: "bullet",
				ripple: "none",
				revision: project.revision,
			})
		).toThrow("overlap the next clip");
	});

	test("ramps linked audio identically in one link group", () => {
		const { clip, project, video } = fixture();
		const audio = asset(crypto.randomUUID(), "audio");
		const groupId = crypto.randomUUID();
		const sound = { ...newSegment(audio, 0, 1), sourceIn: 1, sourceOut: 9 };
		project.segments = [
			{ ...clip, linkGroupId: groupId },
			{ ...sound, linkGroupId: groupId },
		];
		const next = speedRamp(project, [video, audio], {
			clipId: clip.id,
			preset: "flash-in",
			steps: 6,
			revision: project.revision,
		});
		const pictures = onTrack(next.segments, 0);
		const sounds = onTrack(next.segments, 1);
		expect(pictures).toHaveLength(6);
		expect(sounds.map((segment) => [segment.start, segment.speed])).toEqual(
			pictures.map((segment) => [segment.start, segment.speed])
		);
		const groups = new Set(next.segments.map((segment) => segment.linkGroupId));
		expect(groups.size).toBe(1);
		expect(groups.has(groupId)).toBe(false);
	});

	test("keeps animation on its source moments", () => {
		const { clip, project, video } = fixture();
		project.segments = [
			{
				...clip,
				keyframes: [
					{ id: crypto.randomUUID(), property: "x", time: 8, value: 1 },
				],
			},
		];
		const next = speedRamp(project, [video], {
			clipId: clip.id,
			preset: "flash-out",
			steps: 4,
			revision: project.revision,
		});
		const steps = onTrack(next.segments, 0);
		expect(steps[0]?.x).toBe(0);
		expect(steps[2]?.x).toBeCloseTo(0.5, 6);
		expect(steps.at(-1)?.keyframes.at(-1)?.value).toBe(1);
	});

	test("reset merges the steps back into one constant clip", () => {
		const { clip, later, project, video } = fixture();
		const ramped = speedRamp(project, [video], {
			clipId: clip.id,
			preset: "montage",
			steps: 10,
			revision: project.revision,
		});
		const middle = onTrack(ramped.segments, 0)[4] as Segment;
		const laterStart = ramped.segments.find(
			(segment) => segment.id === later.id
		)?.start;
		const reset = resetSpeedRamp(ramped, [video], {
			clipId: middle.id,
			revision: ramped.revision,
		});
		const merged = reset.segments.find((segment) => segment.id === clip.id);
		expect(reset.segments).toHaveLength(2);
		expect(merged?.sourceIn).toBe(1);
		expect(merged?.sourceOut).toBe(9);
		expect(merged ? segmentDuration(merged) : 0).toBeCloseTo(
			laterStart ?? 0,
			5
		);
		const restored = resetSpeedRamp(ramped, [video], {
			clipId: clip.id,
			speed: 1,
			revision: ramped.revision,
		});
		expect(
			restored.segments.find((segment) => segment.id === later.id)?.start
		).toBeCloseTo(8, 5);
	});

	test("reset refuses a clip that is not part of a ramp", () => {
		const { clip, project, video } = fixture();
		expect(() =>
			resetSpeedRamp(project, [video], {
				clipId: clip.id,
				revision: project.revision,
			})
		).toThrow("no speed ramp");
	});

	test("refuses locked tracks and too many steps for a short clip", () => {
		const { clip, project, video } = fixture();
		expect(() =>
			speedRamp(
				{
					...project,
					trackSettings: [
						{ locked: true, muted: false, name: "V1", solo: false, track: 0 },
					],
				},
				[video],
				{ clipId: clip.id, preset: "hero", revision: project.revision }
			)
		).toThrow("Unlock");
		project.segments = [{ ...clip, sourceIn: 0, sourceOut: 0.5 }];
		expect(() =>
			speedRamp(project, [video], {
				clipId: clip.id,
				preset: "flash-in",
				steps: 24,
				revision: project.revision,
			})
		).toThrow("too short");
	});

	test("reset leaves a razor-split sibling untouched", () => {
		const video = asset(crypto.randomUUID());
		const whole = { ...newSegment(video, 0, 0), sourceIn: 0, sourceOut: 12 };
		const [left, right] = splitSegment(whole, 4);
		const project = {
			...newProject("Razor"),
			segments: [left, { ...right, volume: 0.2 }],
		};
		const ramped = speedRamp(project, [video], {
			clipId: left.id,
			preset: "hero",
			steps: 8,
			revision: project.revision,
		});
		const reset = resetSpeedRamp(ramped, [video], {
			clipId: left.id,
			revision: ramped.revision,
		});
		expect(reset.segments).toHaveLength(2);
		const sibling = reset.segments.find((segment) => segment.id === right.id);
		expect(sibling?.speed).toBe(1);
		expect(sibling?.volume).toBe(0.2);
		expect(sibling?.sourceIn).toBe(4);
		const merged = reset.segments.find((segment) => segment.id === left.id);
		expect(merged?.sourceOut).toBe(4);
	});

	test("ramp then reset keeps dense animation intact", () => {
		const video = asset(crypto.randomUUID());
		const properties = [
			"x",
			"y",
			"scale",
			"rotation",
			"opacity",
			"volume",
		] as const;
		const base = { ...newSegment(video, 0, 0), sourceIn: 0, sourceOut: 12 };
		const original: Segment = {
			...base,
			keyframes: properties.flatMap((property) =>
				Array.from({ length: 20 }, (_, index) => ({
					id: crypto.randomUUID(),
					property,
					time: 0.55 * (index + 1),
					value: index % 2 ? 0.4545 : 0.3636,
				}))
			),
		};
		const project = { ...newProject("Dense"), segments: [original] };
		const ramped = speedRamp(project, [video], {
			clipId: original.id,
			preset: "bullet",
			steps: 24,
			revision: project.revision,
		});
		const reset = resetSpeedRamp(ramped, [video], {
			clipId: original.id,
			speed: 1,
			revision: ramped.revision,
		});
		const merged = reset.segments[0] as Segment;
		expect(reset.segments).toHaveLength(1);
		expect(merged.keyframes.length).toBeLessThanOrEqual(120);
		for (const property of properties) {
			for (let time = 0; time <= 12; time += 0.1) {
				expect(animatedValue(merged, property, time)).toBeCloseTo(
					animatedValue(original, property, time),
					4
				);
			}
		}
	});

	test("refuses a ramp whose fade will not fit its end steps", () => {
		const { clip, project, video } = fixture();
		project.segments = [{ ...clip, fadeIn: 1, fadeOut: 1 }];
		expect(() =>
			speedRamp(project, [video], {
				clipId: clip.id,
				preset: "flash-in",
				steps: 24,
				revision: project.revision,
			})
		).toThrow("fade is longer");
		const ramped = speedRamp(project, [video], {
			clipId: clip.id,
			preset: "bullet",
			steps: 4,
			revision: project.revision,
		});
		const reset = resetSpeedRamp(ramped, [video], {
			clipId: clip.id,
			speed: 1,
			revision: ramped.revision,
		});
		expect(reset.segments[0]?.fadeIn).toBe(1);
		expect(reset.segments[0]?.fadeOut).toBe(1);
	});

	test("ramps one half of a linked clip split on every track", () => {
		const video = asset(crypto.randomUUID());
		const audio = asset(crypto.randomUUID(), "audio");
		const groupId = crypto.randomUUID();
		const picture = {
			...newSegment(video, 0, 0),
			linkGroupId: groupId,
			sourceIn: 0,
			sourceOut: 8,
		};
		const sound = {
			...newSegment(audio, 0, 1),
			linkGroupId: groupId,
			sourceIn: 0,
			sourceOut: 8,
		};
		const [left, right] = splitSegment(picture, 4);
		const onePicture = {
			...newProject("Split"),
			segments: [left, right, sound],
		};
		expect(() =>
			speedRamp(onePicture, [video, audio], {
				clipId: left.id,
				preset: "hero",
				steps: 4,
				revision: onePicture.revision,
			})
		).toThrow("split on only one track");
		const [soundLeft, soundRight] = splitSegment(sound, 4);
		const both = {
			...onePicture,
			segments: [left, right, soundLeft, soundRight],
		};
		const ramped = speedRamp(both, [video, audio], {
			clipId: left.id,
			preset: "hero",
			steps: 4,
			ripple: "timeline",
			revision: both.revision,
		});
		expect(onTrack(ramped.segments, 0)).toHaveLength(5);
		expect(onTrack(ramped.segments, 1)).toHaveLength(5);
		const untouched = ramped.segments.filter(
			(segment) => segment.id === right.id || segment.id === soundRight.id
		);
		expect(untouched.map((segment) => segment.linkGroupId)).toEqual([
			groupId,
			groupId,
		]);
	});
});

describe("jump cut preset", () => {
	test("steps hard from fast to slow and back", () => {
		const plan = planSpeedRamp(9, speedRampCurve("jump-cut"), 12);
		const speeds = plan.steps.map((step) => step.speed);
		expect(speeds.slice(0, 4)).toEqual([3, 3, 3, 3]);
		expect(speeds.slice(4, 8)).toEqual([0.5, 0.5, 0.5, 0.5]);
		expect(speeds.slice(8)).toEqual([3, 3, 3, 3]);
	});
});
