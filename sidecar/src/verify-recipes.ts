import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Asset, Project } from "../../shared/project.ts";
import { probe, runMedia } from "./media.ts";
import { createStudioServer } from "./server.ts";
import { type RenderJob, StudioStore } from "./store.ts";

async function test(_name: string, run: () => Promise<void>) {
	await run();
}
await test("production recipes persist, reject stale revisions and render", async () => {
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
			"montage",
			"cinematic",
			"narrated-slides",
			"waveform",
		] as const) {
			const project: Project = await call("/projects", {
				title: `Recipe ${kind}`,
			});
			const input = {
				kind,
				revision: project.revision,
				assetIds:
					kind === "waveform"
						? [assets[0]!.id]
						: assets.slice(0, 2).map((asset) => asset.id),
				audioId: assets[2]!.id,
				shotDuration: 1,
				title: `Recipe ${kind}`,
				format: "landscape",
			};
			const composed: Project = await call(
				`/projects/${project.id}/recipe`,
				input
			);
			assert.equal(composed.revision, 1);
			await assert.rejects(
				call(`/projects/${project.id}/recipe`, input),
				/409/
			);
			assert.equal(store.history(project.id)[0]!.segments.length, 0);
			const queued: RenderJob = await call(
				`/projects/${project.id}/render`,
				{}
			);
			let job = queued;
			for (let attempt = 0; attempt < 1200; attempt++) {
				job = store.jobs().find((value) => value.id === queued.id)!;
				if (job.status === "completed" || job.status === "failed") {
					break;
				}
				await Bun.sleep(100);
			}
			assert.equal(
				job.status,
				"completed",
				`${kind}: ${job.error ?? "render timeout"}`
			);
			const output = await probe(store.renderPath(job.id));
			assert.equal(output.width, 1920);
			assert.equal(output.height, 1080);
			assert.equal(output.hasAudio, true);
			assert.ok(Math.abs(output.duration - 2) < 0.15);
			process.stdout.write(
				`PASS: ${kind} recipe persisted and rendered to 1080p with audio.\n`
			);
		}
	} finally {
		app.stop();
		store.close();
		await rm(directory, { recursive: true, force: true });
	}
});
