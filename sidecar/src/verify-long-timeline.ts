/**
 * Real-FFmpeg proof for chunked rendering of long timelines (W4-Q1).
 *
 * First, short phase scenarios render with forced 3 s chunks and compare
 * every frame and the audio against the one-pass render: 24 and 25 fps
 * sources in a 30 fps project with clips that start off whole seconds and
 * frames (one at 1.5× speed), an NTSC project, ranges whose start is not on
 * a frame, and 260 clips whose audio mixes in three sub-mixes. The one-pass
 * and chunked exports must carry the same audio (a ducked clip once lost
 * its last ~35 ms in the one-pass video export, see `DUCK_HOLD_MARGIN`),
 * and a ducked bed that outlasts the voice must keep playing after it. The
 * 260-clip timeline is also exported through `RenderQueue` (3 s windows),
 * which must run the chunk program and match the one-pass render.
 *
 * Then a 600-clip timeline (0.5 s each, five minutes) with a picture-in-picture
 * clip, a lower-third graphic and a title that all run across every chunk
 * edge renders twice: once as a single FFmpeg graph (`buildRender`) and once
 * as a chunk program (`buildRenderProgram`, 60 s windows). The proof checks
 * that the program really chunks, that both files have the same frame count
 * and an audio stream, and that every frame on either side of each chunk
 * edge matches the one-pass render with PSNR above 45 dB. The same timeline
 * is then exported through `RenderQueue` with its default settings, which
 * must chunk on its own and produce the same frames and audio.
 *
 * Run: `bun src/verify-long-timeline.ts` (about 25 minutes, almost all of
 * it the 600-clip one-pass reference), or `--quick` for the phase scenarios
 * only (about a minute).
 */
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import {
	type Asset,
	newProject,
	newSegment,
	type Project,
} from "../../shared/project.ts";
import { naturalCurveSpeed } from "../../shared/speed-curve.ts";
import { runMedia } from "./media.ts";
import { assCaptions, buildRender, buildRenderProgram } from "./render.ts";
import {
	CHUNK_AUDIO_FILE,
	type RenderProgram,
	type RenderStep,
	runRenderProgram,
} from "./render-chunks.ts";
import { RenderQueue } from "./render-queue.ts";
import { StudioStore } from "./store.ts";

const CLIPS = 600;
/** The curve of the chunked speed-curve scenario. */
const CHUNK_CURVE = [
	{ speed: 0.6, t: 0 },
	{ speed: 2.5, t: 0.45 },
	{ speed: 0.8, t: 1 },
];
const CLIP_SECONDS = 0.5;
const PSNR_FLOOR = 45;
const WIDTH = 320;
const HEIGHT = 180;
const FPS = 30;

function ensure<Condition>(
	condition: Condition,
	message: string
): asserts condition {
	if (!condition) {
		throw new Error(message);
	}
}

function videoAsset(index: number, duration = 20, frameRate = FPS): Asset {
	return {
		createdAt: new Date(0).toISOString(),
		duration,
		frameRate,
		hasAudio: true,
		height: HEIGHT,
		id: `00000000-0000-4000-8000-0000000000${String(index).padStart(2, "0")}`,
		kind: "video",
		name: `source-${index}.mp4`,
		width: WIDTH,
	};
}

const SOURCES = [
	"testsrc2=s=320x180:r=30",
	"smptebars=s=320x180:r=30",
	"rgbtestsrc=s=320x180:r=30",
	"mandelbrot=s=320x180:r=30",
	"testsrc=s=320x180:r=30",
];

async function synthesize(
	index: number,
	path: string,
	seconds: number,
	rate = String(FPS)
) {
	const source = (SOURCES[index % SOURCES.length] ?? "").replace(
		":r=30",
		`:r=${rate}`
	);
	await runMedia([
		"-y",
		"-f",
		"lavfi",
		"-i",
		`${source},format=yuv420p,trim=duration=${seconds}`,
		"-f",
		"lavfi",
		"-i",
		`sine=frequency=${220 + index * 110}:sample_rate=48000:duration=${seconds}`,
		"-c:v",
		"libx264",
		"-preset",
		"ultrafast",
		"-g",
		"15",
		"-pix_fmt",
		"yuv420p",
		"-c:a",
		"aac",
		"-shortest",
		path,
	]);
}

function longProject(assets: Asset[], long: Asset): Project {
	const [first] = assets;
	ensure(first, "missing source asset");
	const segments = Array.from({ length: CLIPS }, (_, index) => {
		const asset = assets[index % assets.length] ?? first;
		const sourceIn = Number(((index * 0.37) % 15).toFixed(2));
		return {
			...newSegment(asset, index * CLIP_SECONDS, 0),
			id: `10000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
			sourceIn,
			sourceOut: sourceIn + CLIP_SECONDS,
			volume: 0.5,
		};
	});
	const total = CLIPS * CLIP_SECONDS;
	// A picture-in-picture clip on track 1 that crosses every chunk edge.
	const pip = {
		...newSegment(long, 0, 1),
		id: "20000000-0000-4000-8000-000000000001",
		scale: 0.3,
		sourceIn: 0,
		sourceOut: total,
		volume: 0,
		x: 0.6,
		y: -0.6,
	};
	return {
		...newProject("Long timeline proof"),
		fps: FPS,
		graphics: [
			{
				animation: "none",
				end: total,
				entryDuration: 0.35,
				fill: "#3355ff",
				height: 0.12,
				id: "30000000-0000-4000-8000-000000000001",
				opacity: 0.7,
				shape: "rectangle",
				start: 0,
				stroke: "#ffffff",
				strokeWidth: 0,
				width: 0.6,
				x: 0.05,
				y: 0.82,
			},
		],
		height: HEIGHT,
		segments: [...segments, pip],
		titles: [
			{
				animation: "fade",
				color: "#ffffff",
				end: total,
				fadeIn: 0,
				fadeOut: 0,
				fontSize: 0.08,
				id: "40000000-0000-4000-8000-000000000001",
				start: 0,
				text: "Long timeline",
				x: 0.5,
				y: 0.1,
			},
		],
		width: WIDTH,
	};
}

const frameCountSchema = z.object({
	streams: z.array(
		z.object({
			codec_type: z.string(),
			nb_read_frames: z.string().optional(),
		})
	),
});

async function streams(path: string) {
	const output = await runMedia(
		[
			"-v",
			"error",
			"-count_frames",
			"-show_entries",
			"stream=codec_type,nb_read_frames",
			"-of",
			"json",
			path,
		],
		{ probe: true, timeoutMs: 300_000 }
	);
	return frameCountSchema.parse(JSON.parse(output)).streams;
}

/** Per-frame PSNR (average over planes) of `a` against `b`. */
async function framePsnr(
	a: string,
	b: string,
	statsPath: string
): Promise<Map<number, number>> {
	await runMedia(
		[
			"-hide_banner",
			"-loglevel",
			"error",
			"-i",
			a,
			"-i",
			b,
			"-filter_complex",
			`[0:v][1:v]psnr=stats_file=${statsPath}`,
			"-f",
			"null",
			"-",
		],
		{ timeoutMs: 600_000 }
	);
	const values = new Map<number, number>();
	for (const line of (await readFile(statsPath, "utf8")).split("\n")) {
		const frame = /n:(\d+)/.exec(line);
		const psnr = /psnr_avg:(\S+)/.exec(line);
		if (frame?.[1] && psnr?.[1]) {
			values.set(
				Number(frame[1]) - 1,
				psnr[1] === "inf" ? Number.POSITIVE_INFINITY : Number(psnr[1])
			);
		}
	}
	return values;
}

/** Run a one-pass argv with its graph in a script file (argv limit). */
async function runOnePass(
	args: readonly string[],
	output: string,
	cwd: string,
	name: string
) {
	const graphAt = args.indexOf("-filter_complex");
	ensure(graphAt >= 0, "the one-pass render has no filter graph");
	await Bun.write(join(cwd, `${name}.filters`), args[graphAt + 1] ?? "");
	const next = [...args];
	next.splice(graphAt, 2, "-filter_complex_script", `${name}.filters`);
	await runMedia([...next, output], { cwd, timeoutMs: 1_800_000 });
}

async function runProgram(program: RenderProgram, work: string) {
	await runRenderProgram(program, {
		run: async (step) => {
			await runMedia([...step.args, step.output], {
				cwd: work,
				timeoutMs: 1_800_000,
			});
		},
		write: async (name, content) => {
			await Bun.write(join(work, name), content);
		},
	});
}

/** Decoded audio as interleaved stereo float samples at 48 kHz. */
async function audioSamples(path: string, raw: string): Promise<Float32Array> {
	await runMedia([
		"-hide_banner",
		"-loglevel",
		"error",
		"-y",
		"-i",
		path,
		"-vn",
		"-ac",
		"2",
		"-ar",
		"48000",
		"-f",
		"f32le",
		raw,
	]);
	return new Float32Array(await Bun.file(raw).arrayBuffer());
}

/** Error of `b` against `a` over their common length, in dB below `a`. */
function audioErrorDb(a: Float32Array, b: Float32Array): number {
	const length = Math.min(a.length, b.length);
	let signal = 0;
	let error = 0;
	for (let index = 0; index < length; index++) {
		const reference = a[index] ?? 0;
		signal += reference * reference;
		error += (reference - (b[index] ?? 0)) ** 2;
	}
	return error === 0
		? Number.POSITIVE_INFINITY
		: 10 * Math.log10(signal / error);
}

/**
 * Compare two stereo float mixes in `blockSeconds` blocks, letting each block
 * shift by one sample (25 ms at each block edge are skipped, where a shifted
 * clip's cut against its neighbour differs). Returns the worst block's error and how many
 * blocks needed the shift.
 */
function mixWithinOneSample(
	a: Float32Array,
	b: Float32Array,
	blockSeconds: number
): { shifted: number; worstDb: number } {
	const frames = Math.min(a.length, b.length) / 2;
	const block = Math.round(blockSeconds * 48_000);
	const edge = 1200;
	let worstDb = Number.POSITIVE_INFINITY;
	let shifted = 0;
	for (let start = 0; start + block <= frames; start += block) {
		let best = Number.NEGATIVE_INFINITY;
		let bestLag = 0;
		for (const lag of [0, -1, 1]) {
			let signal = 0;
			let error = 0;
			for (let frame = start + edge; frame < start + block - edge; frame++) {
				for (const channel of [0, 1]) {
					const reference = a[frame * 2 + channel] ?? 0;
					signal += reference * reference;
					error += (reference - (b[(frame + lag) * 2 + channel] ?? 0)) ** 2;
				}
			}
			const db =
				error === 0
					? Number.POSITIVE_INFINITY
					: signal === 0
						? Number.NEGATIVE_INFINITY
						: 10 * Math.log10(signal / error);
			if (db > best) {
				best = db;
				bestLag = lag;
			}
		}
		if (bestLag !== 0) {
			shifted++;
		}
		worstDb = Math.min(worstDb, best);
	}
	return { shifted, worstDb };
}

/**
 * Below this (dB), the chunked mix (`CHUNK_AUDIO_FILE`, before the final
 * encode) differs from the one-pass audio-only mix of the same span, or the
 * audio of two exports of the same timeline differs.
 */
const AUDIO_ERROR_FLOOR = 80;

interface Scenario {
	assets: Asset[];
	minAudioSteps?: number;
	name: string;
	project: Project;
	/** Also export through `RenderQueue` with this chunk length. */
	queueChunkSeconds?: number;
	range?: { end: number; start: number };
}

/**
 * Export `project` through `RenderQueue` (a real store in `folder`, with the
 * media copied in) and return the export path and the FFmpeg step kinds the
 * queue ran.
 */
async function queueExport(
	folder: string,
	project: Project,
	assets: readonly Asset[],
	paths: Map<string, string>,
	chunkSeconds?: number
): Promise<{ path: string; steps: RenderStep["kind"][] }> {
	const store = new StudioStore(join(folder, "store"));
	for (const asset of assets) {
		const source = paths.get(asset.id);
		ensure(source, `missing media ${asset.id}`);
		await Bun.write(store.mediaPath(asset.id), Bun.file(source));
		store.putAsset(asset);
	}
	const steps: RenderStep["kind"][] = [];
	const queue = new RenderQueue(store, {
		...(chunkSeconds === undefined ? {} : { chunkSeconds }),
		onStep: (step) => steps.push(step.kind),
	});
	const job = queue.start(project);
	for (let attempt = 0; attempt < 36_000; attempt++) {
		const current = store.jobs().find((candidate) => candidate.id === job.id);
		if (current?.status === "completed") {
			return { path: store.renderPath(job.id, current.codec), steps };
		}
		if (current?.status === "failed" || current?.status === "canceled") {
			throw new Error(`queue export ${current.status}: ${current.error ?? ""}`);
		}
		await Bun.sleep(100);
	}
	throw new Error("queue export timed out");
}

/** The queue ran a chunk program: chunks, an audio pass and a final join. */
function ensureChunked(steps: readonly RenderStep["kind"][], label: string) {
	ensure(
		steps.filter((kind) => kind === "chunk").length >= 2 &&
			steps.includes("audio-mix") &&
			steps.at(-1) === "final",
		`${label}: the queue did not render in chunks (${steps.join(", ")})`
	);
}

/**
 * Render a scenario in one pass and with forced 3 s chunks, then require the
 * same frame count, every frame above `PSNR_FLOOR` and the same audio.
 */
async function proveScenario(
	directory: string,
	paths: Map<string, string>,
	scenario: Scenario
) {
	const folder = join(directory, scenario.name);
	const work = join(folder, "work");
	await mkdir(work, { recursive: true });
	const mediaPath = (id: string) => {
		const path = paths.get(id);
		ensure(path, `missing media ${id}`);
		return path;
	};
	const range = scenario.range ? { range: scenario.range } : {};
	const onePass = join(folder, "one-pass.mp4");
	await runOnePass(
		buildRender(
			scenario.project,
			scenario.assets,
			mediaPath,
			undefined,
			[],
			undefined,
			range
		),
		onePass,
		folder,
		"one-pass"
	);
	const chunked = join(folder, "chunked.mp4");
	const program = buildRenderProgram(
		scenario.project,
		scenario.assets,
		mediaPath,
		undefined,
		[],
		{ chunk: true, chunkSeconds: 3, output: chunked, ...range }
	);
	const curved = scenario.project.segments.filter(
		(segment) => segment.speedCurve
	);
	if (curved.length) {
		// Later windows open the curved clip past its start, on its frame grid.
		const seeking = program.steps.filter(
			(step) =>
				step.kind === "chunk" &&
				step.args.some((arg) => arg.includes("(PTS-STARTPTS+round("))
		);
		const graphs = program.files.filter((file) =>
			file.content.includes("(PTS-STARTPTS+round(")
		);
		ensure(
			seeking.length + graphs.length >= 2,
			`${scenario.name}: the curved clip is decoded from its start in every chunk`
		);
	}
	const audioSteps = program.steps.filter((step) => step.kind === "audio");
	ensure(
		audioSteps.length >= (scenario.minAudioSteps ?? 1),
		`${scenario.name}: expected ${scenario.minAudioSteps} audio sub-mixes, got ${audioSteps.length}`
	);
	await runProgram(program, work);
	const [oneStreams, chunkStreams] = await Promise.all([
		streams(onePass),
		streams(chunked),
	]);
	const frames = (list: typeof oneStreams) =>
		Number(
			list.find((stream) => stream.codec_type === "video")?.nb_read_frames
		);
	ensure(
		frames(oneStreams) === frames(chunkStreams),
		`${scenario.name}: frame counts differ: one pass ${frames(oneStreams)}, chunked ${frames(chunkStreams)}`
	);
	const psnr = await framePsnr(onePass, chunked, join(folder, "psnr.log"));
	const bad = [...psnr.entries()].filter(([, value]) => value <= PSNR_FLOOR);
	ensure(
		bad.length === 0,
		`${scenario.name}: ${bad.length} frames differ, first ${bad
			.slice(0, 6)
			.map(([frame, value]) => `${frame}:${value.toFixed(1)}dB`)
			.join(" ")}`
	);
	// The sub-mixes must add up to the one-pass mix: compare the chunked
	// mix before the final encode with an audio-only one-pass render.
	const oneMix = join(folder, "one-pass-mix.wav");
	// A float WAV, so 16-bit rounding does not hide a difference.
	const mixArgs = buildRender(
		scenario.project,
		scenario.assets,
		mediaPath,
		undefined,
		[],
		undefined,
		{ audioOnly: true, overrides: { container: "wav" }, ...range }
	).map((arg) => (arg === "pcm_s16le" ? "pcm_f32le" : arg));
	await runOnePass(mixArgs, oneMix, folder, "one-pass-mix");
	const mixError = audioErrorDb(
		await audioSamples(oneMix, join(folder, "one-pass-mix.f32")),
		await audioSamples(join(work, CHUNK_AUDIO_FILE), join(folder, "mix.f32"))
	);
	ensure(
		mixError > AUDIO_ERROR_FLOOR,
		`${scenario.name}: the chunked mix differs: ${mixError.toFixed(1)} dB`
	);
	// Both exports encode the same mix, so their audio matches too.
	const onePassAudio = await audioSamples(
		onePass,
		join(folder, "one-pass.f32")
	);
	const exportError = audioErrorDb(
		onePassAudio,
		await audioSamples(chunked, join(folder, "chunked.f32"))
	);
	ensure(
		exportError > AUDIO_ERROR_FLOOR,
		`${scenario.name}: the one-pass and chunked export audio differ: ${exportError.toFixed(1)} dB`
	);
	let queueSteps: RenderStep["kind"][] | undefined;
	if (scenario.queueChunkSeconds !== undefined) {
		ensure(!scenario.range, "queue scenarios export the whole timeline");
		const queued = await queueExport(
			folder,
			scenario.project,
			scenario.assets,
			paths,
			scenario.queueChunkSeconds
		);
		queueSteps = queued.steps;
		ensureChunked(queued.steps, scenario.name);
		await ensureSameExport(
			onePass,
			onePassAudio,
			queued.path,
			folder,
			scenario.name
		);
	}
	const worst = Math.min(...psnr.values());
	const db = (value: number) =>
		Number.isFinite(value) ? Number(value.toFixed(1)) : "inf";
	return {
		exportAudioErrorDb: db(exportError),
		mixErrorDb: db(mixError),
		audioSteps: audioSteps.length,
		chunks: program.chunks?.length ?? 0,
		frames: frames(chunkStreams),
		name: scenario.name,
		...(queueSteps ? { queueSteps: queueSteps.length } : {}),
		worstFramePsnr: Number.isFinite(worst) ? Number(worst.toFixed(2)) : "inf",
	};
}

/**
 * `candidate` has the one-pass export's frames (every one) and the
 * reference audio (the one-pass export's, or the chunk program's).
 */
async function ensureSameExport(
	onePass: string,
	referenceAudio: Float32Array,
	candidate: string,
	folder: string,
	label: string
) {
	const [oneStreams, candidateStreams] = await Promise.all([
		streams(onePass),
		streams(candidate),
	]);
	const frames = (list: typeof oneStreams) =>
		Number(
			list.find((stream) => stream.codec_type === "video")?.nb_read_frames
		);
	ensure(
		frames(oneStreams) === frames(candidateStreams),
		`${label}: queue export frame count ${frames(candidateStreams)}, one pass ${frames(oneStreams)}`
	);
	const psnr = await framePsnr(
		onePass,
		candidate,
		join(folder, "queue-psnr.log")
	);
	const worst = Math.min(...psnr.values());
	ensure(
		worst > PSNR_FLOOR,
		`${label}: a queue export frame differs: worst PSNR ${worst} dB`
	);
	const error = audioErrorDb(
		referenceAudio,
		await audioSamples(candidate, join(folder, "queue.f32"))
	);
	ensure(
		error > AUDIO_ERROR_FLOOR,
		`${label}: the queue export audio differs: ${error.toFixed(1)} dB`
	);
}

/** Root mean square of the left channel between two times. */
function rms(samples: Float32Array, from: number, to: number): number {
	let sum = 0;
	let count = 0;
	for (let frame = Math.round(from * 48_000); frame < to * 48_000; frame++) {
		const value = samples[frame * 2] ?? 0;
		sum += value * value;
		count++;
	}
	return Math.sqrt(sum / Math.max(1, count));
}

/**
 * A ducked bed that outlasts the voice keeps playing after the voice ends
 * (FFmpeg's compressor used to end with its shorter input), in the one-pass
 * video export and the audio-only render alike.
 */
async function proveDuckedBed(
	directory: string,
	paths: Map<string, string>,
	assets: Asset[],
	voice: Asset,
	bed: Asset
) {
	const folder = join(directory, "ducked-bed-outlasts-voice");
	await mkdir(folder, { recursive: true });
	const mediaPath = (id: string) => {
		const path = paths.get(id);
		ensure(path, `missing media ${id}`);
		return path;
	};
	const project = phaseProject([
		phaseClip(voice, 900, { sourceOut: 2, volume: 1 }),
		phaseClip(bed, 901, {
			duckUnderVoice: true,
			sourceOut: 6,
			track: 1,
			volume: 1,
		}),
	]);
	const video = join(folder, "export.mp4");
	await runOnePass(
		buildRender(project, assets, mediaPath),
		video,
		folder,
		"export"
	);
	const wav = join(folder, "export.wav");
	await runOnePass(
		buildRender(project, assets, mediaPath, undefined, [], undefined, {
			audioOnly: true,
			overrides: { container: "wav" },
		}),
		wav,
		folder,
		"export-audio"
	);
	const levels: Record<string, number> = {};
	for (const [name, path] of [
		["video", video],
		["audio", wav],
	] as const) {
		const samples = await audioSamples(path, join(folder, `${name}.f32`));
		const during = rms(samples, 0.5, 1.5);
		const after = rms(samples, 3, 5.5);
		levels[`${name}DuringVoice`] = Number(during.toFixed(4));
		levels[`${name}AfterVoice`] = Number(after.toFixed(4));
		ensure(
			samples.length / 2 >= 5.9 * 48_000,
			`ducked bed (${name}): the audio ends at ${(samples.length / 2 / 48_000).toFixed(2)} s`
		);
		ensure(
			after > 0.02,
			`ducked bed (${name}): the bed stops with the voice (RMS ${after.toFixed(4)} after it)`
		);
	}
	return { levels, name: "ducked-bed-outlasts-voice" };
}

function phaseClip(
	asset: Asset,
	index: number,
	fields: Partial<Project["segments"][number]>
) {
	return {
		...newSegment(asset, 0, 0),
		id: `50000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
		volume: 0.5,
		...fields,
	};
}

function phaseProject(
	segments: Project["segments"],
	fps: Project["fps"] = FPS
): Project {
	return {
		...newProject("Chunk phase proof"),
		fps,
		height: HEIGHT,
		segments,
		width: WIDTH,
	};
}

/** Scenarios where window seeks and range starts are off every grid. */
async function provePhases(directory: string) {
	const a24 = videoAsset(10, 20, 24);
	const a25 = videoAsset(11, 20, 25);
	const a30 = videoAsset(12, 20, 30);
	const ntsc = videoAsset(13, 20, 29.97);
	const rates = new Map([
		[a24.id, "24"],
		[a25.id, "25"],
		[a30.id, "30"],
		[ntsc.id, "30000/1001"],
	]);
	const paths = new Map<string, string>();
	for (const [index, asset] of [a24, a25, a30, ntsc].entries()) {
		const path = join(directory, `phase-${index}.mp4`);
		await synthesize(index, path, asset.duration, rates.get(asset.id));
		paths.set(asset.id, path);
	}
	const assets = [a24, a25, a30, ntsc];
	const many = Array.from({ length: 260 }, (_, index) => {
		const asset = [a24, a25, a30][index % 3] ?? a30;
		const sourceIn = Number(((index * 0.137) % 10).toFixed(3));
		return phaseClip(asset, 100 + index, {
			duckUnderVoice: index % 7 === 0,
			sourceIn,
			sourceOut: sourceIn + 0.2,
			start: Number((index * 0.2).toFixed(6)),
		});
	});
	const scenarios: Scenario[] = [
		{
			assets,
			name: "source-24fps-off-second",
			project: phaseProject([phaseClip(a24, 1, { sourceOut: 8, start: 0.1 })]),
		},
		{
			assets,
			name: "source-25fps-and-24fps-at-1.5x",
			project: phaseProject([
				phaseClip(a25, 2, { sourceIn: 0.53, sourceOut: 9.53, start: 0.37 }),
				phaseClip(a24, 3, {
					scale: 0.4,
					sourceIn: 0.21,
					sourceOut: 12.21,
					speed: 1.5,
					start: 0.05,
					track: 1,
					x: 0.5,
					y: -0.5,
				}),
			]),
		},
		{
			assets,
			name: "range-off-frame-round-down",
			project: phaseProject([phaseClip(a30, 4, { sourceOut: 10 })]),
			range: { end: 7.02, start: 1.01 },
		},
		{
			assets,
			name: "range-off-frame-round-up",
			project: phaseProject([
				phaseClip(a24, 5, { sourceIn: 0.3, sourceOut: 10.3, start: 0.02 }),
			]),
			range: { end: 7.5, start: 1.0167 },
		},
		{
			assets,
			name: "ntsc-project",
			project: phaseProject(
				[phaseClip(ntsc, 6, { sourceIn: 0.2, sourceOut: 9.2, start: 0.05 })],
				29.97
			),
			range: { end: 8, start: 0.51 },
		},
		{
			// A speed-curved clip crossing every 3 s chunk edge: each window
			// seeks to the curve-mapped source moment of its start instead of
			// decoding from the clip start, and must match the one-pass frames.
			assets,
			name: "speed-curve-seeks-per-chunk",
			project: phaseProject([
				phaseClip(a24, 7, {
					sourceIn: 0.3,
					sourceOut: 14.3,
					speed: naturalCurveSpeed(CHUNK_CURVE),
					speedCurve: { points: CHUNK_CURVE },
					start: 0.1,
				}),
			]),
		},
		{
			assets,
			minAudioSteps: 3,
			name: "260-clips-three-sub-mixes",
			project: phaseProject(many),
			queueChunkSeconds: 3,
		},
	];
	const results: unknown[] = [];
	for (const scenario of scenarios) {
		results.push(await proveScenario(directory, paths, scenario));
	}
	results.push(await proveDuckedBed(directory, paths, assets, a30, a24));
	console.info(JSON.stringify({ phaseScenarios: results }, null, 2));
}

async function proveLongTimeline(directory: string) {
	const assets = [0, 1, 2, 3].map((index) => videoAsset(index));
	const long = videoAsset(4, CLIPS * CLIP_SECONDS + 1);
	const paths = new Map<string, string>();
	for (const [index, asset] of [...assets, long].entries()) {
		const path = join(directory, `source-${index}.mp4`);
		await synthesize(index, path, asset.duration);
		paths.set(asset.id, path);
	}
	const project = longProject(assets, long);
	const library = [...assets, long];
	const mediaPath = (id: string) => {
		const path = paths.get(id);
		ensure(path, `missing media ${id}`);
		return path;
	};
	await Bun.write(join(directory, "captions.ass"), assCaptions(project));

	const oneStarted = performance.now();
	const onePass = join(directory, "one-pass.mp4");
	// The one-pass graph of 600 clips is larger than one argv string may be
	// (128 KiB on Linux), which is part of why long timelines chunk; the
	// reference render reads it from a script file instead.
	await runOnePass(
		buildRender(project, library, mediaPath, "captions.ass"),
		onePass,
		directory,
		"one-pass"
	);
	const oneSeconds = (performance.now() - oneStarted) / 1000;

	const work = join(directory, "chunks");
	await mkdir(work);
	await Bun.write(join(work, "captions.ass"), assCaptions(project));
	const chunked = join(directory, "chunked.mp4");
	const program = buildRenderProgram(
		project,
		library,
		mediaPath,
		"captions.ass",
		[],
		{ output: chunked }
	);
	const chunks = program.chunks ?? [];
	ensure(
		chunks.length >= 4,
		`expected the 600-clip timeline to chunk, got ${chunks.length} chunks`
	);
	const spanning = chunks.slice(1).every((chunk) => chunk.spanningIds.length);
	ensure(spanning, "the picture-in-picture clip should cross every chunk edge");
	const chunkStarted = performance.now();
	await runProgram(program, work);
	const chunkSeconds = (performance.now() - chunkStarted) / 1000;

	const [oneStreams, chunkStreams] = await Promise.all([
		streams(onePass),
		streams(chunked),
	]);
	const frames = (list: typeof oneStreams) =>
		Number(
			list.find((stream) => stream.codec_type === "video")?.nb_read_frames
		);
	ensure(
		frames(oneStreams) === frames(chunkStreams),
		`frame counts differ: one pass ${frames(oneStreams)}, chunked ${frames(chunkStreams)}`
	);
	ensure(
		frames(chunkStreams) === CLIPS * CLIP_SECONDS * FPS,
		`expected ${CLIPS * CLIP_SECONDS * FPS} frames, got ${frames(chunkStreams)}`
	);
	ensure(
		chunkStreams.some((stream) => stream.codec_type === "audio"),
		"the chunked export has no audio"
	);

	const psnr = await framePsnr(onePass, chunked, join(directory, "psnr.log"));
	const edges = chunks.slice(1).map((chunk) => chunk.startFrame);
	const checked: string[] = [];
	for (const edge of edges) {
		for (const frame of [edge - 1, edge, edge + 1]) {
			const value = psnr.get(frame);
			ensure(value !== undefined, `no PSNR for frame ${frame}`);
			ensure(
				value > PSNR_FLOOR,
				`frame ${frame} at a chunk edge differs: PSNR ${value} dB`
			);
			checked.push(
				`${frame}:${Number.isFinite(value) ? value.toFixed(1) : "inf"}`
			);
		}
	}
	const onePassAudio = await audioSamples(
		onePass,
		join(directory, "one-pass.f32")
	);
	const chunkedAudio = await audioSamples(
		chunked,
		join(directory, "chunked.f32")
	);
	// Every clip is delayed in samples (`adelay …S`), so the two graphs place
	// every clip on the same sample and encode the same mix.
	const audioError = audioErrorDb(onePassAudio, chunkedAudio);
	const oneMix = join(directory, "one-pass-mix.wav");
	await runOnePass(
		buildRender(project, library, mediaPath, undefined, [], undefined, {
			audioOnly: true,
			overrides: { container: "wav" },
		}).map((arg) => (arg === "pcm_s16le" ? "pcm_f32le" : arg)),
		oneMix,
		directory,
		"one-pass-mix"
	);
	const mix = mixWithinOneSample(
		await audioSamples(oneMix, join(directory, "one-pass-mix.f32")),
		await audioSamples(
			join(work, CHUNK_AUDIO_FILE),
			join(directory, "mix.f32")
		),
		CLIP_SECONDS
	);
	ensure(
		mix.worstDb > AUDIO_ERROR_FLOOR,
		`the chunked mix differs from the one-pass mix by more than one sample: ${mix.worstDb.toFixed(1)} dB`
	);
	ensure(
		mix.shifted === 0,
		`${mix.shifted} blocks of the chunked mix sit one sample off the one-pass mix`
	);
	ensure(
		audioError > AUDIO_ERROR_FLOOR,
		`the chunked export audio differs from the one-pass export: ${audioError.toFixed(1)} dB`
	);
	// The export queue chunks this timeline on its own (default windows) and
	// runs the same program, so its audio is the chunked export's.
	const queueStarted = performance.now();
	const queued = await queueExport(directory, project, library, paths);
	const queueSeconds = (performance.now() - queueStarted) / 1000;
	ensureChunked(queued.steps, "600 clips");
	await ensureSameExport(
		onePass,
		chunkedAudio,
		queued.path,
		directory,
		"600 clips"
	);
	const worst = Math.min(...psnr.values());
	console.info(
		JSON.stringify(
			{
				exportAudioErrorDb: Number.isFinite(audioError)
					? Number(audioError.toFixed(1))
					: "inf",
				mixBlocksOneSampleApart: mix.shifted,
				mixWorstBlockDb: Number.isFinite(mix.worstDb)
					? Number(mix.worstDb.toFixed(1))
					: "inf",
				chunkEdges: edges,
				chunkSeconds: Number(chunkSeconds.toFixed(1)),
				chunks: chunks.length,
				edgeFramesPsnr: checked,
				frames: frames(chunkStreams),
				onePassSeconds: Number(oneSeconds.toFixed(1)),
				queueSeconds: Number(queueSeconds.toFixed(1)),
				queueSteps: queued.steps.length,
				steps: program.steps.map((step) => step.kind),
				worstFramePsnr: Number.isFinite(worst)
					? Number(worst.toFixed(2))
					: "inf",
			},
			null,
			2
		)
	);
	ensure(worst > PSNR_FLOOR, `a frame differs: worst PSNR ${worst} dB`);
}

const directory = await mkdtemp(join(tmpdir(), "ryu-video-studio-long-"));
try {
	await provePhases(directory);
	if (!process.argv.includes("--quick")) {
		await proveLongTimeline(directory);
	}
	console.info("verify-long-timeline: ok");
} finally {
	await rm(directory, { force: true, recursive: true });
}
