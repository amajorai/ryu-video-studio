import { expect, test } from "bun:test";
import { mediaBlob, mediaDataUrlBlob } from "./bridge.ts";

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

test("media preloading stops before decoding or fetching another chunk after cancellation", async () => {
	const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
	const controller = new AbortController();
	const reads: string[] = [];
	Object.defineProperty(globalThis, "window", {
		configurable: true,
		value: {
			ryu: {
				app: {
					request: async ({ path }: { path: string }) => {
						reads.push(path);
						controller.abort();
						return {
							data: "invalid base64 must not be decoded",
							size: 20,
							done: false,
						};
					},
				},
			},
		},
	});
	try {
		await expect(
			mediaBlob("/assets/a/data", "image/png", controller.signal)
		).rejects.toMatchObject({ name: "AbortError" });
		expect(reads).toEqual(["/assets/a/data?offset=0"]);
		await expect(
			mediaBlob("/assets/a/data", "image/png", controller.signal)
		).rejects.toMatchObject({ name: "AbortError" });
		expect(reads).toHaveLength(1);
	} finally {
		if (previous) {
			Object.defineProperty(globalThis, "window", previous);
		} else {
			Reflect.deleteProperty(globalThis, "window");
		}
	}
});
