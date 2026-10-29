import { describe, expect, test } from "bun:test";
import { newProject, newSegment } from "./project.ts";
import { soundtrackBarSeconds, soundtrackRequestSchema } from "./soundtrack.ts";
import {
	alignSoundtrackPlan,
	beatMarkerTimes,
	clipSoundtrackSections,
	downbeatTimes,
	measuredBpm,
	parseSoundtrackPlan,
	planSoundtrack,
	type SoundtrackPlan,
	SoundtrackPlanError,
	soundtrackPlanInput,
	soundtrackPlanPrompt,
	soundtrackRequestFromPlan,
	soundtrackTimelineSummary,
	timelineSceneCuts,
} from "./soundtrack-plan.ts";

function asset(kind: "video" | "audio" = "video", duration = 10) {
	return {
		id: crypto.randomUUID(),
		name: kind,
		kind,
		duration,
		width: kind === "audio" ? 0 : 640,
		height: kind === "audio" ? 0 : 360,
		hasAudio: true,
		createdAt: new Date().toISOString(),
	};
}

/** Three 10 s picture clips (cuts at 10 and 20) under a 30 s music bed. */
function fixture() {
	const video = asset("video", 10);
	const music = asset("audio", 30);
	const project = {
		...newProject("Trailer"),
		brief: "A moody product teaser",
		segments: [
			newSegment(video, 0, 0),
			newSegment(video, 10, 0),
			newSegment(video, 20, 0),
			newSegment(music, 0, 1),
		],
		markers: [
			{ id: crypto.randomUUID(), label: "Reveal", time: 19 },
			...[0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4].map((time, index) => ({
				id: crypto.randomUUID(),
				label: `Beat ${index + 1}`,
				time,
			})),
		],
	};
	return { assets: [video, music], project };
}

const plan = (sections: SoundtrackPlan["sections"]): SoundtrackPlan => ({
	bpm: 90,
	sections,
	style: "cinematic",
});

describe("timeline context", () => {
	test("scene cuts come from picture clips, not audio", () => {
		const { assets, project } = fixture();
		expect(timelineSceneCuts(project, assets)).toEqual([10, 20]);
	});

	test("beat markers are read in time order and other markers are summarized", () => {
		const { project } = fixture();
		expect(beatMarkerTimes(project)).toEqual([0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4]);
		const summary = soundtrackTimelineSummary(project);
		expect(summary).toMatchObject({
			brief: "A moody product teaser",
			clipCount: 4,
			duration: 30,
			markers: [{ label: "Reveal", time: 19 }],
			title: "Trailer",
		});
	});

	test("tempo is measured from beats and folded into range", () => {
		expect(measuredBpm([0, 0.5, 1, 1.5, 2])).toBe(120);
		expect(measuredBpm([0, 2, 4, 6])).toBe(60);
		expect(measuredBpm([0, 0.25, 0.5, 0.75])).toBe(120);
		expect(measuredBpm([0, 1])).toBeUndefined();
	});

	test("downbeats are the rendered bar grid, phased to the first beat marker", () => {
		expect(
			downbeatTimes([0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5], 120, 9)
		).toEqual([0.5, 2.5, 4.5, 6.5, 8.5]);
		// A later first beat still yields the bars before it.
		expect(downbeatTimes([4.5, 5, 5.5, 6], 120, 9)).toEqual([
			0.5, 2.5, 4.5, 6.5, 8.5,
		]);
		expect(downbeatTimes([], 120, 9)).toEqual([2, 4, 6, 8]);
		// Too few beats to measure a tempo: no phase, grid from 0.
		expect(downbeatTimes([0.7, 1.2], 120, 5)).toEqual([2, 4]);
	});

	test("the prompt lists styles, cuts, downbeats and measured tempo", () => {
		const { assets, project } = fixture();
		const request = soundtrackPlanPrompt(
			soundtrackTimelineSummary(project),
			timelineSceneCuts(project, assets),
			beatMarkerTimes(project)
		);
		expect(request.system).toContain("lo-fi");
		expect(request.system).toContain("cover 0 to 30 seconds");
		const body = JSON.parse(request.prompt);
		expect(body.sceneCuts).toEqual([10, 20]);
		expect(body.downbeats.slice(0, 3)).toEqual([0.5, 2.5, 4.5]);
		expect(body.measuredBpm).toBe(120);
	});
});

describe("plan parsing", () => {
	test("accepts fenced JSON and rejects malformed or out-of-contract plans", () => {
		const text =
			'```json\n{"style":"upbeat","bpm":120,"sections":[{"start":0,"end":5,"intensity":0.4}]}\n```';
		expect(parseSoundtrackPlan(text).style).toBe("upbeat");
		expect(() => parseSoundtrackPlan("not json")).toThrow(
			"The model returned an unusable soundtrack plan. Try planning again."
		);
		expect(() =>
			parseSoundtrackPlan(
				'{"style":"polka","bpm":120,"sections":[{"start":0,"end":5,"intensity":0.4}]}'
			)
		).toThrow(SoundtrackPlanError);
		expect(() =>
			parseSoundtrackPlan('{"style":"upbeat","bpm":120,"sections":[]}')
		).toThrow("unusable soundtrack plan");
		expect(() => parseSoundtrackPlan('{"style": "upbeat", "bpm":')).toThrow(
			"unusable soundtrack plan"
		);
	});

	test("tolerates ordinary model output around and inside the JSON", () => {
		const plain = {
			bpm: 120,
			sections: [{ start: 0, end: 5, intensity: 0.4 }],
			style: "upbeat" as const,
		};
		expect(
			parseSoundtrackPlan(
				'{"style":"upbeat","bpm":120,"reasoning":"build {energy}","sections":[{"start":0,"end":5,"intensity":0.4,"label":"intro"}]}'
			)
		).toEqual(plain);
		expect(
			parseSoundtrackPlan(
				'Here is the plan: {"style":"upbeat","bpm":120,"sections":[{"start":0,"end":5,"intensity":0.4}]} Enjoy!'
			)
		).toEqual(plain);
		expect(
			parseSoundtrackPlan(
				'{"style":"Cinematic","bpm":200,"sections":[{"start":-1,"end":5,"intensity":2}]}'
			)
		).toEqual({
			bpm: 180,
			sections: [{ start: 0, end: 5, intensity: 1 }],
			style: "cinematic",
		});
		expect(
			parseSoundtrackPlan(
				'{"style":"Lo Fi","bpm":40,"sections":[{"start":0,"end":5,"intensity":-0.2}]}'
			)
		).toMatchObject({ bpm: 60, style: "lo-fi" });
		expect(
			parseSoundtrackPlan(
				'{"style":"LOFI","bpm":90,"sections":[{"start":0,"end":5,"intensity":0.5}]}'
			).style
		).toBe("lo-fi");
	});
});

describe("alignment", () => {
	test("section changes snap to the nearest cut before a downbeat", () => {
		const aligned = alignSoundtrackPlan(
			plan([
				{ start: 0, end: 9, intensity: 0.2 },
				{ start: 9.2, end: 21, intensity: 1 },
				{ start: 21, end: 30, intensity: 0.4 },
			]),
			{ beats: [], duration: 30, sceneCuts: [10, 20] }
		);
		expect(aligned.sections).toEqual([
			{ start: 0, end: 10, intensity: 0.2 },
			{ start: 10, end: 20, intensity: 1 },
			{ start: 20, end: 30, intensity: 0.4 },
		]);
	});

	test("without a nearby cut, a change snaps to the nearest downbeat", () => {
		// 90 BPM bars are 2.667 s long; 15.5 s is nearest the 16 s downbeat.
		const aligned = alignSoundtrackPlan(
			plan([
				{ start: 0, end: 15.5, intensity: 0.3 },
				{ start: 15.5, end: 30, intensity: 0.9 },
			]),
			{ beats: [], duration: 30, sceneCuts: [] }
		);
		expect(aligned.sections.map((section) => section.start)).toEqual([0, 16]);
	});

	test("a change outside the tolerance stays put and gaps become contiguous", () => {
		const aligned = alignSoundtrackPlan(
			plan([
				{ start: 0, end: 4, intensity: 0.3 },
				{ start: 12.3, end: 18, intensity: 0.9 },
			]),
			{ beats: [], duration: 18, sceneCuts: [], tolerance: 0 }
		);
		expect(aligned.sections).toEqual([
			{ start: 0, end: 12.3, intensity: 0.3 },
			{ start: 12.3, end: 18, intensity: 0.9 },
		]);
	});

	test("unordered, overlapping and too-short sections are merged", () => {
		const aligned = alignSoundtrackPlan(
			plan([
				{ start: 10.1, end: 30, intensity: 1 },
				{ start: 0, end: 10, intensity: 0.2 },
				{ start: 10.2, end: 12, intensity: 0.5 },
				{ start: 29.8, end: 31, intensity: 0.1 },
				{ start: 40, end: 50, intensity: 0.1 },
			]),
			{ beats: [], duration: 30, sceneCuts: [10], tolerance: 0.4 }
		);
		expect(aligned.sections).toEqual([
			{ start: 0, end: 10, intensity: 0.2 },
			{ start: 10, end: 30, intensity: 1 },
		]);
	});

	test("measured beats set the tempo and the result is a valid request", () => {
		const { assets, project } = fixture();
		const aligned = alignSoundtrackPlan(
			plan([
				{ start: 0, end: 12, intensity: 0.2 },
				{ start: 12, end: 30, intensity: 0.8 },
			]),
			{
				beats: beatMarkerTimes(project),
				duration: 30,
				sceneCuts: timelineSceneCuts(project, assets),
			}
		);
		expect(aligned.bpm).toBe(120);
		// Bars are anchored on the first beat (0.5 s), so 12 s moves to 12.5 s.
		expect(aligned.sections[1]?.start).toBe(12.5);
		expect(aligned.downbeatOffset).toBe(0.5);
		const body = soundtrackRequestFromPlan(aligned, 30);
		expect(soundtrackRequestSchema.parse(body)).toMatchObject({
			bpm: 120,
			downbeatOffset: 0.5,
			duration: 30,
			mood: "cinematic",
		});
	});

	test("fractional measured tempo: changes land on the rendered score's bars", () => {
		// Reviewer repro: beats every 60/97.4 s from 0.3 s; sections at 0/20/40.
		const beatSeconds = 60 / 97.4;
		const beats = Array.from(
			{ length: 96 },
			(_, index) => Math.round((0.3 + index * beatSeconds) * 1000) / 1000
		);
		const aligned = alignSoundtrackPlan(
			plan([
				{ start: 0, end: 20, intensity: 0.3 },
				{ start: 20, end: 40, intensity: 0.9 },
				{ start: 40, end: 60, intensity: 0.5 },
			]),
			{ beats, duration: 60, sceneCuts: [] }
		);
		expect(aligned.bpm).toBe(97.4);
		expect(aligned.downbeatOffset).toBe(0.3);
		const request = soundtrackRequestSchema.parse(
			soundtrackRequestFromPlan(aligned, 60)
		);
		expect(request.bpm).toBe(97.4);
		const bar = soundtrackBarSeconds(request.bpm);
		for (const section of aligned.sections.slice(1)) {
			const barsFromAnchor =
				(section.start - (request.downbeatOffset ?? 0)) / bar;
			// Within rounding (1 ms) of a whole bar of the rendered score.
			expect(
				Math.abs(barsFromAnchor - Math.round(barsFromAnchor)) * bar
			).toBeLessThan(0.001);
		}
	});

	test("rejects a timeline too short to score or a plan with no sections inside it", () => {
		expect(() =>
			alignSoundtrackPlan(plan([{ start: 0, end: 1, intensity: 1 }]), {
				beats: [],
				duration: 0.2,
				sceneCuts: [],
			})
		).toThrow("half a second");
		expect(() =>
			alignSoundtrackPlan(plan([{ start: 40, end: 50, intensity: 1 }]), {
				beats: [],
				duration: 30,
				sceneCuts: [],
			})
		).toThrow("no sections inside the timeline");
	});

	test("planSoundtrack sends the prompt and aligns the model's plan", async () => {
		const { assets, project } = fixture();
		const prompts: string[] = [];
		const result = await planSoundtrack(
			{
				beats: [],
				sceneCuts: timelineSceneCuts(project, assets),
				summary: soundtrackTimelineSummary(project),
			},
			(request) => {
				prompts.push(request.prompt);
				return Promise.resolve(
					JSON.stringify(
						plan([
							{ start: 0, end: 9.5, intensity: 0.2 },
							{ start: 9.5, end: 20.6, intensity: 1 },
							{ start: 20.6, end: 30, intensity: 0.4 },
						])
					)
				);
			}
		);
		expect(prompts).toHaveLength(1);
		expect(result.sections.map((section) => section.start)).toEqual([
			0, 10, 20,
		]);
	});
});

test("sections are clipped to a shorter soundtrack", () => {
	expect(
		clipSoundtrackSections(
			[
				{ start: 0, end: 10, intensity: 0.2 },
				{ start: 10, end: 20, intensity: 1 },
				{ start: 20, end: 30, intensity: 0.4 },
			],
			20.3
		)
	).toEqual([
		{ start: 0, end: 10, intensity: 0.2 },
		{ start: 10, end: 20, intensity: 1 },
	]);
	expect(
		clipSoundtrackSections([{ start: 0, end: 10, intensity: 0.2 }], 6)
	).toEqual([{ start: 0, end: 6, intensity: 0.2 }]);
});

describe("music description and ranges", () => {
	test("the model may pick layers; unknown names are dropped", () => {
		const plan = parseSoundtrackPlan(
			'{"style":"cinematic","bpm":90,"layers":["Pad","bass","violin","pad"],"sections":[{"start":0,"end":10,"intensity":0.5}]}'
		);
		expect(plan.layers).toEqual(["pad", "bass"]);
		const none = parseSoundtrackPlan(
			'{"style":"cinematic","bpm":90,"layers":["violin"],"sections":[{"start":0,"end":10,"intensity":0.5}]}'
		);
		expect(none.layers).toBeUndefined();
		const aligned = alignSoundtrackPlan(plan, {
			beats: [],
			duration: 10,
			sceneCuts: [],
		});
		expect(soundtrackRequestFromPlan(aligned, 10).layers).toEqual([
			"pad",
			"bass",
		]);
	});

	test("the description reaches the prompt only when given", () => {
		const summary = soundtrackTimelineSummary(newProject("Song"));
		const plain = soundtrackPlanPrompt(summary, [], []);
		expect(plain.prompt).not.toContain("musicDescription");
		const described = soundtrackPlanPrompt(
			summary,
			[],
			[],
			"  dreamy synths  "
		);
		expect(JSON.parse(described.prompt).musicDescription).toBe("dreamy synths");
		expect(described.system).toContain("musicDescription");
	});

	test("a range shifts cuts, beats and markers so it starts at 0", () => {
		const video = {
			createdAt: "",
			duration: 10,
			hasAudio: false,
			height: 360,
			id: crypto.randomUUID(),
			kind: "video" as const,
			name: "v",
			width: 640,
		};
		const project = {
			...newProject("Range"),
			markers: [
				{
					color: "blue" as const,
					id: crypto.randomUUID(),
					label: "Beat 1",
					time: 6,
				},
				{
					color: "blue" as const,
					id: crypto.randomUUID(),
					label: "Drop",
					time: 12,
				},
				{
					color: "blue" as const,
					id: crypto.randomUUID(),
					label: "Late",
					time: 29,
				},
			],
			segments: [
				newSegment(video, 0, 0),
				newSegment(video, 10, 0),
				newSegment(video, 20, 0),
			],
		};
		const input = soundtrackPlanInput(
			project,
			[video],
			{ end: 25, start: 5 },
			"x"
		);
		expect(input.summary.duration).toBe(20);
		expect(input.sceneCuts).toEqual([5, 15]);
		expect(input.beats).toEqual([1]);
		expect(input.summary.markers).toEqual([{ label: "Drop", time: 7 }]);
		expect(input.description).toBe("x");
		expect(() =>
			soundtrackPlanInput(project, [video], { end: 5.2, start: 5 })
		).toThrow("half a second");
	});
});
