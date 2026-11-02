import { expect, test } from "bun:test";
import { importMediaRequestSchema } from "./import-media.ts";

test("import media schema accepts one HTTPS/path/bytes source", () => {
	const parsed = importMediaRequestSchema.parse({
		folder: "B-roll",
		name: "Opening",
		source: {
			bytes: "aGVsbG8=",
			mimeType: "video/mp4",
		},
	});
	expect(parsed.source.bytes).toBe("aGVsbG8=");
	expect(() =>
		importMediaRequestSchema.parse({
			source: { path: "/tmp/source.mp4", url: "https://example.com/a.mp4" },
		})
	).toThrow("exactly one");
	expect(() =>
		importMediaRequestSchema.parse({
			source: { bytes: "aGVsbG8=" },
		})
	).toThrow("mimeType");
	expect(() =>
		importMediaRequestSchema.parse({
			source: { url: "http://example.com/a.mp4" },
		})
	).toThrow("HTTPS");
});
