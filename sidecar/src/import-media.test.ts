import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importMediaAsset } from "./import-media.ts";
import { MAX_MEDIA_STORAGE_BYTES, StudioStore } from "./store.ts";

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

test("local imports stay beneath the configured root", async () => {
	const directory = await mkdtemp(
		join(tmpdir(), "ryu-video-import-root-test-")
	);
	const root = join(directory, "imports");
	const outside = join(directory, "outside.mp4");
	await mkdir(root, { recursive: true });
	await writeFile(join(root, "inside.mp4"), "inside");
	await writeFile(outside, "outside");
	const store = new StudioStore(join(directory, "store"));
	try {
		await expect(
			importMediaAsset(
				store,
				{ source: { path: join(root, "inside.mp4") } },
				{
					localImportRoot: root,
					probe: async () => ({
						hasAudio: false,
						height: 8,
						kind: "video",
						duration: 1,
						width: 8,
					}),
					thumbnail: async () => undefined,
				}
			)
		).resolves.toMatchObject({ kind: "video" });
		await expect(
			importMediaAsset(
				store,
				{ source: { path: outside } },
				{ localImportRoot: root, probe: async () => ({}) as never }
			)
		).rejects.toThrow("beneath the configured import root");
	} finally {
		store.close();
		await rm(directory, { force: true, recursive: true });
	}
});

test("media admission reserves aggregate storage before an import starts", async () => {
	const directory = await mkdtemp(join(tmpdir(), "ryu-video-quota-test-"));
	const store = new StudioStore(directory);
	try {
		const reservation = store.reserveMediaStorage(MAX_MEDIA_STORAGE_BYTES);
		expect(() => store.reserveMediaStorage(1)).toThrow("storage quota");
		reservation.release();
		const retry = store.reserveMediaStorage(1);
		retry.commit();
	} finally {
		store.close();
		await rm(directory, { force: true, recursive: true });
	}
});
