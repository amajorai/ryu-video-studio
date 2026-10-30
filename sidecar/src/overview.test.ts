import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assetSchema, newSegment } from "../../shared/project.ts";
import { probe, runMedia } from "./media.ts";
import {
	overviewLayout,
	overviewRequestSchema,
	overviewResultSchema,
	overviewTimes,
} from "./overview.ts";
import { createStudioServer } from "./server.ts";
import { StudioStore } from "./store.ts";

/** Width and height from a PNG's IHDR chunk. */
function pngSize(bytes: Uint8Array) {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	if (String.fromCharCode(...bytes.subarray(1, 4)) !== "PNG") {
		throw new Error("Expected a PNG.");
	}
	return { height: view.getUint32(20), width: view.getUint32(16) };
}

describe("overview layout", () => {
	test("keeps the canvas aspect and fills rows", () => {
		expect(overviewLayout({ height: 1080, width: 1920 }, 24, 90)).toEqual({
			columns: 8,
			height: 270,
			rows: 3,
			thumbHeight: 90,
			thumbWidth: 160,
			width: 1280,
		});
		expect(overviewLayout({ height: 1920, width: 1080 }, 5, 90, 3)).toEqual({
			columns: 3,
			height: 180,
			rows: 2,
			thumbHeight: 90,
			thumbWidth: 50,
			width: 150,
		});
	});

	test("never uses more columns than frames and keeps even sizes", () => {
		const layout = overviewLayout({ height: 100, width: 333 }, 2, 31);
		expect(layout.columns).toBe(2);
		expect(layout.rows).toBe(1);
		expect(layout.thumbHeight % 2).toBe(0);
		expect(layout.thumbWidth % 2).toBe(0);
	});
});

describe("overview times", () => {
	test("samples the centre of each slice on a frame boundary", () => {
		expect(overviewTimes(0, 10, 4, 30)).toEqual([
			1.233_333, 3.733_333, 6.233_333, 8.733_333,
		]);
		expect(overviewTimes(0, 2, 2, 25)).toEqual([0.48, 1.48]);
	});

	test("stays inside the range and rejects empty ranges", () => {
		const times = overviewTimes(1, 1.05, 24, 30);
		expect(times).toHaveLength(24);
		for (const time of times) {
			expect(time).toBeGreaterThanOrEqual(1);
			expect(time).toBeLessThan(1.05);
		}
		expect(() => overviewTimes(2, 2, 3, 30)).toThrow("duration");
	});

	test("request defaults and bounds", () => {
		expect(overviewRequestSchema.parse({})).toEqual({
			count: 24,
			height: 90,
			start: 0,
		});
		expect(overviewRequestSchema.safeParse({ count: 49 }).success).toBe(false);
		expect(overviewRequestSchema.safeParse({ height: 8 }).success).toBe(false);
	});
});

test("overview route returns a tiled filmstrip PNG of the timeline", async () => {
	const directory = await mkdtemp(join(tmpdir(), "ryu-video-overview-test-"));
	const store = new StudioStore(directory);
	const token = crypto.randomUUID();
	const app = createStudioServer({ store, token, port: 0 });
	const call = (path: string) =>
		fetch(`http://127.0.0.1:${app.server.port}/api/video-studio${path}`, {
			headers: { authorization: `Bearer ${token}` },
		});
	try {
		const fixture = join(directory, "source.mp4");
		await runMedia([
			"-y",
			"-f",
			"lavfi",
			"-i",
			"testsrc2=size=320x180:rate=30:duration=2",
			fixture,
		]);
		const source = assetSchema.parse({
			...(await probe(fixture)),
			createdAt: new Date().toISOString(),
			id: crypto.randomUUID(),
			name: "Overview source",
		});
		await Bun.write(
			store.mediaPath(source.id),
			await Bun.file(fixture).arrayBuffer()
		);
		store.putAsset(source);
		const project = store.save({
			...store.create("Overview"),
			fps: 30,
			height: 180,
			segments: [{ ...newSegment(source), sourceOut: 2 }],
			width: 320,
		});
		const png = await call(
			`/projects/${project.id}/overview?count=5&height=36&columns=3`
		);
		expect(png.status).toBe(200);
		expect(png.headers.get("content-type")).toBe("image/png");
		expect(png.headers.get("x-overview-rows")).toBe("2");
		const bytes = new Uint8Array(await png.arrayBuffer());
		expect(pngSize(bytes)).toEqual({ height: 72, width: 192 });

		const jsonResponse = await call(
			`/projects/${project.id}/overview?count=4&format=json&start=1&end=2`
		);
		expect(jsonResponse.status).toBe(200);
		const overview = overviewResultSchema.parse(await jsonResponse.json());
		expect(overview).toMatchObject({
			columns: 4,
			height: 90,
			projectId: project.id,
			revision: project.revision,
			rows: 1,
			thumbHeight: 90,
			thumbWidth: 160,
			width: 640,
		});
		expect(overview.times).toEqual([1.1, 1.366_667, 1.6, 1.866_667]);
		expect(pngSize(Buffer.from(overview.data, "base64"))).toEqual({
			height: 90,
			width: 640,
		});

		const tooMany = await call(`/projects/${project.id}/overview?count=49`);
		expect(tooMany.status).toBe(400);
		const empty = store.create("Empty overview");
		const failed = await call(`/projects/${empty.id}/overview`);
		expect(failed.status).toBe(400);
	} finally {
		app.stop();
		store.close();
		await rm(directory, { force: true, recursive: true });
	}
}, 30_000);
