import { describe, expect, spyOn, test } from "bun:test";
import * as projectModule from "../../shared/project.ts";
import {
	type Asset,
	newProject,
	newSegment,
	type Project,
	type Segment,
} from "../../shared/project.ts";
import { resolveRenderPlan } from "../../shared/render-options.ts";
import {
	buildRender,
	buildRenderProgram,
	offsetSourceTiming,
} from "./render.ts";
import {
	AUDIO_GROUP_CLIPS,
	audioGroupFileName,
	CHUNK_AUDIO_FILE,
	CHUNK_LIST_FILE,
	CHUNK_MIN_SEGMENTS,
	chunkBoundaries,
	chunkEncodeArgs,
	concatList,
	ffmpegSpanFrame,
	intermediatePixelFormat,
	MAX_ARG_BYTES,
	planRenderChunks,
	restampFilter,
	runRenderProgram,
	segmentInWindow,
	shouldChunkRender,
	spanFrames,
	windowedProject,
	windowSeek,
	windowSkip,
} from "./render-chunks.ts";

function video(id: string, duration = 4000): Asset {
	return {
		createdAt: new Date(0).toISOString(),
		duration,
		hasAudio: true,
		height: 360,
		id,
		kind: "video",
		name: `${id}.mp4`,
		width: 640,
	};
}

const SOURCE = video("00000000-0000-4000-8000-000000000001");
const LONG = video("00000000-0000-4000-8000-000000000002");
/** The long source with a probed 24 fps grid, in a 30 fps project. */
const LONG_24 = { ...LONG, frameRate: 24 };

function clip(index: number, start: number, length: number, track = 0) {
	return {
		...newSegment(SOURCE, start, track),
		id: `10000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
		sourceIn: 0,
		sourceOut: length,
	};
}

/** `count` back-to-back clips of `length` seconds on track 0. */
function timeline(count: number, length: number, extra: Segment[] = []) {
	const project: Project = {
		...newProject("Chunk test"),
		height: 180,
		segments: [
			...Array.from({ length: count }, (_, index) =>
				clip(index, Number((index * length).toFixed(6)), length)
			),
			...extra,
		],
		width: 320,
	};
	return project;
}

const mediaPath = (id: string) => `/media/${id}.mp4`;

function planOf(project: Project, options = {}) {
	return resolveRenderPlan(project, options, {
		timelineDuration: Math.max(
			...project.segments.map((s) => s.start + s.sourceOut - s.sourceIn)
		),
	});
}

describe("shouldChunkRender", () => {
	test("chunks video exports past the clip or length threshold", () => {
		const few = timeline(CHUNK_MIN_SEGMENTS, 1);
		const many = timeline(CHUNK_MIN_SEGMENTS + 1, 1);
		const video = { alpha: false, duration: 60, kind: "video" as const };
		expect(shouldChunkRender(few, video)).toBe(false);
		expect(shouldChunkRender(many, video)).toBe(true);
		expect(shouldChunkRender(few, { ...video, duration: 1801 })).toBe(true);
	});

	test("never chunks GIFs, sequences, audio files or alpha exports", () => {
		const many = timeline(CHUNK_MIN_SEGMENTS + 1, 1);
		for (const kind of ["gif", "sequence", "audio"] as const) {
			expect(
				shouldChunkRender(many, { alpha: false, duration: 3600, kind })
			).toBe(false);
		}
		expect(
			shouldChunkRender(many, { alpha: true, duration: 3600, kind: "video" })
		).toBe(false);
	});
});

describe("planRenderChunks", () => {
	test("a 5000-clip project plans contiguous, cut-aligned windows quickly", () => {
		const project = timeline(5000, 0.5);
		const started = performance.now();
		const plan = planRenderChunks(project, [SOURCE], {
			duration: 2500,
			start: 0,
		});
		const elapsed = performance.now() - started;
		expect(elapsed).toBeLessThan(1000);
		expect(plan.startFrame).toBe(0);
		expect(plan.totalFrames).toBe(75_000);
		expect(plan.chunks.length).toBeGreaterThan(30);
		let next = 0;
		const covered = new Set<string>();
		for (const chunk of plan.chunks) {
			expect(chunk.startFrame).toBe(next);
			// Every edge sits on a cut: 0.5 s clips cut every 15 frames.
			expect(chunk.startFrame % 15).toBe(0);
			expect(chunk.spanningIds).toEqual([]);
			expect(chunk.segmentIds.length).toBeLessThanOrEqual(150 + 2);
			for (const id of chunk.segmentIds) {
				covered.add(id);
			}
			next = chunk.startFrame + chunk.frames;
		}
		expect(next).toBe(75_000);
		expect(covered.size).toBe(5000);
		const again = planRenderChunks(project, [SOURCE], {
			duration: 2500,
			start: 0,
		});
		expect(again).toEqual(plan);
	});

	test("windows are about 60 s and the last absorbs a short remainder", () => {
		const project = timeline(200, 1);
		const { chunks } = planRenderChunks(project, [SOURCE], {
			duration: 200,
			start: 0,
		});
		expect(chunks.map((chunk) => chunk.start)).toEqual([0, 60, 120]);
		expect(chunks.at(-1)?.end).toBe(200);
		expect(chunks.at(-1)?.frames).toBe(80 * 30);
	});

	test("edges move to the nearby cut that the fewest clips cross", () => {
		// Track 1 holds long clips with one cut at 50 s; track 0 cuts every 2 s.
		const project = timeline(60, 2, [
			{ ...clip(900, 0, 50, 1), assetId: LONG.id },
			{ ...clip(901, 50, 70, 1), assetId: LONG.id },
		]);
		const { chunks } = planRenderChunks(project, [SOURCE, LONG], {
			duration: 120,
			start: 0,
		});
		expect(chunks[1]?.start).toBe(50);
		expect(chunks[1]?.spanningIds).toEqual([]);
	});

	test("dense timelines get shorter windows instead of larger graphs", () => {
		const project = timeline(1000, 0.1);
		const { chunks } = planRenderChunks(project, [SOURCE], {
			duration: 100,
			start: 0,
		});
		for (const chunk of chunks) {
			// 150 clips start inside; one ends on each edge.
			expect(chunk.segmentIds.length).toBeLessThanOrEqual(152);
		}
		expect(chunks.length).toBeGreaterThanOrEqual(7);
	});

	test("a range starts on the frame the one-pass output seek keeps", () => {
		const project = timeline(200, 1);
		const plan = planRenderChunks(project, [SOURCE], {
			duration: 100,
			start: 10.01,
		});
		// FFmpeg rescales `-ss 10.01` to the 1/30 timebase rounding to
		// nearest: tick 300.3 → 300, so frame 300 is the first one kept.
		expect(plan.startFrame).toBe(300);
		expect(spanFrames({ duration: 100, start: 10.01 }, 30)).toEqual({
			endFrame: 3300,
			startFrame: 300,
		});
		expect(plan.chunks[0]?.startFrame).toBe(300);
	});

	test("span frames follow FFmpeg's half-away-from-zero rescale", () => {
		expect(ffmpegSpanFrame(1.0166, 30)).toBe(30);
		expect(ffmpegSpanFrame(1.0167, 30)).toBe(31);
		expect(ffmpegSpanFrame(1.05, 30)).toBe(32);
		expect(ffmpegSpanFrame(1.02, 30)).toBe(31);
		// 29.97 is a 1001/30000 timebase.
		expect(ffmpegSpanFrame(1.001, 29.97)).toBe(30);
		expect(ffmpegSpanFrame(1.0177, 29.97)).toBe(31);
		// The frame count is `-t` on the same rule, from the first frame.
		expect(spanFrames({ duration: 6.01, start: 1.01 }, 30)).toEqual({
			endFrame: 210,
			startFrame: 30,
		});
		expect(spanFrames({ duration: 6.02, start: 0 }, 30)).toEqual({
			endFrame: 181,
			startFrame: 0,
		});
	});

	test("clips that cross an edge are listed in both windows", () => {
		const long = { ...clip(900, 0, 200, 1), assetId: LONG.id };
		const project = timeline(200, 1, [long]);
		const { chunks } = planRenderChunks(project, [SOURCE, LONG], {
			duration: 200,
			start: 0,
		});
		for (const chunk of chunks) {
			expect(chunk.segmentIds).toContain(long.id);
		}
		expect(chunks[1]?.spanningIds).toEqual([long.id]);
	});

	test("hidden clips and audio files never constrain the windows", () => {
		const audio: Asset = {
			...SOURCE,
			id: "00000000-0000-4000-8000-0000000000aa",
			kind: "audio",
		};
		const music = { ...clip(902, 0, 200, 2), assetId: audio.id };
		const project = timeline(200, 1, [music]);
		const { chunks } = planRenderChunks(project, [SOURCE, audio], {
			duration: 200,
			start: 0,
		});
		expect(chunks.flatMap((chunk) => chunk.segmentIds)).not.toContain(music.id);
	});
});

describe("chunkBoundaries", () => {
	test("falls back to the target frame without nearby cuts", () => {
		expect(chunkBoundaries([], 0, 300, 100)).toEqual([0, 100, 200, 300]);
		expect(chunkBoundaries([], 0, 250, 100)).toEqual([0, 100, 250]);
	});
});

describe("window helpers", () => {
	const window = { frames: 1800, startFrame: 1800 };

	test("segmentInWindow keeps clips touching either edge", () => {
		expect(segmentInWindow(clip(1, 59, 1), window, 30)).toBe(true);
		expect(segmentInWindow(clip(2, 120, 1), window, 30)).toBe(true);
		expect(segmentInWindow(clip(3, 50, 5), window, 30)).toBe(false);
		expect(segmentInWindow(clip(4, 121, 1), window, 30)).toBe(false);
	});

	test("windowSkip skips all but one second of preroll", () => {
		expect(windowSkip(clip(1, 0, 100), window, 30)).toBe(59);
		expect(windowSkip({ ...clip(1, 0, 100), speed: 2 }, window, 30)).toBe(59.5);
		expect(windowSkip(clip(2, 59.5, 10), window, 30)).toBe(0);
		expect(windowSkip(clip(3, 70, 10), window, 30)).toBe(0);
	});

	test("windowedProject keeps only overlays active in the window", () => {
		const project = timeline(10, 1);
		const graphic = (id: string, start: number, end: number) => ({
			animation: "none" as const,
			end,
			entryDuration: 0.35,
			fill: "#ffffff",
			height: 0.1,
			id,
			opacity: 1,
			shape: "rectangle" as const,
			start,
			stroke: "#ffffff",
			strokeWidth: 0,
			width: 0.1,
			x: 0,
			y: 0,
		});
		const scoped = windowedProject(
			{
				...project,
				graphics: [
					graphic("20000000-0000-4000-8000-000000000001", 0, 10),
					graphic("20000000-0000-4000-8000-000000000002", 30, 90),
					graphic("20000000-0000-4000-8000-000000000003", 119.99, 200),
				],
			},
			window
		);
		expect(scoped.graphics.map((item) => item.start)).toEqual([30, 119.99]);
		expect(scoped.segments).toBe(project.segments);
		expect(scoped.adjustmentLayers).toBeUndefined();
	});

	test("intermediates keep the final pixel format losslessly", () => {
		expect(intermediatePixelFormat({ videoCodec: "h264" })).toBe("yuv420p");
		expect(intermediatePixelFormat({ videoCodec: "prores" })).toBe(
			"yuv422p10le"
		);
		expect(chunkEncodeArgs({ videoCodec: "h264" }, "v", 90)).toEqual([
			"-map",
			"[v]",
			"-an",
			"-frames:v",
			"90",
			"-c:v",
			"libx264",
			"-preset",
			"ultrafast",
			"-qp",
			"0",
			"-pix_fmt",
			"yuv420p",
			"-threads",
			"2",
			"-f",
			"nut",
		]);
		expect(chunkEncodeArgs({ videoCodec: "h265-10bit" }, "v", 1)).toContain(
			"ffv1"
		);
	});

	test("concat lists accept only plain file names", () => {
		expect(concatList(["chunk-0000.nut", "chunk-0001.nut"])).toBe(
			"ffconcat version 1.0\nfile chunk-0000.nut\nfile chunk-0001.nut\n"
		);
		expect(() => concatList(["../escape.nut"])).toThrow("plain file name");
		expect(() => concatList(["a'b.nut"])).toThrow("plain file name");
	});

	test("the join restamps frames on the exact project grid", () => {
		expect(restampFilter(30)).toBe("setpts=N*1/(30*TB)");
		expect(restampFilter(29.97)).toBe("setpts=N*1001/(30000*TB)");
	});
});

describe("window renders", () => {
	const window = { frames: 1800, startFrame: 1800 };

	test("a window render draws only its clips on the timeline clock", () => {
		const project = timeline(200, 1);
		const args = buildRender(
			project,
			[SOURCE],
			mediaPath,
			undefined,
			[],
			undefined,
			{
				plan: planOf(project),
				window,
			}
		);
		const inputs = args.filter((arg) => arg === "-i").length;
		// The canvas plus clips 59..120 (both edges touch the window).
		expect(inputs).toBe(1 + 62);
		const graph = args[args.indexOf("-filter_complex") + 1] ?? "";
		expect(graph).toContain(",fps=30,setpts=PTS+1800[base]");
		expect(graph).toContain("setpts=PTS-STARTPTS[chunkVideo]");
		expect(graph).not.toContain("amix");
		expect(
			args.slice(args.indexOf("-frames:v"), args.indexOf("-frames:v") + 2)
		).toEqual(["-frames:v", "1800"]);
		expect(args).toContain("-an");
		expect(args).not.toContain("-c:a");
		// The canvas is generated for the window only.
		expect(args.find((arg) => arg.startsWith("color="))).toContain(
			":d=60.033333333"
		);
	});

	test("a clip crossing the window start seeks on its own frame grid", () => {
		const long = { ...clip(900, 10, 200, 1), assetId: LONG.id };
		const project = timeline(200, 1, [long]);
		const args = buildRender(
			project,
			[SOURCE, LONG_24],
			mediaPath,
			undefined,
			[],
			undefined,
			{
				plan: planOf(project),
				window,
			}
		);
		const path = args.indexOf(`/media/${LONG.id}.mp4`);
		// Skip to source frame 1176 (49 s at 24 fps) by seeking half a frame
		// before it, then decode to one second past the window end.
		expect(args.slice(path - 5, path)).toEqual([
			"-ss",
			"48.979167",
			"-t",
			"62",
			"-i",
		]);
		const graph = args[args.indexOf("-filter_complex") + 1] ?? "";
		expect(graph).toContain(
			"setpts=(PTS-STARTPTS+round(1176*1/(24*TB))-round(0*1/(24*TB)))/1,"
		);
	});

	test("a clip without a probed frame rate decodes from its start", () => {
		const long = { ...clip(900, 10, 200, 1), assetId: LONG.id };
		const project = timeline(200, 1, [long]);
		const args = buildRender(
			project,
			[SOURCE, LONG],
			mediaPath,
			undefined,
			[],
			undefined,
			{
				plan: planOf(project),
				window,
			}
		);
		const path = args.indexOf(`/media/${LONG.id}.mp4`);
		expect(args.slice(path - 5, path)).toEqual(["-ss", "0", "-t", "111", "-i"]);
		const graph = args[args.indexOf("-filter_complex") + 1] ?? "";
		expect(graph).toContain("setpts=(PTS-STARTPTS)/1,");
	});

	test("windowSeek keeps the one-pass phase of off-grid clips", () => {
		const long = { ...clip(900, 10.1, 200, 1), assetId: LONG.id };
		// sourceIn 0.1 s is 2.4 frames at 24 fps: the one-pass render's first
		// frame is source frame 3, so the skip counts from there.
		const seek = windowSeek({ ...long, sourceIn: 0.1 }, LONG_24, window, 30);
		// The target is 48.9 s into the clip: source 49.0 s, frame 1176.
		expect(seek).toEqual({
			seek: Number((1175.5 / 24).toFixed(6)),
			skip: 1173 / 24,
			ticks: "round(1176*1/(24*TB))-round(3*1/(24*TB))",
		});
		// The skip never passes the preroll target.
		expect(seek?.skip).toBeLessThanOrEqual(windowSkip(long, window, 30));
		// Speed scales the clip seconds the skipped source frames take.
		const fast = windowSeek({ ...long, speed: 1.5 }, LONG_24, window, 30);
		expect(fast?.skip).toBeCloseTo(((fast?.seek ?? 0) + 0.5 / 24) / 1.5, 9);
		// NTSC sources stamp frames in 1001/30000 steps.
		expect(
			windowSeek(long, { frameRate: 29.97, kind: "video" }, window, 30)?.ticks
		).toBe("round(1465*1001/(30000*TB))-round(0*1001/(30000*TB))");
	});

	test("windowSeek refuses grids it cannot trust", () => {
		const long = { ...clip(900, 10, 200, 1), assetId: LONG.id };
		// Within rounding of a source frame: which frame comes first is up to
		// FFmpeg's timestamp rounding.
		expect(
			windowSeek({ ...long, sourceIn: 1 / 24 + 0.001 }, LONG_24, window, 30)
		).toBeUndefined();
		// A variable-rate average is no grid.
		expect(
			windowSeek(long, { frameRate: 29.87, kind: "video" }, window, 30)
		).toBeUndefined();
		expect(windowSeek(long, LONG, window, 30)).toBeUndefined();
		expect(
			windowSeek(long, { frameRate: 24, kind: "image" }, window, 30)
		).toBeUndefined();
		// Clips that start inside the preroll are not skipped at all.
		expect(
			windowSeek({ ...long, start: 59.5 }, LONG_24, window, 30)
		).toBeUndefined();
	});

	test("window renders refuse audio and alpha plans", () => {
		const project = timeline(10, 1);
		expect(() =>
			buildRender(project, [SOURCE], mediaPath, undefined, [], undefined, {
				plan: planOf(project, { audioOnly: true }),
				window,
			})
		).toThrow("Only opaque video exports render in chunks");
	});

	test("offsetSourceTiming leaves unexpected chains alone", () => {
		expect(offsetSourceTiming(["[1:v]null[v1]"], 1, 1, "5")).toBeUndefined();
		expect(
			offsetSourceTiming(["[1:v]setpts=(PTS-STARTPTS)/2,fps=30[v1]"], 1, 2, "5")
		).toEqual(["[1:v]setpts=(PTS-STARTPTS+5)/2,fps=30[v1]"]);
		expect(
			offsetSourceTiming(
				["[1:v]setpts=(PTS-STARTPTS)/10,fps=30[v1]"],
				1,
				1,
				"5"
			)
		).toBeUndefined();
	});
});

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
