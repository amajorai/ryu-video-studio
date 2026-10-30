/**
 * Real-FFmpeg proof for color mattes and Lottie import (W2-M3).
 *
 * 1. `POST /matte` stores a PNG image asset (`derivation: "matte"`) that
 *    FFmpeg decodes at the requested size and color.
 * 2. Uploading RGBA PNG frames (a white square on a transparent background)
 *    through `POST /lottie-frames` in two ordered chunks and then
 *    `POST /lottie-frames-finish` produces a `derivation: "lottie"` video
 *    asset that ffprobe reports as ProRes with a `yuva444p` pixel format and
 *    the declared frame count; its alpha plane is 0 in the corner and 255
 *    in the middle. The same call returns a browser preview copy: a VP9
 *    WebM proxy (`derivedFromAssetId` = the master) whose alpha, decoded
 *    with libvpx as Chromium does, is also 0 in the corner and 255 in the
 *    middle.
 * 3. A project render with the matte on track 0 and the Lottie video on
 *    track 1 shows the matte color through the transparent corner and the
 *    square in the middle, so the alpha survives into the real render.
 *
 * Run: `bun src/verify-lottie.ts`
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { lottieFinishResponseSchema } from "../../shared/lottie.ts";
import {
	type Asset,
	assetSchema,
	newProject,
	newSegment,
	type Project,
} from "../../shared/project.ts";
import { runMedia } from "./media.ts";
import { buildRender } from "./render.ts";
import { routes } from "./routes/matte.ts";
import { createStudioServer } from "./server.ts";
import { StudioStore } from "./store.ts";

function ensure<Condition>(
	condition: Condition,
	message: string
): asserts condition {
	if (!condition) {
		throw new Error(message);
	}
}

const FRAME_COUNT = 6;
const FRAME_EDGE = 64;
const MATTE_COLOR = "#cc2200";

/** RGB(A) bytes of one pixel of the first frame of `path`. */
async function pixel(
	work: string,
	path: string,
	x: number,
	y: number,
	format: "gray" | "rgb24",
	prefilter = ""
): Promise<number[]> {
	const output = join(work, `pixel-${crypto.randomUUID()}.raw`);
	await runMedia([
		"-hide_banner",
		"-loglevel",
		"error",
		"-y",
		"-i",
		path,
		"-vf",
		// Convert first: crop rounds 1 px down to 0 on subsampled YUV.
		`${prefilter}format=${format},crop=1:1:${x}:${y}`,
		"-frames:v",
		"1",
		"-f",
		"rawvideo",
		output,
	]);
	return [...(await readFile(output))];
}

/** One alpha sample of a VP9 WebM's first frame, decoded with libvpx-vp9. */
async function vp9Alpha(
	work: string,
	path: string,
	x: number,
	y: number
): Promise<number> {
	const output = join(work, `${crypto.randomUUID()}.gray`);
	await runMedia([
		"-hide_banner",
		"-loglevel",
		"error",
		"-y",
		"-c:v",
		"libvpx-vp9",
		"-i",
		path,
		"-vf",
		`alphaextract,format=gray,crop=1:1:${x}:${y}`,
		"-frames:v",
		"1",
		"-f",
		"rawvideo",
		output,
	]);
	return (await readFile(output))[0] ?? -1;
}

const streamSchema = z.object({
	streams: z
		.array(
			z.object({
				codec_name: z.string(),
				nb_frames: z.string(),
				pix_fmt: z.string(),
			})
		)
		.min(1),
});

async function framesBase64(work: string): Promise<string[]> {
	await runMedia([
		"-hide_banner",
		"-loglevel",
		"error",
		"-y",
		"-f",
		"lavfi",
		"-i",
		// drawbox leaves alpha untouched, so overlay an opaque square instead.
		`color=c=black@0:s=${FRAME_EDGE}x${FRAME_EDGE}:r=30,format=rgba[bg];color=c=white:s=32x32:r=30,format=rgba[fg];[bg][fg]overlay=16:16:format=auto`,
		"-frames:v",
		String(FRAME_COUNT),
		"-start_number",
		"0",
		join(work, "source-%02d.png"),
	]);
	return await Promise.all(
		Array.from({ length: FRAME_COUNT }, async (_, index) =>
			(
				await readFile(
					join(work, `source-${String(index).padStart(2, "0")}.png`)
				)
			).toString("base64")
		)
	);
}

async function main() {
	const work = await mkdtemp(join(tmpdir(), "ryu-verify-lottie-"));
	const store = new StudioStore(join(work, "library"));
	const token = crypto.randomUUID();
	const app = createStudioServer({ store, token, port: 0, routes });
	const call = async (path: string, body: unknown) => {
		const response = await fetch(
			`http://127.0.0.1:${app.server.port}/api/video-studio${path}`,
			{
				method: "POST",
				headers: {
					authorization: `Bearer ${token}`,
					"content-type": "application/json",
				},
				body: JSON.stringify(body),
			}
		);
		const payload: unknown = await response.json();
		ensure(
			response.ok,
			`${path} answered ${response.status}: ${JSON.stringify(payload)}`
		);
		return payload;
	};
	try {
		console.log("1. Color matte");
		const matte = assetSchema.parse(
			await call("/matte", {
				color: MATTE_COLOR,
				height: 128,
				width: 128,
			})
		);
		ensure(
			matte.derivation === "matte" && matte.kind === "image",
			"matte asset kind"
		);
		const mattePixel = await pixel(
			work,
			store.mediaPath(matte.id),
			64,
			64,
			"rgb24"
		);
		ensure(
			mattePixel.join() === "204,34,0",
			`matte pixel ${mattePixel.join()}`
		);
		console.log(`  ${matte.width}x${matte.height} PNG, pixel ${mattePixel}`);

		console.log("2. Lottie frames → ProRes 4444 with alpha");
		const frames = await framesBase64(work);
		const sessionId = crypto.randomUUID();
		const meta = {
			fps: 30,
			frameCount: FRAME_COUNT,
			height: FRAME_EDGE,
			name: "Verify square",
			width: FRAME_EDGE,
		};
		await call("/lottie-frames", {
			frames: frames.slice(0, 4),
			index: 0,
			meta,
			sessionId,
		});
		await call("/lottie-frames", {
			frames: frames.slice(4),
			index: 4,
			sessionId,
		});
		const finished = lottieFinishResponseSchema.parse(
			await call("/lottie-frames-finish", { sessionId })
		);
		const lottie = finished.asset;
		ensure(
			lottie.derivation === "lottie" && lottie.kind === "video",
			"lottie asset kind"
		);
		const lottiePath = store.mediaPath(lottie.id);
		const probed = streamSchema.parse(
			JSON.parse(
				await runMedia(
					[
						"-v",
						"error",
						"-select_streams",
						"v:0",
						"-show_entries",
						"stream=codec_name,pix_fmt,nb_frames",
						"-of",
						"json",
						lottiePath,
					],
					{ probe: true }
				)
			)
		).streams[0];
		ensure(probed, "no video stream");
		ensure(probed.codec_name === "prores", `codec ${probed.codec_name}`);
		ensure(probed.pix_fmt.startsWith("yuva444p"), `pix_fmt ${probed.pix_fmt}`);
		ensure(
			probed.nb_frames === String(FRAME_COUNT),
			`frames ${probed.nb_frames}`
		);
		const cornerAlpha = await pixel(
			work,
			lottiePath,
			2,
			2,
			"gray",
			"alphaextract,"
		);
		const centerAlpha = await pixel(
			work,
			lottiePath,
			32,
			32,
			"gray",
			"alphaextract,"
		);
		ensure(cornerAlpha[0] === 0, `corner alpha ${cornerAlpha}`);
		ensure(centerAlpha[0] === 255, `center alpha ${centerAlpha}`);
		console.log(
			`  ${probed.codec_name} ${probed.pix_fmt}, ${probed.nb_frames} frames, alpha corner ${cornerAlpha[0]} / center ${centerAlpha[0]}`
		);

		const preview = finished.preview;
		ensure(preview, "no browser preview copy");
		ensure(
			preview.derivation === "proxy" &&
				preview.derivedFromAssetId === lottie.id &&
				preview.width === lottie.width,
			"preview linkage"
		);
		const previewPath = store.mediaPath(preview.id);
		const previewCorner = await vp9Alpha(work, previewPath, 2, 2);
		const previewCenter = await vp9Alpha(work, previewPath, 32, 32);
		ensure(previewCorner <= 2, `preview corner alpha ${previewCorner}`);
		ensure(previewCenter >= 253, `preview center alpha ${previewCenter}`);
		console.log(
			`  preview: VP9 WebM, alpha corner ${previewCorner} / center ${previewCenter}`
		);

		console.log("3. Render: Lottie over the matte");
		await verifyRender(work, store, matte, lottie);
		console.log("Mattes and Lottie import verified.");
	} finally {
		app.stop();
		store.close();
		await rm(work, { recursive: true, force: true });
	}
}

async function verifyRender(
	work: string,
	store: StudioStore,
	matte: Asset,
	lottie: Asset
) {
	const project: Project = {
		...newProject("Lottie over matte"),
		height: 128,
		segments: [
			{ ...newSegment(matte, 0, 0), sourceOut: lottie.duration },
			newSegment(lottie, 0, 1),
		],
		width: 128,
	};
	const output = join(work, "render.mp4");
	await runMedia(
		[
			...buildRender(project, store.assets(), (id) => store.mediaPath(id)),
			output,
		],
		{ cwd: work }
	);
	const corner = await pixel(work, output, 4, 4, "rgb24");
	const center = await pixel(work, output, 64, 64, "rgb24");
	const near = (actual: number[], expected: number[]) =>
		actual.every(
			(value, index) => Math.abs(value - (expected[index] ?? 0)) <= 12
		);
	ensure(near(corner, [204, 34, 0]), `render corner ${corner}`);
	ensure(near(center, [255, 255, 255]), `render center ${center}`);
	console.log(`  corner ${corner} (matte), center ${center} (square)`);
}

await main();
