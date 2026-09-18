import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assetSchema } from "../../shared/project.ts";
import { probe, runMedia } from "./media.ts";
import { createStudioServer } from "./server.ts";
import { StudioStore } from "./store.ts";

test("color scopes route measures a real source frame", async () => {
	const directory = await mkdtemp(join(tmpdir(), "ryu-video-scopes-test-"));
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
		const asset = assetSchema.parse({
			...(await probe(source)),
			createdAt: new Date().toISOString(),
			id: crypto.randomUUID(),
			name: "Red scope source",
		});
		await Bun.write(
			store.mediaPath(asset.id),
			await Bun.file(source).arrayBuffer()
		);
		store.putAsset(asset);
		const token = crypto.randomUUID();
		const app = createStudioServer({ store, token, port: 0 });
		try {
			const response = await fetch(
				`http://127.0.0.1:${app.server.port}/api/video-studio/assets/${asset.id}/scopes?time=0`,
				{ headers: { authorization: `Bearer ${token}` } }
			);
			expect(response.status).toBe(200);
			const scopes = (await response.json()) as {
				assetId: string;
				clipping: { black: boolean; white: boolean };
				luma: { average: number };
				saturation: { average: number };
			};
			expect(scopes.assetId).toBe(asset.id);
			expect(scopes.luma.average).toBeGreaterThan(0);
			expect(scopes.saturation.average).toBeGreaterThan(0.2);
			expect(scopes.clipping.white).toBe(false);
		} finally {
			app.stop();
		}
	} finally {
		store.close();
		await rm(directory, { force: true, recursive: true });
	}
});
