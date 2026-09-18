import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Asset, newSegment, splitSegment } from "../../shared/project.ts";
import { probe, runMedia } from "./media.ts";
import { createStudioServer } from "./server.ts";
import { type RenderJob, StudioStore } from "./store.ts";

async function test(_name: string, run: () => Promise<void>) {
	await run();
}
await test("slide transitions render in four directions and survive a split", async () => {
	const directory = await mkdtemp(join(tmpdir(), "ryu-recipes-"));
	const store = new StudioStore(directory);
	const token = crypto.randomUUID();
	const app = createStudioServer({ store, token, port: 0 });
	const call = async (path: string, body?: unknown) => {
		const response = await fetch(
			`http://127.0.0.1:${app.server.port}/api/video-studio${path}`,
			{
				method: body === undefined ? "GET" : "POST",
				headers: {
					authorization: `Bearer ${token}`,
					"content-type": "application/json",
				},
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
			}
		);
		const value = await response.json();
		if (!response.ok) {
			throw new Error(`${response.status}: ${JSON.stringify(value)}`);
		}
		return value;
	};
	try {
		const red = join(directory, "red.png");
		const blue = join(directory, "blue.png");
		const wav = join(directory, "voice.wav");
		for (const [color, file] of [
			["red", red],
			["blue", blue],
		]) {
			await runMedia([
				"-y",
				"-f",
				"lavfi",
				"-i",
				`color=${color}:s=320x180`,
				"-frames:v",
				"1",
				file!,
			]);
		}
		await runMedia([
			"-y",
			"-f",
			"lavfi",
			"-i",
			"sine=frequency=440:duration=2",
			"-c:a",
			"pcm_s16le",
			wav,
		]);
		const assets: Asset[] = [];
		for (const file of [red, blue, wav]) {
			const id = crypto.randomUUID();
			const media = await probe(file);
			await Bun.write(store.mediaPath(id), Bun.file(file));
			const asset: Asset = {
				...media,
				id,
				name: file.split("/").at(-1)!,
				createdAt: new Date().toISOString(),
			};
			store.putAsset(asset);
			assets.push(asset);
		}
		for (const kind of [
			"slide-left",
			"slide-right",
			"slide-up",
			"slide-down",
		] as const) {
			const original = store.create(`Transition ${kind}`);
			const incoming = {
				...newSegment(assets[1]!, 0.5, 1),
				sourceOut: 1,
				entryTransition: kind,
				entryDuration: 1,
			};
			const project = store.save({
				...original,
				width: 320,
				height: 180,
				segments: [
					{ ...newSegment(assets[0]!), sourceOut: 2 },
					...(kind === "slide-down" ? splitSegment(incoming, 1) : [incoming]),
				],
			});
			const queued: RenderJob = await call(
				`/projects/${project.id}/render`,
				{}
			);
			let job = queued;
			for (let attempt = 0; attempt < 600; attempt++) {
				job = store.jobs().find((value) => value.id === queued.id)!;
				if (["completed", "failed"].includes(job.status)) {
					break;
				}
				await Bun.sleep(100);
			}
			assert.equal(
				job.status,
				"completed",
				`${kind}: ${job.error ?? "timeout"}`
			);
			assert.equal(job.review?.passed, true, `${kind}: delivery review failed`);
			assert.equal(
				job.review?.checks.find((check) => check.id === "content")?.status,
				"passed",
				`${kind}: content sample check failed`
			);
			const readiness = await call(`/projects/${project.id}/readiness`);
			assert.equal(readiness.exportReady, true, `${kind}: export gate blocked`);
			assert.equal(readiness.ready, true, `${kind}: delivery gate blocked`);
			for (const [at, min, max] of [
				[0.75, 0.15, 0.35],
				[1.25, 0.65, 0.85],
			]) {
				const frame = join(directory, `${kind}-${at}.rgb`);
				await runMedia([
					"-y",
					"-ss",
					String(at),
					"-i",
					store.renderPath(job.id),
					"-frames:v",
					"1",
					"-pix_fmt",
					"rgb24",
					"-f",
					"rawvideo",
					frame,
				]);
				const bytes = new Uint8Array(await Bun.file(frame).arrayBuffer());
				let bluePixels = 0;
				let redPixels = 0;
				for (let i = 0; i < bytes.length; i += 3) {
					if (bytes[i + 2]! > 150 && bytes[i]! < 70) {
						bluePixels++;
					}
					if (bytes[i]! > 150 && bytes[i + 2]! < 70) {
						redPixels++;
					}
				}
				const fraction = bluePixels / (320 * 180);
				assert.ok(
					fraction > min! && fraction < max!,
					`${kind} at ${at}: ${fraction}`
				);
				assert.ok(
					(bluePixels + redPixels) / (320 * 180) > 0.95,
					"Underlying footage remains visible during the transition"
				);
			}
			process.stdout.write(
				`PASS: ${kind} rendered frame coverage and underlying footage.\n`
			);
		}
	} finally {
		app.stop();
		store.close();
		await rm(directory, { recursive: true, force: true });
	}
});
