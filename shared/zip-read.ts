/**
 * Minimal ZIP reader for bounded archives (dotLottie files, project
 * archives). It reads the central directory, accepts `store` (0) and
 * `deflate` (8) entries, inflates with the platform `DecompressionStream`
 * ("deflate-raw", available in browsers and Bun), and refuses archives over
 * the given entry and byte limits before inflating anything, plus entry names
 * that are absolute or climb out of the archive (`..`). Inflation is
 * incremental and stops as soon as an entry outgrows its declared size.
 */

const LOCAL_HEADER = 0x04_03_4b_50;
const CENTRAL_HEADER = 0x02_01_4b_50;
const END_OF_CENTRAL_DIRECTORY = 0x06_05_4b_50;
/** The end record is at most 22 bytes plus a 65 535-byte comment from the end. */
const MAX_END_SEARCH = 22 + 0xff_ff;

export interface ZipReadLimits {
	/** Most entries the archive may hold. */
	maxEntries: number;
	/** Largest total uncompressed size, in bytes. */
	maxTotalBytes: number;
}

interface CentralEntry {
	compressed: number;
	method: number;
	name: string;
	offset: number;
	size: number;
}

export class ZipReadError extends Error {
	override name = "ZipReadError";
}

/** Whether a stored name is safe to use as a relative path. */
export function safeZipName(name: string): boolean {
	return (
		name.length > 0 &&
		!name.startsWith("/") &&
		!name.startsWith("\\") &&
		!/^[a-z]:/i.test(name) &&
		!name.split(/[\\/]/).some((part) => part === "..")
	);
}

function endRecord(view: DataView): number {
	const start = Math.max(0, view.byteLength - MAX_END_SEARCH);
	for (let offset = view.byteLength - 22; offset >= start; offset--) {
		if (view.getUint32(offset, true) === END_OF_CENTRAL_DIRECTORY) {
			return offset;
		}
	}
	throw new ZipReadError("This file is not a ZIP archive.");
}

function centralEntries(
	bytes: Uint8Array,
	limits: ZipReadLimits
): CentralEntry[] {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const end = endRecord(view);
	const count = view.getUint16(end + 10, true);
	let offset = view.getUint32(end + 16, true);
	if (count > limits.maxEntries) {
		throw new ZipReadError(
			`The archive holds more than ${limits.maxEntries} files.`
		);
	}
	const decoder = new TextDecoder();
	const entries: CentralEntry[] = [];
	let total = 0;
	for (let index = 0; index < count; index++) {
		if (
			offset + 46 > bytes.byteLength ||
			view.getUint32(offset, true) !== CENTRAL_HEADER
		) {
			throw new ZipReadError("The archive's file list is damaged.");
		}
		const flags = view.getUint16(offset + 8, true);
		const method = view.getUint16(offset + 10, true);
		const compressed = view.getUint32(offset + 20, true);
		const size = view.getUint32(offset + 24, true);
		const nameLength = view.getUint16(offset + 28, true);
		const extraLength = view.getUint16(offset + 30, true);
		const commentLength = view.getUint16(offset + 32, true);
		const local = view.getUint32(offset + 42, true);
		const name = decoder.decode(
			bytes.subarray(offset + 46, offset + 46 + nameLength)
		);
		offset += 46 + nameLength + extraLength + commentLength;
		if (flags & 0x1) {
			throw new ZipReadError("Encrypted archives are not supported.");
		}
		if (name.endsWith("/")) {
			continue;
		}
		if (!safeZipName(name)) {
			throw new ZipReadError(`The archive has an unsafe file name: ${name}`);
		}
		if (method !== 0 && method !== 8) {
			throw new ZipReadError(`Unsupported compression in ${name}.`);
		}
		total += size;
		if (total > limits.maxTotalBytes) {
			throw new ZipReadError("The archive is too large to open.");
		}
		entries.push({ compressed, method, name, offset: local, size });
	}
	return entries;
}

/**
 * Compressed bytes fed to the inflater per step. The output is read as it is
 * produced, so a deflate bomb (a tiny entry that expands far past its declared
 * size) is abandoned after at most one step's expansion instead of being
 * inflated into memory in full.
 */
const INFLATE_INPUT_CHUNK = 64 * 1024;

async function inflate(data: Uint8Array, size: number): Promise<Uint8Array> {
	let position = 0;
	const source = new ReadableStream<BufferSource>(
		{
			pull(controller) {
				if (position >= data.byteLength) {
					controller.close();
					return;
				}
				const end = Math.min(data.byteLength, position + INFLATE_INPUT_CHUNK);
				controller.enqueue(data.slice(position, end));
				position = end;
			},
		},
		{ highWaterMark: 0 }
	);
	const reader = source
		.pipeThrough(new DecompressionStream("deflate-raw"))
		.getReader();
	const chunks: Uint8Array[] = [];
	let written = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) {
			break;
		}
		written += value.byteLength;
		if (written > size) {
			// Stop inflating the moment the entry outgrows its declared size; the
			// declared sizes were already checked against `maxTotalBytes`.
			await reader.cancel().catch(() => undefined);
			throw new ZipReadError("A file in the archive is damaged.");
		}
		chunks.push(value);
	}
	if (written !== size) {
		throw new ZipReadError("A file in the archive is damaged.");
	}
	if (chunks.length === 1 && chunks[0]) {
		return chunks[0];
	}
	const out = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return out;
}

/** Every file in the archive, by its stored name. */
export async function readZip(
	bytes: Uint8Array,
	limits: ZipReadLimits
): Promise<Map<string, Uint8Array>> {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const files = new Map<string, Uint8Array>();
	for (const entry of centralEntries(bytes, limits)) {
		const at = entry.offset;
		if (
			at + 30 > bytes.byteLength ||
			view.getUint32(at, true) !== LOCAL_HEADER
		) {
			throw new ZipReadError("The archive is damaged.");
		}
		const start =
			at + 30 + view.getUint16(at + 26, true) + view.getUint16(at + 28, true);
		const data = bytes.subarray(start, start + entry.compressed);
		if (data.byteLength !== entry.compressed) {
			throw new ZipReadError("The archive is truncated.");
		}
		if (entry.method === 0 && entry.compressed !== entry.size) {
			// A stored entry is its own data: a size that differs from its stored
			// length would slip past the `maxTotalBytes` check.
			throw new ZipReadError("A file in the archive is damaged.");
		}
		files.set(
			entry.name,
			entry.method === 0 ? data : await inflate(data, entry.size)
		);
	}
	return files;
}
