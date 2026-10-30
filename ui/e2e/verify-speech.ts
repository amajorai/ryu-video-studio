import assert from "node:assert/strict";
import { createCoreSpeechHost } from "./core-speech-host.ts";

async function test(_name: string, run: () => Promise<void>) {
	await run();
}
await test("Ryu Core transcribes real synthetic speech with engine timestamps", async () => {
	const speech = await createCoreSpeechHost();
	try {
		const result = await speech.transcribe(
			Bun.file("/tmp/ryu-video-studio-speech.wav")
		);
		assert.ok(
			/video studio/i.test(result.text),
			"Recognize the spoken product name"
		);
		assert.ok(
			/captions/i.test(result.text),
			"Recognize the spoken editing description"
		);
		assert.ok(result.segments.length > 0, "Preserve actual engine timestamps");
		process.stdout.write(
			`${JSON.stringify({
				result: "PASS",
				text: result.text,
				segments: result.segments,
			})}\n`
		);
	} finally {
		speech.stop();
		speech.stop();
	}
});
