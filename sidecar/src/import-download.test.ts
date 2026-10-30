import { expect, mock, spyOn, test } from "bun:test";
import type { LookupAddress } from "node:dns";
import * as dns from "node:dns/promises";
import { EventEmitter } from "node:events";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { IncomingMessage } from "node:http";
import * as https from "node:https";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importMediaAsset, requestPinned } from "./import-media.ts";
import {
	acquireMediaOperation,
	withMediaOperation,
} from "./media-operation.ts";
import { StudioStore } from "./store.ts";

interface MediaLookupResolver {
	lookup(
		host: string,
		options: { all: true; verbatim: true }
	): Promise<LookupAddress[]>;
}
const mediaLookupResolver: MediaLookupResolver = dns;

class ControlledRequest extends EventEmitter {
	destroyed = false;
	closed = false;
	readonly response = new IncomingMessage(new Socket());
	constructor(
		private readonly callback: (response: IncomingMessage) => void,
		private readonly holdClose = false,
		private readonly holdHeaders = false
	) {
		super();
		this.response.statusCode = 200;
		this.response.headers = {};
	}
	setTimeout() {
		return this;
	}
	end() {
		if (!this.holdHeaders) {
			queueMicrotask(() => this.callback(this.response));
		}
		return this;
	}
	destroy(error?: Error) {
		if (this.destroyed) {
			return this;
		}
		this.destroyed = true;
		this.response.destroy(error);
		if (error) {
			this.emit("error", error);
		}
		if (!this.holdClose) {
			queueMicrotask(() => this.finishClose());
		}
		return this;
	}
	finishClose() {
		if (!this.closed) {
			this.closed = true;
			this.emit("close");
		}
	}
}

interface RequestEventAdapter extends Pick<EventEmitter, "once"> {
	destroy(error?: Error): void;
	end(): void;
	setTimeout(timeout: number, callback: () => void): void;
}
interface RequestTransport {
	request(
		options: https.RequestOptions,
		callback: (response: IncomingMessage) => void
	): RequestEventAdapter;
}

function transport(
	make: (
		callback: (response: IncomingMessage) => void,
		options: https.RequestOptions
	) => ControlledRequest
) {
	// Match the options/callback event contract consumed by requestPinned.
	const requestTransport: RequestTransport = https;
	const implementation = (
		options: https.RequestOptions,
		callback: (response: IncomingMessage) => void
	): RequestEventAdapter => make(callback, options);
	spyOn(requestTransport, "request").mockImplementation(implementation);
}

test("slow URL download abort holds media admission until request close and deletes partial bytes before probe", async () => {
	const store = new StudioStore(
		await mkdtemp(join(tmpdir(), "ryu-download-abort-"))
	);
	const lookup = spyOn(mediaLookupResolver, "lookup");
	lookup.mockResolvedValue([{ address: "203.0.113.20", family: 4 }]);
	let request: ControlledRequest | undefined;
	transport((callback) => {
		request = new ControlledRequest(callback, true);
		return request;
	});
	let probed = false;
	const controller = new AbortController();
	const pending = withMediaOperation(
		60_000,
		{ signal: controller.signal },
		(operation) =>
			importMediaAsset(
				store,
				{ source: { url: "https://media.example.test/clip.mp4" } },
				{
					signal: operation.signal,
					probe: async () => {
						probed = true;
						throw new Error("Probe must not run");
					},
				}
			)
	).catch((error) => error);
	const other = acquireMediaOperation(60_000);
	try {
		while (!request) {
			await Bun.sleep(5);
		}
		request.response.push(Buffer.from("first chunk"));
		await Bun.sleep(10);
		request.response.push(Buffer.from("periodic chunk"));
		await Bun.sleep(10);
		controller.abort();
		await Bun.sleep(20);
		expect(request.destroyed).toBe(true);
		expect(probed).toBe(false);
		expect(() => acquireMediaOperation(1000)).toThrow("Two media operations");
		request.finishClose();
		expect((await pending).message).toMatch(/canceled|aborted/);
		expect(await readdir(join(store.directory, "media"))).toEqual([]);
		expect(store.assets()).toEqual([]);
		const recovered = acquireMediaOperation(1000);
		recovered.release();
	} finally {
		controller.abort();
		request?.finishClose();
		await pending;
		other.release();
		mock.restore();
		store.close();
		await rm(store.directory, {
			recursive: true,
			force: true,
			maxRetries: 10,
			retryDelay: 100,
		});
	}
});

test("abort before response headers settles only after native request close", async () => {
	let request: ControlledRequest | undefined;
	transport((callback) => {
		request = new ControlledRequest(callback, true, true);
		return request;
	});
	const controller = new AbortController();
	let settled = false;
	const pending = requestPinned(
		new URL("https://media.example.test/clip.mp4"),
		"203.0.113.20",
		controller.signal
	).catch((error) => {
		settled = true;
		return error;
	});
	try {
		controller.abort();
		await Bun.sleep(20);
		expect(settled).toBe(false);
		expect(request?.destroyed).toBe(true);
		request?.finishClose();
		expect((await pending).message).toContain("canceled");
	} finally {
		request?.finishClose();
		await pending;
		mock.restore();
	}
});

test("a valid redirected download closes each hop, retains bytes and proceeds to probe", async () => {
	const store = new StudioStore(
		await mkdtemp(join(tmpdir(), "ryu-download-valid-"))
	);
	const lookup = spyOn(mediaLookupResolver, "lookup");
	lookup.mockResolvedValue([{ address: "203.0.113.20", family: 4 }]);
	const requests: ControlledRequest[] = [];
	transport((callback) => {
		const request = new ControlledRequest(callback);
		requests.push(request);
		if (requests.length === 1) {
			request.response.statusCode = 302;
			request.response.headers.location = "/final.mp4";
		} else {
			expect(requests[0]?.closed).toBe(true);
			queueMicrotask(() => {
				request.response.push(Buffer.from("valid bytes"));
				request.response.push(null);
			});
		}
		return request;
	});
	try {
		const asset = await importMediaAsset(
			store,
			{ source: { url: "https://media.example.test/start.mp4" } },
			{
				signal: new AbortController().signal,
				probe: async () => ({
					kind: "video",
					duration: 1,
					width: 320,
					height: 180,
					hasAudio: false,
				}),
				thumbnail: async () => undefined,
			}
		);
		expect(await Bun.file(store.mediaPath(asset.id)).text()).toBe(
			"valid bytes"
		);
		expect(requests).toHaveLength(2);
		expect(requests.every((request) => request.closed)).toBe(true);
		expect(store.assets()).toHaveLength(1);
	} finally {
		mock.restore();
		store.close();
		await rm(store.directory, {
			recursive: true,
			force: true,
			maxRetries: 10,
			retryDelay: 100,
		});
	}
});
