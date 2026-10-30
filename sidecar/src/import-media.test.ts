import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { creditsForProject } from "../../shared/credits.ts";
import { newSegment } from "../../shared/project.ts";
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
				{
					localImportRoot: root,
					probe: async () => {
						throw new Error(
							"Probe must not run outside the configured import root"
						);
					},
				}
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

test("bundled sticker provenance is stored and credited; other providers are refused", async () => {
	const directory = await mkdtemp(join(tmpdir(), "ryu-video-import-test-"));
	const store = new StudioStore(directory);
	const origin = {
		attribution:
			"Twemoji graphics by Twitter, Inc and other contributors, licensed under CC-BY 4.0.",
		identifier: "emoji-1f600",
		licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
		pageUrl: "https://github.com/jdecked/twemoji",
		provider: "bundled" as const,
		rights: "CC-BY 4.0",
	};
	const dependencies = {
		probe: async () => ({
			duration: 5,
			hasAudio: false,
			height: 8,
			kind: "image" as const,
			width: 8,
		}),
		thumbnail: async () => undefined,
	};
	try {
		const asset = await importMediaAsset(
			store,
			{
				derivation: "sticker",
				folder: "Stickers",
				name: "Grinning face",
				origin,
				source: { bytes: "aGVsbG8=", mimeType: "image/png" },
			},
			dependencies
		);
		expect(asset).toMatchObject({ derivation: "sticker", origin });
		const project = store.save({
			...store.create("Credits"),
			segments: [{ ...newSegment(asset, 0), sourceOut: 4 }],
		});
		const credits = creditsForProject(project, store.assets());
		expect(JSON.stringify(credits)).toContain("Twemoji graphics");
		await expect(
			importMediaAsset(
				store,
				{
					origin: { ...origin, provider: "pexels" },
					source: { bytes: "aGVsbG8=", mimeType: "image/png" },
				},
				dependencies
			)
		).rejects.toThrow();
	} finally {
		store.close();
		await rm(directory, { force: true, recursive: true });
	}
});
