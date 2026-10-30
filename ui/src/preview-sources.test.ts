import { describe, expect, test } from "bun:test";
import {
	alphaPreviewMissing,
	PreviewSources,
	previewMimeType,
	selectPreviewMedia,
	wantedProxyVariant,
	withoutProxies,
} from "./preview-sources.ts";

const image = (id: string) => ({ id, kind: "image" as const });
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test("normalizes a rejected non-error value to the existing operation message", async () => {
	const errors: Error[] = [];
	const cache = new PreviewSources(() => Promise.reject("untrusted failure"));
	cache.sync(
		[image("failed")],
		() => undefined,
		(error) => errors.push(error)
	);
	await settle();
	expect(errors[0]).toBeInstanceOf(Error);
	expect(errors[0]?.message).toBe("The operation failed.");
	cache.dispose();
});

test("reuses a pending read when a newer preview still needs the asset", async () => {
	const reads: string[] = [];
	let resolve!: (blob: Blob) => void;
	const pending = new Promise<Blob>((done) => {
		resolve = done;
	});
	let created = 0;
	const cache = new PreviewSources(
		async (asset) => {
			reads.push(asset.id);
			return pending;
		},
		() => `blob:${++created}`,
		() => undefined
	);
	const first: unknown[] = [];
	const second: unknown[] = [];
	const stop = cache.sync(
		[image("a")],
		(value) => first.push(value),
		(error) => first.push(error)
	);
	await settle();
	stop();
	cache.sync(
		[image("a")],
		(value) => second.push(value),
		(error) => second.push(error)
	);
	resolve(new Blob(["a"]));
	await settle();
	expect(reads).toEqual(["a"]);
	expect(first).toEqual([]);
	expect(second).toEqual([{ a: "blob:1" }]);
	expect(created).toBe(1);
	cache.dispose();
});

test("a canceled failed read cannot start the rest of its preload queue", async () => {
	const reads: string[] = [];
	let reject!: (error: Error) => void;
	const pending = new Promise<Blob>((_, fail) => {
		reject = fail;
	});
	const errors: unknown[] = [];
	const cache = new PreviewSources(async (asset) => {
		reads.push(asset.id);
		return pending;
	});
	const stop = cache.sync(
		[image("a"), image("b")],
		() => undefined,
		(error) => errors.push(error)
	);
	await settle();
	stop();
	reject(new Error("old request failed"));
	await settle();
	expect(reads).toEqual(["a"]);
	expect(errors).toEqual([]);
	cache.dispose();
});

test("retains shared sources, releases unused ones, and rejects late loads on close", async () => {
	const revoked: string[] = [];
	let created = 0;
	let resolve!: (blob: Blob) => void;
	const pending = new Promise<Blob>((done) => {
		resolve = done;
	});
	const cache = new PreviewSources(
		(asset) =>
			asset.id === "late" ? pending : Promise.resolve(new Blob([asset.id])),
		() => `blob:${++created}`,
		(url) => revoked.push(url)
	);
	const errors: unknown[] = [];
	const changed: unknown[] = [];
	const sync = (ids: string[]) =>
		cache.sync(
			ids.map(image),
			(value) => changed.push(value),
			(error) => errors.push(error)
		);
	sync(["a", "b"]);
	await settle();
	expect(cache.snapshot()).toEqual({ a: "blob:1", b: "blob:2" });
	sync(["b", "late"]);
	expect(revoked).toEqual(["blob:1"]);
	expect(cache.snapshot()).toEqual({ b: "blob:2" });
	await settle();
	cache.dispose();
	resolve(new Blob(["late"]));
	await settle();
	expect(created).toBe(2);
	expect(revoked).toEqual(["blob:1", "blob:2"]);
	expect(cache.snapshot()).toEqual({});
	expect(errors).toEqual([]);
	expect(changed).toHaveLength(3);
});

test("reports one failed read and retries it exactly once on the next sync", async () => {
	const reads: string[] = [];
	const failure = new Error("media read failed");
	const cache = new PreviewSources(
		async (asset) => {
			reads.push(asset.id);
			if (reads.length === 1) {
				throw failure;
			}
			return new Blob([asset.id]);
		},
		() => "blob:recovered",
		() => undefined
	);
	const errors: unknown[] = [];
	const changed: unknown[] = [];
	const sync = () =>
		cache.sync(
			[image("retry")],
			(value) => changed.push(value),
			(error) => errors.push(error)
		);

	sync();
	await settle();
	expect(reads).toEqual(["retry"]);
	expect(errors).toEqual([failure]);
	expect(cache.snapshot()).toEqual({});

	sync();
	await settle();
	expect(reads).toEqual(["retry", "retry"]);
	expect(changed).toEqual([{ retry: "blob:recovered" }]);
	expect(cache.snapshot()).toEqual({ retry: "blob:recovered" });
	cache.dispose();
});

test("removing a pending source aborts its read without surfacing an error", async () => {
	const signals: AbortSignal[] = [];
	const errors: unknown[] = [];
	const cache = new PreviewSources((_asset, signal) => {
		signals.push(signal);
		return new Promise<Blob>((_resolve, reject) => {
			signal.addEventListener("abort", () => reject(signal.reason), {
				once: true,
			});
		});
	});

	cache.sync(
		[image("pending")],
		() => undefined,
		(error) => errors.push(error)
	);
	await settle();
	cache.sync(
		[],
		() => undefined,
		(error) => errors.push(error)
	);
	await settle();

	expect(signals).toHaveLength(1);
	expect(signals[0]?.aborted).toBe(true);
	expect(errors).toEqual([]);
	expect(cache.snapshot()).toEqual({});
	cache.dispose();
});

const source = (id: string, width: number) => ({
	id,
	kind: "video" as const,
	width,
});
const proxyOf = (id: string, sourceId: string, width: number) => ({
	derivation: "proxy" as const,
	derivedFromAssetId: sourceId,
	id,
	kind: "video" as const,
	width,
});

describe("proxy selection", () => {
	const original = source("src", 3840);
	const standard = proxyOf("p960", "src", 960);
	const half = proxyOf("p1920", "src", 1920);
	const library = [original, standard, half, proxyOf("other", "x", 480)];

	test("full quality without the toggle keeps the original", () => {
		expect(
			selectPreviewMedia(original, library, {
				quality: "full",
				useProxies: false,
			})
		).toBe(original);
	});

	test("the toggle at full quality uses the widest proxy", () => {
		expect(
			selectPreviewMedia(original, library, {
				quality: "full",
				useProxies: true,
			})
		).toBe(half);
	});

	test("reduced quality picks the narrowest adequate proxy", () => {
		expect(
			selectPreviewMedia(original, library, {
				quality: "half",
				useProxies: false,
			})
		).toBe(half);
		expect(
			selectPreviewMedia(original, library, {
				quality: "quarter",
				useProxies: false,
			})
		).toBe(standard);
		expect(
			selectPreviewMedia(original, [original, standard], {
				quality: "half",
				useProxies: false,
			})
		).toBe(standard);
	});

	test("media without a proxy, audio, and images keep the original", () => {
		const audio = { id: "a", kind: "audio" as const };
		const still = { id: "i", kind: "image" as const, width: 4000 };
		const bare = source("bare", 4000);
		for (const asset of [audio, still, bare]) {
			expect(
				selectPreviewMedia(asset, library, {
					quality: "quarter",
					useProxies: true,
				})
			).toBe(asset);
		}
	});

	test("AI mattes and cutouts preview through their VP9 alpha copy", () => {
		for (const derivation of ["ai-matte", "cutout", "lottie"] as const) {
			const master = {
				derivation,
				derivedFromAssetId: "src",
				id: `${derivation}-master`,
				kind: "video" as const,
				width: 3840,
			};
			const alphaCopy = proxyOf(`${derivation}-vp9`, master.id, 3840);
			const withCopy = [master, alphaCopy];
			for (const quality of ["full", "half", "quarter"] as const) {
				// Never the ProRes master, at any quality.
				expect(
					selectPreviewMedia(master, withCopy, { quality, useProxies: false })
				).toBe(alphaCopy);
				// Never an H.264 proxy, which would drop the alpha.
				expect(wantedProxyVariant(master, [master], quality)).toBeNull();
			}
			expect(
				previewMimeType(alphaCopy, (id) =>
					id === master.id ? master : undefined
				)
			).toBe("video/webm");
			expect(alphaPreviewMissing(master, withCopy)).toBe(false);
			expect(alphaPreviewMissing(master, [master])).toBe(true);
		}
		expect(
			previewMimeType(standard, (id) => (id === "src" ? {} : undefined))
		).toBe("video/mp4");
		expect(alphaPreviewMissing(original, [original])).toBe(false);
	});

	test("the library listing hides proxies", () => {
		expect(withoutProxies(library).map((asset) => asset.id)).toEqual(["src"]);
	});

	test("wants a lazy half or quarter variant only when no proxy is adequate", () => {
		expect(wantedProxyVariant(original, [original, standard], "half")).toBe(
			"half"
		);
		expect(wantedProxyVariant(original, library, "half")).toBeNull();
		expect(
			wantedProxyVariant(original, [original, standard], "quarter")
		).toBeNull();
		expect(wantedProxyVariant(original, [original], "quarter")).toBe("quarter");
		expect(wantedProxyVariant(original, library, "full")).toBeNull();
		expect(wantedProxyVariant(source("hd", 1280), [], "quarter")).toBeNull();
	});

	test("sync loads the chosen proxy under the clip asset's id and swaps it when the choice changes", async () => {
		const loads: string[] = [];
		const revoked: string[] = [];
		const cache = new PreviewSources(
			async (asset) => {
				loads.push(asset.id);
				return new Blob([asset.id]);
			},
			() => `blob:${loads.at(-1)}`,
			(url) => revoked.push(url)
		);
		const sync = (quality: "full" | "half" | "quarter", useProxies = false) =>
			cache.sync(
				[original],
				() => undefined,
				() => undefined,
				{ library, quality, useProxies }
			);
		sync("quarter");
		await settle();
		expect(cache.snapshot()).toEqual({ src: "blob:p960" });
		sync("quarter");
		await settle();
		expect(loads).toEqual(["p960"]);
		sync("full");
		await settle();
		expect(revoked).toEqual(["blob:p960"]);
		expect(cache.snapshot()).toEqual({ src: "blob:src" });
		sync("full", true);
		await settle();
		expect(cache.snapshot()).toEqual({ src: "blob:p1920" });
		expect(loads).toEqual(["p960", "src", "p1920"]);
		cache.dispose();
	});

	test("sync without a proxy preference keeps loading originals", async () => {
		const loads: string[] = [];
		const cache = new PreviewSources(
			async (asset) => {
				loads.push(asset.id);
				return new Blob([asset.id]);
			},
			() => "blob:x",
			() => undefined
		);
		cache.sync(
			[original],
			() => undefined,
			() => undefined
		);
		await settle();
		expect(loads).toEqual(["src"]);
		cache.dispose();
	});
});
