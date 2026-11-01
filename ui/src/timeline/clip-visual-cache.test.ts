import { afterEach, describe, expect, test } from "bun:test";
import { newSegment } from "../../../shared/project.ts";
import { testVideo } from "../editor/test-runtime.ts";
import {
	createVisualCache,
	type FilmstripPlan,
	type FilmstripSprite,
	filmstripFrameCount,
	filmstripKey,
	filmstripPath,
	filmstripThumbWidth,
	filmstripTiles,
	hasWaveform,
	invalidatePeaks,
	MAX_FILMSTRIP_TILES,
	MAX_WAVEFORM_COLUMNS,
	peakInRange,
	peaksCache,
	peaksFromAnalysis,
	peaksRetryDelay,
	planFilmstrip,
	type WaveformPeaks,
	watchPeaks,
	waveformColumns,
	waveformColumnsInSpan,
	waveformRetryPolicy,
} from "./clip-visual-cache.ts";
import { clipDrawSpan, viewportTimeWindow } from "./virtualize.ts";

/** Ten one-second bins whose peak is the bin index / 10. */
const ramp = {
	duration: 10,
	peaks: Array.from({ length: 10 }, (_, index) => index / 10),
};

describe("waveform source-range mapping", () => {
	test("a bin range takes the largest overlapping peak", () => {
		expect(peakInRange(ramp, 2, 3)).toBe(0.2);
		expect(peakInRange(ramp, 2.5, 4.5)).toBe(0.4);
		expect(peakInRange(ramp, 3.2, 3.3)).toBe(0.3);
		expect(peakInRange(ramp, 10, 12)).toBe(0);
		expect(peakInRange({ duration: 0, peaks: [1] }, 0, 1)).toBe(0);
	});

	test("columns cover the clip's source range at 1x", () => {
		const columns = waveformColumns(
			ramp,
			{ sourceIn: 2, sourceOut: 6, speed: 1, volume: 1 },
			{ columnWidth: 10, pxPerSec: 10 }
		);
		// 4 timeline seconds at 10 px/s in 10 px columns: one column per second.
		expect(columns).toEqual([0.2, 0.3, 0.4, 0.5]);
	});

	test("speed packs more source into each column", () => {
		const columns = waveformColumns(
			ramp,
			{ sourceIn: 2, sourceOut: 6, speed: 2, volume: 1 },
			{ columnWidth: 10, pxPerSec: 10 }
		);
		// The clip lasts 2 timeline seconds; each column spans 2 source seconds.
		expect(columns).toEqual([0.3, 0.5]);
		const slow = waveformColumns(
			ramp,
			{ sourceIn: 2, sourceOut: 4, speed: 0.5, volume: 1 },
			{ columnWidth: 10, pxPerSec: 10 }
		);
		expect(slow).toEqual([0.2, 0.2, 0.3, 0.3]);
	});

	test("volume scales peaks and caps at full height", () => {
		const columns = waveformColumns(
			ramp,
			{ sourceIn: 4, sourceOut: 6, speed: 1, volume: 2 },
			{ columnWidth: 10, pxPerSec: 10 }
		);
		expect(columns).toEqual([0.8, 1]);
		expect(
			waveformColumns(
				ramp,
				{ sourceIn: 4, sourceOut: 6, speed: 1, volume: 0 },
				{ columnWidth: 10, pxPerSec: 10 }
			)
		).toEqual([0, 0]);
	});

	test("long clips stop at the column limit", () => {
		expect(
			waveformColumns(
				ramp,
				{ sourceIn: 0, sourceOut: 10, speed: 1, volume: 1 },
				{ maxColumns: 16, pxPerSec: 1000 }
			)
		).toHaveLength(16);
	});

	test("only completed analyses provide peaks", () => {
		const analysis = {
			assetId: crypto.randomUUID(),
			createdAt: new Date(0).toISOString(),
			duration: 8,
			sceneCuts: [],
			status: "completed",
			waveform: [0.1, 0.9],
		};
		expect(peaksFromAnalysis(analysis, 10)).toEqual({
			duration: 8,
			peaks: [0.1, 0.9],
		});
		expect(peaksFromAnalysis({ ...analysis, status: "running" }, 10)).toBe(
			null
		);
		expect(peaksFromAnalysis(null, 10)).toBe(null);
		expect(peaksFromAnalysis({ ...analysis, duration: 0 }, 10)?.duration).toBe(
			10
		);
	});

	test("silent video and stills have no waveform", () => {
		expect(hasWaveform(testVideo())).toBe(true);
		expect(hasWaveform({ ...testVideo(), hasAudio: false })).toBe(false);
		expect(hasWaveform({ ...testVideo(), kind: "image" })).toBe(false);
		expect(hasWaveform({ ...testVideo(), kind: "audio" })).toBe(true);
		expect(hasWaveform(undefined)).toBe(false);
	});
});

describe("filmstrip planning", () => {
	const asset = testVideo("camera.mp4", 20);

	test("thumbnail width follows the asset aspect ratio", () => {
		expect(filmstripThumbWidth(asset)).toBe(57);
		expect(filmstripThumbWidth({ height: 0, width: 0 })).toBe(57);
		expect(filmstripThumbWidth({ height: 1920, width: 1080 })).toBe(18);
		expect(filmstripThumbWidth({ height: 100, width: 1000 })).toBe(96);
	});

	test("frame counts are bucketed and capped at 60", () => {
		expect(filmstripFrameCount(10, 57)).toBe(1);
		expect(filmstripFrameCount(120, 57)).toBe(4);
		expect(filmstripFrameCount(57 * 9, 57)).toBe(16);
		expect(filmstripFrameCount(57 * 40, 57)).toBe(60);
		expect(filmstripFrameCount(57 * 400, 57)).toBe(60);
	});

	test("plans cover the clip's source range, rounded to the millisecond", () => {
		const segment = {
			...newSegment(asset, 0),
			sourceIn: 1.234_56,
			sourceOut: 5,
		};
		const plan = planFilmstrip(asset, segment, 200);
		expect(plan).toEqual({
			assetId: asset.id,
			count: 4,
			end: 5,
			height: 48,
			start: 1.235,
		});
		const nudged = planFilmstrip(asset, { ...segment, sourceIn: 1.2349 }, 210);
		expect(nudged && filmstripKey(nudged)).toBe(plan && filmstripKey(plan));
		expect(plan && filmstripPath(plan)).toBe(
			`/assets/${asset.id}/filmstrip?count=4&end=5&height=48&start=1.235`
		);
	});

	test("stills need one frame; audio and empty ranges need none", () => {
		const still = { ...asset, kind: "image" as const };
		expect(planFilmstrip(still, newSegment(still, 0), 500)?.count).toBe(1);
		const sound = { ...asset, kind: "audio" as const };
		expect(planFilmstrip(sound, newSegment(sound, 0), 500)).toBe(null);
		expect(
			planFilmstrip(asset, { ...newSegment(asset, 0), sourceIn: 20 }, 500)
		).toBe(null);
		expect(planFilmstrip(undefined, newSegment(asset, 0), 500)).toBe(null);
	});

	test("tiles repeat across the clip and pick the frame under their centre", () => {
		expect(filmstripTiles(200, 50, 4)).toEqual([
			{ frame: 0, left: 0 },
			{ frame: 1, left: 50 },
			{ frame: 2, left: 100 },
			{ frame: 3, left: 150 },
		]);
		// More tiles than frames reuse frames; fewer tiles skip frames.
		expect(filmstripTiles(200, 50, 2).map((tile) => tile.frame)).toEqual([
			0, 0, 1, 1,
		]);
		expect(filmstripTiles(100, 50, 8).map((tile) => tile.frame)).toEqual([
			2, 6,
		]);
		expect(filmstripTiles(30, 50, 4)).toEqual([{ frame: 2, left: 0 }]);
		// A clipped last tile shows the frame under its visible centre.
		expect(filmstripTiles(220, 50, 22).at(-1)).toEqual({
			frame: 21,
			left: 200,
		});
		expect(filmstripTiles(0, 50, 4)).toEqual([]);
	});

	test("clips wider than the tile cap stay covered end to end", () => {
		// 60 s at max zoom (600 px/s) with 57 px thumbnails and 60 frames.
		const clipWidth = 60 * 600;
		const tiles = filmstripTiles(clipWidth, 57, 60);
		expect(tiles).toHaveLength(MAX_FILMSTRIP_TILES);
		const slot = clipWidth / MAX_FILMSTRIP_TILES;
		expect(tiles[0]?.left).toBe(Math.round(slot / 2 - 28.5));
		const last = tiles.at(-1);
		expect((last?.left ?? 0) + 57).toBeGreaterThan(clipWidth - slot);
		expect(tiles[0]?.frame).toBe(0);
		expect(last?.frame).toBe(59);
		// Every sprite frame is shown, in order.
		const frames = tiles.map((tile) => tile.frame);
		expect(new Set(frames).size).toBe(60);
		expect(frames).toEqual([...frames].sort((a, b) => a - b));
		// Exactly at the cap, tiles keep their natural packing.
		const packed = filmstripTiles(57 * MAX_FILMSTRIP_TILES, 57, 60);
		expect(packed.at(-1)?.left).toBe(57 * (MAX_FILMSTRIP_TILES - 1));
	});
});

describe("visual cache", () => {
	const sprite: FilmstripSprite = {
		count: 4,
		frameHeight: 48,
		frameWidth: 85,
		url: "data:image/png;base64,AA==",
	};
	const plan: FilmstripPlan = {
		assetId: crypto.randomUUID(),
		count: 4,
		end: 4,
		height: 48,
		start: 0,
	};

	test("ten clips with one sprite issue one request", async () => {
		const cache = createVisualCache<FilmstripSprite>();
		let requests = 0;
		const load = () => {
			requests++;
			return Promise.resolve(sprite);
		};
		const results = await Promise.all(
			Array.from({ length: 10 }, () => cache.get(filmstripKey(plan), load))
		);
		expect(requests).toBe(1);
		expect(new Set(results).size).toBe(1);
		expect(cache.peek(filmstripKey(plan))).toBe(sprite);
		await cache.get(filmstripKey(plan), load);
		expect(requests).toBe(1);
	});

	test("loads run one at a time in request order", async () => {
		const cache = createVisualCache<string>();
		const order: string[] = [];
		let active = 0;
		let overlap = false;
		const load = (key: string) => async () => {
			active++;
			overlap ||= active > 1;
			await Promise.resolve();
			order.push(key);
			active--;
			return key;
		};
		await Promise.all(["a", "b", "c"].map((key) => cache.get(key, load(key))));
		expect(order).toEqual(["a", "b", "c"]);
		expect(overlap).toBe(false);
	});

	test("failures and rejected values are forgotten so a later mount retries", async () => {
		const cache = createVisualCache<string | null>({
			keep: (value) => value !== null,
		});
		await expect(
			cache.get("x", () => Promise.reject(new Error("offline")))
		).rejects.toThrow("offline");
		expect(cache.size).toBe(0);
		expect(await cache.get("x", () => Promise.resolve(null))).toBe(null);
		expect(cache.size).toBe(0);
		expect(await cache.get("x", () => Promise.resolve("ok"))).toBe("ok");
		expect(cache.peek("x")).toBe("ok");
	});

	test("a deleted entry loads again", async () => {
		const cache = createVisualCache<string>();
		await cache.get("a", () => Promise.resolve("first"));
		cache.delete("a");
		expect(cache.peek("a")).toBeUndefined();
		expect(await cache.get("a", () => Promise.resolve("second"))).toBe(
			"second"
		);
	});

	test("least recently used entries are evicted", async () => {
		const cache = createVisualCache<string>({ maxEntries: 2 });
		await cache.get("a", () => Promise.resolve("a"));
		await cache.get("b", () => Promise.resolve("b"));
		await cache.get("a", () => Promise.resolve("again"));
		await cache.get("c", () => Promise.resolve("c"));
		expect(cache.peek("a")).toBe("a");
		expect(cache.peek("b")).toBeUndefined();
		expect(cache.size).toBe(2);
	});
});

describe("waveform peaks watch", () => {
	const peaks: WaveformPeaks = { duration: 10, peaks: [0.5] };
	const policy = { ...waveformRetryPolicy };
	afterEach(() => {
		Object.assign(waveformRetryPolicy, policy);
		peaksCache.clear();
	});
	const settle = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

	test("retry delays double from the base and cap", () => {
		const custom = { baseMs: 100, maxMs: 500 };
		expect([0, 1, 2, 3, 9].map((n) => peaksRetryDelay(n, custom))).toEqual([
			100, 200, 400, 500, 500,
		]);
	});

	test("an analysis finishing after mount is picked up by every clip", async () => {
		waveformRetryPolicy.baseMs = 5;
		waveformRetryPolicy.maxMs = 5;
		const asset = { duration: 10, id: crypto.randomUUID() };
		let ready = false;
		let reads = 0;
		const fetcher = () => {
			reads++;
			return Promise.resolve(ready ? peaks : null);
		};
		const seen: WaveformPeaks[] = [];
		const stops = [0, 1, 2].map(() =>
			watchPeaks(asset, (value) => seen.push(value), fetcher)
		);
		await settle(20);
		expect(seen).toHaveLength(0);
		// Three clips share one watch, so polling reads once per round.
		const pending = reads;
		expect(pending).toBeGreaterThan(1);
		ready = true;
		await settle(30);
		expect(seen).toEqual([peaks, peaks, peaks]);
		const done = reads;
		await settle(20);
		expect(reads).toBe(done);
		for (const stop of stops) {
			stop();
		}
	});

	test("unsubscribing stops polling", async () => {
		waveformRetryPolicy.baseMs = 5;
		waveformRetryPolicy.maxMs = 5;
		let reads = 0;
		const stop = watchPeaks(
			{ duration: 10, id: crypto.randomUUID() },
			() => undefined,
			() => {
				reads++;
				return Promise.resolve(null);
			}
		);
		await settle(15);
		stop();
		const stopped = reads;
		await settle(25);
		expect(reads).toBe(stopped);
	});

	test("invalidation reloads peaks for subscribed clips", async () => {
		const asset = { duration: 10, id: crypto.randomUUID() };
		let current: WaveformPeaks = peaks;
		const seen: WaveformPeaks[] = [];
		const stop = watchPeaks(
			asset,
			(value) => seen.push(value),
			() => Promise.resolve(current)
		);
		await settle();
		expect(seen).toEqual([peaks]);
		const rerun = { duration: 10, peaks: [0.25] };
		current = rerun;
		invalidatePeaks(asset.id);
		await settle();
		expect(seen).toEqual([peaks, rerun]);
		expect(peaksCache.peek(asset.id)).toBe(rerun);
		stop();
	});
});

describe("visuals over part of a wide clip", () => {
	test("span columns equal the same columns of the whole clip", () => {
		const segment = { sourceIn: 1, sourceOut: 9, speed: 1, volume: 1 };
		const layout = { maxColumns: 100_000, pxPerSec: 1000 };
		const whole = waveformColumns(ramp, segment, layout);
		expect(whole).toHaveLength(4000);
		const part = waveformColumnsInSpan(ramp, segment, layout, {
			from: 3001,
			to: 4999,
		});
		expect(part.total).toBe(4000);
		expect(part.first).toBe(1500);
		expect(part.columns).toEqual(whole.slice(1500, 2500));
		// Without a span the whole clip is capped; with one the clip keeps its
		// natural column width and only the drawn columns are capped.
		expect(waveformColumns(ramp, segment, { pxPerSec: 1000 })).toHaveLength(
			2048
		);
		const capped = waveformColumnsInSpan(
			ramp,
			segment,
			{ maxColumns: 10, pxPerSec: 1000 },
			{ from: 0, to: 8000 }
		);
		expect([capped.first, capped.total, capped.columns.length]).toEqual([
			0, 4000, 10,
		]);
	});

	test("span columns cover a window wider than 4096 px", () => {
		// An ultrawide lane: 3400 px viewport at zoom 100, scrolled into a
		// 600 s clip; the window adds overscan and a scroll bucket.
		const zoom = 100;
		const segment = { sourceIn: 0, sourceOut: 600, speed: 1, volume: 1 };
		const window = viewportTimeWindow({
			lanesOffset: 0,
			scrollLeft: 20_000,
			viewportWidth: 3400,
			zoom,
		});
		const span = clipDrawSpan({ ...segment, start: 0 }, window, zoom);
		expect(span.to - span.from).toBeGreaterThan(2 * MAX_WAVEFORM_COLUMNS);
		const drawn = waveformColumnsInSpan(
			ramp,
			segment,
			{ pxPerSec: zoom },
			span
		);
		const columnPx = (600 * zoom) / drawn.total;
		expect(drawn.first * columnPx).toBeLessThanOrEqual(span.from);
		expect(
			(drawn.first + drawn.columns.length) * columnPx
		).toBeGreaterThanOrEqual(span.to);
		// The visible right edge at the far end of the scroll bucket is covered.
		expect((drawn.first + drawn.columns.length) * columnPx).toBeGreaterThan(
			20_399 + 3400
		);
	});

	test("filmstrip tiles over a span keep their whole-clip frames", () => {
		const whole = filmstripTiles(5000, 50, 60);
		expect(whole).toHaveLength(100);
		const part = filmstripTiles(5000, 50, 60, { from: 1020, to: 1490 });
		expect(part).toEqual(whole.slice(20, 30));
		expect(filmstripTiles(5000, 50, 60, { from: 0, to: 5000 })).toEqual(whole);
		const wide = filmstripTiles(200_000, 50, 60, {
			from: 100_000,
			to: 101_000,
		});
		expect(wide.map((tile) => tile.left)).toEqual(
			Array.from({ length: 20 }, (_, index) => 100_000 + index * 50)
		);
		expect(wide[0]?.frame).toBe(30);
	});
});
