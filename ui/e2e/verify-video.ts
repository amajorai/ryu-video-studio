import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { mediaDataUrlBlob } from "../src/bridge.ts";
import { createCoreSpeechHost } from "./core-speech-host.ts";

async function runTool(args: string[]) {
	const process = Bun.spawn({ cmd: args, stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(process.stdout).text(),
		new Response(process.stderr).text(),
		process.exited,
	]);
	if (exitCode !== 0) {
		throw new Error(`${args[0]} failed: ${stderr.slice(-1000)}`);
	}
	return stdout;
}

async function test(_name: string, run: () => Promise<void>) {
	await run();
}
await test("Core completes a real local async video job", async () => {
	const host = await createCoreSpeechHost({ mediaOnly: true, video: true });
	try {
		await host.enableMedia();
		process.stdout.write(
			"Submitting local Wan video generation through Core.\n"
		);
		const result = await host.video(
			"A red ball rolling slowly across a wooden table, fixed camera, daylight"
		);
		assert.ok(Array.isArray(result.data) && result.data.length === 1);
		const item = result.data[0];
		assert.equal(item.mediaType, "video/webm");
		const blob = mediaDataUrlBlob(item.url);
		assert.ok(blob.size > 1000);
		const output = "/tmp/ryu-video-studio-generated-video.webm";
		await Bun.write(output, blob);
		const probe = JSON.parse(
			await runTool([
				"ffprobe",
				"-v",
				"error",
				"-show_entries",
				"stream=codec_name,width,height,r_frame_rate:format=duration",
				"-of",
				"json",
				output,
			])
		) as {
			streams?: Array<{
				codec_name?: string;
				width?: number;
				height?: number;
				r_frame_rate?: string;
			}>;
			format?: { duration?: string };
		};
		assert.equal(probe.streams?.[0]?.codec_name, "vp8");
		assert.equal(probe.streams?.[0]?.width, 128);
		assert.equal(probe.streams?.[0]?.height, 128);
		assert.equal(probe.streams?.[0]?.r_frame_rate, "5/1");
		assert.ok(Number(probe.format?.duration) >= 0.8);
		const frames = `/tmp/ryu-video-studio-frames-${crypto.randomUUID()}`;
		await mkdir(frames, { recursive: true, mode: 0o700 });
		const framePath = `${frames}/selected.rgb`;
		await runTool([
			"ffmpeg",
			"-y",
			"-loglevel",
			"error",
			"-i",
			output,
			"-vf",
			"select=eq(n\\,0)+eq(n\\,4)",
			"-fps_mode",
			"vfr",
			"-frames:v",
			"2",
			"-pix_fmt",
			"rgb24",
			"-f",
			"rawvideo",
			framePath,
		]);
		const pixels = new Uint8Array(await Bun.file(framePath).arrayBuffer());
		const frameSize = 128 * 128 * 3;
		assert.ok(pixels.length >= frameSize * 2);
		let difference = 0;
		for (let index = 0; index < frameSize; index++) {
			difference += Math.abs(pixels[index]! - pixels[frameSize + index]!);
		}
		assert.ok(difference / frameSize > 0.5, "generated frames should differ");
		process.stdout.write(
			`PASS: Core returned ${blob.size} bytes of 128x128 WebM; decoded frame delta ${Math.round(difference / frameSize)}.\n`
		);
	} finally {
		host.stop();
	}
});
