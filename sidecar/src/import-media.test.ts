import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importMediaAsset } from "./import-media.ts";
import { StudioStore } from "./store.ts";

test("inline media import writes app-owned bytes and metadata", async () => {
	const directory = await mkdtemp(join(tmpdir(), "ryu-video-import-test-"));
	const store = new StudioStore(directory);
	try {
		const asset = await importMediaAsset(
			store,
			{
				folder: "Proof/Imports",
				name: "Imported still",
				source: { bytes: "aGVsbG8=", mimeType: "image/png" },
			},
			{
				probe: async () => ({
					hasAudio: false,
					height: 8,
					kind: "image",
					duration: 5,
					width: 8,
				}),
				thumbnail: async () => undefined,
			}
		);
		expect(asset).toMatchObject({
			folder: "Proof/Imports",
			kind: "image",
			name: "Imported still",
		});
		expect(await Bun.file(store.mediaPath(asset.id)).text()).toBe("hello");
		expect(store.assets()).toHaveLength(1);
	} finally {
		store.close();
		await rm(directory, { force: true, recursive: true });
	}
});
