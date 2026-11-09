/**
 * Real-FFmpeg proof for library hover-skim frames (W1-L1).
 *
 * 1. A source whose luma encodes time (20 levels per second) is skimmed at
 *    several times; each frame's centre luma must match the time the route
 *    reports, so a pointer position shows the frame it maps to.
 * 2. Requests past the end clamp to a decodable frame near the end.
 * 3. Eight equal concurrent requests run FFmpeg once; a later one is a disk
 *    cache hit with no run. Deleting the asset through the bulk route removes
 *    its cached frames.
 *
 * Run: `bun src/verify-skim.ts`
 */
import {
	chmod,
	mkdtemp,
	readFile,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Asset } from "../../shared/project.ts";
import { mediaBinary, probe, runMedia } from "./media.ts";
import { deleteManyAssets } from "./routes/assets-bulk.ts";
import { assetSkimFrame, skimFrameDirectory } from "./skim-frames.ts";
import { StudioStore } from "./store.ts";

const LUMA_PER_SECOND = 20;
const HEIGHT = 90;

function ensure<Condition>(
	condition: Condition,
	message: string
): asserts condition {
	if (!condition) {
		throw new Error(message);
	}
}

async function grayPixels(jpeg: Uint8Array, directory: string) {
	const input = join(directory, "frame.jpg");
	const output = join(directory, "frame.gray");
	await writeFile(input, jpeg);
	await runMedia([
		"-v",
		"error",
		"-y",
		"-i",
		input,
		"-f",
		"rawvideo",
		"-pix_fmt",
		"gray",
		output,
	]);
	return new Uint8Array(await readFile(output));
}

async function main() {
	const directory = await mkdtemp(join(tmpdir(), "ryu-verify-skim-"));
	const store = new StudioStore(directory);
	try {
		const source = join(directory, "ramp.mp4");
		await runMedia([
			"-v",
			"error",
			"-y",
			"-f",
			"lavfi",
			"-i",
			`color=c=black:s=320x180:r=30:d=10,format=gray,geq=lum='min(255,floor(T*30)/30*${LUMA_PER_SECOND})'`,
			"-c:v",
			"libx264",
			"-qp",
			"0",
			"-pix_fmt",
			"yuv420p",
			source,
		]);
		const asset: Asset = {
			...(await probe(source)),
			createdAt: new Date().toISOString(),
			id: crypto.randomUUID(),
			name: "Ramp",
		};
		await Bun.write(store.mediaPath(asset.id), Bun.file(source));
		store.putAsset(asset);

		const width = 160;
		for (const time of [0.5, 2.25, 4, 7.5, 9.2, 30]) {
			const frame = await assetSkimFrame(store, asset, {
				height: HEIGHT,
				time,
			});
			const pixels = await grayPixels(
				Uint8Array.from(Buffer.from(frame.data, "base64")),
				directory
			);
			ensure(pixels.length === width * HEIGHT, `frame size at ${time}s`);
			const luma =
				pixels[Math.floor(HEIGHT / 2) * width + Math.floor(width / 2)] ?? 0;
			const expected = frame.time * LUMA_PER_SECOND;
			// The frame is the latest at or before the time (one frame is 0.67
			// luma); JPEG and RGB conversion cost a few levels more.
			ensure(
				Math.abs(luma - expected) <= 4,
				`skim at ${time}s (shown ${frame.time}s): luma ${luma}, expected ${expected.toFixed(1)}`
			);
			console.log(
				`skim ${time}s -> ${frame.time}s luma ${luma} (expected ${expected.toFixed(1)})`
			);
		}

		const log = join(directory, "runs.log");
		const wrapper = join(directory, "ffmpeg-wrapper.sh");
		await writeFile(
			wrapper,
			`#!/bin/sh\necho run >> '${log}'\nexec '${mediaBinary("ffmpeg")}' "$@"\n`
		);
		await chmod(wrapper, 0o700);
		const previous = process.env.RYU_VIDEO_STUDIO_FFMPEG;
		process.env.RYU_VIDEO_STUDIO_FFMPEG = wrapper;
		try {
			const request = { height: HEIGHT, time: 5.5 };
			const results = await Promise.all(
				Array.from({ length: 8 }, () => assetSkimFrame(store, asset, request))
			);
			const runs = async () =>
				(await readFile(log, "utf8").catch(() => "")).trim().split("\n").length;
			ensure((await runs()) === 1, "eight equal skims ran FFmpeg once");
			ensure(
				new Set(results.map((result) => result.data)).size === 1,
				"equal skims share one frame"
			);
			const later = await assetSkimFrame(store, asset, request);
			ensure(later.cached, "the later skim is a disk cache hit");
			ensure((await runs()) === 1, "a cache hit runs no FFmpeg");
		} finally {
			if (previous === undefined) {
				Reflect.deleteProperty(process.env, "RYU_VIDEO_STUDIO_FFMPEG");
			} else {
				process.env.RYU_VIDEO_STUDIO_FFMPEG = previous;
			}
		}
		console.log("eight equal skims ran FFmpeg once; cache hit ran none");

		const result = await deleteManyAssets(store, [asset.id]);
		ensure(result.deleted[0] === asset.id, "unused asset deleted");
		const cacheLeft = await stat(skimFrameDirectory(store, asset.id)).then(
			() => true,
			() => false
		);
		ensure(!cacheLeft, "bulk delete removed the skim cache");
		console.log("bulk delete removed media and skim cache");
		console.log("verify-skim: ok");
	} finally {
		store.close();
		await rm(directory, { force: true, recursive: true });
	}
}

await main();
