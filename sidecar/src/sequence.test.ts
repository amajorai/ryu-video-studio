import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	assetSchema,
	newSegment,
	projectSchema,
} from "../../shared/project.ts";
import { probe, runMedia } from "./media.ts";
import { createStudioServer } from "./server.ts";
import { StudioStore } from "./store.ts";

test("sequence route renders and refreshes an independent timeline clip", async () => {
	const directory = await mkdtemp(join(tmpdir(), "ryu-video-sequence-test-"));
	const store = new StudioStore(directory);
	const sourcePath = join(directory, "source.mp4");
	try {
		await runMedia([
			"-f",
			"lavfi",
			"-i",
			"color=c=red:s=8x4:r=10:d=0.5",
			"-c:v",
			"libx264",
			"-pix_fmt",
			"yuv420p",
			sourcePath,
		]);
		const sourceAsset = assetSchema.parse({
			...(await probe(sourcePath)),
			createdAt: new Date().toISOString(),
			id: crypto.randomUUID(),
			name: "Sequence source",
		});
		await Bun.write(
			store.mediaPath(sourceAsset.id),
			await Bun.file(sourcePath).arrayBuffer()
		);
		store.putAsset(sourceAsset);
		const source = store.save({
			...store.create("Source workspace"),
			segments: [newSegment(sourceAsset)],
		});
		const parent = store.create("Parent workspace");
		const token = crypto.randomUUID();
		const app = createStudioServer({ store, token, port: 0 });
		try {
			const response = await fetch(
				`http://127.0.0.1:${app.server.port}/api/video-studio/projects/${parent.id}/sequence`,
				{
					body: JSON.stringify({
						revision: parent.revision,
						sourceProjectId: source.id,
					}),
					headers: {
						authorization: `Bearer ${token}`,
						"content-type": "application/json",
					},
					method: "POST",
				}
			);
			expect(response.status).toBe(201);
			const sequence = assetSchema.parse(await response.json());
			expect(sequence.sequenceProjectId).toBe(source.id);
			expect(sequence.kind).toBe("video");
			expect(await Bun.file(store.mediaPath(sequence.id)).exists()).toBe(true);
			const refreshed = await fetch(
				`http://127.0.0.1:${app.server.port}/api/video-studio/assets/${sequence.id}/refresh-sequence`,
				{
					body: "{}",
					headers: {
						authorization: `Bearer ${token}`,
						"content-type": "application/json",
					},
					method: "POST",
				}
			);
			expect(refreshed.status).toBe(200);
			expect(
				projectSchema.parse(store.project(source.id)).segments
			).toHaveLength(1);
		} finally {
			app.stop();
		}
	} finally {
		store.close();
		await rm(directory, { force: true, recursive: true });
	}
}, 30_000);
