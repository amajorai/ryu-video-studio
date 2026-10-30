import { afterAll, beforeEach, expect, test } from "bun:test";
import type { HostServices } from "@ryu/app-host/rpc";
import { z } from "zod";
import {
	mediaBlob,
	mediaDataUrlBlob,
	request,
	type StudioResponse,
	studioResponseSchema,
} from "./bridge.ts";

type StudioHostRequest = Parameters<NonNullable<HostServices["appRequest"]>>[0];
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
const received: StudioHostRequest[] = [];
let response: StudioResponse;
let rejection: Error | undefined;

beforeEach(() => {
	received.length = 0;
	response = null;
	rejection = undefined;
	const requestService: NonNullable<HostServices["appRequest"]> = async (
		input
	) => {
		received.push(input);
		if (rejection) {
			throw rejection;
		}
		return response;
	};
	Object.defineProperty(globalThis, "window", {
		configurable: true,
		value: { ryu: { app: { request: requestService } } },
	});
});

afterAll(() => {
	if (originalWindow) {
		Object.defineProperty(globalThis, "window", originalWindow);
	} else {
		Reflect.deleteProperty(globalThis, "window");
	}
});

test("validates responses against the caller's domain schema", async () => {
	response = { count: 3, providerMetadata: "preserved" };
	const schema = z.object({ count: z.number().int().positive() }).passthrough();
	expect(await request(schema, "/fixture")).toEqual({
		count: 3,
		providerMetadata: "preserved",
	});
	response = { count: "3" };
	await expect(request(schema, "/fixture")).rejects.toThrow();
});

test("preserves structured host errors before parsing a successful response", async () => {
	response = {
		code: "permission-denied",
		message: "Core refused the operation",
	};
	await expect(
		request(z.object({ count: z.number() }), "/fixture")
	).rejects.toThrow("Core refused the operation");
});

test("omits an absent body and sends a supplied body unchanged", async () => {
	await request(studioResponseSchema, "/fixture");
	expect(received[0]).toEqual({ path: "/fixture", method: "GET" });
	await request(studioResponseSchema, "/fixture", "POST", { count: 3 });
	expect(received[1]).toEqual({
		path: "/fixture",
		method: "POST",
		body: { count: 3 },
	});
});

test("allows empty responses for operations without response data", async () => {
	response = undefined;
	expect(
		await request(studioResponseSchema, "/fixture", "DELETE")
	).toBeUndefined();
});

test("retains a host rejection and the disconnected library message", async () => {
	rejection = new Error("Core denied access");
	await expect(request(studioResponseSchema, "/fixture")).rejects.toThrow(
		"Core denied access"
	);
	Object.defineProperty(globalThis, "window", {
		configurable: true,
		value: {},
	});
	await expect(request(studioResponseSchema, "/fixture")).rejects.toThrow(
		"Open Video Studio in Ryu to connect to your project library."
	);
});

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
