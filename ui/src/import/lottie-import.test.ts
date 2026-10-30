import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { z } from "zod";
import { parseLottieDocument } from "../../../shared/lottie.ts";
import {
	importLottie,
	type LottieFrameRenderer,
	type LottieRequest,
	lottieAssetName,
	readLottieFile,
} from "./lottie-import.ts";

const fixturePath = join(
	import.meta.dir,
	"../../e2e/fixtures/spinning-square.lottie.json"
);

const animation = parseLottieDocument(
	JSON.stringify({ fr: 30, h: 100, ip: 0, layers: [], op: 120, w: 100 })
);

function lottieAsset() {
	return {
		createdAt: new Date(0).toISOString(),
		derivation: "lottie",
		duration: 4,
		hasAudio: false,
		height: 100,
		id: crypto.randomUUID(),
		kind: "video",
		name: "Spinner",
		width: 100,
	};
}

interface Call {
	body?: Record<string, unknown>;
	method: string;
	path: string;
}

/** A fake sidecar that accepts ordered chunks and records every call. */
function fakeSidecar(
	options: { loseFrames?: boolean; onUpload?: () => void } = {}
) {
	const calls: Call[] = [];
	let received = 0;
	const send: LottieRequest = <T>(
		schema: z.ZodType<T>,
		path: string,
		method: "DELETE" | "POST",
		body?: Record<string, unknown>
	) => {
		calls.push(body ? { body, method, path } : { method, path });
		if (path === "/lottie-frames") {
			const frames = Array.isArray(body?.frames) ? body.frames.length : 0;
			received += options.loseFrames ? frames - 1 : frames;
			options.onUpload?.();
			return Promise.resolve(
				schema.parse({
					frameCount: 120,
					received,
					sessionId: body?.sessionId,
				})
			);
		}
		if (path === "/lottie-frames-finish") {
			return Promise.resolve(schema.parse({ asset: lottieAsset() }));
		}
		return Promise.resolve(schema.parse({ aborted: true }));
	};
	return { calls, send };
}

function fakeRenderer(frameChars = 8) {
	const rendered: number[] = [];
	let destroyed = false;
	const renderer: LottieFrameRenderer = {
		destroy: () => {
			destroyed = true;
		},
		render: (frame) => {
			rendered.push(frame);
			return Promise.resolve("A".repeat(frameChars));
		},
	};
	return {
		createRenderer: () => Promise.resolve(renderer),
		destroyed: () => destroyed,
		rendered,
	};
}

describe("Lottie import", () => {
	test("renders every frame at the project rate and uploads ordered chunks of at most 50", async () => {
		const sidecar = fakeSidecar();
		const renderer = fakeRenderer();
		const progress: number[] = [];
		const { asset, preview } = await importLottie({
			animation,
			createRenderer: renderer.createRenderer,
			name: "Spinner",
			onProgress: (value) => progress.push(value),
			projectFps: 30,
			send: sidecar.send,
		});
		expect(asset.derivation).toBe("lottie");
		expect(preview).toBeUndefined();
		expect(renderer.rendered).toHaveLength(120);
		expect(renderer.rendered.slice(0, 3)).toEqual([0, 1, 2]);
		expect(renderer.destroyed()).toBe(true);
		const uploads = sidecar.calls.filter(
			(call) => call.path === "/lottie-frames"
		);
		expect(uploads.map((call) => call.body?.index)).toEqual([0, 50, 100]);
		expect(
			uploads.map((call) =>
				Array.isArray(call.body?.frames) ? call.body.frames.length : 0
			)
		).toEqual([50, 50, 20]);
		expect(uploads[0]?.body?.meta).toEqual({
			fps: 30,
			frameCount: 120,
			height: 100,
			name: "Spinner",
			width: 100,
		});
		expect(uploads[1]?.body?.meta).toBeUndefined();
		const sessionIds = new Set(
			sidecar.calls.map((call) => call.body?.sessionId)
		);
		expect(sessionIds.size).toBe(1);
		expect(sidecar.calls.at(-1)?.path).toBe("/lottie-frames-finish");
		expect(progress.at(-1)).toBe(1);
	});

	test("large frames close a chunk at the byte budget", async () => {
		const sidecar = fakeSidecar();
		await importLottie({
			animation: { ...animation, op: 5 },
			createRenderer: fakeRenderer(600_000).createRenderer,
			name: "Big",
			projectFps: 30,
			send: sidecar.send,
		});
		expect(
			sidecar.calls
				.filter((call) => call.path === "/lottie-frames")
				.map((call) => call.body?.index)
		).toEqual([0, 2, 4]);
	});

	test("an abort cancels the sidecar session and destroys the renderer", async () => {
		const sidecar = fakeSidecar();
		const renderer = fakeRenderer();
		const controller = new AbortController();
		const createRenderer = async () => {
			const inner = await renderer.createRenderer();
			return {
				destroy: inner.destroy,
				render: async (frame: number) => {
					if (frame === 60) {
						controller.abort();
					}
					return await inner.render(frame);
				},
			};
		};
		await expect(
			importLottie({
				animation,
				createRenderer,
				name: "Spinner",
				projectFps: 30,
				send: sidecar.send,
				signal: controller.signal,
			})
		).rejects.toThrow();
		expect(renderer.destroyed()).toBe(true);
		const last = sidecar.calls.at(-1);
		expect(last?.method).toBe("DELETE");
		expect(last?.path).toMatch(/^\/lottie-frames\?sessionId=[0-9a-f-]{36}$/);
		expect(
			sidecar.calls.some((call) => call.path === "/lottie-frames-finish")
		).toBe(false);
	});

	test("renders absolute Lottie frames from the in point at the project rate", async () => {
		const renderer = fakeRenderer();
		await importLottie({
			animation: { ...animation, ip: 30, op: 90 },
			createRenderer: renderer.createRenderer,
			name: "Offset",
			projectFps: 30,
			send: fakeSidecar().send,
		});
		expect(renderer.rendered).toHaveLength(60);
		expect([
			renderer.rendered[0],
			renderer.rendered[30],
			renderer.rendered[59],
		]).toEqual([30, 60, 89]);
	});

	test("an abort during a chunk upload stops before the next chunk", async () => {
		const controller = new AbortController();
		const sidecar = fakeSidecar({ onUpload: () => controller.abort() });
		await expect(
			importLottie({
				animation,
				createRenderer: fakeRenderer().createRenderer,
				name: "Spinner",
				projectFps: 30,
				send: sidecar.send,
				signal: controller.signal,
			})
		).rejects.toThrow();
		expect(sidecar.calls.map((call) => call.method)).toEqual([
			"POST",
			"DELETE",
		]);
	});

	test("onEncoding fires once, after the last upload and before finish", async () => {
		const sidecar = fakeSidecar();
		const events: string[] = [];
		await importLottie({
			animation,
			createRenderer: fakeRenderer().createRenderer,
			name: "Spinner",
			onEncoding: () => events.push(`encoding after ${sidecar.calls.length}`),
			projectFps: 30,
			send: sidecar.send,
		});
		expect(events).toEqual(["encoding after 3"]);
		expect(sidecar.calls.at(-1)?.path).toBe("/lottie-frames-finish");
	});

	test("a sidecar that lost frames stops the import", async () => {
		const sidecar = fakeSidecar({ loseFrames: true });
		await expect(
			importLottie({
				animation,
				createRenderer: fakeRenderer().createRenderer,
				name: "Spinner",
				projectFps: 30,
				send: sidecar.send,
			})
		).rejects.toThrow("lost its place");
		expect(sidecar.calls.at(-1)?.method).toBe("DELETE");
	});

	test("oversized frames and long animations fail before any upload", async () => {
		const sidecar = fakeSidecar();
		await expect(
			importLottie({
				animation,
				createRenderer: fakeRenderer(1_500_001).createRenderer,
				name: "Huge",
				projectFps: 30,
				send: sidecar.send,
			})
		).rejects.toThrow("too detailed");
		await expect(
			importLottie({
				animation: { ...animation, op: 1200 },
				createRenderer: fakeRenderer().createRenderer,
				name: "Long",
				projectFps: 30,
				send: sidecar.send,
			})
		).rejects.toThrow("limit is 600");
		expect(sidecar.calls).toEqual([]);
	});

	test("reads the bundled fixture and names assets after the file", async () => {
		const document = await readLottieFile(
			new Blob([await readFile(fixturePath, "utf8")])
		);
		expect(document).toMatchObject({ fr: 30, h: 200, op: 30, w: 200 });
		await expect(
			readLottieFile(new Blob([new Uint8Array(5 * 1024 * 1024 + 1)]))
		).rejects.toThrow("5 MB");
		expect(lottieAssetName("Spinner.JSON")).toBe("Spinner");
		expect(lottieAssetName("loader.lottie.json")).toBe("loader");
		expect(lottieAssetName("loader.lottie")).toBe("loader");
		expect(lottieAssetName(".json")).toBe("Lottie animation");
	});

	test("reads a .lottie (dotLottie) archive through the same importer", async () => {
		const archive = await readFile(
			join(import.meta.dir, "../../e2e/fixtures/spinning-square.lottie")
		);
		const document = await readLottieFile(
			new File([archive], "spinning-square.lottie")
		);
		expect(document).toMatchObject({ fr: 30, h: 200, op: 30, w: 200 });
		// Detected from the bytes even without the extension.
		expect(await readLottieFile(new File([archive], "download"))).toMatchObject(
			{ w: 200 }
		);
	});
});
