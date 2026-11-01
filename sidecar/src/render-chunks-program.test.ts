import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import type { Project, Segment } from "../../shared/project.ts";
import * as projectModule from "../../shared/project.ts";
import { buildRender, buildRenderProgram } from "./render.ts";
import {
	AUDIO_GROUP_CLIPS,
	audioGroupFileName,
	CHUNK_AUDIO_FILE,
	CHUNK_LIST_FILE,
	MAX_ARG_BYTES,
	runRenderProgram,
	setRenderArgvLimits,
} from "./render-chunks.ts";
import { clip, mediaPath, SOURCE, timeline } from "./render-chunks-fixture.ts";

// Step and group counts below are the Linux and macOS ones;
// `render-program.test.ts` covers the smaller Windows limits.
beforeAll(() => setRenderArgvLimits("linux"));
afterAll(() => setRenderArgvLimits());

describe("buildRenderProgram", () => {
	test("short timelines are one step equal to buildRender", () => {
		const project = timeline(10, 1);
		const program = buildRenderProgram(
			project,
			[SOURCE],
			mediaPath,
			undefined,
			[],
			{
				output: "export.mp4",
			}
		);
		expect(program.chunks).toBeUndefined();
		expect(program.files).toEqual([]);
		expect(program.steps).toEqual([
			{
				args: buildRender(project, [SOURCE], mediaPath),
				kind: "single",
				output: "export.mp4",
			},
		]);
	});

	test("long timelines render chunks, one audio pass and a final join", () => {
		const project = timeline(200, 1);
		const program = buildRenderProgram(
			project,
			[SOURCE],
			mediaPath,
			"captions.ass",
			[],
			{
				output: "export.mp4",
			}
		);
		expect(program.steps.map((step) => step.kind)).toEqual([
			"chunk",
			"chunk",
			"chunk",
			"audio",
			"audio",
			"audio-mix",
			"final",
		]);
		expect(program.steps.map((step) => step.output)).toEqual([
			"chunk-0000.nut",
			"chunk-0001.nut",
			"chunk-0002.nut",
			audioGroupFileName(0),
			audioGroupFileName(1),
			CHUNK_AUDIO_FILE,
			"export.mp4",
		]);
		expect(program.files.map((file) => file.name)).toEqual([
			CHUNK_LIST_FILE,
			"chunk-0000.graph",
			"chunk-0001.graph",
			"chunk-0002.graph",
			"audio-group-0000.graph",
			"audio-group-0001.graph",
			"audio-mix.graph",
			"final.graph",
		]);
		expect(program.files[0]?.content).toBe(
			"ffconcat version 1.0\nfile chunk-0000.nut\nfile chunk-0001.nut\nfile chunk-0002.nut\n"
		);
		const graphOf = (index: number) => {
			const args = program.steps[index]?.args ?? [];
			expect(args).not.toContain("-filter_complex");
			const name = args[args.indexOf("-filter_complex_script") + 1];
			return program.files.find((file) => file.name === name)?.content ?? "";
		};
		expect(graphOf(0)).toContain("subtitles=filename=captions.ass");
		// Sub-mixes sum 100 clips each on a clock from their first clip,
		// unlimited, into float WAVs.
		const group = program.steps[4]?.args ?? [];
		expect(group.filter((arg) => arg === "-i")).toHaveLength(100);
		expect(group).toContain("pcm_f32le");
		expect(graphOf(4)).toContain("aresample=48000,adelay=0S:all=1[a0]");
		expect(graphOf(4)).toContain("amix=inputs=100:normalize=0[groupMix]");
		expect(graphOf(4)).not.toContain("alimiter");
		const mix = program.steps[5]?.args ?? [];
		expect(mix.filter((arg) => arg === "-i")).toHaveLength(2);
		expect(graphOf(5)).toBe(
			"[0:a]adelay=0S:all=1[group0];[1:a]adelay=4800000S:all=1[group1];[group0][group1]amix=inputs=2:normalize=0,alimiter=limit=0.95:level=0:latency=1[mix];[mix]apad=whole_dur=200[exportAudio]"
		);
		const final = program.steps[6]?.args ?? [];
		expect(final.slice(final.indexOf("-f"), final.indexOf("-f") + 4)).toEqual([
			"-f",
			"concat",
			"-i",
			CHUNK_LIST_FILE,
		]);
		expect(final).toContain(CHUNK_AUDIO_FILE);
		expect(graphOf(6)).toBe(
			"[0:v]setpts=N*1/(30*TB)[joined];[1:a]anull[joinedAudio]"
		);
		expect(final).toContain("libx264");
		expect(final).toContain("aac");
		expect(final.slice(final.indexOf("-t"), final.indexOf("-t") + 2)).toEqual([
			"-t",
			"200",
		]);
	});

	test("a range export joins without seeking again", () => {
		const project = timeline(200, 1);
		const program = buildRenderProgram(
			project,
			[SOURCE],
			mediaPath,
			undefined,
			[],
			{
				output: "export.mp4",
				range: { end: 150, start: 20 },
			}
		);
		expect(program.chunks?.[0]?.startFrame).toBe(600);
		const audio =
			program.steps.find((step) => step.kind === "audio-mix")?.args ?? [];
		// The output-side seek follows the last input.
		const seek = audio.lastIndexOf("-ss");
		expect(audio.slice(seek, seek + 2)).toEqual(["-ss", "20"]);
		const final = program.steps.at(-1)?.args ?? [];
		expect(final).not.toContain("-ss");
		expect(final.slice(final.indexOf("-t"), final.indexOf("-t") + 2)).toEqual([
			"-t",
			"130",
		]);
	});

	test("ducking clips are summed apart and ducked against the rest", () => {
		const project = timeline(200, 1);
		project.segments = project.segments.map((segment, index) =>
			index % 2 ? { ...segment, duckUnderVoice: true } : segment
		);
		const program = buildRenderProgram(
			project,
			[SOURCE],
			mediaPath,
			undefined,
			[],
			{ output: "export.mp4" }
		);
		const graph =
			program.files.find((file) => file.name === "audio-mix.graph")?.content ??
			"";
		expect(graph).toContain(
			"[group0]amix=inputs=1:normalize=0,apad=whole_dur=201[sidechainMix];[sidechainMix]asplit=2[sidechainMain][sidechain0];[group1]apad=whole_dur=201[duckHeld0];[sidechain0]dcshift=shift=0.000001,asplit=2[duck0KeyA][duck0KeyB]"
		);
		expect(graph).toContain(
			"[duck0Wet][duck0Voiced]sidechaingate=threshold=1:ratio=2:range=0:knee=1:attack=36.409569:release=455.119613:detection=peak,volume=-0.645187[duck0Cut];[duck0Dry][duck0Cut]amix=inputs=2:normalize=0[ducked0]"
		);
		expect(graph).toContain(
			"[sidechainMain][ducked0]amix=inputs=2:normalize=0,alimiter"
		);
	});

	test("ducking clips with different settings are gated apart", () => {
		const project = timeline(200, 1);
		project.segments = project.segments.map((segment, index) => {
			if (index % 2 === 0) {
				return segment;
			}
			return index % 4 === 1
				? {
						...segment,
						duckUnderVoice: true,
						ducking: { amountDb: 15, attackMs: 60, releaseMs: 700 },
					}
				: { ...segment, duckUnderVoice: true };
		});
		const program = buildRenderProgram(
			project,
			[SOURCE],
			mediaPath,
			undefined,
			[],
			{ output: "export.mp4" }
		);
		const graph =
			program.files.find((file) => file.name === "audio-mix.graph")?.content ??
			"";
		expect(graph).toContain(
			"attack=36.409569:release=455.119613:detection=peak,volume=-0.645187"
		);
		expect(graph).toContain(
			"attack=109.228707:release=1274.334917:detection=peak,volume=-0.822172"
		);
		expect(graph).toContain(
			"[sidechainMain][ducked0][ducked1]amix=inputs=3:normalize=0,alimiter"
		);
	});

	test("a chunked export validates the project once, not once per window", () => {
		const validate = spyOn(projectModule, "validateProject");
		try {
			const program = buildRenderProgram(
				timeline(600, 0.5),
				[SOURCE],
				mediaPath,
				undefined,
				[],
				{ chunk: true, chunkSeconds: 30, output: "export.mp4" }
			);
			expect(
				program.steps.filter((step) => step.kind === "chunk").length
			).toBeGreaterThan(5);
			expect(validate).toHaveBeenCalledTimes(1);
		} finally {
			validate.mockRestore();
		}
	});

	test("every step of a 5000-clip export fits one argv string", () => {
		const project = timeline(5000, 0.5);
		const program = buildRenderProgram(
			project,
			[SOURCE],
			mediaPath,
			"captions.ass",
			[],
			{ output: "export.mp4" }
		);
		expect(program.steps.length).toBeGreaterThan(50);
		for (const step of program.steps) {
			const longest = Math.max(
				...step.args.map((arg) => Buffer.byteLength(arg))
			);
			expect(longest).toBeLessThan(MAX_ARG_BYTES);
			// No step opens more than a window's or a sub-mix's inputs.
			expect(
				step.args.filter((arg) => arg === "-i").length
			).toBeLessThanOrEqual(AUDIO_GROUP_CLIPS + 160);
		}
		const audio = program.steps.filter((step) => step.kind === "audio");
		expect(audio).toHaveLength(5000 / AUDIO_GROUP_CLIPS);
	});

	test("a one-pass graph too long for argv moves to a script file", () => {
		const project = timeline(1500, 0.5);
		const program = buildRenderProgram(
			project,
			[SOURCE],
			mediaPath,
			undefined,
			[],
			{ audioOnly: true, output: "export.wav" }
		);
		expect(program.steps.map((step) => step.kind)).toEqual(["single"]);
		const args = program.steps[0]?.args ?? [];
		const reference = buildRender(project, [SOURCE], mediaPath);
		expect(reference).toContain("-filter_complex");
		expect(args).toContain("-filter_complex_script");
		expect(program.files.map((file) => file.name)).toEqual(["single.graph"]);
		expect(Buffer.byteLength(program.files[0]?.content ?? "")).toBeGreaterThan(
			MAX_ARG_BYTES
		);
		expect(Math.max(...args.map((arg) => Buffer.byteLength(arg)))).toBeLessThan(
			MAX_ARG_BYTES
		);
	});

	test("silent timelines skip the audio pass", () => {
		const project = timeline(200, 1);
		project.segments = project.segments.map((segment) => ({
			...segment,
			volume: 0,
		}));
		const program = buildRenderProgram(
			project,
			[SOURCE],
			mediaPath,
			undefined,
			[],
			{
				output: "export.mp4",
			}
		);
		const kinds = program.steps.map((step) => step.kind);
		expect(kinds).not.toContain("audio");
		expect(kinds).not.toContain("audio-mix");
		expect(program.files.find((file) => file.name === "final.graph")).toEqual({
			content: "[0:v]setpts=N*1/(30*TB)[joined]",
			name: "final.graph",
		});
	});

	test("chunks hide, mute and duck the same clips as one pass", () => {
		const id = (index: number) =>
			`20000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
		const extra: Segment[] = [
			{ ...clip(0, 3, 2, 1), id: id(1) },
			{ ...clip(0, 70, 2, 2), id: id(2) },
			{ ...clip(0, 130, 2, 3), duckUnderVoice: true, id: id(3) },
		];
		const project: Project = {
			...timeline(200, 1, extra),
			trackSettings: [
				{
					hidden: true,
					locked: false,
					muted: false,
					name: "Hidden",
					solo: false,
					track: 1,
				},
				{ locked: false, muted: true, name: "Muted", solo: false, track: 2 },
			],
		};
		const edits: Record<number, Partial<Segment>> = {
			5: { hidden: true },
			20: { muted: true },
			40: { sourceOut: 20, speed: 20 },
			60: { muted: false, sourceOut: 20, speed: 20 },
			80: { volume: 0 },
			100: {
				keyframes: [{ id: id(9), property: "volume", time: 0.5, value: 0.5 }],
				volume: 0,
			},
			150: { hidden: true, muted: false },
		};
		project.segments = project.segments.map((segment, index) => ({
			...segment,
			...edits[index],
		}));
		/** Clip path per input, so a graph's `[n:a]`/`[n:v]` name their clips. */
		const clipPath = (_asset: string, clipId?: string) =>
			`/media/${clipId}.mp4`;
		const uses = (
			args: readonly string[],
			graph: string,
			stream: "a" | "v"
		) => {
			const used = new Set<string>();
			const inputs = args.flatMap((arg, index) =>
				args[index - 1] === "-i" ? [arg] : []
			);
			for (const [index, path] of inputs.entries()) {
				const clipId = /\/media\/(.+)\.mp4$/.exec(path)?.[1];
				if (clipId && graph.includes(`[${index}:${stream}]`)) {
					used.add(clipId);
				}
			}
			return used;
		};
		const single = buildRender(project, [SOURCE], clipPath);
		const singleGraph = single[single.indexOf("-filter_complex") + 1] ?? "";
		const program = buildRenderProgram(
			project,
			[SOURCE],
			clipPath,
			undefined,
			[],
			{
				output: "export.mp4",
			}
		);
		const graphOf = (step: (typeof program.steps)[number]) => {
			const script = step.args[step.args.indexOf("-filter_complex_script") + 1];
			return program.files.find((file) => file.name === script)?.content ?? "";
		};
		const chunked = { a: new Set<string>(), v: new Set<string>() };
		for (const step of program.steps) {
			const stream =
				step.kind === "chunk" ? "v" : step.kind === "audio" ? "a" : null;
			if (stream) {
				for (const used of uses(step.args, graphOf(step), stream)) {
					chunked[stream].add(used);
				}
			}
		}
		const heard = uses(single, singleGraph, "a");
		const drawn = uses(single, singleGraph, "v");
		expect([...chunked.a].sort()).toEqual([...heard].sort());
		expect([...chunked.v].sort()).toEqual([...drawn].sort());
		const segmentAt = (index: number) => project.segments[index]?.id ?? "";
		for (const silent of [5, 20, 40, 80, 150]) {
			expect(heard.has(segmentAt(silent))).toBe(false);
		}
		for (const audible of [60, 100, 0]) {
			expect(heard.has(segmentAt(audible))).toBe(true);
		}
		expect(heard.has(id(1))).toBe(false);
		expect(heard.has(id(2))).toBe(false);
		expect(heard.has(id(3))).toBe(true);
		expect(drawn.has(segmentAt(5))).toBe(false);
		expect(drawn.has(segmentAt(150))).toBe(false);
		expect(drawn.has(id(1))).toBe(false);
		expect(drawn.has(id(2))).toBe(true);
		const ducked = program.steps.filter(
			(step) =>
				step.kind === "audio" && step.args.includes(`/media/${id(3)}.mp4`)
		);
		expect(ducked).toHaveLength(1);
		expect(ducked[0]?.args.filter((arg) => arg.startsWith("/media/"))).toEqual([
			`/media/${id(3)}.mp4`,
		]);
	});

	test("GIF and alpha exports stay one pass even when forced", () => {
		const project = timeline(200, 1);
		const gif = buildRenderProgram(
			project,
			[SOURCE],
			mediaPath,
			undefined,
			[],
			{
				chunk: true,
				output: "export.gif",
				overrides: { container: "gif" },
			}
		);
		expect(gif.steps.map((step) => step.kind)).toEqual(["single"]);
	});

	test("runRenderProgram writes files, then runs every step in order", async () => {
		const project = timeline(200, 1);
		const program = buildRenderProgram(
			project,
			[SOURCE],
			mediaPath,
			undefined,
			[],
			{
				output: "export.mp4",
			}
		);
		const events: string[] = [];
		const progress: number[] = [];
		await runRenderProgram(program, {
			check: () => events.push("check"),
			progress: (fraction) => progress.push(fraction),
			run: async (step) => {
				events.push(step.output);
				await Promise.resolve();
			},
			write: async (name) => {
				events.push(`write ${name}`);
				await Promise.resolve();
			},
		});
		expect(events.slice(0, program.files.length)).toEqual(
			program.files.map((file) => `write ${file.name}`)
		);
		expect(
			events.slice(program.files.length).filter((event) => event !== "check")
		).toEqual(program.steps.map((step) => step.output));
		expect(progress.at(-1)).toBe(1);
	});

	test("a failed step stops the program", async () => {
		const project = timeline(200, 1);
		const program = buildRenderProgram(
			project,
			[SOURCE],
			mediaPath,
			undefined,
			[],
			{
				output: "export.mp4",
			}
		);
		const ran: string[] = [];
		await expect(
			runRenderProgram(program, {
				run: async (step) => {
					ran.push(step.output);
					await Promise.resolve();
					if (ran.length === 2) {
						throw new Error("encode failed");
					}
				},
				write: async () => {
					await Promise.resolve();
				},
			})
		).rejects.toThrow("encode failed");
		expect(ran).toHaveLength(2);
	});
});
