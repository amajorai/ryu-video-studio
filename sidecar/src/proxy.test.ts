import { afterEach, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import {
	type Asset,
	assetSchema,
	newSegment,
	projectSchema,
} from "../../shared/project.ts";
import { probe, runMedia } from "./media.ts";
import {
	autoProxyOnImport,
	averageBitrate,
	createProxy,
	libraryAssets,
	MAX_PROXY_SWEEP,
	needsProxy,
	PROXY_GOP,
	proxiesFor,
	proxyArgs,
	proxyAt,
	proxyVariantWidth,
	pruneOrphanProxies,
	readProxySettings,
	sweepProxies,
	writeProxySettings,
} from "./proxy.ts";
import { buildRender } from "./render.ts";
import { routes } from "./routes/proxy.ts";
import { createStudioServer } from "./server.ts";
import { StudioStore } from "./store.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) {
		await cleanup();
	}
});

function video(overrides: Partial<Asset> = {}): Asset {
	return {
		createdAt: new Date(0).toISOString(),
		duration: 10,
		hasAudio: false,
		height: 2160,
		id: crypto.randomUUID(),
		kind: "video",
		name: "Drone.mov",
		width: 3840,
		...overrides,
	};
}

describe("proxy policy", () => {
	test("heavy video needs a proxy by width or bitrate", () => {
		expect(needsProxy(video(), 1000)).toBe(true);
		expect(needsProxy(video({ width: 1920, height: 1080 }), 1000)).toBe(false);
		// 50 MB over 10 s is 40 Mb/s.
		expect(needsProxy(video({ width: 1920, height: 1080 }), 50_000_000)).toBe(
			true
		);
		expect(needsProxy(video({ kind: "image" }), 1)).toBe(false);
		expect(needsProxy(video({ kind: "audio", width: 0 }), 1e12)).toBe(false);
		expect(needsProxy(video({ derivation: "proxy" }), 1)).toBe(false);
		expect(averageBitrate(0, 10)).toBe(0);
		expect(averageBitrate(10, 0)).toBe(0);
	});

	test("variant widths are even and never wider than the source", () => {
		const uhd = video();
		expect(proxyVariantWidth(uhd, "standard")).toBe(960);
		expect(proxyVariantWidth(uhd, "half")).toBe(1920);
		expect(proxyVariantWidth(uhd, "quarter")).toBe(960);
		const small = video({ width: 641 });
		expect(proxyVariantWidth(small, "standard")).toBe(640);
		expect(proxyVariantWidth(small, "quarter")).toBe(160);
		expect(proxyVariantWidth(video({ width: 3 }), "quarter")).toBe(2);
	});

	test("proxies are found per source, narrowest first, and hidden from the library", () => {
		const source = video();
		const wide = video({
			derivation: "proxy",
			derivedFromAssetId: source.id,
			width: 1920,
		});
		const narrow = video({
			derivation: "proxy",
			derivedFromAssetId: source.id,
			width: 960,
		});
		const unrelated = video({ derivation: "proxy", width: 960 });
		const assets = [source, wide, narrow, unrelated];
		expect(proxiesFor(assets, source.id)).toEqual([narrow, wide]);
		expect(proxyAt(assets, source.id, 962)).toBe(narrow);
		expect(proxyAt(assets, source.id, 1280)).toBeUndefined();
		expect(libraryAssets(assets)).toEqual([source]);
	});

	test("proxy encode args scale to the width with a 12-frame GOP", () => {
		const args = proxyArgs("/in.mov", "/out.mp4", 960, true);
		expect(args).toContain("scale=960:-2:flags=bilinear,format=yuv420p");
		expect(args.slice(args.indexOf("-g"), args.indexOf("-g") + 2)).toEqual([
			"-g",
			String(PROXY_GOP),
		]);
		expect(args).toContain("libx264");
		expect(args).toContain("aac");
		expect(args.at(-1)).toBe("/out.mp4");
		expect(proxyArgs("/in.mov", "/out.mp4", 960, false)).toContain("-an");
	});
});

const fixtureSchema = z
	.object({ assets: z.array(assetSchema), project: projectSchema })
	.loose();

describe("render ignores proxies", () => {
	const directory = join(import.meta.dir, "__fixtures__", "render");
	const fixtures = readdirSync(directory)
		.filter((file) => file.endsWith(".json"))
		.sort()
		.map(
			(file) =>
				[
					file,
					fixtureSchema.parse(
						JSON.parse(readFileSync(join(directory, file), "utf8"))
					),
				] as const
		);

	test.each(
		fixtures
	)("%s argv is identical with proxies in the library", (_file, fixture) => {
		const proxies = fixture.assets
			.filter((asset) => asset.kind === "video")
			.map((asset) =>
				video({
					derivation: "proxy",
					derivedFromAssetId: asset.id,
					width: 960,
				})
			);
		const proxyIds = new Set(proxies.map((proxy) => proxy.id));
		const requested: string[] = [];
		const mediaPath = (id: string, clipId?: string) => {
			requested.push(id);
			return `/media/${id}${clipId ? `#${clipId}` : ""}`;
		};
		const plain = buildRender(fixture.project, fixture.assets, mediaPath);
		const withProxies = buildRender(
			fixture.project,
			[...proxies, ...fixture.assets],
			mediaPath
		);
		expect(withProxies).toEqual(plain);
		expect(requested.some((id) => proxyIds.has(id))).toBe(false);
	});
});

async function testStore() {
	const store = new StudioStore(await mkdtemp(join(tmpdir(), "ryu-proxy-")));
	cleanups.push(async () => {
		store.close();
		await rm(store.directory, { recursive: true, force: true });
	});
	return store;
}

async function importClip(
	store: StudioStore,
	size: string,
	options: { audio?: boolean; seconds?: number } = {}
): Promise<Asset> {
	const seconds = options.seconds ?? 0.5;
	const file = join(store.directory, `source-${crypto.randomUUID()}.mp4`);
	await runMedia([
		"-hide_banner",
		"-loglevel",
		"error",
		"-y",
		"-f",
		"lavfi",
		"-i",
		`testsrc2=s=${size}:r=24:d=${seconds}`,
		...(options.audio
			? [
					"-f",
					"lavfi",
					"-i",
					`sine=f=440:d=${seconds}`,
					"-c:a",
					"aac",
					"-shortest",
				]
			: []),
		"-c:v",
		"libx264",
		"-preset",
		"ultrafast",
		"-pix_fmt",
		"yuv420p",
		file,
	]);
	const asset = assetSchema.parse({
		...(await probe(file)),
		createdAt: new Date().toISOString(),
		id: crypto.randomUUID(),
		name: `Clip ${size}`,
	});
	await Bun.write(store.mediaPath(asset.id), Bun.file(file));
	await rm(file);
	store.putAsset(asset);
	return asset;
}

describe("proxy media (real FFmpeg)", () => {
	test("settings default on, persist, and gate the import hook", async () => {
		const store = await testStore();
		expect(await readProxySettings(store)).toEqual({ autoProxy: true });
		const light = await importClip(store, "320x180");
		expect(await autoProxyOnImport(store, light)).toBeNull();
		await writeProxySettings(store, { autoProxy: false });
		expect(await readProxySettings(store)).toEqual({ autoProxy: false });
		const heavy = await importClip(store, "2048x1152");
		expect(await autoProxyOnImport(store, heavy)).toBeNull();
		expect(store.assets()).toHaveLength(2);
		await writeProxySettings(store, { autoProxy: true });
		const proxy = await autoProxyOnImport(store, heavy);
		expect(proxy).toMatchObject({
			derivation: "proxy",
			derivedFromAssetId: heavy.id,
			kind: "video",
			width: 960,
		});
		// Idempotent: the existing proxy is reused.
		expect((await autoProxyOnImport(store, heavy))?.id).toBe(proxy?.id);
	}, 60_000);

	test("routes create variants on demand, list them, sweep and prune", async () => {
		const store = await testStore();
		const token = crypto.randomUUID();
		const app = createStudioServer({ store, token, port: 0, routes });
		cleanups.push(async () => app.stop());
		const call = (method: string, path: string, body?: unknown) =>
			fetch(`http://127.0.0.1:${app.server.port}/api/video-studio${path}`, {
				method,
				headers: {
					authorization: `Bearer ${token}`,
					"content-type": "application/json",
				},
				body: body === undefined ? undefined : JSON.stringify(body),
			});
		const heavy = await importClip(store, "2048x1152", { audio: true });
		const light = await importClip(store, "320x180");

		const created = await call("POST", `/assets/${heavy.id}/proxy`, {
			variant: "half",
		});
		expect(created.status).toBe(201);
		const half = z
			.object({ asset: assetSchema, created: z.boolean() })
			.parse(await created.json());
		expect(half.asset).toMatchObject({ width: 1024, hasAudio: true });
		const again = await call("POST", `/assets/${heavy.id}/proxy`, {
			variant: "half",
		});
		expect(again.status).toBe(200);
		const empty = await call("POST", `/assets/${light.id}/proxy`);
		expect(empty.status).toBe(201);

		const sweep = await call("POST", "/proxies", {});
		expect(sweep.status).toBe(200);
		const swept = z
			.object({
				created: z.array(assetSchema),
				failed: z.array(z.object({ assetId: z.string(), message: z.string() })),
				pruned: z.array(z.string()),
				remaining: z.number(),
				skipped: z.array(z.string()),
			})
			.parse(await sweep.json());
		expect(swept.created.map((asset) => asset.width)).toEqual([960]);
		expect(swept.skipped).toContain(light.id);
		expect(swept.failed).toEqual([]);
		expect(swept.remaining).toBe(0);

		const listed = await call("GET", `/assets/${heavy.id}/proxies`);
		const { proxies } = z
			.object({ proxies: z.array(assetSchema) })
			.parse(await listed.json());
		expect(proxies.map((asset) => asset.width)).toEqual([960, 1024]);

		const off = await call("PUT", "/proxy-settings", { autoProxy: false });
		expect(await off.json()).toEqual({ autoProxy: false });
		const read = await call("GET", "/proxy-settings");
		expect(await read.json()).toEqual({ autoProxy: false });
		expect(
			(await call("PUT", "/proxy-settings", { autoProxy: "no" })).status
		).toBe(400);
		expect(
			(await call("POST", `/assets/${heavy.id}/proxy`, { variant: "tiny" }))
				.status
		).toBe(400);

		store.discardAsset(heavy.id);
		const pruned = await pruneOrphanProxies(store);
		expect(pruned.sort()).toEqual(proxies.map((asset) => asset.id).sort());
		expect(proxiesFor(store.assets(), heavy.id)).toEqual([]);
	}, 120_000);

	test("importing 4K through the import route creates a hidden 960 px proxy", async () => {
		const store = await testStore();
		const token = crypto.randomUUID();
		const app = createStudioServer({ store, token, port: 0, routes });
		cleanups.push(async () => app.stop());
		const call = (method: string, path: string, body?: unknown) =>
			fetch(`http://127.0.0.1:${app.server.port}/api/video-studio${path}`, {
				method,
				headers: {
					authorization: `Bearer ${token}`,
					"content-type": "application/json",
				},
				body: body === undefined ? undefined : JSON.stringify(body),
			});
		const imports = join(store.directory, "imports");
		await mkdir(imports, { recursive: true });
		const file = join(imports, "uhd.mp4");
		await runMedia([
			"-hide_banner",
			"-loglevel",
			"error",
			"-y",
			"-f",
			"lavfi",
			"-i",
			"testsrc2=s=3840x2160:r=24:d=0.5",
			"-c:v",
			"libx264",
			"-preset",
			"ultrafast",
			"-pix_fmt",
			"yuv420p",
			file,
		]);
		const imported = await call("POST", "/assets/import", {
			source: { path: file },
		});
		expect(imported.status).toBe(201);
		const source = assetSchema.parse(await imported.json());
		let proxy: Asset | undefined;
		for (let attempt = 0; attempt < 600 && !proxy; attempt++) {
			proxy = proxiesFor(store.assets(), source.id)[0];
			if (!proxy) {
				await Bun.sleep(100);
			}
		}
		expect(proxy).toMatchObject({
			derivation: "proxy",
			derivedFromAssetId: source.id,
			width: 960,
		});
		const listing = z
			.object({ assets: z.array(assetSchema) })
			.parse(await (await call("GET", "/assets")).json());
		expect(listing.assets.map((asset) => asset.id)).toEqual([source.id]);
		const everything = z
			.object({ assets: z.array(assetSchema) })
			.parse(await (await call("GET", "/assets?includeProxies=1")).json());
		expect(everything.assets).toHaveLength(2);
		expect(() =>
			store.save({
				...store.create("Proxy clip"),
				segments: [{ ...newSegment(proxy as Asset, 0), sourceOut: 0.5 }],
			})
		).toThrow("preview proxy");
	}, 120_000);

	test("a waiter that aborts does not cancel the others sharing the encode", async () => {
		const store = await testStore();
		const heavy = await importClip(store, "3840x2160", { seconds: 2 });
		const first = new AbortController();
		const second = new AbortController();
		const a = createProxy(store, heavy, "standard", { signal: first.signal });
		const aOutcome = a.then(
			() => "resolved",
			(error: Error) => error.message
		);
		await Bun.sleep(50);
		const b = createProxy(store, heavy, "standard", { signal: second.signal });
		first.abort();
		expect(await aOutcome).toBe("Media operation canceled.");
		const joined = await b;
		expect(second.signal.aborted).toBe(false);
		expect(joined.created).toBe(false);
		expect(joined.asset).toMatchObject({
			derivation: "proxy",
			derivedFromAssetId: heavy.id,
			width: 960,
		});
		expect(proxiesFor(store.assets(), heavy.id)).toHaveLength(1);
	}, 60_000);

	test("the encode stops when every waiter has gone, and a later request starts fresh", async () => {
		const store = await testStore();
		const heavy = await importClip(store, "3840x2160", { seconds: 2 });
		const first = new AbortController();
		const second = new AbortController();
		const a = createProxy(store, heavy, "standard", {
			signal: first.signal,
		}).catch((error: Error) => error.message);
		await Bun.sleep(50);
		const b = createProxy(store, heavy, "standard", {
			signal: second.signal,
		}).catch((error: Error) => error.message);
		first.abort();
		second.abort();
		expect(await a).toBe("Media operation canceled.");
		expect(await b).toBe("Media operation canceled.");
		await Bun.sleep(300);
		expect(proxiesFor(store.assets(), heavy.id)).toEqual([]);
		const fresh = await createProxy(store, heavy);
		expect(fresh.created).toBe(true);
		expect(fresh.asset.width).toBe(960);
	}, 60_000);

	test("one failing asset is reported and the sweep carries on", async () => {
		const store = await testStore();
		const older = await importClip(store, "2048x1152");
		const corrupt = await importClip(store, "2048x1152");
		const missing = await importClip(store, "2048x1152");
		await Bun.write(store.mediaPath(corrupt.id), "not a video");
		await rm(store.mediaPath(missing.id));
		for (let round = 0; round < 2; round++) {
			const result = await sweepProxies(store, undefined);
			expect(result.failed.map((failure) => failure.assetId).sort()).toEqual(
				[corrupt.id, missing.id].sort()
			);
			expect(
				result.failed.find((failure) => failure.assetId === missing.id)?.message
			).toBe("The media file is missing.");
			expect(result.created.map((asset) => asset.derivedFromAssetId)).toEqual(
				round === 0 ? [older.id] : []
			);
		}
		expect(proxiesFor(store.assets(), older.id)).toHaveLength(1);
	}, 120_000);

	test("light and already-proxied video does not starve older heavy video", async () => {
		const store = await testStore();
		const heavy = await importClip(store, "2048x1152");
		for (let index = 0; index < 50; index++) {
			const light = video({
				duration: 1,
				height: 180,
				name: `Light ${index}`,
				width: 320,
			});
			await Bun.write(store.mediaPath(light.id), "x");
			store.putAsset(light);
		}
		const first = await sweepProxies(store, undefined);
		expect(first.created.map((asset) => asset.derivedFromAssetId)).toEqual([
			heavy.id,
		]);
		expect(first.skipped).toHaveLength(50);
		expect(first.remaining).toBe(0);
		const second = await sweepProxies(store, undefined);
		expect(second.created).toEqual([]);
		expect(second.skipped).toContain(heavy.id);
	}, 60_000);

	test("opted-out sweeps create nothing and skip heavy video", async () => {
		const store = await testStore();
		await writeProxySettings(store, { autoProxy: false });
		const heavy = video({ name: "Heavy" });
		await Bun.write(store.mediaPath(heavy.id), "x");
		store.putAsset(heavy);
		const result = await sweepProxies(store, undefined);
		expect(result).toMatchObject({
			created: [],
			failed: [],
			remaining: 0,
			skipped: [heavy.id],
		});
	});

	test("heavy video beyond the batch limit is reported as remaining", async () => {
		const store = await testStore();
		for (let index = 0; index <= MAX_PROXY_SWEEP; index++) {
			const heavy = video({ name: `Broken ${index}` });
			await Bun.write(store.mediaPath(heavy.id), "x");
			store.putAsset(heavy);
		}
		const result = await sweepProxies(store, undefined);
		expect(result.created).toEqual([]);
		expect(result.failed).toHaveLength(MAX_PROXY_SWEEP);
		expect(result.remaining).toBe(1);
	}, 120_000);
});
