import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	colorScopesDetailSchema,
	colorScopesSchema,
	lumaCode,
	SCOPE_PARADE_BINS,
	SCOPE_VECTOR_SIZE,
	timelineScopesSchema,
} from "../../shared/color-scopes.ts";
import { type Asset, assetSchema, newSegment } from "../../shared/project.ts";
import { scopeSeekTime } from "./color-scopes.ts";
import { probe, runMedia } from "./media.ts";
import { createStudioServer } from "./server.ts";
import { StudioStore } from "./store.ts";

async function withScopeServer(
	run: (context: {
		call: (path: string) => Promise<Response>;
		directory: string;
		store: StudioStore;
	}) => Promise<void>
) {
	const directory = await mkdtemp(join(tmpdir(), "ryu-video-scopes-test-"));
	const store = new StudioStore(directory);
	const token = crypto.randomUUID();
	const app = createStudioServer({ store, token, port: 0 });
	try {
		await run({
			call: (path) =>
				fetch(`http://127.0.0.1:${app.server.port}/api/video-studio${path}`, {
					headers: { authorization: `Bearer ${token}` },
				}),
			directory,
			store,
		});
	} finally {
		app.stop();
		store.close();
		await rm(directory, { force: true, recursive: true });
	}
}

async function importSource(
	store: StudioStore,
	directory: string,
	name: string,
	lavfi: string,
	extension: string
): Promise<Asset> {
	const source = join(directory, `${crypto.randomUUID()}.${extension}`);
	await runMedia([
		"-y",
		"-f",
		"lavfi",
		"-i",
		lavfi,
		...(extension === "png" ? ["-frames:v", "1"] : []),
		source,
	]);
	const asset = assetSchema.parse({
		...(await probe(source)),
		createdAt: new Date().toISOString(),
		id: crypto.randomUUID(),
		name,
	});
	await Bun.write(
		store.mediaPath(asset.id),
		await Bun.file(source).arrayBuffer()
	);
	store.putAsset(asset);
	return asset;
}

const peakBin = (values: readonly number[]) =>
	values.reduce(
		(best, value, index) => (value > (values[best] ?? 0) ? index : best),
		0
	);

test("color scopes route measures a real source frame", async () => {
	await withScopeServer(async ({ call, directory, store }) => {
		const asset = await importSource(
			store,
			directory,
			"Red scope source",
			"color=c=red:s=8x4:d=1",
			"png"
		);
		const response = await call(`/assets/${asset.id}/scopes?time=0`);
		expect(response.status).toBe(200);
		const scopes = colorScopesSchema.parse(await response.json());
		expect(scopes.assetId).toBe(asset.id);
		expect(scopes.luma.average).toBeGreaterThan(0);
		expect(scopes.saturation.average).toBeGreaterThan(0.2);
		expect(scopes.clipping.white).toBe(false);
	});
});

test("detail=full adds histogram, parade, and vectorscope arrays", async () => {
	await withScopeServer(async ({ call, directory, store }) => {
		const asset = await importSource(
			store,
			directory,
			"Red still",
			"color=c=red:s=64x36:d=1",
			"png"
		);
		const response = await call(
			`/assets/${asset.id}/scopes?time=3&detail=full&columns=16`
		);
		expect(response.status).toBe(200);
		const scopes = colorScopesDetailSchema.parse(await response.json());
		const { waveforms } = scopes;
		expect(waveforms).toMatchObject({ height: 36, pixels: 64 * 36, width: 64 });
		expect(Math.abs(peakBin(waveforms.histogram) - lumaCode(255, 0, 0))).toBe(
			0
		);
		expect(waveforms.parade.columns).toBe(16);
		for (const column of waveforms.parade.r) {
			expect(peakBin(column)).toBe(SCOPE_PARADE_BINS - 1);
		}
		for (const column of waveforms.parade.g) {
			expect(peakBin(column)).toBe(0);
		}
		const redRow = waveforms.vectorscope.cells[0] ?? [];
		expect(redRow.reduce((total, value) => total + value, 0)).toBe(64 * 36);
		const invalid = await call(`/assets/${asset.id}/scopes?columns=0`);
		expect(invalid.status).toBe(200);
		const rejected = await call(
			`/assets/${asset.id}/scopes?detail=full&columns=0`
		);
		expect(rejected.status).toBe(400);
	});
});

test("project scopes measure the composited timeline frame", async () => {
	await withScopeServer(async ({ call, directory, store }) => {
		const source = await importSource(
			store,
			directory,
			"Blue clip",
			"color=c=blue:s=320x180:d=1",
			"mp4"
		);
		const project = store.save({
			...store.create("Scope timeline"),
			fps: 30,
			height: 180,
			segments: [{ ...newSegment(source), sourceOut: 1 }],
			width: 320,
		});
		const response = await call(
			`/projects/${project.id}/scopes?time=0.5&columns=32`
		);
		expect(response.status).toBe(200);
		const scopes = timelineScopesSchema.parse(await response.json());
		expect(scopes).toMatchObject({
			projectId: project.id,
			revision: project.revision,
			time: 0.5,
		});
		expect(scopes.waveforms).toMatchObject({ height: 144, width: 256 });
		expect(scopes.waveforms.parade.columns).toBe(32);
		// Blue survives the YUV round trip within a few code values.
		expect(
			Math.abs(peakBin(scopes.waveforms.histogram) - lumaCode(0, 0, 255))
		).toBeLessThanOrEqual(3);
		for (const column of scopes.waveforms.parade.b) {
			expect(peakBin(column)).toBeGreaterThanOrEqual(SCOPE_PARADE_BINS - 2);
		}
		const blueCell = scopes.waveforms.vectorscope.cells.findIndex(
			(row) => (row[SCOPE_VECTOR_SIZE - 1] ?? 0) > 0
		);
		expect(blueCell).toBeGreaterThan(SCOPE_VECTOR_SIZE / 2);
		const empty = store.create("Empty scopes");
		const failed = await call(`/projects/${empty.id}/scopes`);
		expect(failed.status).toBe(400);
	});
});

test("video scopes clamp to the last decodable frame", async () => {
	await withScopeServer(async ({ call, directory, store }) => {
		const asset = await importSource(
			store,
			directory,
			"Two second clip",
			"testsrc2=s=64x36:r=30:d=2",
			"mp4"
		);
		for (const time of [1.99, 2, 5]) {
			const full = await call(
				`/assets/${asset.id}/scopes?time=${time}&detail=full`
			);
			expect(full.status).toBe(200);
			const scopes = colorScopesDetailSchema.parse(await full.json());
			expect(scopes.sampledAt).toBeLessThan(asset.duration);
			expect(scopes.luma.average).toBeGreaterThan(0);
			expect(scopes.waveforms.pixels).toBe(64 * 36);
			const summary = colorScopesSchema.parse(
				await (await call(`/assets/${asset.id}/scopes?time=${time}`)).json()
			);
			expect(summary.sampledAt).toBe(scopes.sampledAt);
			expect(summary.luma.average).toBe(scopes.luma.average);
		}
	});
});

test("scope seek time stays inside the decodable range", () => {
	const video = { duration: 2, frameRate: 30, kind: "video" as const };
	expect(scopeSeekTime(video, 1)).toBe(1);
	expect(scopeSeekTime(video, 2)).toBeCloseTo(2 - 1 / 30, 9);
	expect(scopeSeekTime(video, 9)).toBeCloseTo(2 - 1 / 30, 9);
	expect(scopeSeekTime({ duration: 2, kind: "video" }, 2)).toBeCloseTo(
		2 - 1 / 24,
		9
	);
	expect(scopeSeekTime({ duration: 0.01, kind: "video" }, 1)).toBe(0);
	expect(scopeSeekTime({ duration: 5, kind: "image" }, 3)).toBe(0);
});
