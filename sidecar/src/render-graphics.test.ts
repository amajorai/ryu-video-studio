import { afterAll, describe, expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type Graphic,
	graphicSchema,
	newProject,
	type Project,
} from "../../shared/project.ts";
import { runMedia } from "./media.ts";
import {
	filtergraphPath,
	graphicsFilters,
	MAX_SHAPE_RENDER_FRAMES,
	opacityCommands,
	prepareShapeSequences,
	SHAPE_SEQUENCE_TIMEOUT_MESSAGE,
	shapeSamples,
	sweepStaleRasterDirectories,
} from "./render-graphics.ts";
import { crc32, encodeRgbaPng } from "./render-graphics-png.ts";

const directory = mkdtempSync(join(tmpdir(), "ryu-render-graphics-test-"));
afterAll(() => rmSync(directory, { force: true, recursive: true }));

function graphic(fields: Partial<Graphic> = {}): Graphic {
	return graphicSchema.parse({
		end: 3,
		fill: "#ff0000",
		height: 0.25,
		id: "00000000-0000-4000-8000-000000000001",
		opacity: 0.8,
		start: 1,
		width: 0.25,
		x: 0.1,
		y: 0.2,
		...fields,
	});
}

function project(graphics: Graphic[]): Project {
	return { ...newProject("Shapes"), graphics, height: 360, width: 640 };
}

describe("legacy drawbox graphics", () => {
	test("a plain rectangle is one drawbox, unchanged", () => {
		expect(graphicsFilters(project([graphic()]), "base")).toEqual({
			filters: [
				"[base]drawbox=x='iw*(0.1)':y='ih*(0.2)':w='iw*0.25':h='ih*0.25':color=0xff0000@0.8:t=fill:enable='between(t,1,3)'[graphic0rect]",
			],
			last: "graphic0rect",
		});
	});

	test("legacy graphics write no rasters", () => {
		const own = mkdtempSync(join(directory, "legacy-"));
		graphicsFilters(
			project([
				graphic({ shape: "ellipse" }),
				graphic({ shape: "line" }),
				graphic({ shape: "triangle" }),
			]),
			"base",
			{ rasterDirectory: own }
		);
		expect(readdirSync(own)).toEqual([]);
	});
});

describe("raster graphics", () => {
	test("a static star is a two-frame movie composited at its box", () => {
		const own = mkdtempSync(join(directory, "star-"));
		const chain = graphicsFilters(
			project([graphic({ shape: "star" })]),
			"base",
			{ rasterDirectory: own }
		);
		const [file] = readdirSync(own);
		expect(file).toMatch(/^shape-[0-9a-f]{32}\.png$/);
		expect(chain.last).toBe("graphic0shape");
		// No canvas follows the composite: the PNG has a frame at the start and
		// at the end of the window and nothing else.
		expect(chain.filters).toHaveLength(2);
		expect(chain.filters[0]).toBe(
			`movie=filename=${filtergraphPath(join(own, file ?? ""))},format=rgba,loop=loop=1:size=1,settb=AVTB,setpts=1/TB+N*2/TB[graphic0png]`
		);
		const graph = chain.filters.join(";");
		expect(graph).not.toContain("split");
		expect(graph).not.toContain("rotate=");
		expect(graph).not.toContain("geq=");
		expect(chain.filters.at(-1)).toMatch(
			/^\[base\]\[graphic0png\]overlay=x='640\*\(0\.1\)\+\(-?[\d.]+\)':y='360\*\(0\.2\)\+\(-?[\d.]+\)':eof_action=pass:enable='between\(t,1,3\)'\[graphic0shape\]$/
		);
	});

	test("large rasters are capped and scaled up once in FFmpeg", () => {
		const own = mkdtempSync(join(directory, "capped-"));
		const chain = graphicsFilters(
			{
				...project([graphic({ height: 1, shape: "star", width: 1 })]),
				height: 2160,
				width: 3840,
			},
			"base",
			{ rasterDirectory: own }
		);
		expect(chain.filters[0]).toMatch(
			/,format=rgba,scale=(\d+):\1:flags=bicubic,loop=/
		);
		const side = Number(/scale=(\d+):/.exec(chain.filters[0] ?? "")?.[1]);
		expect(side).toBeGreaterThan(2560);
		const [file] = readdirSync(own);
		const png = readFileSync(join(own, file ?? ""));
		// IHDR width and height.
		expect(png.readUInt32BE(16)).toBe(2560);
		expect(png.readUInt32BE(20)).toBe(2560);
	});

	test("identical rasters are written once", () => {
		const own = mkdtempSync(join(directory, "shared-"));
		const star = graphic({ shape: "star" });
		graphicsFilters(
			project([
				star,
				{ ...star, id: "00000000-0000-4000-8000-000000000002", x: 0.5 },
			]),
			"base",
			{ rasterDirectory: own }
		);
		graphicsFilters(project([star]), "base", { rasterDirectory: own });
		expect(readdirSync(own)).toHaveLength(1);
	});

	test("keyframed rotation, opacity and position animate per frame", () => {
		const own = mkdtempSync(join(directory, "animated-"));
		const chain = graphicsFilters(
			project([
				graphic({
					animation: "slide-up",
					entryDuration: 0.5,
					keyframes: [
						{
							id: "00000000-0000-4000-8000-000000000003",
							property: "rotation",
							time: 1,
							value: 90,
						},
						{
							id: "00000000-0000-4000-8000-000000000004",
							property: "opacity",
							time: 1,
							value: 0,
						},
						{
							id: "00000000-0000-4000-8000-000000000005",
							property: "x",
							time: 2,
							value: 0.5,
						},
					],
					shape: "heart",
				}),
			]),
			"base",
			{ rasterDirectory: own }
		);
		const graph = chain.filters.join(";");
		const command = readdirSync(own).find((name) => name.endsWith(".cmd"));
		expect(command).toMatch(/^opacity-[0-9a-f]{32}\.cmd$/);
		expect(chain.filters[0]).toContain(",format=rgba,format=yuva420p,loop=");
		expect(graph).toContain(
			`[graphic0clock]sendcmd=f=${filtergraphPath(join(own, command ?? ""))},crop=2:2:0:0,format=yuva420p,lut=a=0,pad=`
		);
		expect(graph).toContain(
			"overlay=x=0:y=0:format=yuv420:enable='between(t,1,3)'[graphic0raster]"
		);
		expect(graph).toContain(
			"[graphic0raster]rotate=a='(if(lt((t-1),1),0+(90)*clip(((t-1)-0)/1,0,1),90))*PI/180':c=none:ow=iw:oh=ih:enable='between(t,1,3)'[graphic0rotated]"
		);
		expect(graph).toContain(
			"[graphic0rotated]lut@graphic0opacity=a=round(val*0.8):enable='between(t,1,3)'[graphic0faded]"
		);
		expect(graph).not.toContain("geq=");
		expect(graph).toContain(
			"x='640*((if(lt((t-1),2),0.1+(0.4)*clip(((t-1)-0)/2,0,1),0.5)))+("
		);
		expect(graph).toContain(
			"y='360*(0.2+((1-(min(1,max(0,(t-1)/0.5))))*0.08))+("
		);
		const commands = readFileSync(join(own, command ?? ""), "utf8");
		expect(commands.split("\n")[0]).toBe(
			"1.033333 lut@graphic0opacity a round(val*0.7733);"
		);
		expect(commands.split("\n").at(-1)).toBe(
			"2 lut@graphic0opacity a round(val*0);"
		);
	});

	test("rotation-only keyframes need no opacity commands", () => {
		const own = mkdtempSync(join(directory, "rotation-only-"));
		const chain = graphicsFilters(
			project([
				graphic({
					keyframes: [
						{
							id: "00000000-0000-4000-8000-000000000007",
							property: "rotation",
							time: 1,
							value: 45,
						},
					],
					shape: "star",
				}),
			]),
			"base",
			{ rasterDirectory: own }
		);
		const graph = chain.filters.join(";");
		expect(graph).not.toContain("sendcmd");
		expect(graph).not.toContain("lut@");
		expect(graph).toContain("[graphic0clock]crop=2:2:0:0,format=yuva420p");
		expect(readdirSync(own).filter((name) => name.endsWith(".cmd"))).toEqual(
			[]
		);
	});

	test("blend modes use the shared compositor", () => {
		const own = mkdtempSync(join(directory, "blend-"));
		const chain = graphicsFilters(
			project([graphic({ blendMode: "screen", cornerRadius: 0.2 })]),
			"base",
			{ rasterDirectory: own }
		);
		const graph = chain.filters.join(";");
		expect(graph).toContain("blend=all_mode=screen");
		expect(chain.last).toBe("graphic0shape");
	});

	test("graphics chain in start order across both paths", () => {
		const own = mkdtempSync(join(directory, "mixed-"));
		const chain = graphicsFilters(
			project([
				graphic({ shape: "star", start: 2 }),
				graphic({ id: "00000000-0000-4000-8000-000000000006", start: 0 }),
			]),
			"base",
			{ rasterDirectory: own }
		);
		expect(chain.filters[0]).toStartWith("[base]drawbox");
		expect(chain.filters[2]).toStartWith("[graphic0rect][graphic1png]overlay=");
		expect(chain.last).toBe("graphic1shape");
	});
});

describe("opacity commands", () => {
	test("one command per frame where the value changes", () => {
		const fade = graphic({
			end: 2,
			keyframes: [
				{
					id: "00000000-0000-4000-8000-000000000008",
					property: "opacity",
					time: 0.5,
					value: 1,
				},
				{
					id: "00000000-0000-4000-8000-000000000009",
					property: "opacity",
					time: 0.6,
					value: 0,
				},
			],
			opacity: 1,
			start: 1,
		});
		expect(opacityCommands(fade, 10, "lut@g")).toEqual({
			// Held at 1 until 1.5 s, then a 0.1 s ramp to 0 at 10 fps.
			commands: "1.6 lut@g a round(val*0);",
			initial: 1,
		});
		const steady = graphic({
			keyframes: [
				{
					id: "00000000-0000-4000-8000-000000000010",
					property: "opacity",
					time: 0,
					value: 0.5,
				},
			],
		});
		expect(opacityCommands(steady, 30, "lut@g")).toEqual({
			commands: "",
			initial: 0.5,
		});
	});
});

describe("raster directories", () => {
	test("directories of dead processes are swept, live ones kept", () => {
		const root = mkdtempSync(join(directory, "sweep-"));
		for (const name of [
			"ryu-video-studio-shapes-111-abc",
			"ryu-video-studio-shapes-222-def",
			`ryu-video-studio-shapes-${process.pid}-ghi`,
			"ryu-video-studio-shapes-legacy",
			"unrelated-333-x",
		]) {
			mkdirSync(join(root, name));
		}
		const removed = sweepStaleRasterDirectories(root, (pid) => pid === 222);
		expect(removed).toEqual(["ryu-video-studio-shapes-111-abc"]);
		expect(readdirSync(root).sort()).toEqual(
			[
				"ryu-video-studio-shapes-222-def",
				`ryu-video-studio-shapes-${process.pid}-ghi`,
				"ryu-video-studio-shapes-legacy",
				"unrelated-333-x",
			].sort()
		);
	});
});

describe("filtergraph paths", () => {
	test("plain paths pass through", () => {
		expect(filtergraphPath("/tmp/a/shape-1.png")).toBe("/tmp/a/shape-1.png");
	});

	test("special characters are escaped at both levels", () => {
		expect(filtergraphPath("C:\\a b's,[x];y.png")).toBe(
			"C\\\\:\\\\\\\\a b\\\\\\'s\\,\\[x\\]\\;y.png"
		);
	});
});

describe("PNG encoder", () => {
	test("crc32 matches the standard check value", () => {
		expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcb_f4_39_26);
	});

	test("rejects mismatched buffers", () => {
		expect(() => encodeRgbaPng(2, 2, new Uint8Array(3))).toThrow(
			"does not match"
		);
		expect(() => encodeRgbaPng(0, 2, new Uint8Array(0))).toThrow("positive");
	});

	test("FFmpeg decodes the PNG back to the same pixels", async () => {
		const pixels = new Uint8Array([
			255, 0, 0, 255, 0, 255, 0, 128, 0, 0, 255, 0, 10, 20, 30, 40,
		]);
		const png = join(directory, "tiny.png");
		await Bun.write(png, encodeRgbaPng(2, 2, pixels));
		const raw = join(directory, "tiny.rgba");
		await runMedia([
			"-y",
			"-i",
			png,
			"-f",
			"rawvideo",
			"-pix_fmt",
			"rgba",
			raw,
		]);
		expect(Array.from(readFileSync(raw))).toEqual(Array.from(pixels));
	});
});

describe("shape keyframes", () => {
	const keyed = () =>
		graphic({
			keyframes: [
				{
					id: "00000000-0000-4000-8000-0000000000a1",
					property: "scale",
					time: 0,
					value: 0.5,
				},
				{
					id: "00000000-0000-4000-8000-0000000000a2",
					property: "scale",
					time: 2,
					value: 1.5,
				},
				{
					color: "#0000ff",
					id: "00000000-0000-4000-8000-0000000000a3",
					property: "fill",
					time: 2,
					value: 0,
				},
			],
			shape: "star",
		});

	test("resolves one raster per changing frame, with no sampling cap", () => {
		const samples = shapeSamples(keyed(), 30);
		expect(samples.length).toBe(60);
		expect(samples[0]?.time).toBe(1);
		expect(samples[0]?.shape.width).toBeCloseTo(0.125, 9);
		expect(samples.at(-1)?.shape.fill).not.toBe("#ff0000");
		const long = shapeSamples(
			{ ...keyed(), end: 1 + 600, keyframes: keyed().keyframes },
			30
		);
		// Every changing frame of a ten-minute animation, not a sampled subset.
		// The keys change it on frames 30 to 90; it then holds for ten minutes.
		expect(long.map((sample) => sample.frame)).toEqual(
			Array.from({ length: 61 }, (_, index) => 30 + index)
		);
		const still = shapeSamples(
			graphic({
				keyframes: [
					{
						color: "#00ff00",
						id: "00000000-0000-4000-8000-0000000000a4",
						property: "stroke",
						time: 0,
						value: 0,
					},
				],
			}),
			30
		);
		expect(still).toHaveLength(1);
	});

	test("plays every frame from one prepared PNG sequence, repeats linked", async () => {
		const rasters = join(directory, "shape-keys");
		mkdirSync(rasters, { recursive: true });
		const project = { ...newProject("Shape keys"), graphics: [keyed()] };
		const prepared = await prepareShapeSequences(project, {
			rasterDirectory: rasters,
		});
		expect(prepared.sequences.size).toBe(1);
		expect(prepared.bytes).toBeGreaterThan(0);
		const chain = graphicsFilters(project, "base", {
			shapeSequences: prepared.sequences,
		});
		const source = chain.filters[0] ?? "";
		expect(source).toContain("%06d.png:f=image2,format=rgba");
		// Frame 0 shows from the graphic's start, frame k on output frame 30 + k.
		expect(source).toContain("setpts=if(eq(N\\,0)\\,1\\,(30+N)/(30))/TB");
		const sequence = readdirSync(rasters).find((name) =>
			name.startsWith("shape-seq-")
		);
		expect(sequence).toBeDefined();
		const folder = join(rasters, sequence ?? "");
		const frames = readdirSync(folder)
			.filter((name) => name.endsWith(".png"))
			.sort();
		// keyed() runs 1 s to 3 s at 30 fps: 60 frames, every one on disk.
		expect(frames).toHaveLength(60);
		expect(frames[0]).toBe("000000.png");
		expect(frames.at(-1)).toBe("000059.png");
		// The same graphic reuses its finished sequence and writes nothing.
		const again = await prepareShapeSequences(project, {
			rasterDirectory: rasters,
		});
		expect(again.bytes).toBe(0);
		expect([...again.sequences.values()]).toEqual([
			...prepared.sequences.values(),
		]);
		expect(
			readdirSync(rasters).filter((name) => name.startsWith("shape-seq-"))
		).toHaveLength(1);
		// A single-frame render writes only the frames around its time, inline.
		const single = graphicsFilters(project, "base", {
			frameTime: 2,
			rasterDirectory: rasters,
		});
		expect(single.filters[0]).toContain("setpts=(59+N)/(30)/TB");
		expect(chain.filters.at(-1)).toContain("overlay=");
	});

	test("a long animation is never drawn while the graph is built", () => {
		const project = { ...newProject("Shape keys"), graphics: [keyed()] };
		expect(() =>
			graphicsFilters(project, "base", {
				rasterDirectory: join(directory, "unprepared"),
			})
		).toThrow("drawn before the export graph");
	});

	test("preparing yields to the event loop between frames", async () => {
		const project = {
			...newProject("Shape keys"),
			graphics: [keyed()],
			height: 1080,
			width: 1920,
		};
		let ticks = 0;
		const timer = setInterval(() => {
			ticks++;
		}, 1);
		const started = performance.now();
		try {
			await prepareShapeSequences(project, {
				rasterDirectory: join(directory, "yield"),
			});
		} finally {
			clearInterval(timer);
		}
		const elapsed = performance.now() - started;
		// The interval keeps firing while 60 full-HD rasters are drawn.
		expect(ticks).toBeGreaterThan(Math.min(10, elapsed / 50));
	});

	test("preparing stops on cancel, deadline, budget and frame limit", async () => {
		const project = { ...newProject("Shape keys"), graphics: [keyed()] };
		const canceled = new AbortController();
		canceled.abort();
		await expect(
			prepareShapeSequences(project, {
				rasterDirectory: join(directory, "cancel"),
				signal: canceled.signal,
			})
		).rejects.toThrow("canceled");
		let remaining = 3;
		await expect(
			prepareShapeSequences(project, {
				rasterDirectory: join(directory, "deadline"),
				remainingMs: () => remaining--,
			})
		).rejects.toThrow(SHAPE_SEQUENCE_TIMEOUT_MESSAGE);
		await expect(
			prepareShapeSequences(project, {
				budgetBytes: 1000,
				rasterDirectory: join(directory, "budget"),
			})
		).rejects.toThrow("working-file budget");
		// Unfinished sequences are removed when preparing fails.
		for (const name of ["cancel", "deadline", "budget"]) {
			const left = readdirSync(join(directory, name), {
				withFileTypes: true,
			}).filter((entry) => entry.name.startsWith("shape-seq-"));
			expect(left).toEqual([]);
		}
		const endless = {
			...project,
			graphics: [{ ...keyed(), end: 1 + MAX_SHAPE_RENDER_FRAMES / 30 + 1 }],
		};
		await expect(
			prepareShapeSequences(endless, {
				rasterDirectory: join(directory, "entries"),
			})
		).rejects.toThrow("one render may write");
	});

	test("a chunk seeks the sequence to its window's first frame", async () => {
		const rasters = join(directory, "window");
		const project = {
			...newProject("Shape keys"),
			graphics: [keyed()],
			height: 120,
			width: 160,
		};
		const prepared = await prepareShapeSequences(project, {
			rasterDirectory: rasters,
		});
		// Window from output frame 50: read from frame 49, 19 into the sequence.
		const chain = graphicsFilters(project, "base", {
			shapeSequences: prepared.sequences,
			window: { startFrame: 50 },
		});
		const source = chain.filters[0] ?? "";
		expect(source).toContain(":f=image2:sp=0.76,");
		expect(source).toContain("setpts=(49+N)/(30)/TB");
		// FFmpeg's first frame after that seek is exactly file 000019.png.
		const folder = [...prepared.sequences.values()][0] ?? "";
		const seeked = join(directory, "seeked.rgba");
		const direct = join(directory, "direct.rgba");
		await runMedia([
			"-y",
			"-f",
			"lavfi",
			"-i",
			`movie=filename=${filtergraphPath(join(folder, "%06d.png"))}:f=image2:sp=0.76`,
			"-frames:v",
			"1",
			"-f",
			"rawvideo",
			"-pix_fmt",
			"rgba",
			seeked,
		]);
		await runMedia([
			"-y",
			"-i",
			join(folder, "000019.png"),
			"-f",
			"rawvideo",
			"-pix_fmt",
			"rgba",
			direct,
		]);
		const before = join(directory, "before.rgba");
		await runMedia([
			"-y",
			"-i",
			join(folder, "000018.png"),
			"-f",
			"rawvideo",
			"-pix_fmt",
			"rgba",
			before,
		]);
		expect(readFileSync(seeked).equals(readFileSync(direct))).toBe(true);
		expect(readFileSync(seeked).equals(readFileSync(before))).toBe(false);
	});
});
