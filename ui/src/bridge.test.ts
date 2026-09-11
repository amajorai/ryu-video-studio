import { expect, test } from "bun:test";
import { mediaDataUrlBlob } from "./bridge.ts";

test("media data URLs decode locally without a network fetch", async () => {
	const blob = mediaDataUrlBlob("data:audio/wav;base64,V2F2ZSBieXRlcw==");
	expect(blob.type).toBe("audio/wav");
	expect(await blob.text()).toBe("Wave bytes");
});
test("media decoding rejects remote and executable document URLs", () => {
	expect(() => mediaDataUrlBlob("https://example.com/audio.wav")).toThrow();
	expect(() =>
		mediaDataUrlBlob("data:text/html;base64,PHNjcmlwdD4=")
	).toThrow();
	expect(() => mediaDataUrlBlob("data:audio/wav;base64,***")).toThrow();
});
