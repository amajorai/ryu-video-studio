import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";
import { dotLottieJson, isDotLottieName } from "./dotlottie.ts";
import { readZip, safeZipName, ZipReadError } from "./zip-read.ts";

/** Zip `files` (deflated) with the system `zip` tool and return the bytes. */
async function zipOf(files: Record<string, string | Uint8Array>) {
	const directory = await mkdtemp(join(tmpdir(), "ryu-dotlottie-"));
	try {
		for (const [name, content] of Object.entries(files)) {
			const path = join(directory, "src", name);
			await mkdir(join(path, ".."), { recursive: true });
			await writeFile(path, content);
		}
		const archive = join(directory, "out.zip");
		const result = Bun.spawnSync(["zip", "-q", "-r", "-9", archive, "."], {
			cwd: join(directory, "src"),
		});
		if (result.exitCode !== 0) {
			throw new Error(`zip failed: ${result.stderr.toString()}`);
		}
		return new Uint8Array(await readFile(archive));
	} finally {
		await rm(directory, { force: true, recursive: true });
	}
}

/**
 * A one-entry deflate archive whose headers declare `declaredSize` bytes,
 * whatever `content` really inflates to.
 */
function deflateZip(name: string, content: Uint8Array, declaredSize: number) {
	const encodedName = new TextEncoder().encode(name);
	const data = deflateRawSync(content);
	const local = new DataView(new ArrayBuffer(30));
	local.setUint32(0, 0x04_03_4b_50, true);
	local.setUint16(4, 20, true);
	local.setUint16(8, 8, true);
	local.setUint32(18, data.byteLength, true);
	local.setUint32(22, declaredSize, true);
	local.setUint16(26, encodedName.byteLength, true);
	const central = new DataView(new ArrayBuffer(46));
	central.setUint32(0, 0x02_01_4b_50, true);
	central.setUint16(4, 20, true);
	central.setUint16(6, 20, true);
	central.setUint16(10, 8, true);
	central.setUint32(20, data.byteLength, true);
	central.setUint32(24, declaredSize, true);
	central.setUint16(28, encodedName.byteLength, true);
	const centralOffset = 30 + encodedName.byteLength + data.byteLength;
	const end = new DataView(new ArrayBuffer(22));
	end.setUint32(0, 0x06_05_4b_50, true);
	end.setUint16(8, 1, true);
	end.setUint16(10, 1, true);
	end.setUint32(12, 46 + encodedName.byteLength, true);
	end.setUint32(16, centralOffset, true);
	return new Uint8Array(
		Buffer.concat([
			new Uint8Array(local.buffer),
			encodedName,
			data,
			new Uint8Array(central.buffer),
			encodedName,
			new Uint8Array(end.buffer),
		])
	);
}

/** Run `work` while counting every byte the platform inflater emits. */
async function countingInflatedBytes(work: () => Promise<unknown>) {
	const Platform = globalThis.DecompressionStream;
	let inflated = 0;
	class CountingDecompressionStream {
		readonly readable: ReadableStream<Uint8Array>;
		readonly writable: WritableStream<BufferSource>;
		constructor(format: CompressionFormat) {
			const inner = new Platform(format);
			this.writable = inner.writable;
			this.readable = inner.readable.pipeThrough(
				new TransformStream<Uint8Array, Uint8Array>({
					transform(chunk, controller) {
						inflated += chunk.byteLength;
						controller.enqueue(chunk);
					},
				})
			);
		}
	}
	globalThis.DecompressionStream =
		CountingDecompressionStream as unknown as typeof DecompressionStream;
	try {
		await work();
	} finally {
		globalThis.DecompressionStream = Platform;
	}
	return inflated;
}

const animation = (assets: unknown[] = []) =>
	JSON.stringify({
		assets,
		fr: 30,
		h: 100,
		ip: 0,
		layers: [],
		op: 30,
		v: "5.7.0",
		w: 100,
	});

describe("dotLottie", () => {
	test("v1 archives: the manifest's first animation, with images inlined", async () => {
		const png = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);
		const bytes = await zipOf({
			"animations/intro.json": animation([
				{ e: 0, h: 10, id: "image_0", p: "img_0.png", u: "/images/", w: 10 },
			]),
			"animations/second.json": animation(),
			"images/img_0.png": png,
			"manifest.json": JSON.stringify({
				animations: [{ id: "intro" }, { id: "second" }],
				version: "1.0",
			}),
		});
		const json = JSON.parse(await dotLottieJson(bytes));
		expect(json.assets[0]).toMatchObject({
			e: 1,
			p: `data:image/png;base64,${Buffer.from(png).toString("base64")}`,
			u: "",
		});
	});

	test("v2 archives without a manifest fall back to the first animation file", async () => {
		const bytes = await zipOf({ "a/main.json": animation() });
		expect(JSON.parse(await dotLottieJson(bytes)).w).toBe(100);
	});

	test("archives without an animation, or that are not zips, are refused", async () => {
		await expect(dotLottieJson(await zipOf({ "x.txt": "hi" }))).rejects.toThrow(
			"no animation"
		);
		await expect(dotLottieJson(new Uint8Array([1, 2, 3]))).rejects.toThrow(
			"not a ZIP"
		);
		expect(isDotLottieName("Intro.LOTTIE")).toBe(true);
		expect(isDotLottieName("intro.lottie.json")).toBe(false);
	});

	test("the zip reader enforces limits and safe names", async () => {
		const bytes = await zipOf({ "a.txt": "a", "b.txt": "b" });
		await expect(
			readZip(bytes, { maxEntries: 1, maxTotalBytes: 100 })
		).rejects.toThrow("more than 1");
		await expect(
			readZip(bytes, { maxEntries: 5, maxTotalBytes: 1 })
		).rejects.toThrow("too large");
		expect(safeZipName("../etc/passwd")).toBe(false);
		expect(safeZipName("/abs")).toBe(false);
		expect(safeZipName("media/clip.mp4")).toBe(true);
	});

	test("the zip reader refuses a deflate bomb without inflating it in full", async () => {
		const realSize = 10 * 1024 * 1024;
		const bomb = deflateZip("bomb.bin", new Uint8Array(realSize), 1);
		let refusal: unknown;
		const inflated = await countingInflatedBytes(async () => {
			refusal = await readZip(bomb, {
				maxEntries: 1,
				maxTotalBytes: 1024,
			}).catch((error: unknown) => error);
		});
		expect(refusal).toBeInstanceOf(ZipReadError);
		expect((refusal as Error).message).toBe(
			"A file in the archive is damaged."
		);
		// Inflation stops at the first output past the declared byte, long
		// before the entry's real 10 MB.
		expect(inflated).toBeLessThan(1024 * 1024);
	});

	test("the zip reader inflates multi-chunk entries that match their declared size", async () => {
		const content = new Uint8Array(300 * 1024).map((_, index) => index % 251);
		const files = await readZip(
			deflateZip("clip.bin", content, content.byteLength),
			{ maxEntries: 1, maxTotalBytes: content.byteLength }
		);
		expect(files.get("clip.bin")).toEqual(content);
		await expect(
			readZip(deflateZip("short.bin", content, content.byteLength + 1), {
				maxEntries: 1,
				maxTotalBytes: content.byteLength + 1,
			})
		).rejects.toThrow("damaged");
	});
});
