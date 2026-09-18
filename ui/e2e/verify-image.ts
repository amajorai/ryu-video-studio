import assert from "node:assert/strict";
import { mediaDataUrlBlob } from "../src/bridge.ts";
import { createCoreSpeechHost } from "./core-speech-host.ts";

async function test(_name: string, run: () => Promise<void>) {
	await run();
}
await test("real local image generation crosses Core's image endpoint", async () => {
	const host = await createCoreSpeechHost({ image: true, mediaOnly: true });
	try {
		await host.enableMedia();
		const images = await host.image({
			prompt:
				"A red bicycle leaning against a brick wall, daylight, realistic photograph",
			count: 1,
		});
		assert.equal(images.length, 1);
		const blob = mediaDataUrlBlob(images[0]!);
		const bytes = Buffer.from(await blob.arrayBuffer());
		assert.equal(bytes.subarray(1, 4).toString(), "PNG");
		assert.equal(bytes.readUInt32BE(16), 512);
		assert.equal(bytes.readUInt32BE(20), 512);
		assert.ok(bytes.length > 10_000);
		await Bun.write("/tmp/ryu-video-studio-generated-image.png", blob);
		process.stdout.write(
			`PASS: Core returned a ${bytes.length}-byte 512x512 image from local diffusion.\n`
		);
	} finally {
		host.stop();
	}
});
