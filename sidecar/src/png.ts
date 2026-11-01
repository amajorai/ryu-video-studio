import type { AlphaRaster, RgbaRaster } from "../../shared/raster.ts";

/**
 * Minimal deterministic PNG encoder (W1-R1) for rasterized mattes and shape
 * layers that the renderer feeds to FFmpeg as still inputs. It writes 8-bit
 * grayscale, gray+alpha, RGB or RGBA images, chooses a scanline filter per
 * row with the minimum-sum-of-absolute-differences heuristic, and compresses
 * through `Bun.deflateSync` wrapped in a zlib stream.
 */

/** Bytes per pixel: gray, gray+alpha, RGB or RGBA. */
export type PngChannels = 1 | 2 | 3 | 4;

export interface PngImage {
	readonly channels: PngChannels;
	readonly data: Uint8Array;
	readonly height: number;
	readonly width: number;
}

export interface PngEncodeOptions {
	/** Deflate level 0..9 (default 6). */
	level?: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
}

/** PNG's own limit on an image edge. */
const MAX_PNG_EDGE = 2_147_483_647;
/** Largest uncompressed scanline payload this encoder accepts (1 GiB). */
export const MAX_PNG_BYTES = 1 << 30;

const SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const COLOR_TYPE: Record<PngChannels, number> = { 1: 0, 2: 4, 3: 2, 4: 6 };

let crcTable: Uint32Array | undefined;

function crcLookup(): Uint32Array {
	if (crcTable) {
		return crcTable;
	}
	const table = new Uint32Array(256);
	for (let byte = 0; byte < 256; byte += 1) {
		let value = byte;
		for (let bit = 0; bit < 8; bit += 1) {
			value = value & 1 ? 0xed_b8_83_20 ^ (value >>> 1) : value >>> 1;
		}
		table[byte] = value >>> 0;
	}
	crcTable = table;
	return table;
}

/** CRC-32 (ISO 3309) over the concatenation of `parts`. */
export function crc32(...parts: Uint8Array[]): number {
	const table = crcLookup();
	let crc = 0xff_ff_ff_ff;
	for (const part of parts) {
		for (const byte of part) {
			crc = (table[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
		}
	}
	return (crc ^ 0xff_ff_ff_ff) >>> 0;
}

/** Adler-32 checksum that closes a zlib stream. */
export function adler32(data: Uint8Array): number {
	let a = 1;
	let b = 0;
	// 5552 is the longest run before the sums can overflow 2^32.
	for (let start = 0; start < data.length; start += 5552) {
		const end = Math.min(data.length, start + 5552);
		for (let index = start; index < end; index += 1) {
			a += data[index] ?? 0;
			b += a;
		}
		a %= 65_521;
		b %= 65_521;
	}
	return ((b << 16) | a) >>> 0;
}

function chunk(type: string, payload: Uint8Array): Uint8Array {
	const typeBytes = new TextEncoder().encode(type);
	const out = new Uint8Array(12 + payload.length);
	const view = new DataView(out.buffer);
	view.setUint32(0, payload.length);
	out.set(typeBytes, 4);
	out.set(payload, 8);
	view.setUint32(8 + payload.length, crc32(typeBytes, payload));
	return out;
}

function paeth(left: number, up: number, upLeft: number): number {
	const estimate = left + up - upLeft;
	const toLeft = Math.abs(estimate - left);
	const toUp = Math.abs(estimate - up);
	const toUpLeft = Math.abs(estimate - upLeft);
	if (toLeft <= toUp && toLeft <= toUpLeft) {
		return left;
	}
	return toUp <= toUpLeft ? up : upLeft;
}

/** Filters one scanline with `filter` (0..4) into `out`; returns its cost. */
function filterRow(
	filter: number,
	row: Uint8Array,
	previous: Uint8Array | undefined,
	bpp: number,
	out: Uint8Array
): number {
	let cost = 0;
	for (let index = 0; index < row.length; index += 1) {
		const raw = row[index] ?? 0;
		const left = index >= bpp ? (row[index - bpp] ?? 0) : 0;
		const up = previous?.[index] ?? 0;
		const upLeft = index >= bpp ? (previous?.[index - bpp] ?? 0) : 0;
		let predictor = 0;
		switch (filter) {
			case 1:
				predictor = left;
				break;
			case 2:
				predictor = up;
				break;
			case 3:
				predictor = (left + up) >>> 1;
				break;
			case 4:
				predictor = paeth(left, up, upLeft);
				break;
			default:
				predictor = 0;
		}
		const value = (raw - predictor) & 0xff;
		out[index] = value;
		cost += value < 128 ? value : 256 - value;
	}
	return cost;
}

function validate(image: PngImage): void {
	const { channels, data, height, width } = image;
	if (!(channels in COLOR_TYPE)) {
		throw new RangeError("PNG images have 1, 2, 3 or 4 channels.");
	}
	for (const [value, label] of [
		[width, "PNG width"],
		[height, "PNG height"],
	] as const) {
		if (!Number.isInteger(value) || value < 1 || value > MAX_PNG_EDGE) {
			throw new RangeError(`${label} must be a positive integer.`);
		}
	}
	const expected = width * height * channels;
	if (expected + height > MAX_PNG_BYTES) {
		throw new RangeError("The PNG image is too large to encode.");
	}
	if (data.length !== expected) {
		throw new RangeError(
			`PNG data has ${data.length} bytes; ${width}x${height}x${channels} needs ${expected}.`
		);
	}
}

/** Encodes an 8-bit image as PNG bytes. Same input, same bytes. */
export function encodePng(
	image: PngImage,
	{ level = 6 }: PngEncodeOptions = {}
): Uint8Array {
	validate(image);
	const { channels, data, height, width } = image;
	const stride = width * channels;
	const filtered = new Uint8Array((stride + 1) * height);
	const candidate = new Uint8Array(stride);
	const best = new Uint8Array(stride);
	for (let row = 0; row < height; row += 1) {
		const line = data.subarray(row * stride, (row + 1) * stride);
		const previous =
			row > 0 ? data.subarray((row - 1) * stride, row * stride) : undefined;
		let bestFilter = 0;
		let bestCost = filterRow(0, line, previous, channels, best);
		for (let filter = 1; filter <= 4; filter += 1) {
			const cost = filterRow(filter, line, previous, channels, candidate);
			if (cost < bestCost) {
				bestCost = cost;
				bestFilter = filter;
				best.set(candidate);
			}
		}
		const offset = row * (stride + 1);
		filtered[offset] = bestFilter;
		filtered.set(best, offset + 1);
	}
	const deflated = Bun.deflateSync(filtered, { level });
	// zlib wrapper: CMF 0x78 (deflate, 32 KiB window) and a FLG that makes the
	// header a multiple of 31, then the raw stream and its Adler-32.
	const zlib = new Uint8Array(deflated.length + 6);
	zlib[0] = 0x78;
	zlib[1] = 0x9c;
	zlib.set(deflated, 2);
	new DataView(zlib.buffer).setUint32(deflated.length + 2, adler32(filtered));

	const header = new Uint8Array(13);
	const headerView = new DataView(header.buffer);
	headerView.setUint32(0, width);
	headerView.setUint32(4, height);
	header[8] = 8;
	header[9] = COLOR_TYPE[channels];
	header[10] = 0;
	header[11] = 0;
	header[12] = 0;

	const parts = [
		SIGNATURE,
		chunk("IHDR", header),
		chunk("IDAT", zlib),
		chunk("IEND", new Uint8Array()),
	];
	const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
	let offset = 0;
	for (const part of parts) {
		out.set(part, offset);
		offset += part.length;
	}
	return out;
}

/** A coverage mask as a grayscale PNG (white = covered), FFmpeg's matte form. */
export function alphaRasterToPng(
	mask: AlphaRaster,
	options?: PngEncodeOptions
): Uint8Array {
	return encodePng(
		{ channels: 1, data: mask.data, height: mask.height, width: mask.width },
		options
	);
}

/** A straight-alpha RGBA raster as an RGBA PNG. */
export function rgbaRasterToPng(
	raster: RgbaRaster,
	options?: PngEncodeOptions
): Uint8Array {
	return encodePng(
		{
			channels: 4,
			data: raster.data,
			height: raster.height,
			width: raster.width,
		},
		options
	);
}

/** Encodes `image` and writes it to `path`. */
export async function writePng(
	path: string,
	image: PngImage,
	options?: PngEncodeOptions
): Promise<void> {
	await Bun.write(path, encodePng(image, options));
}
