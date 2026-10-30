import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import { MATTE_STILL_SECONDS } from "../../shared/matte.ts";
import { assetSchema, newSegment } from "../../shared/project.ts";
import {
	crc32,
	createMatte,
	encodeSolidPng,
	matteAsset,
	pngDimensions,
} from "./matte.ts";
import { probe, runMedia } from "./media.ts";
import { routes } from "./routes/matte.ts";
import { createStudioServer } from "./server.ts";
import { StudioStore } from "./store.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) {
		await cleanup();
	}
});

async function testStore() {
	const store = new StudioStore(await mkdtemp(join(tmpdir(), "ryu-matte-")));
	cleanups.push(async () => {
		store.close();
		await rm(store.directory, {
			recursive: true,
			force: true,
			maxRetries: 10,
			retryDelay: 100,
		});
	});
	return store;
}

describe("solid PNG encoding", () => {
	test("CRC-32 matches the reference value", () => {
		expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcb_f4_39_26);
		expect(crc32(new Uint8Array())).toBe(0);
	});

	test("writes a 1-bit palette PNG of the requested size and color", () => {
		const png = encodeSolidPng(1921, 3, [0x12, 0xab, 0xef]);
		expect(pngDimensions(png)).toEqual({ width: 1921, height: 3 });
		// Signature, IHDR (bit depth 1, palette), PLTE holding the color.
		expect([...png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
		expect(png[24]).toBe(1);
		expect(png[25]).toBe(3);
		const plte = png.indexOf("PLTE");
		expect([...png.subarray(plte + 4, plte + 7)]).toEqual([0x12, 0xab, 0xef]);
		const idat = png.indexOf("IDAT");
		const length = png.readUInt32BE(idat - 4);
		const rows = inflateSync(png.subarray(idat + 4, idat + 4 + length));
		expect(rows.length).toBe(3 * (1 + Math.ceil(1921 / 8)));
		expect(rows.every((byte) => byte === 0)).toBe(true);
		// Deterministic and small even at 8K.
		expect(encodeSolidPng(1921, 3, [1, 2, 3])).toEqual(
			encodeSolidPng(1921, 3, [1, 2, 3])
		);
		expect(encodeSolidPng(8192, 8192, [0, 0, 0]).length).toBeLessThan(64_000);
		expect(() => encodeSolidPng(0, 1, [0, 0, 0])).toThrow();
		expect(() => encodeSolidPng(1.5, 1, [0, 0, 0])).toThrow();
	});

	test("pngDimensions refuses non-PNG bytes", () => {
		expect(pngDimensions(new Uint8Array(30))).toBeUndefined();
		expect(pngDimensions(new Uint8Array(3))).toBeUndefined();
	});

	test("matte assets are image derivatives with the requested size and the still length", () => {
		const asset = matteAsset(
			{ color: "#000000", height: 1080, width: 1920 },
			crypto.randomUUID(),
			new Date(0).toISOString()
		);
		expect(asset).toMatchObject({
			derivation: "matte",
			duration: MATTE_STILL_SECONDS,
			hasAudio: false,
			height: 1080,
			kind: "image",
			name: "Color matte #000000",
			width: 1920,
		});
		expect(assetSchema.parse(asset)).toEqual(asset);
	});

	test("a matte's duration matches the span it gets when placed from the library", () => {
		const asset = matteAsset(
			{ color: "#cc2200", height: 1080, width: 1920 },
			crypto.randomUUID(),
			new Date(0).toISOString()
		);
		const segment = newSegment(asset, 0, 0);
		expect(segment.sourceOut - segment.sourceIn).toBe(asset.duration);
	});
});

describe("matte assets", () => {
	test("FFmpeg decodes the stored matte at its size and color", async () => {
		const store = await testStore();
		const asset = await createMatte(store, {
			color: "#ff8000",
			height: 90,
			width: 160,
		});
		expect(store.assets().find((item) => item.id === asset.id)).toEqual(asset);
		const info = await probe(store.mediaPath(asset.id));
		expect(info).toMatchObject({ kind: "image", width: 160, height: 90 });
		const pixel = join(store.directory, "pixel.rgb");
		await runMedia([
			"-hide_banner",
			"-loglevel",
			"error",
			"-y",
			"-f",
			"png_pipe",
			"-i",
			store.mediaPath(asset.id),
			"-vf",
			"crop=1:1:80:45,format=rgb24",
			"-frames:v",
			"1",
			"-f",
			"rawvideo",
			pixel,
		]);
		expect([...(await readFile(pixel))]).toEqual([255, 128, 0]);
		// The library thumbnail is made best effort.
		expect(
			(await readFile(join(store.directory, "media", `${asset.id}.jpg`))).length
		).toBeGreaterThan(0);
	}, 30_000);

	test("POST /matte creates an asset and refuses invalid bodies", async () => {
		const store = await testStore();
		const token = crypto.randomUUID();
		const app = createStudioServer({ store, token, port: 0, routes });
		cleanups.push(async () => app.stop());
		const call = (body: unknown) =>
			fetch(`http://127.0.0.1:${app.server.port}/api/video-studio/matte`, {
				method: "POST",
				headers: {
					authorization: `Bearer ${token}`,
					"content-type": "application/json",
				},
				body: JSON.stringify(body),
			});
		const created = await call({
			color: "#336699",
			height: 1080,
			name: "Blue",
			width: 1920,
		});
		expect(created.status).toBe(201);
		const asset = assetSchema.parse(await created.json());
		expect(asset).toMatchObject({
			derivation: "matte",
			duration: MATTE_STILL_SECONDS,
			height: 1080,
			kind: "image",
			name: "Blue",
			width: 1920,
		});
		expect(pngDimensions(await readFile(store.mediaPath(asset.id)))).toEqual({
			width: 1920,
			height: 1080,
		});
		expect((await call({ color: "#336699" })).status).toBe(400);
		expect(store.assets()).toHaveLength(1);
	}, 30_000);
});
