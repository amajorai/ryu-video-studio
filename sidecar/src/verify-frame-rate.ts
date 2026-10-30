/**
 * Real-FFmpeg proof for frame rates and media probing (W2-X3).
 *
 * 1. Every project rate encodes through `ffmpegFrameRate` (lavfi `r=`, the
 *    `fps` filter and `-r`) and ffprobe reports the exact rational
 *    (`30000/1001` for 29.97, never `2997/100`).
 * 2. `probe()` records `frameRate` and `colorTransfer` for NTSC SDR, PQ and
 *    HLG sources.
 * 3. A project render through `buildRender` carries the project rate. NTSC
 *    project renders also need the encoder to use `ffmpegFrameRate` (W2-E1)
 *    and `validateProject` to accept fractional rates. Until both land that
 *    step is PENDING, which fails the run. `--allow-pending` reports it and
 *    exits 2 instead, so the other checks can be run on their own; it never
 *    prints `ok`.
 *
 * Run: `bun src/verify-frame-rate.ts [--allow-pending]`
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import {
	ffmpegFrameRate,
	fpsRational,
	PROJECT_FRAME_RATES,
} from "../../shared/frame-rate.ts";
import {
	type Asset,
	isWritableProjectFps,
	newProject,
	newSegment,
	type Project,
	type ProjectFps,
} from "../../shared/project.ts";
import { probe, runMedia } from "./media.ts";
import { buildRender } from "./render.ts";

function ensure<Condition>(
	condition: Condition,
	message: string
): asserts condition {
	if (!condition) {
		throw new Error(message);
	}
}

const streamSchema = z.object({
	streams: z
		.array(
			z.object({
				codec_type: z.string().optional(),
				nb_read_frames: z.string().optional(),
				r_frame_rate: z.string().optional(),
			})
		)
		.min(1),
});

async function videoStream(path: string) {
	const output = await runMedia(
		[
			"-v",
			"error",
			"-count_frames",
			"-select_streams",
			"v:0",
			"-show_entries",
			"stream=codec_type,r_frame_rate,nb_read_frames",
			"-of",
			"json",
			path,
		],
		{ probe: true }
	);
	const stream = streamSchema.parse(JSON.parse(output)).streams[0];
	ensure(stream, `${path} has no video stream`);
	return stream;
}

const expectedRational = (fps: number) => {
	const { den, num } = fpsRational(fps);
	return `${num}/${den}`;
};

async function encodeAtRate(
	work: string,
	fps: number,
	seconds: number
): Promise<string> {
	const rate = ffmpegFrameRate(fps);
	const path = join(work, `rate-${fps}.mp4`);
	await runMedia([
		"-hide_banner",
		"-loglevel",
		"error",
		"-y",
		"-f",
		"lavfi",
		"-i",
		`testsrc2=s=160x90:r=${rate}:d=${seconds}`,
		"-vf",
		`fps=${rate}`,
		"-r",
		rate,
		"-c:v",
		"libx264",
		"-preset",
		"ultrafast",
		"-pix_fmt",
		"yuv420p",
		path,
	]);
	return path;
}

async function verifyRates(work: string): Promise<void> {
	for (const fps of PROJECT_FRAME_RATES) {
		const stream = await videoStream(await encodeAtRate(work, fps, 2));
		ensure(
			stream.r_frame_rate === expectedRational(fps),
			`${fps} fps encoded as ${stream.r_frame_rate}, expected ${expectedRational(fps)}`
		);
		const frames = Number(stream.nb_read_frames);
		const expected = Math.round(
			(2 * fpsRational(fps).num) / fpsRational(fps).den
		);
		ensure(
			Math.abs(frames - expected) <= 1,
			`${fps} fps produced ${frames} frames in 2 s, expected ${expected}`
		);
		console.log(
			`  ${fps} fps → r_frame_rate ${stream.r_frame_rate}, ${frames} frames`
		);
	}
	const decimal = await videoStream(
		await (async () => {
			const path = join(work, "decimal-29.97.mp4");
			await runMedia([
				"-hide_banner",
				"-loglevel",
				"error",
				"-y",
				"-f",
				"lavfi",
				"-i",
				"testsrc2=s=160x90:r=29.97:d=1",
				"-r",
				"29.97",
				"-c:v",
				"libx264",
				"-preset",
				"ultrafast",
				path,
			]);
			return path;
		})()
	);
	console.log(
		`  (decimal "-r 29.97" without the helper encodes as ${decimal.r_frame_rate})`
	);
}

async function taggedSource(
	work: string,
	name: string,
	fps: number,
	transfer: string
): Promise<string> {
	const rate = ffmpegFrameRate(fps);
	const path = join(work, `${name}.mov`);
	const hdr = transfer === "bt709" ? "bt709" : "bt2020";
	await runMedia([
		"-hide_banner",
		"-loglevel",
		"error",
		"-y",
		"-f",
		"lavfi",
		"-i",
		`testsrc2=s=320x180:r=${rate}:d=1`,
		"-f",
		"lavfi",
		"-i",
		"sine=frequency=440:sample_rate=48000:duration=1",
		"-c:v",
		"libx264",
		"-preset",
		"ultrafast",
		"-pix_fmt",
		"yuv420p",
		"-color_primaries",
		hdr,
		"-colorspace",
		hdr === "bt709" ? "bt709" : "bt2020nc",
		"-color_trc",
		transfer,
		"-c:a",
		"pcm_s16le",
		"-shortest",
		path,
	]);
	return path;
}

async function verifyProbe(work: string): Promise<Asset> {
	const cases = [
		{ fps: 29.97, name: "ntsc-sdr", transfer: "bt709", want: "bt709" },
		{ fps: 23.976, name: "film-pq", transfer: "smpte2084", want: "pq" },
		{ fps: 59.94, name: "sport-hlg", transfer: "arib-std-b67", want: "hlg" },
		{ fps: 50, name: "pal-sdr", transfer: "bt709", want: "bt709" },
	] as const;
	let palAsset: Asset | undefined;
	for (const item of cases) {
		const path = await taggedSource(work, item.name, item.fps, item.transfer);
		const info = await probe(path);
		ensure(
			info.frameRate === item.fps,
			`${item.name}: probed frameRate ${info.frameRate}, expected ${item.fps}`
		);
		ensure(
			info.colorTransfer === item.want,
			`${item.name}: probed colorTransfer ${info.colorTransfer}, expected ${item.want}`
		);
		console.log(
			`  ${item.name}: frameRate ${info.frameRate}, colorTransfer ${info.colorTransfer}`
		);
		if (item.fps === 50) {
			palAsset = {
				...info,
				createdAt: new Date().toISOString(),
				id: crypto.randomUUID(),
				name: `${item.name}.mov`,
			};
		}
	}
	ensure(palAsset, "the 50 fps source was not probed");
	return palAsset;
}

async function renderProject(
	work: string,
	project: Project,
	asset: Asset,
	sourcePath: string
): Promise<string> {
	const output = join(work, `render-${project.fps}.mp4`);
	await runMedia([...buildRender(project, [asset], () => sourcePath), output], {
		cwd: work,
	});
	return (await videoStream(output)).r_frame_rate ?? "";
}

/** True when the NTSC render step is pending; throws when not allowed. */
async function verifyRender(
	work: string,
	asset: Asset,
	allowPending: boolean
): Promise<boolean> {
	const source = join(work, "pal-sdr.mov");
	const segment = { ...newSegment(asset, 0), sourceOut: 1 };
	const base: Project = {
		...newProject("Frame rate"),
		height: 180,
		segments: [segment],
		width: 320,
	};
	const integer = await renderProject(
		work,
		{ ...base, fps: 50 },
		asset,
		source
	);
	ensure(integer === "50/1", `50 fps project rendered at ${integer}`);
	console.log(`  50 fps project → r_frame_rate ${integer}`);
	const ntsc: ProjectFps = 29.97;
	if (!isWritableProjectFps(ntsc)) {
		const message =
			"PENDING: validateProject still rejects 29.97 (isWritableProjectFps); NTSC project renders wait for that gate and W2-E1's encodeArgs to use ffmpegFrameRate.";
		ensure(allowPending, message);
		console.log(`  ${message}`);
		return true;
	}
	const rendered = await renderProject(
		work,
		{ ...base, fps: ntsc },
		asset,
		source
	);
	const pending = rendered !== expectedRational(ntsc);
	const message = `29.97 fps project rendered at ${rendered}, expected ${expectedRational(ntsc)}${pending ? " (PENDING: render stages must use ffmpegFrameRate)" : ""}`;
	ensure(allowPending || !pending, message);
	console.log(`  ${message}`);
	return pending;
}

const allowPending = process.argv.includes("--allow-pending");
const work = await mkdtemp(join(tmpdir(), "ryu-verify-frame-rate-"));
try {
	console.log("Exact rational rates:");
	await verifyRates(work);
	console.log("Probe frameRate and colorTransfer:");
	const asset = await verifyProbe(work);
	console.log("Project render:");
	if (await verifyRender(work, asset, allowPending)) {
		console.log("verify-frame-rate: PENDING (NTSC project render not exact)");
		process.exitCode = 2;
	} else {
		console.log("verify-frame-rate: ok");
	}
} finally {
	await rm(work, { force: true, recursive: true });
}
