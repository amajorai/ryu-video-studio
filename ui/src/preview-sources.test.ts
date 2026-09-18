import { expect, test } from "bun:test";
import { PreviewSources } from "./preview-sources.ts";

const image = (id: string) => ({ id, kind: "image" as const });
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

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
