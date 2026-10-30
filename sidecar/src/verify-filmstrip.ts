/**
 * Real-FFmpeg proof for timeline filmstrips (W1-T9).
 *
 * 1. A source whose luma encodes time (20 levels per second) is sampled into
 *    a sprite; each tile's centre luma must match its reported sample time,
 *    so frames land where `times` says they do.
 * 2. Ten clips requesting the same sprite at once run FFmpeg exactly once,
 *    and a later request is served from the disk cache with no run at all.
 *
 * Run: `bun src/verify-filmstrip.ts`
 */
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Asset } from "../../shared/project.ts";
import { assetFilmstrip } from "./filmstrip.ts";
import { mediaBinary, probe, runMedia } from "./media.ts";
import { StudioStore } from "./store.ts";

const LUMA_PER_SECOND = 20;
const HEIGHT = 36;

function ensure<Condition>(
	condition: Condition,
	message: string
): asserts condition {
	if (!condition) {
		throw new Error(message);
	}
}

async function grayPixels(png: Uint8Array, directory: string) {
	const input = join(directory, "sprite.png");
	const output = join(directory, "sprite.gray");
	await writeFile(input, png);
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
	const directory = await mkdtemp(join(tmpdir(), "ryu-verify-filmstrip-"));
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
			`color=c=black:s=160x90:r=30:d=10,format=gray,geq=lum='min(255,floor(T*30)/30*${LUMA_PER_SECOND})'`,
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

		// A wide step makes a half-step sampling error (0.67 s, 13 luma) obvious.
		const request = { count: 6, end: 9, height: HEIGHT, start: 1 };
		const sprite = await assetFilmstrip(store, asset, request);
		ensure(sprite.frameHeight === HEIGHT, "sprite height");
		ensure(sprite.frameWidth === 64, `frame width ${sprite.frameWidth}`);
		ensure(sprite.width === 6 * 64, "single row of 6 frames");
		const pixels = await grayPixels(
			Uint8Array.from(Buffer.from(sprite.data, "base64")),
			directory
		);
		ensure(pixels.length === sprite.width * HEIGHT, "decoded sprite size");
		for (const [index, time] of sprite.times.entries()) {
			const x = Math.floor((index + 0.5) * sprite.frameWidth);
			const y = Math.floor(HEIGHT / 2);
			const luma = pixels[y * sprite.width + x] ?? 0;
			const expected = time * LUMA_PER_SECOND;
			// The tile shows the latest frame at or before its sample time (one
			// frame is 0.67 luma); RGB conversion of the sprite costs up to ~2.
			ensure(
				Math.abs(luma - expected) <= 4,
				`tile ${index} at ${time}s: luma ${luma}, expected ${expected.toFixed(1)}`
			);
		}
		console.log(
			`frames land on their sample times: ${sprite.times.map((time) => time.toFixed(2)).join(", ")}`
		);

		// Count FFmpeg runs through a wrapper that logs each invocation.
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
			const shared = { count: 8, end: 6, height: HEIGHT, start: 2 };
			const results = await Promise.all(
				Array.from({ length: 10 }, () => assetFilmstrip(store, asset, shared))
			);
			const runs = async () =>
				(await readFile(log, "utf8").catch(() => "")).trim().split("\n").length;
			ensure((await runs()) === 1, "ten equal clips ran FFmpeg once");
			ensure(
				new Set(results.map((result) => result.data)).size === 1,
				"ten clips share one sprite"
			);
			const later = await assetFilmstrip(store, asset, shared);
			ensure(later.cached, "the later request is a disk cache hit");
			ensure((await runs()) === 1, "a cache hit runs no FFmpeg");
		} finally {
			if (previous === undefined) {
				Reflect.deleteProperty(process.env, "RYU_VIDEO_STUDIO_FFMPEG");
			} else {
				process.env.RYU_VIDEO_STUDIO_FFMPEG = previous;
			}
		}
		console.log(
			"ten equal filmstrip requests ran FFmpeg once; cache hit ran none"
		);
		console.log("verify-filmstrip: ok");
	} finally {
		store.close();
		await rm(directory, { force: true, recursive: true });
	}
}

await main();
