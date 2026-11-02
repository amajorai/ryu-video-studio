import { rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import {
	MATTE_STILL_SECONDS,
	type MatteRequest,
	matteName,
	matteRgb,
} from "../../shared/matte.ts";
import { type Asset, assetSchema } from "../../shared/project.ts";
import { thumbnail } from "./media.ts";
import { sweepMediaLeftovers } from "./media-leftovers.ts";
import type { StudioStore } from "./store.ts";

/**
 * Solid color mattes (G60). A matte is a one-color PNG stored as an image
 * asset with `derivation: "matte"`. The PNG is a 1-bit palette image, so
 * even an 8K matte is a few kilobytes and encodes without FFmpeg.
 */

const PNG_SIGNATURE = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);

const crcTable = (() => {
	const table = new Uint32Array(256);
	for (let index = 0; index < 256; index++) {
		let value = index;
		for (let bit = 0; bit < 8; bit++) {
			value = value & 1 ? 0xed_b8_83_20 ^ (value >>> 1) : value >>> 1;
		}
		table[index] = value >>> 0;
	}
	return table;
})();

/** CRC-32 (ISO 3309) as PNG chunks use it. */
export function crc32(bytes: Uint8Array): number {
	let crc = 0xff_ff_ff_ff;
	for (const byte of bytes) {
		crc = (crcTable[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
	}
	return (crc ^ 0xff_ff_ff_ff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Buffer {
	const chunk = Buffer.alloc(12 + data.length);
	chunk.writeUInt32BE(data.length, 0);
	chunk.write(type, 4, "ascii");
	chunk.set(data, 8);
	chunk.writeUInt32BE(
		crc32(chunk.subarray(4, 8 + data.length)),
		8 + data.length
	);
	return chunk;
}

/**
 * Encode a `width`x`height` PNG filled with one RGB color: palette color
 * type, bit depth 1, every pixel index 0. Deterministic for equal inputs.
 */
export function encodeSolidPng(
	width: number,
	height: number,
	[red, green, blue]: readonly [number, number, number]
): Buffer {
	if (!(Number.isInteger(width) && Number.isInteger(height))) {
		throw new Error("PNG dimensions must be whole pixels.");
	}
	if (width < 1 || height < 1) {
		throw new Error("PNG dimensions must be positive.");
	}
	const header = Buffer.alloc(13);
	header.writeUInt32BE(width, 0);
	header.writeUInt32BE(height, 4);
	header[8] = 1; // bit depth
	header[9] = 3; // palette color type
	// Compression, filter and interlace methods stay 0.
	const rowBytes = 1 + Math.ceil(width / 8);
	// Every row is filter type 0 followed by zero indices.
	const pixels = deflateSync(Buffer.alloc(rowBytes * height), { level: 9 });
	return Buffer.concat([
		PNG_SIGNATURE,
		pngChunk("IHDR", header),
		pngChunk("PLTE", Uint8Array.from([red, green, blue])),
		pngChunk("IDAT", pixels),
		pngChunk("IEND", new Uint8Array()),
	]);
}

/** Width and height from a PNG's IHDR chunk, or `undefined` for non-PNG bytes. */
export function pngDimensions(
	bytes: Uint8Array
): { height: number; width: number } | undefined {
	if (bytes.length < 24) {
		return;
	}
	for (const [index, value] of PNG_SIGNATURE.entries()) {
		if (bytes[index] !== value) {
			return;
		}
	}
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const type = String.fromCharCode(...bytes.subarray(12, 16));
	if (type !== "IHDR") {
		return;
	}
	return { width: view.getUint32(16), height: view.getUint32(20) };
}

/** The asset record for a matte (before it is stored). */
export function matteAsset(
	input: MatteRequest,
	id: string,
	createdAt: string
): Asset {
	return assetSchema.parse({
		createdAt,
		derivation: "matte",
		duration: MATTE_STILL_SECONDS,
		hasAudio: false,
		height: input.height,
		id,
		kind: "image",
		name: matteName(input),
		width: input.width,
	});
}

/**
 * Create a color matte asset: write the PNG into app-owned media storage,
 * register the asset and make its library thumbnail (best effort).
 */
export async function createMatte(
	store: StudioStore,
	input: MatteRequest,
	options: { signal?: AbortSignal } = {}
): Promise<Asset> {
	await sweepMediaLeftovers(store);
	const png = encodeSolidPng(input.width, input.height, matteRgb(input.color));
	const reservation = store.reserveMediaStorage(png.length);
	const asset = matteAsset(
		input,
		crypto.randomUUID(),
		new Date().toISOString()
	);
	const path = store.mediaPath(asset.id);
	const temporary = join(store.directory, "media", `.matte-${asset.id}.png`);
	try {
		await writeFile(temporary, png, { mode: 0o600 });
		await rename(temporary, path);
		store.putAsset(asset);
		reservation.commit();
	} catch (error) {
		await rm(temporary, { force: true });
		await rm(path, { force: true });
		reservation.release();
		throw error;
	}
	await thumbnail(
		path,
		join(store.directory, "media"),
		asset.id,
		options.signal
	).catch(() => undefined);
	return asset;
}
