import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeZip, zipFiles } from "./export-zip.ts";

async function archive(entries: { data: Uint8Array; name: string }[]) {
	const chunks: Uint8Array[] = [];
	const size = await writeZip(entries, {
		write: (chunk) => void chunks.push(chunk),
	});
	return { bytes: Buffer.concat(chunks), size };
}

test("stored entries carry CRC, sizes and a central directory", async () => {
	const data = new TextEncoder().encode("hello");
	const { bytes, size } = await archive([{ name: "a.txt", data }]);
	expect(size).toBe(bytes.length);
	// Local header + name + data, central header + name, end record.
	expect(bytes.length).toBe(30 + 5 + 5 + 46 + 5 + 22);
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	expect(view.getUint32(0, true)).toBe(0x04_03_4b_50);
	expect(view.getUint32(14, true)).toBe(0x36_10_a6_86);
	expect(view.getUint32(18, true)).toBe(5);
	const end = bytes.length - 22;
	expect(view.getUint32(end, true)).toBe(0x06_05_4b_50);
	expect(view.getUint16(end + 10, true)).toBe(1);
	expect(view.getUint32(end + 16, true)).toBe(40);
});

test("archives are byte-reproducible", async () => {
	const entries = () => [
		{ name: "frame_000001.png", data: new Uint8Array([1, 2, 3]) },
		{ name: "frame_000002.png", data: new Uint8Array([4, 5]) },
	];
	expect((await archive(entries())).bytes).toEqual(
		(await archive(entries())).bytes
	);
});

test("zipFiles writes an archive that unzip accepts", async () => {
	const directory = await mkdtemp(join(tmpdir(), "ryu-export-zip-"));
	try {
		await writeFile(join(directory, "one.bin"), new Uint8Array(1000).fill(7));
		await writeFile(join(directory, "two.bin"), "second");
		const output = join(directory, "frames.zip");
		const size = await zipFiles(
			[
				{ name: "frame_000001.bin", path: join(directory, "one.bin") },
				{ name: "frame_000002.bin", path: join(directory, "two.bin") },
			],
			output
		);
		expect(Bun.file(output).size).toBe(size);
		const unzip = spawnSync("unzip", ["-t", output], { encoding: "utf8" });
		if (unzip.error) {
			// `unzip` is optional on the test host; the byte checks above cover the format.
			return;
		}
		expect(unzip.status).toBe(0);
		expect(unzip.stdout).toContain("No errors detected");
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
