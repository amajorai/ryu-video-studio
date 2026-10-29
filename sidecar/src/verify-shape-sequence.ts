/**
 * Real-FFmpeg proof that a shape-keyframed graphic plays every frame of its
 * animation from one PNG sequence, with no cap on its length.
 *
 * A star turns from -179° to 179° and grows over 600 frames (20 s at 30 fps),
 * so every frame's raster differs from the last. The export must:
 *
 * - write a sequence of exactly 600 PNGs, all distinct files (no frame is
 *   held from a sampled neighbour, as the old 240-raster cap did past
 *   frame 240), ahead of the graph (`prepareShapeSequences`) while the
 *   event loop keeps running, and reuse it for a second render;
 * - read it as one `movie` image2 input and produce 600 frames in which
 *   every frame differs from the one before it inside the star;
 * - agree with single-frame renders (the preview path, which writes only the
 *   frames around its time) at frames 0, 299 and 599.
 *
 * Run: `bun src/verify-shape-sequence.ts`
 */
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	graphicSchema,
	newProject,
	type Project,
} from "../../shared/project.ts";
import { runMedia } from "./media.ts";
import { buildRender, buildRenderProgram } from "./render.ts";
import { runRenderProgram } from "./render-chunks.ts";
import { prepareShapeSequences, shapeSamples } from "./render-graphics.ts";

function ensure<Condition>(
	condition: Condition,
	message: string
): asserts condition {
	if (!condition) {
		throw new Error(message);
	}
}

const WIDTH = 320;
const HEIGHT = 240;
const FPS = 30;
const FRAMES = 600;
const SECONDS = FRAMES / FPS;
const SIDE = 120;

const star = graphicSchema.parse({
	animation: "none",
	end: SECONDS,
	entryDuration: 0,
	fill: "#ffcc00",
	height: SIDE / HEIGHT,
	id: crypto.randomUUID(),
	innerRadius: 0.45,
	keyframes: [
		{ id: crypto.randomUUID(), property: "rotation", time: 0, value: -179 },
		{
			id: crypto.randomUUID(),
			property: "rotation",
			time: SECONDS,
			value: 179,
		},
		{ id: crypto.randomUUID(), property: "scale", time: 0, value: 0.6 },
		{ id: crypto.randomUUID(), property: "scale", time: SECONDS, value: 1.2 },
	],
	opacity: 1,
	points: 5,
	shape: "star",
	start: 0,
	stroke: "#ffffff",
	strokeWidth: 0,
	width: SIDE / WIDTH,
	x: (WIDTH / 2 - SIDE / 2) / WIDTH,
	y: (HEIGHT / 2 - SIDE / 2) / HEIGHT,
});

const project: Project = {
	...newProject("Shape sequence proof"),
	fps: FPS,
	graphics: [star],
	height: HEIGHT,
	width: WIDTH,
};

/** Every frame of `path` as raw RGB. */
async function frames(path: string, raw: string): Promise<Uint8Array[]> {
	await runMedia([
		"-hide_banner",
		"-loglevel",
		"error",
		"-y",
		"-i",
		path,
		"-pix_fmt",
		"rgb24",
		"-f",
		"rawvideo",
		raw,
	]);
	const bytes = new Uint8Array(await readFile(raw));
	const size = WIDTH * HEIGHT * 3;
	return Array.from({ length: Math.floor(bytes.length / size) }, (_, index) =>
		bytes.slice(index * size, (index + 1) * size)
	);
}

/** Mean absolute difference of two RGB frames inside the star's square. */
function difference(a: Uint8Array, b: Uint8Array): number {
	let sum = 0;
	let count = 0;
	const half = SIDE * 0.65;
	for (let y = HEIGHT / 2 - half; y < HEIGHT / 2 + half; y++) {
		for (let x = WIDTH / 2 - half; x < WIDTH / 2 + half; x++) {
			const offset = (Math.round(y) * WIDTH + Math.round(x)) * 3;
			for (let channel = 0; channel < 3; channel++) {
				sum += Math.abs(
					(a[offset + channel] ?? 0) - (b[offset + channel] ?? 0)
				);
				count++;
			}
		}
	}
	return sum / Math.max(1, count);
}

const directory = await mkdtemp(join(tmpdir(), "ryu-verify-shape-sequence-"));
try {
	const samples = shapeSamples(star, FPS);
	ensure(
		samples.length === FRAMES,
		`expected ${FRAMES} distinct rasters, got ${samples.length}`
	);

	const exportPath = join(directory, "export.mkv");
	// Exports draw the sequence ahead of the graph without blocking the
	// event loop, as the render queue does.
	let ticks = 0;
	const timer = setInterval(() => {
		ticks++;
	}, 5);
	const preparing = performance.now();
	const shapes = await prepareShapeSequences(project, {
		rasterDirectory: join(directory, "graphics"),
	});
	clearInterval(timer);
	const prepareMs = performance.now() - preparing;
	ensure(
		ticks >= Math.floor(prepareMs / 100),
		`the event loop stalled while the sequence was drawn (${ticks} ticks in ${prepareMs.toFixed(0)} ms)`
	);
	const options = { shapeSequences: shapes.sequences };
	const args = buildRender(
		project,
		[],
		() => "",
		undefined,
		[],
		undefined,
		options
	);
	const graph = args[args.indexOf("-filter_complex") + 1] ?? "";
	const source = /movie=filename=([^:]+%06d\.png):f=image2/.exec(graph);
	ensure(source?.[1], "the shape is not read as one image2 sequence");
	ensure(
		(graph.match(/movie=/g) ?? []).length === 1,
		"the shape opens more than one movie input"
	);
	const folder = source[1].replaceAll("\\\\", "\\").replace(/\/%06d\.png$/, "");
	const names = (await readdir(folder)).filter((name) => name.endsWith(".png"));
	ensure(
		names.length === FRAMES,
		`the sequence holds ${names.length} frames, expected ${FRAMES}`
	);
	const inodes = new Set<number>();
	for (const name of names) {
		inodes.add((await stat(join(folder, name))).ino);
	}
	ensure(
		inodes.size === FRAMES,
		`only ${inodes.size} of ${FRAMES} sequence frames are distinct files`
	);
	// Lossless output so frame differences are the render's, not a codec's.
	const lossless = args.slice(0, args.indexOf("-filter_complex") + 2);
	const mapped = args[args.indexOf("-map") + 1];
	await runMedia(
		[
			...lossless,
			"-map",
			mapped ?? "[out]",
			"-c:v",
			"ffv1",
			"-t",
			String(SECONDS),
			exportPath,
		],
		{ cwd: directory }
	);
	const exported = await frames(exportPath, join(directory, "export.rgb"));
	ensure(
		exported.length === FRAMES,
		`the export has ${exported.length} frames, expected ${FRAMES}`
	);
	let flattest = Number.POSITIVE_INFINITY;
	for (let index = 1; index < exported.length; index++) {
		const a = exported[index - 1];
		const b = exported[index];
		ensure(a && b, `frame ${index} missing`);
		const change = difference(a, b);
		flattest = Math.min(flattest, change);
		ensure(
			change > 0.05,
			`frame ${index} repeats frame ${index - 1} (mean difference ${change.toFixed(3)})`
		);
	}

	// A second export reuses the finished sequence.
	const reused = await prepareShapeSequences(project, {
		rasterDirectory: join(directory, "graphics"),
	});
	ensure(reused.bytes === 0, "a second render redrew the finished sequence");
	const again = buildRender(project, [], () => "", undefined, [], undefined, {
		shapeSequences: reused.sequences,
	});
	ensure(
		again[again.indexOf("-filter_complex") + 1] === graph,
		"a second render did not reuse the finished sequence"
	);

	const checked: string[] = [];
	for (const frame of [0, 299, 599]) {
		const png = join(directory, `frame-${frame}.png`);
		await runMedia(
			[...buildRender(project, [], () => "", undefined, [], frame / FPS), png],
			{ cwd: directory }
		);
		const [single] = await frames(png, join(directory, `frame-${frame}.rgb`));
		const reference = exported[frame];
		ensure(single && reference, `frame ${frame} missing`);
		const error = difference(single, reference);
		ensure(
			error < 1.5,
			`the single-frame render at frame ${frame} differs from the export (${error.toFixed(2)})`
		);
		checked.push(`${frame}:${error.toFixed(3)}`);
	}
	// A chunked export seeks the sequence to each window's first frame
	// instead of decoding it from frame 0; every chunk frame matches.
	const program = buildRenderProgram(project, [], () => "", undefined, [], {
		chunk: true,
		chunkSeconds: 7,
		output: "chunked.mp4",
		shapeSequences: shapes.sequences,
	});
	const chunkSteps = program.steps.filter((step) => step.kind === "chunk");
	ensure(chunkSteps.length > 1, "the export did not split into chunks");
	// Chunk graphs are written to filter scripts; read each one's script.
	const chunkGraph = (step: (typeof chunkSteps)[number]) => {
		const script = step.args[step.args.indexOf("-filter_complex_script") + 1];
		return program.files.find((file) => file.name === script)?.content ?? "";
	};
	ensure(
		chunkSteps
			.slice(1)
			.every((step) => /:f=image2:sp=[\d.]+,/.test(chunkGraph(step))),
		"a later chunk does not seek its shape sequence"
	);
	await runRenderProgram(
		{ files: program.files, steps: chunkSteps },
		{
			run: async (step) => {
				await runMedia([...step.args, step.output], { cwd: directory });
			},
			write: async (name, content) => {
				await Bun.write(join(directory, name), content);
			},
		}
	);
	const chunked: Uint8Array[] = [];
	for (const step of chunkSteps) {
		chunked.push(
			...(await frames(
				join(directory, step.output),
				join(directory, `${step.output}.rgb`)
			))
		);
	}
	ensure(
		chunked.length === FRAMES,
		`the chunks hold ${chunked.length} frames, expected ${FRAMES}`
	);
	let chunkError = 0;
	for (const [index, frame] of chunked.entries()) {
		const reference = exported[index];
		ensure(reference, `export frame ${index} missing`);
		chunkError = Math.max(chunkError, difference(frame, reference));
	}
	ensure(
		chunkError < 1.5,
		`a chunk frame differs from the single-pass export (${chunkError.toFixed(2)})`
	);

	console.info(
		JSON.stringify(
			{
				chunkSteps: chunkSteps.length,
				largestChunkFrameError: Number(chunkError.toFixed(3)),
				distinctFiles: inodes.size,
				eventLoopTicksWhileDrawing: ticks,
				exportFrames: exported.length,
				prepareMs: Math.round(prepareMs),
				sequenceFrames: names.length,
				singleFrameErrors: checked,
				smallestFrameChange: Number(flattest.toFixed(3)),
			},
			null,
			2
		)
	);
	console.info("verify-shape-sequence: ok");
} finally {
	await rm(directory, { force: true, recursive: true });
}
