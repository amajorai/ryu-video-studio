/**
 * Verification helper: give a font a family name no installed font has, so a
 * real render can prove a title was drawn from that exact imported file
 * rather than a system or bundled fallback. Used by the real-FFmpeg verify
 * scripts only.
 */

function check(condition: boolean, message: string): asserts condition {
	if (!condition) {
		throw new Error(message);
	}
}

/** Replace a same-length family name inside the font's `name` table only. */
export function renameFontFamily(
	bytes: Uint8Array,
	from: string,
	to: string
): Uint8Array {
	check(from.length === to.length, "names must have the same length");
	const out = new Uint8Array(bytes);
	const view = new DataView(out.buffer);
	let start = -1;
	let end = -1;
	for (let index = 0; index < view.getUint16(4); index++) {
		const at = 12 + index * 16;
		if (new TextDecoder().decode(out.subarray(at, at + 4)) === "name") {
			start = view.getUint32(at + 8);
			end = start + view.getUint32(at + 12);
		}
	}
	check(start >= 0, "the font has no name table");
	const encodings = [
		(text: string) => new Uint8Array([...text].map((c) => c.charCodeAt(0))),
		(text: string) =>
			new Uint8Array([...text].flatMap((c) => [0, c.charCodeAt(0)])),
	];
	let replaced = 0;
	for (const encode of encodings) {
		const needle = encode(from);
		const value = encode(to);
		for (let at = start; at + needle.length <= end; at++) {
			if (needle.every((byte, offset) => out[at + offset] === byte)) {
				out.set(value, at);
				replaced++;
			}
		}
	}
	check(replaced > 0, `${from} was not found in the name table`);
	return out;
}
