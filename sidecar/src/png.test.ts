import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import { z } from "zod";
import { alphaToRgba, rasterizeShape } from "../../shared/raster.ts";
import { runMedia } from "./media.ts";
import {
	adler32,
	alphaRasterToPng,
	crc32,
	encodePng,
	type PngChannels,
	rgbaRasterToPng,
	writePng,
} from "./png.ts";

interface DecodedChunk {
	data: Uint8Array;
	type: string;
}

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

/** Splits PNG bytes into chunks; throws on a bad signature or chunk CRC. */
function readChunks(bytes: Uint8Array): DecodedChunk[] {
	if (PNG_SIGNATURE.some((byte, index) => bytes[index] !== byte)) {
		throw new Error("Missing PNG signature.");
	}
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const chunks: DecodedChunk[] = [];
	let offset = 8;
	while (offset < bytes.length) {
		const length = view.getUint32(offset);
		const typeBytes = bytes.subarray(offset + 4, offset + 8);
		const data = bytes.subarray(offset + 8, offset + 8 + length);
		if (view.getUint32(offset + 8 + length) !== crc32(typeBytes, data)) {
			throw new Error("Chunk CRC mismatch.");
		}
		chunks.push({ data, type: new TextDecoder().decode(typeBytes) });
		offset += 12 + length;
	}
	return chunks;
}

/** Reverses the PNG scanline filters; enough of a decoder to test round trips. */
function unfilter(
	filtered: Uint8Array,
	width: number,
	height: number,
	bpp: number
): Uint8Array {
	const stride = width * bpp;
	const out = new Uint8Array(stride * height);
	for (let row = 0; row < height; row += 1) {
		const filter = filtered[row * (stride + 1)];
		for (let index = 0; index < stride; index += 1) {
			const raw = filtered[row * (stride + 1) + 1 + index] ?? 0;
			const left = index >= bpp ? (out[row * stride + index - bpp] ?? 0) : 0;
			const up = row > 0 ? (out[(row - 1) * stride + index] ?? 0) : 0;
			const upLeft =
				row > 0 && index >= bpp
					? (out[(row - 1) * stride + index - bpp] ?? 0)
					: 0;
			let predictor = 0;
			if (filter === 1) {
				predictor = left;
			} else if (filter === 2) {
				predictor = up;
			} else if (filter === 3) {
				predictor = (left + up) >>> 1;
			} else if (filter === 4) {
				const estimate = left + up - upLeft;
				const a = Math.abs(estimate - left);
				const b = Math.abs(estimate - up);
				const c = Math.abs(estimate - upLeft);
				if (a <= b && a <= c) {
					predictor = left;
				} else {
					predictor = b <= c ? up : upLeft;
				}
			}
			out[row * stride + index] = (raw + predictor) & 0xff;
		}
	}
	return out;
}

function decode(bytes: Uint8Array) {
	const chunks = readChunks(bytes);
	const header = chunks[0]?.data ?? new Uint8Array();
	const view = new DataView(
		header.buffer,
		header.byteOffset,
		header.byteLength
	);
	const width = view.getUint32(0);
	const height = view.getUint32(4);
	const colorType = header[9];
	const bpp = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType ?? 0] ?? 0;
	// node:zlib verifies the zlib header and the Adler-32 trailer.
	const filtered = inflateSync(chunks[1]?.data ?? new Uint8Array());
	return {
		bitDepth: header[8],
		chunkTypes: chunks.map((chunk) => chunk.type),
		colorType,
		data: unfilter(new Uint8Array(filtered), width, height, bpp),
		height,
		width,
	};
}

function noise(length: number, seed: number): Uint8Array {
	const out = new Uint8Array(length);
	let state = seed;
	for (let index = 0; index < length; index += 1) {
		state = (state * 1_103_515_245 + 12_345) >>> 0;
		out[index] = state >>> 24;
	}
	return out;
}

describe("PNG encoding", () => {
	test("checksums match reference values", () => {
		const text = new TextEncoder().encode("123456789");
		expect(crc32(text)).toBe(0xcb_f4_39_26);
		expect(adler32(new TextEncoder().encode("Wikipedia"))).toBe(0x11_e6_03_98);
	});

	test("every channel layout round-trips through zlib and the filters", () => {
		for (const channels of [1, 2, 3, 4] satisfies PngChannels[]) {
			const width = 37;
			const height = 23;
			const data = noise(width * height * channels, channels);
			const decoded = decode(encodePng({ channels, data, height, width }));
			expect(decoded.chunkTypes).toEqual(["IHDR", "IDAT", "IEND"]);
			expect(decoded.width).toBe(width);
			expect(decoded.height).toBe(height);
			expect(decoded.bitDepth).toBe(8);
			expect(decoded.colorType).toBe({ 1: 0, 2: 4, 3: 2, 4: 6 }[channels]);
			expect(Buffer.from(decoded.data).equals(Buffer.from(data))).toBe(true);
		}
	});

	test("smooth rasters round-trip and compress", () => {
		const mask = rasterizeShape(
			{ cx: 120, cy: 80, kind: "ellipse", rx: 90, ry: 60 },
			240,
			160
		);
		const bytes = alphaRasterToPng(mask);
		expect(bytes.length).toBeLessThan(mask.data.length / 4);
		expect(Buffer.from(decode(bytes).data).equals(Buffer.from(mask.data))).toBe(
			true
		);
	});

	test("encoding is deterministic", () => {
		const image = {
			channels: 3 as const,
			data: noise(30, 9),
			height: 2,
			width: 5,
		};
		expect(
			Buffer.from(encodePng(image)).equals(Buffer.from(encodePng(image)))
		).toBe(true);
	});

	test("mismatched or invalid images are rejected", () => {
		expect(() =>
			encodePng({ channels: 1, data: new Uint8Array(3), height: 2, width: 2 })
		).toThrow(RangeError);
		expect(() =>
			encodePng({ channels: 1, data: new Uint8Array(0), height: 0, width: 0 })
		).toThrow(RangeError);
		expect(() =>
			encodePng({
				channels: 5 as PngChannels,
				data: new Uint8Array(5),
				height: 1,
				width: 1,
			})
		).toThrow(RangeError);
	});
});

const probeSchema = z.object({
	streams: z.array(
		z.object({
			codec_name: z.string(),
			height: z.number(),
			pix_fmt: z.string(),
			width: z.number(),
		})
	),
});

test("FFmpeg reads encoded mattes and shape layers byte for byte", async () => {
	const directory = await mkdtemp(join(tmpdir(), "ryu-video-png-test-"));
	try {
		const mask = rasterizeShape(
			{
				cx: 64,
				cy: 48,
				innerRadius: 0.45,
				kind: "star",
				points: 5,
				rotation: 12,
				rx: 44,
				ry: 40,
			},
			128,
			96
		);
		const rgba = alphaToRgba(mask, { b: 40, g: 200, r: 250 });
		const cases = [
			{ bytes: alphaRasterToPng(mask), data: mask.data, pixFmt: "gray" },
			{ bytes: rgbaRasterToPng(rgba), data: rgba.data, pixFmt: "rgba" },
		];
		for (const [index, item] of cases.entries()) {
			const path = join(directory, `shape-${index}.png`);
			await Bun.write(path, item.bytes);
			const probed = probeSchema.parse(
				JSON.parse(
					await runMedia(
						[
							"-v",
							"error",
							"-show_entries",
							"stream=codec_name,width,height,pix_fmt",
							"-of",
							"json",
							path,
						],
						{ probe: true }
					)
				)
			);
			expect(probed.streams[0]).toEqual({
				codec_name: "png",
				height: 96,
				pix_fmt: item.pixFmt,
				width: 128,
			});
			const raw = join(directory, `shape-${index}.raw`);
			await runMedia([
				"-v",
				"error",
				"-y",
				"-i",
				path,
				"-f",
				"rawvideo",
				"-pix_fmt",
				item.pixFmt,
				raw,
			]);
			const decoded = new Uint8Array(await Bun.file(raw).arrayBuffer());
			expect(Buffer.from(decoded).equals(Buffer.from(item.data))).toBe(true);
		}
		const written = join(directory, "written.png");
		await writePng(written, {
			channels: 2,
			data: noise(8, 3),
			height: 2,
			width: 2,
		});
		expect(
			decode(new Uint8Array(await Bun.file(written).arrayBuffer())).width
		).toBe(2);
	} finally {
		await rm(directory, {
			force: true,
			recursive: true,
			maxRetries: 10,
			retryDelay: 100,
		});
	}
});
