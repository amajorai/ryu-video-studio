/**
 * Real-FFmpeg proof for continuous speed curves (time remapping).
 *
 * A 4 s source whose luma rises one step per frame carries short tone
 * bursts at source 1.0 s and 3.0 s (on audio piece boundaries) and at
 * 1.37 s and 2.61 s (inside pieces). `POST /projects/:id/speed-curve` gives the
 * clip a 0.2x → 6x → 0.5x custom curve through the sidecar route, and the
 * export (`buildRender`) must:
 *
 * - keep one clip whose length is the curve's exact integral;
 * - place every output frame on the source frame the shared mapping
 *   (`clipSourceOffset`) predicts, within 1.5 source frames or 1.5 output
 *   frames (fast stretches skip source frames);
 * - render the clip's audio along the curve ahead of the graph
 *   (`prepareCurveAudio`, pitch kept by WSOLA) and start every burst where
 *   the curve puts its source moment, within 8 ms, measured on the exact
 *   samples of an audio-only WAV export, with the audio as long as the clip;
 * - without the rendered audio, the `atempo` piece plan still starts every
 *   burst within 30 ms (its tempo is constant inside each 0.25 s piece;
 *   FFmpeg's `atempo` drops about one 21 ms hop whenever its tempo is
 *   commanded mid-stream, so it cannot ramp inside a piece);
 * - bake (`POST /speed-curve/bake`) into 12 constant-speed clips of the same
 *   total length.
 *
 * Run: `bun src/verify-speed-curve.ts`
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type Asset,
	newSegment,
	type Project,
	segmentDuration,
} from "../../shared/project.ts";
import {
	clipSourceOffset,
	clipTimeAtSourceOffset,
	curveUnitDuration,
} from "../../shared/speed-curve.ts";
import { probe, runMedia } from "./media.ts";
import { buildRender } from "./render.ts";
import { createStudioServer } from "./server.ts";
import { StudioStore } from "./store.ts";
import { prepareCurveAudio } from "./varispeed.ts";

function ensure<Condition>(
	condition: Condition,
	message: string
): asserts condition {
	if (!condition) {
		throw new Error(message);
	}
}

const FPS = 30;
const SECONDS = 4;
const BURSTS = [1, 1.37, 2.61, 3];
/** Onset error allowed with the curve audio rendered ahead (seconds). */
const RENDERED_ONSET_TOLERANCE = 0.008;
/** Onset error allowed for the `atempo` piece fallback (seconds). */
const PIECE_ONSET_TOLERANCE = 0.03;
const RATE = 48_000;
const POINTS = [
	{ t: 0, speed: 0.2 },
	{ t: 0.4, speed: 6 },
	{ t: 1, speed: 0.5 },
];

async function run(
	command: string[]
): Promise<{ stderr: string; stdout: string }> {
	const child = Bun.spawn(command, { stderr: "pipe", stdout: "pipe" });
	const [stdout, stderr, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	if (code !== 0) {
		throw new Error(`${command[0]} exited with ${code}: ${stderr.slice(-800)}`);
	}
	return { stderr, stdout };
}

/** Mean luma of every frame of `file`, in order. */
async function frameLuma(file: string): Promise<number[]> {
	const { stdout } = await run([
		"ffmpeg",
		"-hide_banner",
		"-loglevel",
		"error",
		"-i",
		file,
		"-vf",
		"signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-",
		"-an",
		"-f",
		"null",
		"-",
	]);
	return [...stdout.matchAll(/YAVG=([\d.]+)/g)].map((match) =>
		Number(match[1])
	);
}

async function duration(file: string, stream: "a" | "v"): Promise<number> {
	const { stdout } = await run([
		"ffprobe",
		"-v",
		"error",
		"-select_streams",
		`${stream}:0`,
		"-show_entries",
		"stream=duration",
		"-of",
		"default=noprint_wrappers=1:nokey=1",
		file,
	]);
	return Number(stdout.trim());
}

const directory = await mkdtemp(join(tmpdir(), "ryu-verify-speed-curve-"));
const store = new StudioStore(directory);
const token = crypto.randomUUID();
const app = createStudioServer({ store, token, port: 0 });
const post = async (path: string, body: Record<string, unknown>) => {
	const response = await fetch(
		`http://127.0.0.1:${app.server.port}/api/video-studio${path}`,
		{
			body: JSON.stringify(body),
			headers: {
				authorization: `Bearer ${token}`,
				"content-type": "application/json",
			},
			method: "POST",
		}
	);
	const text = await response.text();
	ensure(response.status === 200, text);
	return JSON.parse(text) as Project;
};

try {
	const sourceFile = join(directory, "ramp.mp4");
	const tone = BURSTS.map(
		(at) => `between(t\\,${at}\\,${at + 0.08})*0.8*sin(2*PI*1000*(t-${at}))`
	).join("+");
	await runMedia([
		"-hide_banner",
		"-loglevel",
		"error",
		"-y",
		"-f",
		"lavfi",
		"-i",
		`color=c=black:s=160x128:r=${FPS}:d=${SECONDS},format=yuv444p,geq=lum='16+N*1.8':cb=128:cr=128,format=yuv420p`,
		"-f",
		"lavfi",
		"-i",
		`aevalsrc=${tone}:s=48000:d=${SECONDS}`,
		"-c:v",
		"libx264",
		"-qp",
		"0",
		"-c:a",
		"pcm_s16le",
		"-shortest",
		join(directory, "ramp.mov"),
	]);
	await runMedia([
		"-hide_banner",
		"-loglevel",
		"error",
		"-y",
		"-i",
		join(directory, "ramp.mov"),
		"-c:v",
		"copy",
		"-c:a",
		"aac",
		"-b:a",
		"192k",
		sourceFile,
	]);
	const asset: Asset = {
		...(await probe(sourceFile)),
		createdAt: new Date().toISOString(),
		id: crypto.randomUUID(),
		name: "Luma ramp",
	};
	await Bun.write(store.mediaPath(asset.id), Bun.file(sourceFile));
	store.putAsset(asset);
	const clip = { ...newSegment(asset, 0, 0), sourceOut: SECONDS };
	const created = store.save({
		...store.create("Speed curve proof"),
		fps: FPS,
		height: 128,
		segments: [clip],
		width: 160,
	});
	const render = async (
		project: Project,
		name: string,
		curveAudio?: Map<string, string>
	) => {
		const output = join(directory, `${name}.mp4`);
		const args = buildRender(
			project,
			[asset],
			() => sourceFile,
			undefined,
			[],
			undefined,
			curveAudio ? { curveAudio } : {}
		);
		await runMedia([...args, output], { cwd: directory });
		return output;
	};
	/** Burst onsets (seconds) on the exact samples of an audio-only export. */
	const sampleOnsets = async (
		project: Project,
		name: string,
		curveAudio?: Map<string, string>
	) => {
		const output = join(directory, `${name}.f32`);
		const args = buildRender(
			project,
			[asset],
			() => sourceFile,
			undefined,
			[],
			undefined,
			{
				audioOnly: true,
				overrides: { container: "wav" },
				...(curveAudio ? { curveAudio } : {}),
			}
		);
		const wav = join(directory, `${name}.wav`);
		await runMedia([...args, wav], { cwd: directory });
		await runMedia([
			"-hide_banner",
			"-loglevel",
			"error",
			"-y",
			"-i",
			wav,
			"-ac",
			"1",
			"-f",
			"f32le",
			"-c:a",
			"pcm_f32le",
			output,
		]);
		const samples = new Float32Array(await Bun.file(output).arrayBuffer());
		const found: number[] = [];
		let quiet = Number.POSITIVE_INFINITY;
		for (const [index, value] of samples.entries()) {
			if (Math.abs(value) >= 0.1) {
				if (quiet > RATE * 0.02) {
					found.push(index / RATE);
				}
				quiet = 0;
			} else {
				quiet++;
			}
		}
		return found;
	};
	/** Worst onset error of the bursts against the curve, and the onsets. */
	const onsetErrors = (found: number[], clipStart: number) =>
		BURSTS.map((at) => {
			// The burst first reaches 0.1 a little after it starts.
			const rise = Math.asin(0.1 / 0.8) / (2 * Math.PI * 1000);
			const expected =
				clipStart + clipTimeAtSourceOffset(segmentOf(), at + rise);
			const nearest = found.reduce(
				(best, value) =>
					Math.abs(value - expected) < Math.abs(best - expected) ? value : best,
				Number.POSITIVE_INFINITY
			);
			return { at, error: Math.abs(nearest - expected), expected, nearest };
		});
	let curvedSegment: Project["segments"][number] | undefined;
	const segmentOf = () => {
		ensure(curvedSegment, "no curved clip yet");
		return curvedSegment;
	};

	// Baseline: the source decoded through the same render at 1x.
	const baseline = await frameLuma(await render(created, "baseline"));
	ensure(baseline.length >= SECONDS * FPS - 1, "baseline frames missing");
	const sourceFrameOf = (luma: number) => {
		let best = 0;
		for (const [index, value] of baseline.entries()) {
			if (Math.abs(value - luma) < Math.abs((baseline[best] ?? 0) - luma)) {
				best = index;
			}
		}
		return best;
	};

	const curved = await post(`/projects/${created.id}/speed-curve`, {
		clipId: clip.id,
		points: POINTS,
		preset: "custom",
		revision: created.revision,
	});
	ensure(curved.segments.length === 1, "a curve keeps one clip");
	const segment = curved.segments[0];
	ensure(segment?.speedCurve, "the clip stores its speed curve");
	curvedSegment = segment;
	const length = segmentDuration(segment);
	const expectedLength = SECONDS * curveUnitDuration(POINTS);
	ensure(
		Math.abs(length - expectedLength) < 1e-3,
		`clip length ${length} is not the curve integral ${expectedLength}`
	);

	const curveAudio = await prepareCurveAudio(
		curved,
		[asset],
		() => sourceFile,
		join(directory, "curve-audio")
	);
	ensure(curveAudio.has(segment.id), "the curved clip's audio was rendered");
	const output = await render(curved, "curved", curveAudio);
	const lumas = await frameLuma(output);
	let worst = 0;
	for (const [index, luma] of lumas.entries()) {
		const time = index / FPS;
		if (time > length - 1 / FPS) {
			break;
		}
		// A frame is on the curve when it shows the source frame the mapping
		// predicts (within 1.5 source frames, for slow stretches) or the clip
		// time of the frame it shows is within one output frame (fast ones,
		// where one output frame spans several source frames).
		const shown = sourceFrameOf(luma);
		const sourceError = Math.abs(shown - clipSourceOffset(segment, time) * FPS);
		const timeError =
			Math.abs(clipTimeAtSourceOffset(segment, shown / FPS) - time) * FPS;
		worst = Math.max(worst, Math.min(sourceError, timeError));
	}
	ensure(
		worst <= 1.5,
		`output frames drift ${worst.toFixed(2)} frames from the curve`
	);

	const rendered = onsetErrors(
		await sampleOnsets(curved, "curved-audio", curveAudio),
		0
	);
	for (const burst of rendered) {
		ensure(
			burst.error <= RENDERED_ONSET_TOLERANCE,
			`rendered curve audio: the burst at source ${burst.at}s starts at ${burst.nearest.toFixed(4)}s, expected ${burst.expected.toFixed(4)}s`
		);
	}
	const pieceOnsets = await sampleOnsets(curved, "piece-audio");
	const pieces = onsetErrors(pieceOnsets, 0);
	for (const burst of pieces) {
		ensure(
			burst.error <= PIECE_ONSET_TOLERANCE,
			`atempo pieces: the burst at source ${burst.at}s starts at ${burst.nearest.toFixed(4)}s, expected ${burst.expected.toFixed(4)}s`
		);
	}
	const found = rendered.map((burst) => burst.nearest);
	const audioLength = await duration(output, "a");
	ensure(
		Math.abs(audioLength - length) <= 0.1,
		`audio runs ${audioLength}s for a ${length.toFixed(3)}s clip`
	);

	const baked = await post(`/projects/${created.id}/speed-curve/bake`, {
		clipId: clip.id,
		revision: curved.revision,
		steps: 12,
	});
	ensure(baked.segments.length === 12, "baking makes 12 clips");
	const bakedLength = baked.segments.reduce(
		(total, step) => total + segmentDuration(step),
		0
	);
	ensure(
		Math.abs(bakedLength - length) < 0.01,
		`baked clips run ${bakedLength}s, the curve ${length}s`
	);
	const worstMs = (list: typeof rendered) =>
		(Math.max(...list.map((burst) => burst.error)) * 1000).toFixed(2);
	process.stdout.write(
		`PASS: one curved clip (${length.toFixed(3)}s) tracks the curve within ${worst.toFixed(2)} frames; burst onsets ${found.map((value) => value.toFixed(4)).join(", ")}s (worst ${worstMs(rendered)} ms rendered along the curve, ${worstMs(pieces)} ms through atempo pieces); audio ${audioLength.toFixed(3)}s; baked into 12 clips (${bakedLength.toFixed(3)}s).\n`
	);
} finally {
	app.stop();
	store.close();
	await rm(directory, { force: true, recursive: true });
}
