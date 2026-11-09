/**
 * Real-FFmpeg proof for W2-E1 export formats. Renders a 2 s fixture through
 * `POST /projects/:id/render` in every container and checks the result with
 * ffprobe: codec, pixel format, alpha, duration (ranges), frame size and
 * audio presence. Run: `bun sidecar/src/verify-export-formats.ts`.
 */
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Asset, newSegment, type Project } from "../../shared/project.ts";
import {
	type ExportJobOutput,
	exportJobOutputSchema,
	type RenderRequest,
} from "../../shared/render-options.ts";
import { probe, runMedia } from "./media.ts";
import { createStudioServer } from "./server.ts";
import { type RenderJob, StudioStore } from "./store.ts";

type ExportJob = RenderJob & { export?: ExportJobOutput };

function ensure<Condition>(
	condition: Condition,
	message: string
): asserts condition {
	if (!condition) {
		throw new Error(message);
	}
}

function same(actual: unknown, expected: unknown, label = "value") {
	const left = JSON.stringify(actual);
	const right = JSON.stringify(expected);
	ensure(left === right, `${label}: expected ${right}, received ${left}`);
}

interface StreamFacts {
	codec_name?: string;
	codec_type?: string;
	color_transfer?: string;
	height?: number;
	nb_read_frames?: string;
	pix_fmt?: string;
	r_frame_rate?: string;
	tags?: Record<string, string>;
	width?: number;
}

function ffprobe(path: string): { duration: number; streams: StreamFacts[] } {
	const result = spawnSync(
		"ffprobe",
		[
			"-v",
			"error",
			"-show_entries",
			"format=duration:stream=codec_name,codec_type,width,height,pix_fmt,color_transfer,r_frame_rate:stream_tags",
			"-of",
			"json",
			path,
		],
		{ encoding: "utf8" }
	);
	same(result.status, 0, result.stderr);
	const parsed = JSON.parse(result.stdout) as {
		format?: { duration?: string };
		streams?: StreamFacts[];
	};
	return {
		duration: Number(parsed.format?.duration ?? 0),
		streams: parsed.streams ?? [],
	};
}

const FRAME_WIDTH = 320;
const FRAME_HEIGHT = 180;

/**
 * Alpha of one RGBA pixel from the first frame, decoded with `decoder`. The
 * whole frame is read because libvpx reconfigures the graph after its first
 * frame, which a crop filter cannot survive.
 */
function alphaAt(
	path: string,
	x: number,
	y: number,
	decoder: string[] = []
): number {
	const result = spawnSync(
		"ffmpeg",
		[
			"-v",
			"error",
			...decoder,
			"-i",
			path,
			"-frames:v",
			"1",
			"-vf",
			"format=rgba",
			"-f",
			"rawvideo",
			"-",
		],
		{ maxBuffer: FRAME_WIDTH * FRAME_HEIGHT * 4 * 2 }
	);
	same(result.status, 0, String(result.stderr));
	const frame = result.stdout as Buffer;
	same(frame.length, FRAME_WIDTH * FRAME_HEIGHT * 4, "one RGBA frame");
	return frame[(y * FRAME_WIDTH + x) * 4 + 3] ?? -1;
}

const directory = await mkdtemp(join(tmpdir(), "ryu-verify-export-"));
const store = new StudioStore(directory);
const token = crypto.randomUUID();
const app = createStudioServer({ store, token, port: 0 });
const results: string[] = [];

async function call(path: string, body?: unknown): Promise<ExportJob> {
	const response = await fetch(
		`http://127.0.0.1:${app.server.port}/api/video-studio${path}`,
		{
			method: body === undefined ? "GET" : "POST",
			headers: {
				authorization: `Bearer ${token}`,
				"content-type": "application/json",
			},
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		}
	);
	const value = await response.json();
	if (!response.ok) {
		throw new Error(`${response.status}: ${JSON.stringify(value)}`);
	}
	return value;
}

async function importFixture(name: string, args: string[]): Promise<Asset> {
	const file = join(directory, name);
	await runMedia(["-hide_banner", "-loglevel", "error", "-y", ...args, file]);
	const asset: Asset = {
		...(await probe(file)),
		id: crypto.randomUUID(),
		name,
		createdAt: new Date().toISOString(),
	};
	await Bun.write(store.mediaPath(asset.id), Bun.file(file));
	store.putAsset(asset);
	return asset;
}

async function render(project: Project, request: RenderRequest) {
	const queued = await call(`/projects/${project.id}/render`, request);
	for (let attempt = 0; attempt < 1200; attempt++) {
		const job = store.jobs().find((value) => value.id === queued.id) as
			| ExportJob
			| undefined;
		if (job && ["completed", "failed", "canceled"].includes(job.status)) {
			same(job.status, "completed", job.error ?? "export failed");
			return {
				job,
				// The empty (legacy) request records no export summary.
				output: exportJobOutputSchema.parse(
					job.export ?? {
						alpha: false,
						container: "mp4",
						duration: 0,
						extension: "mp4",
						height: 1,
						includeAudio: true,
						kind: "video",
						label: "MP4",
						mime: "video/mp4",
						warnings: [],
						width: 1,
					}
				),
				path: store.renderPath(job.id, job.codec),
			};
		}
		await Bun.sleep(50);
	}
	throw new Error("export timed out");
}

function stream(facts: ReturnType<typeof ffprobe>, type: "video" | "audio") {
	return facts.streams.find((candidate) => candidate.codec_type === type);
}

function near(
	actual: number,
	expected: number,
	label: string,
	tolerance = 0.15
) {
	ensure(
		Math.abs(actual - expected) <= tolerance,
		`${label}: expected ${expected}s, received ${actual}s`
	);
}

function pass(message: string) {
	results.push(message);
	process.stdout.write(`PASS: ${message}\n`);
}

try {
	const source = await importFixture("source.mp4", [
		"-f",
		"lavfi",
		"-i",
		"testsrc2=s=320x180:r=30:d=2",
		"-f",
		"lavfi",
		"-i",
		"sine=frequency=440:duration=2",
		"-c:v",
		"libx264",
		"-pix_fmt",
		"yuv420p",
		"-c:a",
		"aac",
		"-shortest",
	]);
	const pqSource = await importFixture("pq.mp4", [
		"-f",
		"lavfi",
		"-i",
		"testsrc2=s=320x180:r=30:d=2",
		"-c:v",
		"libx264",
		"-pix_fmt",
		"yuv420p",
		"-color_primaries",
		"bt2020",
		"-color_trc",
		"smpte2084",
		"-colorspace",
		"bt2020nc",
	]);
	same(pqSource.colorTransfer, "pq", "the PQ fixture probes as PQ");
	const base = {
		...store.create("Export formats"),
		fps: 30 as const,
		width: 320,
		height: 180,
	};
	const full = store.save({
		...base,
		segments: [{ ...newSegment(source, 0, 0), sourceOut: 2 }],
	});
	// A half-size clip in the centre leaves transparent corners for alpha.
	const inset = store.save({
		...store.create("Alpha"),
		fps: 30,
		width: 320,
		height: 180,
		segments: [{ ...newSegment(source, 0, 0), sourceOut: 2, scale: 0.5 }],
	});
	const hdr = store.save({
		...store.create("HDR"),
		fps: 30,
		width: 320,
		height: 180,
		segments: [{ ...newSegment(pqSource, 0, 0), sourceOut: 2 }],
	});

	{
		const { path } = await render(full, {});
		const facts = ffprobe(path);
		same(stream(facts, "video")?.codec_name, "h264");
		same(stream(facts, "video")?.pix_fmt, "yuv420p");
		same(stream(facts, "audio")?.codec_name, "aac");
		near(facts.duration, 2, "default duration");
		pass("default request: H.264/AAC MP4, 2 s, unchanged legacy export");
	}
	{
		const { path, output } = await render(full, {
			range: { start: 0.5, end: 1.5 },
		});
		const facts = ffprobe(path);
		near(facts.duration, 1, "range duration", 0.1);
		ensure(stream(facts, "audio"), "range keeps audio");
		same(output.range, { start: 0.5, end: 1.5 });
		pass("range 0.5-1.5 s: MP4 duration 1 s with audio");
	}
	{
		const { path } = await render(full, {
			overrides: { container: "mov", includeAudio: false },
		});
		const facts = ffprobe(path);
		same(stream(facts, "video")?.codec_name, "h264");
		same(stream(facts, "audio"), undefined, "audio was excluded");
		pass("includeAudio=false: H.264 MOV without an audio stream");
	}
	{
		const { path } = await render(full, { codec: "h265-10bit" });
		const video = stream(ffprobe(path), "video");
		same(video?.codec_name, "hevc");
		same(video?.pix_fmt, "yuv420p10le");
		pass("HEVC 10-bit: hevc yuv420p10le");
	}
	{
		const { path } = await render(hdr, {
			codec: "h265-10bit",
			overrides: { hdr: "auto" },
		});
		const video = stream(ffprobe(path), "video");
		same(video?.color_transfer, "smpte2084");
		pass("HEVC 10-bit with hdr=auto from a PQ source: tagged smpte2084");
	}
	{
		const { path, output } = await render(inset, {
			overrides: { container: "mov", alpha: true },
		});
		const video = stream(ffprobe(path), "video");
		same(video?.codec_name, "prores");
		// The ProRes decoder reports 4444 as yuva444p10le or yuva444p12le.
		ensure(
			/^yuva444p1[02]le$/.test(video?.pix_fmt ?? ""),
			`ProRes 4444 pixel format ${video?.pix_fmt}`
		);
		same(output.codec, "prores-4444");
		same(alphaAt(path, 4, 4), 0, "corner is transparent");
		same(alphaAt(path, 160, 90), 255, "centre is opaque");
		pass(
			"alpha MOV: ProRes 4444 with an alpha plane, transparent corner, opaque centre"
		);
	}
	{
		// A project blur fills around base-track clips per clip; a transparent
		// export replaces the canvas, so that fill must not cover the corners.
		const blurred = store.save({
			...inset,
			background: { amount: 0.5, dim: 0.2, type: "blur" },
		});
		const { path } = await render(blurred, {
			overrides: { container: "mov", alpha: true },
		});
		same(alphaAt(path, 4, 4), 0, "blur-background corner is transparent");
		same(alphaAt(path, 160, 90), 255, "blur-background centre is opaque");
		pass(
			"alpha MOV with a project blur background: the blur fill is dropped, corner stays transparent"
		);
	}
	{
		const { path } = await render(full, {
			overrides: { container: "webm", crf: 34, encoderPreset: "ultrafast" },
		});
		const facts = ffprobe(path);
		same(stream(facts, "video")?.codec_name, "vp9");
		same(stream(facts, "audio")?.codec_name, "opus");
		near(facts.duration, 2, "webm duration");
		pass("WebM: VP9 + Opus");
	}
	{
		const { path } = await render(inset, {
			overrides: { container: "webm", alpha: true, encoderPreset: "ultrafast" },
		});
		const video = stream(ffprobe(path), "video");
		same(video?.codec_name, "vp9");
		same(video?.tags?.alpha_mode ?? video?.tags?.ALPHA_MODE, "1");
		const libvpx = ["-c:v", "libvpx-vp9"];
		same(alphaAt(path, 4, 4, libvpx), 0, "VP9 corner is transparent");
		same(alphaAt(path, 160, 90, libvpx), 255, "VP9 centre is opaque");
		pass(
			"alpha WebM: VP9 with alpha_mode=1, transparent corner, opaque centre"
		);
	}
	{
		const { path, output } = await render(full, {
			range: { start: 0, end: 1 },
			overrides: { container: "gif", gifWidth: 160, gifFps: 10 },
		});
		const facts = ffprobe(path);
		const video = stream(facts, "video");
		same(video?.codec_name, "gif");
		same(video?.width, 160);
		same(video?.height, 90);
		same(output.kind, "gif");
		near(facts.duration, 1, "gif duration", 0.15);
		pass("GIF: palette GIF 160x90, 1 s range");
	}
	{
		const { path } = await render(full, {
			range: { start: 0, end: 1 },
			overrides: {
				container: "gif",
				gifWidth: 160,
				outputHeight: 160,
				outputWidth: 160,
			},
		});
		const video = stream(ffprobe(path), "video");
		same(video?.width, 160);
		same(video?.height, 160);
		const frame = spawnSync(
			"ffmpeg",
			[
				"-v",
				"error",
				"-i",
				path,
				"-frames:v",
				"1",
				"-f",
				"rawvideo",
				"-pix_fmt",
				"rgb24",
				"-",
			],
			{ maxBuffer: 160 * 160 * 3 * 2 }
		);
		same(frame.status, 0, String(frame.stderr));
		const pixels = frame.stdout as Buffer;
		const luma = (x: number, y: number) => {
			const index = (y * 160 + x) * 3;
			return (
				(pixels[index] ?? 0) +
				(pixels[index + 1] ?? 0) +
				(pixels[index + 2] ?? 0)
			);
		};
		ensure(luma(80, 4) < 30, "GIF top bar is black (letterboxed)");
		ensure(luma(80, 80) > 30, "GIF centre carries the picture");
		pass("GIF: 160x160 output letterboxes a 16:9 canvas instead of stretching");
	}
	{
		const stored = store.save({
			...full,
			exportSettings: { container: "wav", platformPreset: "podcast-audio" },
		});
		const { job, output } = await render(stored, {});
		same(job.codec, undefined, "audio job has no codec");
		same(output.container, "wav");
		same(output.mime, "audio/wav");
		ensure(Boolean(output.metadata), "preset metadata recorded");
		same(
			stream(ffprobe(store.renderPath(job.id, job.codec)), "audio")?.codec_name,
			"pcm_s16le"
		);
		store.save({ ...stored, exportSettings: undefined });
		pass(
			"body-less export of stored WAV settings records its file type and metadata"
		);
	}
	for (const [container, codec] of [
		["wav", "pcm_s16le"],
		["mp3", "mp3"],
		["aac", "aac"],
	] as const) {
		const { path, output } = await render(full, {
			audioOnly: true,
			range: { start: 0.5, end: 1.5 },
			overrides: { container },
		});
		const facts = ffprobe(path);
		same(stream(facts, "video"), undefined, `${container} has no video`);
		same(stream(facts, "audio")?.codec_name, codec);
		near(facts.duration, 1, `${container} duration`, 0.1);
		same(output.kind, "audio");
		pass(`audio-only ${container}: ${codec}, 1 s range, no video`);
	}
	{
		const { path, output } = await render(full, {
			overrides: { container: "png-sequence" },
		});
		same(output.frames, 60);
		const listing = spawnSync("unzip", ["-l", path], { encoding: "utf8" });
		if (!listing.error) {
			same(listing.status, 0, listing.stderr);
			same(
				listing.stdout.match(/frame_\d{6}\.png/g)?.length,
				60,
				"zip lists 60 PNG frames"
			);
			const test = spawnSync("unzip", ["-t", path], { encoding: "utf8" });
			same(test.status, 0, "zip integrity");
		}
		pass("PNG sequence: 60 frames zipped (unzip -t passes)");
	}
	{
		const { output } = await render(full, {
			range: { start: 1, end: 2 },
			overrides: { container: "jpeg-sequence" },
		});
		same(output.frames, 30);
		pass("JPEG sequence: 1 s range -> 30 frames");
	}
	{
		const { path } = await render(full, {
			overrides: {
				outputWidth: 640,
				outputHeight: 640,
				rateControl: "cbr",
				bitrateKbps: 1500,
			},
		});
		const video = stream(ffprobe(path), "video");
		same(video?.width, 640);
		same(video?.height, 640);
		pass("output size 640x640 (letterboxed) with CBR");
	}
	{
		const { output, job } = await render(full, {
			saveAsAsset: true,
			overrides: { platformPreset: "tiktok" },
		});
		same(output.width, 1080);
		same(output.height, 1920);
		ensure(
			output.warnings.some((warning) => warning.includes("letterboxed")),
			"TikTok warns about letterboxing"
		);
		ensure(
			output.metadata?.startsWith("Title: Export formats"),
			"TikTok metadata title"
		);
		const asset = store.assets().find((value) => value.id === output.assetId);
		same(asset?.derivation, "render");
		same(asset?.width, 1080);
		ensure(job.review?.passed, "TikTok delivery review passed");
		pass("TikTok preset: 1080x1920 with metadata.txt and a library asset");
	}
	for (const [codec, codecName, extension] of [
		["h265-10bit", "hevc", "mp4"],
		["prores-4444", "prores", "mov"],
		["vp9", "vp9", "webm"],
	] as const) {
		// W2 lifted the W0 codec gate: a project may store these codecs and a
		// body-less render encodes them.
		const stored = store.save({
			...store.create(`Stored ${codec}`),
			exportCodec: codec,
			fps: 30,
			height: 180,
			segments: [{ ...newSegment(source, 0, 0), sourceOut: 2 }],
			width: 320,
		});
		same(stored.exportCodec, codec, `project stores ${codec}`);
		const { path, output } = await render(stored, {});
		same(stream(ffprobe(path), "video")?.codec_name, codecName);
		same(output.extension, extension, `${codec} extension`);
		pass(`project exportCodec ${codec}: body-less render encodes ${codecName}`);
	}
	{
		// W2 lifted the fractional frame-rate gate: an NTSC project renders on
		// the exact 30000/1001 timebase.
		const ntsc = store.save({
			...store.create("NTSC"),
			fps: 29.97,
			height: 180,
			segments: [{ ...newSegment(source, 0, 0), sourceOut: 2 }],
			width: 320,
		});
		same(ntsc.fps, 29.97, "project stores 29.97");
		const { path } = await render(ntsc, {});
		const video = stream(ffprobe(path), "video");
		same(video?.r_frame_rate, "30000/1001", "NTSC r_frame_rate");
		pass("29.97 fps project: r_frame_rate 30000/1001");
	}
	process.stdout.write(`\n${results.length} export checks passed.\n`);
} finally {
	app.stop();
	store.close();
	await rm(directory, { recursive: true, force: true });
}
