import { describe, expect, test } from "bun:test";
import { clipTempoFilters, withClipSpeed } from "./clip-speed.ts";
import {
	newProject,
	newSegment,
	type Project,
	type Segment,
	segmentDuration,
	splitSegment,
	validateProject,
} from "./project.ts";
import {
	clipSourceOffset,
	clipSpeedAt,
	clipTimeAtSourceOffset,
	curveTempoSteps,
	curveUnitDuration,
	naturalCurveSpeed,
	speedCurveAudioGraph,
	speedCurveSetpts,
	splitSpeedCurve,
	subCurvePoints,
} from "./speed-curve.ts";
import {
	applySpeedCurve,
	bakeSpeedCurve,
	removeSpeedCurve,
	setSpeedCurvePitch,
	speedRamp,
} from "./speed-ramp.ts";

function asset(kind: "video" | "audio" = "video") {
	return {
		id: crypto.randomUUID(),
		name: kind,
		kind,
		duration: 20,
		width: kind === "audio" ? 0 : 640,
		height: kind === "audio" ? 0 : 360,
		hasAudio: true,
		createdAt: new Date().toISOString(),
	};
}

function fixture() {
	const video = asset();
	const clip = newSegment(video, 0, 0);
	clip.sourceIn = 1;
	clip.sourceOut = 9;
	const later = newSegment(video, 8, 0);
	later.sourceOut = 2;
	const project: Project = {
		...newProject("Curve"),
		segments: [clip, later],
	};
	return { clip, later, project, video };
}

const byId = (project: Project, id: string) => {
	const found = project.segments.find((segment) => segment.id === id);
	if (!found) {
		throw new Error("missing clip");
	}
	return found;
};

describe("speed curve math", () => {
	test("integrates constant and linear speeds exactly", () => {
		expect(
			curveUnitDuration([
				{ t: 0, speed: 2 },
				{ t: 1, speed: 2 },
			])
		).toBeCloseTo(0.5, 9);
		expect(
			curveUnitDuration([
				{ t: 0, speed: 1 },
				{ t: 1, speed: 2 },
			])
		).toBeCloseTo(Math.log(2), 9);
		// Holds outside the first and last point.
		expect(
			curveUnitDuration([
				{ t: 0.5, speed: 0.5 },
				{ t: 0.75, speed: 0.5 },
			])
		).toBeCloseTo(2, 9);
	});

	test("maps clip time to source and back on the curve", () => {
		const clip = {
			sourceIn: 2,
			sourceOut: 6,
			speed: 0,
			speedCurve: {
				points: [
					{ t: 0, speed: 0.1 },
					{ t: 0.5, speed: 10 },
					{ t: 1, speed: 1 },
				],
			},
		} satisfies Pick<
			Segment,
			"sourceIn" | "sourceOut" | "speed" | "speedCurve"
		>;
		clip.speed = naturalCurveSpeed(clip.speedCurve.points);
		const duration = 4 / clip.speed;
		for (const fraction of [0, 0.1, 0.33, 0.5, 0.8, 1]) {
			const time = duration * fraction;
			const offset = clipSourceOffset(clip, time);
			expect(clipTimeAtSourceOffset(clip, offset)).toBeCloseTo(time, 6);
		}
		expect(clipSpeedAt(clip, 0)).toBeCloseTo(0.1, 6);
		expect(clipSpeedAt(clip, clipTimeAtSourceOffset(clip, 2))).toBeCloseTo(
			10,
			6
		);
		expect(clipSourceOffset(clip, duration)).toBeCloseTo(4, 9);
	});

	test("constant clips keep the linear mapping", () => {
		const clip = { sourceIn: 0, sourceOut: 4, speed: 2 };
		expect(clipSourceOffset(clip, 1)).toBe(2);
		expect(clipTimeAtSourceOffset(clip, 3)).toBe(1.5);
		expect(clipSpeedAt(clip, 1)).toBe(2);
	});

	test("sub-curves interpolate their boundary points", () => {
		const points = subCurvePoints(
			[
				{ t: 0, speed: 1 },
				{ t: 1, speed: 3 },
			],
			0.5,
			1
		);
		expect(points).toEqual([
			{ speed: 2, t: 0 },
			{ speed: 3, t: 1 },
		]);
	});

	test("audio tempo steps add up to the clip time", () => {
		const clip = {
			id: crypto.randomUUID(),
			sourceIn: 0,
			sourceOut: 3,
			speed: 1,
			speedCurve: {
				points: [
					{ t: 0, speed: 0.1 },
					{ t: 1, speed: 4 },
				],
			},
		};
		clip.speed = naturalCurveSpeed(clip.speedCurve.points);
		const steps = curveTempoSteps(clip);
		let total = 0;
		for (const step of steps) {
			total += (step.end - step.at) / step.speed;
			expect(step.timeTo - step.timeFrom).toBeCloseTo(
				(step.end - step.at) / step.speed,
				9
			);
		}
		expect(total).toBeCloseTo(3 / clip.speed, 6);
		expect(steps.at(-1)?.timeTo).toBeCloseTo(3 / clip.speed, 9);
		const graph = speedCurveAudioGraph(clip, "[0:a]", "[out]", "c");
		expect(graph[0]).toBe(
			`[0:a]asetpts=PTS-STARTPTS,aresample=48000,asplit=${steps.length}${steps.map((_, index) => `[cs${index}]`).join("")}`
		);
		expect(graph).toHaveLength(steps.length + 2);
		expect(graph.at(-1)).toEndWith(`concat=n=${steps.length}:v=0:a=1[out]`);
		// The 0.1x start needs four atempo stages within 0.5x to 2x.
		expect(graph[1]?.match(/atempo=/g)?.length).toBeGreaterThan(1);
		// The clip's own chain only mutes; the graph carries the tempo.
		expect(clipTempoFilters({ ...clip, muted: true })).toEqual([
			"anull",
			"volume=0",
		]);
	});

	test("the setpts expression uses the exact logarithmic remap", () => {
		const clip = {
			sourceIn: 0,
			sourceOut: 2,
			speed: 1,
			speedCurve: {
				points: [
					{ t: 0, speed: 1 },
					{ t: 1, speed: 2 },
				],
			},
		};
		const expression = speedCurveSetpts(clip);
		expect(expression).toStartWith("setpts='st(0,(PTS-STARTPTS)*TB);");
		expect(expression).toContain("log(1+");
		expect(expression).toEndWith("/TB'");
	});
});

describe("speed curve edits", () => {
	test("keeps one clip and remaps it continuously", () => {
		const { clip, later, project, video } = fixture();
		const next = applySpeedCurve(project, [video], {
			clipId: clip.id,
			preset: "custom",
			points: [
				{ t: 0, speed: 0.1 },
				{ t: 0.5, speed: 10 },
				{ t: 1, speed: 1 },
			],
			revision: project.revision,
		});
		expect(next.segments).toHaveLength(2);
		const curved = byId(next, clip.id);
		expect(curved.speedCurve?.points).toHaveLength(3);
		const expected =
			8 *
			curveUnitDuration([
				{ t: 0, speed: 0.1 },
				{ t: 0.5, speed: 10 },
				{ t: 1, speed: 1 },
			]);
		expect(segmentDuration(curved)).toBeCloseTo(expected, 4);
		// The later clip rippled by the change in length.
		expect(byId(next, later.id).start).toBeCloseTo(
			8 + segmentDuration(curved) - 8,
			4
		);
		expect(() => validateProject(next, [video])).not.toThrow();
	});

	test("rejects curve speeds outside 0.1x to 10x", () => {
		const { clip, project, video } = fixture();
		expect(() =>
			applySpeedCurve(project, [video], {
				clipId: clip.id,
				preset: "custom",
				points: [
					{ t: 0, speed: 0.05 },
					{ t: 1, speed: 1 },
				],
				revision: project.revision,
			})
		).toThrow();
		expect(() =>
			applySpeedCurve(project, [video], {
				clipId: clip.id,
				preset: "custom",
				points: [
					{ t: 0, speed: 1 },
					{ t: 1, speed: 12 },
				],
				revision: project.revision,
			})
		).toThrow();
	});

	test("linked partners follow the same curve", () => {
		const video = asset();
		const audio = asset("audio");
		const linkGroupId = crypto.randomUUID();
		const picture = { ...newSegment(video, 0, 0), linkGroupId, sourceOut: 6 };
		const sound = { ...newSegment(audio, 0, 1), linkGroupId, sourceOut: 6 };
		const project: Project = {
			...newProject("Linked"),
			segments: [picture, sound],
		};
		const next = applySpeedCurve(project, [video, audio], {
			clipId: picture.id,
			preset: "hero",
			revision: project.revision,
		});
		const a = byId(next, picture.id);
		const b = byId(next, sound.id);
		expect(b.speedCurve).toEqual(a.speedCurve);
		expect(segmentDuration(b)).toBeCloseTo(segmentDuration(a), 6);
	});

	test("keyframes stay on their source moments", () => {
		const { clip, project, video } = fixture();
		const keyed: Segment = {
			...clip,
			keyframes: [
				{ id: crypto.randomUUID(), property: "opacity", time: 4, value: 0.5 },
			],
		};
		const next = applySpeedCurve(
			{ ...project, segments: [keyed, ...project.segments.slice(1)] },
			[video],
			{ clipId: clip.id, preset: "bullet", revision: project.revision }
		);
		const curved = byId(next, clip.id);
		const frame = curved.keyframes[0];
		expect(frame).toBeDefined();
		expect(clipSourceOffset(curved, frame?.time ?? 0)).toBeCloseTo(4, 4);
	});

	test("a split keeps both halves on the original curve", () => {
		const { clip, project, video } = fixture();
		const next = applySpeedCurve(project, [video], {
			clipId: clip.id,
			preset: "montage",
			revision: project.revision,
		});
		const curved = byId(next, clip.id);
		const duration = segmentDuration(curved);
		const at = duration * 0.4;
		const [left, right] = splitSegment(curved, at);
		expect(segmentDuration(left)).toBeCloseTo(at, 6);
		expect(segmentDuration(right)).toBeCloseTo(duration - at, 6);
		expect(left.sourceOut).toBeCloseTo(
			curved.sourceIn + clipSourceOffset(curved, at),
			9
		);
		// Inside each half the mapping matches the whole clip.
		const probe = at * 0.5;
		expect(left.sourceIn + clipSourceOffset(left, probe)).toBeCloseTo(
			curved.sourceIn + clipSourceOffset(curved, probe),
			4
		);
		const later = at + (duration - at) * 0.5;
		expect(right.sourceIn + clipSourceOffset(right, later - at)).toBeCloseTo(
			curved.sourceIn + clipSourceOffset(curved, later),
			4
		);
	});

	test("removing a curve keeps its length; a constant speed replaces it", () => {
		const { clip, project, video } = fixture();
		const curved = applySpeedCurve(project, [video], {
			clipId: clip.id,
			preset: "flash-in",
			revision: project.revision,
		});
		const length = segmentDuration(byId(curved, clip.id));
		const flat = removeSpeedCurve(curved, [video], {
			clipId: clip.id,
			revision: curved.revision,
		});
		expect(byId(flat, clip.id).speedCurve).toBeUndefined();
		expect(segmentDuration(byId(flat, clip.id))).toBeCloseTo(length, 4);
		const constant = withClipSpeed(curved, clip.id, 2);
		expect(constant?.project.segments[0]?.speedCurve).toBeUndefined();
		expect(() =>
			removeSpeedCurve(flat, [video], {
				clipId: clip.id,
				revision: flat.revision,
			})
		).toThrow("This clip has no speed curve.");
	});

	test("baking cuts the curve into constant-speed steps of the same length", () => {
		const { clip, project, video } = fixture();
		const curved = applySpeedCurve(project, [video], {
			clipId: clip.id,
			preset: "custom",
			points: [
				{ t: 0, speed: 0.2 },
				{ t: 1, speed: 8 },
			],
			revision: project.revision,
		});
		const length = segmentDuration(byId(curved, clip.id));
		const baked = bakeSpeedCurve(curved, [video], {
			clipId: clip.id,
			steps: 8,
			revision: curved.revision,
		});
		const steps = baked.segments
			.filter((segment) => segment.track === 0)
			.sort((a, b) => a.start - b.start)
			.slice(0, 8);
		expect(steps).toHaveLength(8);
		expect(steps.every((step) => step.speedCurve === undefined)).toBe(true);
		const total = steps.reduce((sum, step) => sum + segmentDuration(step), 0);
		expect(total).toBeCloseTo(length, 3);
		expect(steps[0]?.sourceIn).toBe(1);
		expect(steps.at(-1)?.sourceOut).toBe(9);
	});

	test("the stepped ramp accepts the widened 0.1x to 10x range", () => {
		const { clip, project, video } = fixture();
		const next = speedRamp(project, [video], {
			clipId: clip.id,
			preset: "custom",
			points: [
				{ t: 0, speed: 0.1 },
				{ t: 0.5, speed: 0.1 },
				{ t: 0.51, speed: 10 },
				{ t: 1, speed: 10 },
			],
			steps: 4,
			revision: project.revision,
		});
		const speeds = next.segments
			.filter((segment) => segment.track === 0)
			.map((segment) => segment.speed);
		expect(Math.min(...speeds)).toBeLessThan(0.25);
		expect(Math.max(...speeds)).toBeGreaterThan(4);
	});

	test("tape-style audio is a per-curve choice that splits and re-applies keep", () => {
		const { clip, project, video } = fixture();
		const curved = applySpeedCurve(project, [video], {
			clipId: clip.id,
			preset: "montage",
			revision: project.revision,
		});
		expect(byId(curved, clip.id).speedCurve?.preservePitch).toBeUndefined();
		const tape = setSpeedCurvePitch(curved, {
			clipId: clip.id,
			preservePitch: false,
			revision: curved.revision,
		});
		expect(byId(tape, clip.id).speedCurve?.preservePitch).toBe(false);
		// Re-applying a preset keeps the clip's choice unless one is given.
		const again = applySpeedCurve(tape, [video], {
			clipId: clip.id,
			preset: "hero",
			revision: tape.revision,
		});
		expect(byId(again, clip.id).speedCurve?.preservePitch).toBe(false);
		const kept = applySpeedCurve(tape, [video], {
			clipId: clip.id,
			preservePitch: true,
			preset: "hero",
			revision: tape.revision,
		});
		expect(byId(kept, clip.id).speedCurve?.preservePitch).toBeUndefined();
		// Both halves of a split keep it.
		const halves = splitSpeedCurve(byId(tape, clip.id), 1);
		expect(halves.left.speedCurve?.preservePitch).toBe(false);
		expect(halves.right.speedCurve?.preservePitch).toBe(false);
		// Switching back drops the field, the default.
		const restored = setSpeedCurvePitch(tape, {
			clipId: clip.id,
			preservePitch: true,
			revision: tape.revision,
		});
		expect(byId(restored, clip.id).speedCurve).not.toHaveProperty(
			"preservePitch"
		);
		expect(() =>
			setSpeedCurvePitch(project, {
				clipId: clip.id,
				preservePitch: false,
				revision: project.revision,
			})
		).toThrow("no speed curve");
		expect(() => validateProject(tape, [video])).not.toThrow();
	});
});
