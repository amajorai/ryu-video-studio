import assert from "node:assert/strict";
import { createCoreSpeechHost } from "./core-speech-host.ts";

async function test(_name: string, run: () => Promise<void>) {
	await run();
}
await test("Core synthesizes intelligible local narration on its isolated profile", async () => {
	const host = await createCoreSpeechHost({ narration: true });
	try {
		const audio = await host.speak({
			text: "Welcome to Video Studio. Turn your story into a finished film.",
			voice: "af_heart",
			language: "en-us",
			speed: 1,
		});
		assert.equal(audio.type, "audio/wav");
		assert.ok(audio.size > 24_000);
		const bytes = Buffer.from(await audio.arrayBuffer());
		assert.equal(bytes.subarray(0, 4).toString(), "RIFF");
		assert.equal((await host.ttsInstallation()).installed, true);
		const engines = await host.ttsEngines();
		const rows = Array.isArray(engines) ? engines : engines.data;
		assert.ok(
			rows.some(
				(engine: { id: string; loaded?: boolean }) =>
					engine.id === "kokoro" && engine.loaded
			),
			"The actual Kokoro runtime must be loaded"
		);
		const transcript = await host.transcribe(audio);
		assert.match(transcript.text, /video studio/i);
		assert.match(transcript.text, /finished film/i);
		await Bun.write("/tmp/ryu-video-studio-generated-narration.wav", audio);
		process.stdout.write(
			`PASS: Core Kokoro generated ${audio.size} bytes, and real Whisper recognized: ${transcript.text}\n`
		);
	} finally {
		host.stop();
	}
});
