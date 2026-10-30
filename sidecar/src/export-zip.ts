/**
 * Minimal ZIP writer for image-sequence exports. Entries use the `store`
 * method (PNG and JPEG are already compressed), a fixed 1980-01-01 DOS
 * timestamp so archives are byte-reproducible, and the classic 32-bit
 * format: at most 65 535 entries and 4 GiB in total.
 */

export const MAX_ZIP_ENTRIES = 0xff_ff;
export const MAX_ZIP_BYTES = 0xff_ff_ff_ff;

const LOCAL_HEADER = 0x04_03_4b_50;
const CENTRAL_HEADER = 0x02_01_4b_50;
const END_OF_CENTRAL_DIRECTORY = 0x06_05_4b_50;
/** Version 2.0: the minimum for stored entries in folders. */
const VERSION = 20;
/** 1980-01-01, the DOS epoch. */
const DOS_DATE = (1 << 5) | 1;
/** Bit 11: names are UTF-8. */
const UTF8_FLAG = 0x8_00;

export interface ZipEntry {
	data: Uint8Array;
	name: string;
}

interface CentralRecord {
	crc: number;
	name: Uint8Array;
	offset: number;
	size: number;
}

function localHeader(name: Uint8Array, crc: number, size: number): Uint8Array {
	const header = new Uint8Array(30 + name.length);
	const view = new DataView(header.buffer);
	view.setUint32(0, LOCAL_HEADER, true);
	view.setUint16(4, VERSION, true);
	view.setUint16(6, UTF8_FLAG, true);
	view.setUint16(8, 0, true);
	view.setUint16(10, 0, true);
	view.setUint16(12, DOS_DATE, true);
	view.setUint32(14, crc, true);
	view.setUint32(18, size, true);
	view.setUint32(22, size, true);
	view.setUint16(26, name.length, true);
	view.setUint16(28, 0, true);
	header.set(name, 30);
	return header;
}

function centralHeader(record: CentralRecord): Uint8Array {
	const header = new Uint8Array(46 + record.name.length);
	const view = new DataView(header.buffer);
	view.setUint32(0, CENTRAL_HEADER, true);
	view.setUint16(4, VERSION, true);
	view.setUint16(6, VERSION, true);
	view.setUint16(8, UTF8_FLAG, true);
	view.setUint16(10, 0, true);
	view.setUint16(12, 0, true);
	view.setUint16(14, DOS_DATE, true);
	view.setUint32(16, record.crc, true);
	view.setUint32(20, record.size, true);
	view.setUint32(24, record.size, true);
	view.setUint16(28, record.name.length, true);
	view.setUint32(42, record.offset, true);
	header.set(record.name, 46);
	return header;
}

function endRecord(
	count: number,
	directorySize: number,
	directoryOffset: number
): Uint8Array {
	const record = new Uint8Array(22);
	const view = new DataView(record.buffer);
	view.setUint32(0, END_OF_CENTRAL_DIRECTORY, true);
	view.setUint16(8, count, true);
	view.setUint16(10, count, true);
	view.setUint32(12, directorySize, true);
	view.setUint32(16, directoryOffset, true);
	return record;
}

/** Sink for archive bytes; `write` is called in archive order. */
export interface ZipSink {
	write: (chunk: Uint8Array) => void | Promise<void>;
}

/**
 * Streams stored entries into `sink`. Entries are pulled one at a time, so
 * only one frame is in memory. Returns the archive size in bytes.
 */
export async function writeZip(
	entries: AsyncIterable<ZipEntry> | Iterable<ZipEntry>,
	sink: ZipSink
): Promise<number> {
	const encoder = new TextEncoder();
	const records: CentralRecord[] = [];
	let offset = 0;
	const emit = async (chunk: Uint8Array) => {
		offset += chunk.length;
		if (offset > MAX_ZIP_BYTES) {
			throw new Error(
				"The frame archive exceeds 4 GB. Export a shorter range."
			);
		}
		await sink.write(chunk);
	};
	for await (const entry of entries) {
		if (records.length >= MAX_ZIP_ENTRIES) {
			throw new Error("The frame archive holds too many files.");
		}
		const name = encoder.encode(entry.name);
		const crc = Bun.hash.crc32(entry.data) >>> 0;
		const record = { crc, name, offset, size: entry.data.length };
		await emit(localHeader(name, crc, entry.data.length));
		await emit(entry.data);
		records.push(record);
	}
	const directoryOffset = offset;
	for (const record of records) {
		await emit(centralHeader(record));
	}
	await emit(
		endRecord(records.length, offset - directoryOffset, directoryOffset)
	);
	return offset;
}

/** Writes a ZIP of `files` (archive name → local path) to `outputPath`. */
export async function zipFiles(
	files: readonly { name: string; path: string }[],
	outputPath: string
): Promise<number> {
	const writer = Bun.file(outputPath).writer();
	async function* entries() {
		for (const file of files) {
			yield { name: file.name, data: await Bun.file(file.path).bytes() };
		}
	}
	try {
		return await writeZip(entries(), {
			write: async (chunk) => {
				writer.write(chunk);
				await writer.flush();
			},
		});
	} finally {
		await writer.end();
	}
}
