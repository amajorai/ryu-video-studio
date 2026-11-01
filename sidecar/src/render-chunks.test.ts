import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Asset } from "../../shared/project.ts";
import { buildRender, offsetSourceTiming } from "./render.ts";
import {
	CHUNK_MIN_SEGMENTS,
	chunkBoundaries,
	chunkEncodeArgs,
	concatList,
	ffmpegSpanFrame,
	intermediatePixelFormat,
	planRenderChunks,
	restampFilter,
	segmentInWindow,
	setRenderArgvLimits,
	shouldChunkRender,
	spanFrames,
	windowedProject,
	windowSeek,
	windowSkip,
} from "./render-chunks.ts";
import {
	clip,
	LONG,
	LONG_24,
	mediaPath,
	planOf,
	SOURCE,
	timeline,
} from "./render-chunks-fixture.ts";

// Window sizes below are the Linux and macOS ones; `render-program.test.ts`
// covers the smaller Windows limits.
beforeAll(() => setRenderArgvLimits("linux"));
afterAll(() => setRenderArgvLimits());

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
