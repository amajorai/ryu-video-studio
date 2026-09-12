import assert from "node:assert/strict";
import { createCoreSpeechHost } from "./core-speech-host.ts";

async function test(_name: string, run: () => Promise<void>) {
	await run();
}
await test("Core preserves real Whisper word alignment", async () => {
	const host = await createCoreSpeechHost();
	try {
		const result = await host.transcribe(
			Bun.file("/tmp/ryu-video-studio-speech.wav")
		);
		assert.ok(
			result.words && result.words.length >= 10,
			"Retain actual engine words"
		);
		assert.ok(result.words.some((word) => /studio/i.test(word.text)));
		assert.ok(
			result.words.every(
				(word) => word.endMs > word.startMs && word.endMs <= 6000
			)
		);
		assert.ok(
			new Set(result.words.map((word) => word.endMs - word.startMs)).size > 3,
			"Real word durations vary with the spoken audio"
		);
		process.stdout.write(
			`PASS: ${result.words.length} measured words retained through Core and shared client. ${JSON.stringify(result.words.slice(0, 5))}\n`
		);
	} finally {
		host.stop();
	}
});
