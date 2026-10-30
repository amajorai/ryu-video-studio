import { expect, test } from "bun:test";
import {
	generatedDataUrl,
	generatedMediaResponseSchema,
} from "./generation-response.ts";

test("generated media keeps legacy strings and URL records", () => {
	const url = "data:image/png;base64,YQ==";
	expect(generatedDataUrl(url, "image")).toBe(url);
	expect(generatedDataUrl({ url, provider: "legacy" }, "image")).toBe(url);
	expect(generatedDataUrl([null, { url: 42 }, { url }], "image")).toBe(url);
});

test("generated media rejects remote URLs and media of another kind", () => {
	expect(() =>
		generatedDataUrl({ url: "https://example.org/image.png" }, "image")
	).toThrow("usable generated media");
	expect(() => generatedDataUrl("data:audio/wav;base64,YQ==", "image")).toThrow(
		"usable generated media"
	);
	expect(() => generatedDataUrl(undefined, "image")).toThrow(
		"usable generated media"
	);
});

test("generated media selection retains the first sixteen candidate limit", () => {
	const candidates = Array.from({ length: 16 }, () => null);
	expect(() =>
		generatedDataUrl([...candidates, "data:image/png;base64,YQ=="], "image")
	).toThrow("usable generated media");
});

test("the host response boundary rejects values that are not JSON", () => {
	expect(() =>
		generatedMediaResponseSchema.parse({ url: () => "untrusted" })
	).toThrow();
});
