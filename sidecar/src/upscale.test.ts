import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assetSchema } from "../../shared/project.ts";
import { probe, runMedia } from "./media.ts";
import { createStudioServer } from "./server.ts";
import { StudioStore } from "./store.ts";

test("upscale route creates a bounded visual derivative and keeps the source", async () => {
	const directory = await mkdtemp(join(tmpdir(), "ryu-video-upscale-test-"));
	const store = new StudioStore(directory);
	const source = join(directory, "source.png");
	try {
		await runMedia([
			"-f",
			"lavfi",
			"-i",
			"color=c=red:s=8x4:d=1",
			"-frames:v",
			"1",
			source,
		]);
		const sourceAsset = assetSchema.parse({
			...(await probe(source)),
			createdAt: new Date().toISOString(),
			id: crypto.randomUUID(),
			name: "Small red source",
		});
		await Bun.write(
			store.mediaPath(sourceAsset.id),
			await Bun.file(source).arrayBuffer()
		);
		store.putAsset(sourceAsset);
		const token = crypto.randomUUID();
		const app = createStudioServer({ store, token, port: 0 });
		try {
			const response = await fetch(
				`http://127.0.0.1:${app.server.port}/api/video-studio/assets/${sourceAsset.id}/upscale`,
				{
					body: JSON.stringify({ factor: 2 }),
					headers: {
						authorization: `Bearer ${token}`,
						"content-type": "application/json",
					},
					method: "POST",
				}
			);
			expect(response.status).toBe(201);
			const derivative = assetSchema.parse(await response.json());
			expect(derivative).toMatchObject({
				height: 8,
				kind: "image",
				name: "Small red source · 2× local upscale",
				width: 16,
			});
			expect(store.assets()).toHaveLength(2);
			expect(await Bun.file(store.mediaPath(sourceAsset.id)).exists()).toBe(
				true
			);
			expect(await Bun.file(store.mediaPath(derivative.id)).exists()).toBe(
				true
			);
		} finally {
			app.stop();
		}
	} finally {
		store.close();
		await rm(directory, { force: true, recursive: true });
	}
});

test("upscale route preserves a video's audio stream", async () => {
	const directory = await mkdtemp(
		join(tmpdir(), "ryu-video-upscale-video-test-")
	);
	const store = new StudioStore(directory);
	const source = join(directory, "source.mp4");
	try {
		await runMedia([
			"-f",
			"lavfi",
			"-i",
			"color=c=blue:s=8x4:r=10:d=0.5",
			"-f",
			"lavfi",
			"-i",
			"sine=frequency=440:duration=0.5",
			"-shortest",
			"-c:v",
			"libx264",
			"-pix_fmt",
			"yuv420p",
			"-c:a",
			"aac",
			source,
		]);
		const sourceAsset = assetSchema.parse({
			...(await probe(source)),
			createdAt: new Date().toISOString(),
			id: crypto.randomUUID(),
			name: "Small blue video",
		});
		await Bun.write(
			store.mediaPath(sourceAsset.id),
			await Bun.file(source).arrayBuffer()
		);
		store.putAsset(sourceAsset);
		const token = crypto.randomUUID();
		const app = createStudioServer({ store, token, port: 0 });
		try {
			const response = await fetch(
				`http://127.0.0.1:${app.server.port}/api/video-studio/assets/${sourceAsset.id}/upscale`,
				{
					body: JSON.stringify({ factor: 2 }),
					headers: {
						authorization: `Bearer ${token}`,
						"content-type": "application/json",
					},
					method: "POST",
				}
			);
			expect(response.status).toBe(201);
			const derivative = assetSchema.parse(await response.json());
			expect(derivative).toMatchObject({
				hasAudio: true,
				height: 8,
				kind: "video",
				width: 16,
			});
			expect(derivative.duration).toBeGreaterThan(0);
		} finally {
			app.stop();
		}
	} finally {
		store.close();
		await rm(directory, { force: true, recursive: true });
	}
});
