import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Asset, newSegment } from "../../shared/project.ts";
import { waveformPoints } from "../../shared/waveform.ts";
import { extractAudioWindow } from "./audio-window.ts";
import { probe, runMedia } from "./media.ts";
import { RenderQueue } from "./render.ts";
import { StudioStore } from "./store.ts";

async function test(_name: string, run: () => Promise<void>) {
	await run();
}
function pcmFromDataUrl(dataUrl: string): Float32Array {
	const wav = Buffer.from(dataUrl.split(",")[1]!, "base64");
	let offset = 12;
	while (wav.toString("ascii", offset, offset + 4) !== "data") {
		offset += 8 + wav.readUInt32LE(offset + 4);
		if (offset >= wav.length) {
			throw new Error("Missing PCM data");
		}
	}
	const count = wav.readUInt32LE(offset + 4) / 2;
	const pcm = new Float32Array(count);
	for (let index = 0; index < count; index++) {
		pcm[index] = wav.readInt16LE(offset + 8 + index * 2) / 32_768;
	}
	return pcm;
}
await test("preview waveform windows match rendered timing at normal, slow and fast speed", async () => {
	const directory = await mkdtemp(join(tmpdir(), "ryu-waveform-timing-"));
	const store = new StudioStore(directory);
	try {
		const id = crypto.randomUUID();
		const file = join(directory, "pulses.wav");
		await runMedia([
			"-y",
			"-f",
			"lavfi",
			"-i",
			"aevalsrc=if(lt(mod(t\\,0.4)\\,0.2)\\,0.8*sin(2*PI*220*t)\\,0):d=4:s=16000",
			"-c:a",
			"pcm_s16le",
			file,
		]);
		await Bun.write(store.mediaPath(id), Bun.file(file));
		const asset: Asset = {
			...(await probe(file)),
			id,
			name: "Pulse source",
			createdAt: new Date().toISOString(),
		};
		store.putAsset(asset);
		for (const [speed, fps] of [
			[1, 30],
			[0.5, 30],
			[2, 30],
			[1, 60],
			[2, 60],
		] as const) {
			const segment = {
				...newSegment(asset),
				sourceIn: 0.18,
				sourceOut: 3.9,
				speed,
				visualization: "waveform" as const,
				waveformHeight: 0.8,
			};
			const project = store.save({
				...store.create(`Waveform ${speed}`),
				width: 320,
				height: 180,
				fps,
				segments: [segment],
			});
			const window = await extractAudioWindow(store, asset, segment.sourceIn, {
				sourceOut: segment.sourceOut,
				speed,
				offset: 0,
			});
			const pcm = pcmFromDataUrl(window.dataUrl);
			const later = pcmFromDataUrl(
				(
					await extractAudioWindow(store, asset, segment.sourceIn, {
						sourceOut: segment.sourceOut,
						speed,
						offset: 1,
					})
				).dataUrl
			);
			for (let sample = 64; sample < 1024; sample++) {
				assert.ok(
					Math.abs(later[sample]! - pcm[16_000 + sample]!) < 0.001,
					"Later windows retain the same time-stretch context"
				);
			}

			const queue = new RenderQueue(store);
			const queued = queue.start(project);
			let job = queued;
			for (let attempt = 0; attempt < 900; attempt++) {
				job = store.jobs().find((item) => item.id === queued.id)!;
				if (["completed", "failed"].includes(job.status)) {
					break;
				}
				await Bun.sleep(100);
			}
			assert.equal(job.status, "completed", job.error);
			for (const time of [0, 0.3, 0.7, 1, 1.3]) {
				const points = waveformPoints([pcm], 16_000, time, fps, 1600);
				const expected = (Math.max(...points.map(Math.abs)) * 180 * 0.8) / 2;
				const frame = join(directory, "frame.rgb");
				await runMedia([
					"-y",
					"-i",
					store.renderPath(job.id),
					"-vf",
					`select=eq(n\\,${Math.round(time * fps)})`,
					"-fps_mode",
					"passthrough",
					"-frames:v",
					"1",
					"-pix_fmt",
					"rgb24",
					"-f",
					"rawvideo",
					frame,
				]);
				const pixels = new Uint8Array(await Bun.file(frame).arrayBuffer());
				let observed = 0;
				for (let y = 0; y < 180; y++) {
					for (let x = 0; x < 320; x++) {
						if (pixels[(y * 320 + x) * 3]! > 150) {
							observed = Math.max(observed, Math.abs(y - 90));
						}
					}
				}
				assert.ok(
					Math.abs(expected - observed) < 5,
					`speed ${speed} at ${time}: preview ${expected}, export ${observed}`
				);
			}
			process.stdout.write(
				`PASS: preview/export waveform timing at ${speed}x / ${fps}fps.\n`
			);
		}
	} finally {
		store.close();
		await rm(directory, { recursive: true, force: true });
	}
});
