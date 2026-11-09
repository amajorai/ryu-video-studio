import { describe, expect, test } from "bun:test";
import { dubbingFilename, dubbingScript } from "./dubbing.ts";

describe("dubbing scripts", () => {
	test("joins timed caption text without changing its source timing", () => {
		expect(
			dubbingScript([
				{ id: crypto.randomUUID(), start: 0, end: 1, text: " Hello " },
				{ id: crypto.randomUUID(), start: 1, end: 2, text: "world." },
			])
		).toBe("Hello world.");
	});

	test("rejects empty and oversized tracks and sanitizes filenames", () => {
		expect(() => dubbingScript([])).toThrow("Add captions");
		expect(() =>
			dubbingScript([
				{ id: crypto.randomUUID(), start: 0, end: 1, text: "x".repeat(8001) },
			])
		).toThrow("longer");
		expect(dubbingFilename("français / dub")).toBe(
			"Dubbed captions fran-ais-dub.wav"
		);
	});
});
