import { deflateSync } from "node:zlib";

/**
 * Minimal PNG encoder for shape rasters (W2-V11): 8-bit straight-alpha RGBA,
 * no filtering, one zlib IDAT. Deterministic for identical pixels.
 */

const crcTable = (() => {
	const table = new Uint32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) {
			c = c & 1 ? 0xed_b8_83_20 ^ (c >>> 1) : c >>> 1;
		}
		table[n] = c >>> 0;
	}
	return table;
})();

export function crc32(bytes: Uint8Array): number {
	let crc = 0xff_ff_ff_ff;
	for (const byte of bytes) {
		crc = (crcTable[(crc ^ byte) & 0xff] as number) ^ (crc >>> 8);
	}
	return (crc ^ 0xff_ff_ff_ff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
	const out = new Uint8Array(12 + data.length);
	const view = new DataView(out.buffer);
	view.setUint32(0, data.length);
	for (let index = 0; index < 4; index++) {
		out[4 + index] = type.charCodeAt(index);
	}
	out.set(data, 8);
	view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
	return out;
}

const signature = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

/** Encodes `width * height * 4` RGBA bytes as a PNG file. */
export function encodeRgbaPng(
	width: number,
	height: number,
	pixels: Uint8Array
): Uint8Array {
	if (
		!(Number.isInteger(width) && Number.isInteger(height)) ||
		width < 1 ||
		height < 1
	) {
		throw new Error("PNG dimensions must be positive integers.");
	}
	if (pixels.length !== width * height * 4) {
		throw new Error("PNG pixel buffer does not match its dimensions.");
	}
	const header = new Uint8Array(13);
	const headerView = new DataView(header.buffer);
	headerView.setUint32(0, width);
	headerView.setUint32(4, height);
	header[8] = 8; // bit depth
	header[9] = 6; // RGBA
	const stride = width * 4;
	const raw = new Uint8Array((stride + 1) * height);
	for (let row = 0; row < height; row++) {
		raw[row * (stride + 1)] = 0; // filter: none
		raw.set(
			pixels.subarray(row * stride, (row + 1) * stride),
			row * (stride + 1) + 1
		);
	}
	const parts = [
		signature,
		chunk("IHDR", header),
		chunk("IDAT", new Uint8Array(deflateSync(raw))),
		chunk("IEND", new Uint8Array(0)),
	];
	const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
	let offset = 0;
	for (const part of parts) {
		out.set(part, offset);
		offset += part.length;
	}
	return out;
}
