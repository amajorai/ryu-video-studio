import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assetSchema } from "../../shared/project.ts";
import { createStudioServer } from "./server.ts";
import {
	MAX_MEDIA_ASSETS,
	MAX_MEDIA_STORAGE_BYTES,
	StudioStore,
} from "./store.ts";

test("cancelling an upload frees its file, slot, and reservation; restarts drop orphans", async () => {
	const directory = await mkdtemp(join(tmpdir(), "ryu-video-upload-test-"));
	const store = new StudioStore(directory);
	const orphan = join(directory, "media", `${crypto.randomUUID()}.upload`);
	await Bun.write(orphan, new Uint8Array(64));
	const token = crypto.randomUUID();
	const app = createStudioServer({ store, token, port: 0 });
	const call = (path: string, method: string, body?: unknown) =>
		fetch(
			`http://127.0.0.1:${app.server.port}/api/video-studio/uploads${path}`,
			{
				body: body === undefined ? undefined : JSON.stringify(body),
				headers: {
					authorization: `Bearer ${token}`,
					"content-type": "application/json",
				},
				method,
			}
		);
	try {
		expect(await Bun.file(orphan).exists()).toBe(false);
		const begin = await call("", "POST", { name: "clip.mp4", size: 1024 });
		expect(begin.status).toBe(201);
		const { id } = (await begin.json()) as { id: string };
		const chunk = await call(`/${id}`, "PUT", {
			data: Buffer.from(new Uint8Array(16)).toString("base64"),
			offset: 0,
		});
		expect(chunk.status).toBe(200);
		expect(store.mediaStorageHeadroom()).toBe(MAX_MEDIA_STORAGE_BYTES - 1024);
		const cancel = await call(`/${id}/cancel`, "POST");
		expect(cancel.status).toBe(200);
		expect(
			await Bun.file(join(directory, "media", `${id}.upload`)).exists()
		).toBe(false);
		expect(store.mediaStorageHeadroom()).toBe(MAX_MEDIA_STORAGE_BYTES);
		expect(
			(await call(`/${id}`, "PUT", { data: "AA==", offset: 16 })).status
		).toBe(404);
	} finally {
		app.stop();
		store.close();
		await rm(directory, { force: true, recursive: true });
	}
});

test("a refused insert at the asset limit removes the media it would have referenced", async () => {
	const directory = await mkdtemp(join(tmpdir(), "ryu-video-limit-test-"));
	const store = new StudioStore(directory);
	const asset = (id: string) =>
		assetSchema.parse({
			createdAt: new Date().toISOString(),
			duration: 1,
			hasAudio: false,
			height: 4,
			id,
			kind: "image",
			name: "Fixture",
			width: 4,
		});
	try {
		const kept = crypto.randomUUID();
		store.putAsset(asset(kept));
		await Bun.write(store.mediaPath(kept), new Uint8Array(8));
		store.db.transaction(() => {
			for (let index = 1; index < MAX_MEDIA_ASSETS; index += 1) {
				store.putAsset(asset(crypto.randomUUID()));
			}
		})();
		const refused = crypto.randomUUID();
		await Bun.write(store.mediaPath(refused), new Uint8Array(64));
		await Bun.write(
			join(directory, "media", `${refused}.jpg`),
			new Uint8Array(8)
		);
		expect(() => store.putAsset(asset(refused))).toThrow(
			"Media asset limit reached."
		);
		expect(await Bun.file(store.mediaPath(refused)).exists()).toBe(false);
		expect(
			await Bun.file(join(directory, "media", `${refused}.jpg`)).exists()
		).toBe(false);
		// A duplicate id at the limit must not delete the existing row's media.
		expect(() => store.putAsset(asset(kept))).toThrow();
		expect(await Bun.file(store.mediaPath(kept)).exists()).toBe(true);
		expect(() => store.reserveMediaStorage(1)).toThrow(
			"Media asset limit reached."
		);
	} finally {
		store.close();
		await rm(directory, { force: true, recursive: true });
	}
});
