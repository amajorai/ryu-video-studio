/**
 * Pure planning and request caches for per-clip timeline visuals (W1-T9):
 * waveform columns from the asset's analysis peaks, and filmstrip sprites
 * from `GET /assets/:id/filmstrip`. Every clip on the timeline shares these
 * caches, so equal clips never issue duplicate requests.
 */
import { z } from "zod";
import { analysisSchema } from "../../../shared/analysis.ts";
import type { Asset, Segment } from "../../../shared/project.ts";
import { request } from "../bridge.ts";
import type { ClipPixelSpan } from "./virtualize.ts";

/* ------------------------------------------------------------------ */
/* Waveforms                                                           */
/* ------------------------------------------------------------------ */

export interface WaveformPeaks {
	/** Source seconds covered by `peaks`. */
	duration: number;
	/** Normalized peak amplitude per equal bin of the source, 0..1. */
	peaks: readonly number[];
}

export interface WaveformLayout {
	/** Pixels per drawn column. */
	columnWidth?: number;
	/**
	 * Upper bound on drawn columns, so long clips stay cheap. Without a span
	 * it defaults to `MAX_WAVEFORM_COLUMNS`; over a span, to the columns the
	 * span needs, up to `MAX_SPAN_WAVEFORM_COLUMNS`.
	 */
	maxColumns?: number;
	/** Timeline zoom in pixels per second. */
	pxPerSec: number;
}

export const DEFAULT_WAVEFORM_COLUMN_WIDTH = 2;
export const MAX_WAVEFORM_COLUMNS = 2048;
/**
 * Hard limit on the columns drawn over a span. A span is the viewport plus
 * its overscan and scroll bucket, so this covers lanes far wider than any
 * display (16,384 px at the default column width) while bounding the canvas.
 */
export const MAX_SPAN_WAVEFORM_COLUMNS = 8192;

/** Largest peak among the bins that overlap source seconds `from..to`. */
export function peakInRange(
	{ duration, peaks }: WaveformPeaks,
	from: number,
	to: number
): number {
	if (
		peaks.length === 0 ||
		!(duration > 0) ||
		to <= 0 ||
		from >= duration ||
		to < from
	) {
		return 0;
	}
	const scale = peaks.length / duration;
	const last = peaks.length - 1;
	const first = Math.min(last, Math.max(0, Math.floor(from * scale + 1e-9)));
	const end = Math.min(last, Math.max(first, Math.ceil(to * scale - 1e-9) - 1));
	let peak = 0;
	for (let index = first; index <= end; index++) {
		peak = Math.max(peak, peaks[index] ?? 0);
	}
	return peak;
}

/**
 * Amplitude per drawn column of a clip. Column `c` covers timeline offsets
 * `c..c+1` columns into the clip; at the clip's speed that is source time
 * `sourceIn + offset * speed`, so a 2x clip packs twice the source into
 * each column. Amplitudes are scaled by the clip volume and capped at 1.
 */
export function waveformColumns(
	waveform: WaveformPeaks,
	segment: Pick<Segment, "sourceIn" | "sourceOut" | "speed" | "volume">,
	layout: WaveformLayout
): number[] {
	return waveformColumnsInSpan(waveform, segment, layout).columns;
}

/** Waveform columns of one part of a clip (`waveformColumnsInSpan`). */
export interface WaveformSpan {
	columns: number[];
	/** Index of the first drawn column among `total`. */
	first: number;
	/** Columns across the whole clip. */
	total: number;
}

/**
 * Waveform columns across the clip, or only those over `span` (pixels from
 * the clip's left edge). Without a span the whole clip is drawn in at most
 * `maxColumns` columns; with one, the clip keeps its natural column width
 * and only the columns over the span are computed (by default every one of
 * them, so the drawn waveform covers the whole span on any display width),
 * each identical to the same column of the whole clip, so a very long clip
 * at high zoom never needs a canvas wider than the viewport.
 */
export function waveformColumnsInSpan(
	waveform: WaveformPeaks,
	segment: Pick<Segment, "sourceIn" | "sourceOut" | "speed" | "volume">,
	layout: WaveformLayout,
	span?: ClipPixelSpan
): WaveformSpan {
	const columnWidth = layout.columnWidth ?? DEFAULT_WAVEFORM_COLUMN_WIDTH;
	const spanColumns = span
		? Math.min(
				MAX_SPAN_WAVEFORM_COLUMNS,
				Math.max(1, Math.ceil((span.to - span.from) / columnWidth) + 1)
			)
		: MAX_WAVEFORM_COLUMNS;
	const maxColumns = layout.maxColumns ?? spanColumns;
	const speed = segment.speed > 0 ? segment.speed : 1;
	const timelineDuration = Math.max(
		0,
		(segment.sourceOut - segment.sourceIn) / speed
	);
	const clipPx = timelineDuration * layout.pxPerSec;
	const natural = Math.max(0, Math.ceil(clipPx / columnWidth));
	const total = span ? natural : Math.min(maxColumns, natural);
	const first =
		span && clipPx > 0
			? Math.min(total, Math.max(0, Math.floor((span.from / clipPx) * total)))
			: 0;
	const last =
		span && clipPx > 0
			? Math.min(
					total,
					first + maxColumns,
					Math.max(first, Math.ceil((span.to / clipPx) * total))
				)
			: total;
	const volume = Math.max(0, segment.volume);
	const columns: number[] = [];
	for (let column = first; column < last; column++) {
		const from = segment.sourceIn + (column / total) * timelineDuration * speed;
		const to =
			segment.sourceIn + ((column + 1) / total) * timelineDuration * speed;
		columns.push(Math.min(1, peakInRange(waveform, from, to) * volume));
	}
	return { columns, first, total };
}

/** Peaks from a stored analysis, or `null` until one has completed. */
export function peaksFromAnalysis(
	analysis: unknown,
	assetDuration: number
): WaveformPeaks | null {
	const parsed = analysisSchema.safeParse(analysis);
	if (!parsed.success || parsed.data.status !== "completed") {
		return null;
	}
	if (parsed.data.waveform.length === 0) {
		return null;
	}
	return {
		duration: parsed.data.duration > 0 ? parsed.data.duration : assetDuration,
		peaks: parsed.data.waveform,
	};
}

/** Whether a clip of this asset carries sound worth drawing. */
export const hasWaveform = (asset: Asset | undefined): asset is Asset =>
	asset !== undefined &&
	(asset.kind === "audio" || (asset.kind === "video" && asset.hasAudio));

/* ------------------------------------------------------------------ */
/* Filmstrips                                                          */
/* ------------------------------------------------------------------ */

/** Thumbnail height requested from the sidecar (crisp at 1.5x density). */
export const FILMSTRIP_REQUEST_HEIGHT = 48;
/** Thumbnail height drawn inside a timeline clip. */
export const FILMSTRIP_DISPLAY_HEIGHT = 32;
export const MAX_FILMSTRIP_FRAMES = 60;
/** Frame counts snap to these so zooming reuses cached sprites. */
const FRAME_BUCKETS = [1, 2, 4, 8, 16, 32, MAX_FILMSTRIP_FRAMES] as const;
/** Tiles drawn per clip at most; wider clips reuse the sprite's frames. */
export const MAX_FILMSTRIP_TILES = 240;

export interface FilmstripPlan {
	assetId: string;
	count: number;
	end: number;
	height: number;
	start: number;
}

export interface FilmstripTile {
	/** Sprite frame drawn in this tile. */
	frame: number;
	/** Offset from the clip's left edge, in pixels. */
	left: number;
}

const millis = (value: number) => Math.round(value * 1000) / 1000;

/** Display width of one thumbnail, from the asset's aspect ratio. */
export function filmstripThumbWidth(
	asset: Pick<Asset, "height" | "width">,
	height = FILMSTRIP_DISPLAY_HEIGHT
): number {
	const aspect =
		asset.width > 0 && asset.height > 0 ? asset.width / asset.height : 16 / 9;
	return Math.max(1, Math.round(height * Math.min(3, Math.max(0.25, aspect))));
}

/** Smallest bucketed frame count that gives every visible tile a frame. */
export function filmstripFrameCount(
	clipWidth: number,
	thumbWidth: number
): number {
	const needed = Math.max(1, Math.ceil(clipWidth / Math.max(1, thumbWidth)));
	return (
		FRAME_BUCKETS.find((bucket) => bucket >= needed) ?? MAX_FILMSTRIP_FRAMES
	);
}

/**
 * The sprite a clip needs: its visible source range, rounded to the
 * millisecond so equal clips share a cache key, and a frame count derived
 * from the clip width over the thumbnail width. Stills need one frame.
 */
export function planFilmstrip(
	asset: Asset | undefined,
	segment: Pick<Segment, "assetId" | "sourceIn" | "sourceOut">,
	clipWidth: number
): FilmstripPlan | null {
	if (!asset || asset.kind === "audio" || asset.id !== segment.assetId) {
		return null;
	}
	if (asset.kind === "image") {
		return {
			assetId: asset.id,
			count: 1,
			end: 1,
			height: FILMSTRIP_REQUEST_HEIGHT,
			start: 0,
		};
	}
	const start = millis(Math.max(0, segment.sourceIn));
	const end = millis(Math.min(segment.sourceOut, asset.duration));
	if (end - start < 0.001) {
		return null;
	}
	return {
		assetId: asset.id,
		count: filmstripFrameCount(clipWidth, filmstripThumbWidth(asset)),
		end,
		height: FILMSTRIP_REQUEST_HEIGHT,
		start,
	};
}

export const filmstripKey = (plan: FilmstripPlan) =>
	`${plan.assetId}|${plan.start}|${plan.end}|${plan.count}|${plan.height}`;

export const filmstripPath = (plan: FilmstripPlan) =>
	`/assets/${plan.assetId}/filmstrip?${new URLSearchParams({
		count: String(plan.count),
		end: String(plan.end),
		height: String(plan.height),
		start: String(plan.start),
	}).toString()}`;

/**
 * Lay thumbnails across the clip at their natural width. Each tile shows the
 * sprite frame whose slice of the source range contains the centre of the
 * tile's visible part. A clip wider than `MAX_FILMSTRIP_TILES` thumbnails
 * spaces that many tiles evenly across its whole width instead, each centred
 * in its slot, so the full width and every sprite frame stay covered.
 * With a `span` (pixels from the clip's left edge) that leaves part of the
 * clip out, only the natural tiles over the span are laid out (at most
 * `MAX_FILMSTRIP_TILES`), each with the frame it has in the whole clip.
 */
export function filmstripTiles(
	clipWidth: number,
	thumbWidth: number,
	frameCount: number,
	span?: ClipPixelSpan
): FilmstripTile[] {
	if (!(clipWidth > 0 && thumbWidth > 0 && frameCount > 0)) {
		return [];
	}
	const natural = Math.ceil(clipWidth / thumbWidth);
	const frameAt = (centre: number) =>
		Math.min(frameCount - 1, Math.floor((centre / clipWidth) * frameCount));
	const tiles: FilmstripTile[] = [];
	if (span && (span.from > 0 || span.to < clipWidth)) {
		const first = Math.max(0, Math.floor(span.from / thumbWidth));
		const last = Math.min(
			natural,
			first + MAX_FILMSTRIP_TILES,
			Math.ceil(span.to / thumbWidth)
		);
		for (let index = first; index < last; index++) {
			const left = index * thumbWidth;
			const visible = Math.min(thumbWidth, clipWidth - left);
			tiles.push({ frame: frameAt(left + visible / 2), left });
		}
		return tiles;
	}
	if (natural > MAX_FILMSTRIP_TILES) {
		const slot = clipWidth / MAX_FILMSTRIP_TILES;
		for (let index = 0; index < MAX_FILMSTRIP_TILES; index++) {
			const centre = (index + 0.5) * slot;
			tiles.push({
				frame: frameAt(centre),
				left: Math.round(centre - thumbWidth / 2),
			});
		}
		return tiles;
	}
	for (let index = 0; index < natural; index++) {
		const left = index * thumbWidth;
		const visible = Math.min(thumbWidth, clipWidth - left);
		tiles.push({ frame: frameAt(left + visible / 2), left });
	}
	return tiles;
}

export const filmstripResponseSchema = z.object({
	count: z.number().int().min(1),
	data: z.string().min(1),
	frameHeight: z.number().int().min(1),
	frameWidth: z.number().int().min(1),
	times: z.array(z.number()),
	width: z.number().int().min(1),
});

export interface FilmstripSprite {
	count: number;
	frameHeight: number;
	frameWidth: number;
	/** `data:image/png;base64,…` URL of the single-row sprite. */
	url: string;
}

/* ------------------------------------------------------------------ */
/* Request cache                                                       */
/* ------------------------------------------------------------------ */

export interface VisualCache<Value> {
	/** Drop every entry; in-flight loads still resolve for their callers. */
	clear(): void;
	/** Drop one entry so the next `get` loads it again. */
	delete(key: string): void;
	/**
	 * Load once per key; concurrent and later callers share the result and
	 * their own `load` is not called.
	 */
	get(key: string, load: () => Promise<Value>): Promise<Value>;
	/** The settled value for a key, if any, so renders can skip a flash. */
	peek(key: string): Value | undefined;
	readonly size: number;
}

interface CacheEntry<Value> {
	promise: Promise<Value>;
	value?: Value;
}

/**
 * A least-recently-used cache of keyed loads. Loads run one at a time in
 * request order so a timeline full of clips never floods the sidecar. A
 * failed load, or one whose value `keep` rejects, is forgotten so a later
 * mount can retry.
 */
export function createVisualCache<Value>(
	options: { keep?: (value: Value) => boolean; maxEntries?: number } = {}
): VisualCache<Value> {
	const maxEntries = options.maxEntries ?? 200;
	const entries = new Map<string, CacheEntry<Value>>();
	let lane: Promise<unknown> = Promise.resolve();
	const touch = (key: string, entry: CacheEntry<Value>) => {
		entries.delete(key);
		entries.set(key, entry);
		while (entries.size > maxEntries) {
			const oldest = entries.keys().next().value;
			if (oldest === undefined) {
				break;
			}
			entries.delete(oldest);
		}
	};
	const forget = (key: string, entry: CacheEntry<Value>) => {
		if (entries.get(key) === entry) {
			entries.delete(key);
		}
	};
	return {
		clear() {
			entries.clear();
		},
		delete(key) {
			entries.delete(key);
		},
		get(key, load) {
			const existing = entries.get(key);
			if (existing) {
				touch(key, existing);
				return existing.promise;
			}
			const entry: CacheEntry<Value> = { promise: lane.then(load) };
			lane = entry.promise.catch(() => undefined);
			entry.promise.then(
				(value) => {
					if (options.keep && !options.keep(value)) {
						forget(key, entry);
					} else {
						entry.value = value;
					}
				},
				() => forget(key, entry)
			);
			touch(key, entry);
			return entry.promise;
		},
		peek(key) {
			return entries.get(key)?.value;
		},
		get size() {
			return entries.size;
		},
	};
}

/** Fetch one filmstrip sprite from the sidecar. */
export async function fetchFilmstrip(
	plan: FilmstripPlan
): Promise<FilmstripSprite> {
	const result = await request(filmstripResponseSchema, filmstripPath(plan));
	return {
		count: result.count,
		frameHeight: result.frameHeight,
		frameWidth: result.frameWidth,
		url: `data:image/png;base64,${result.data}`,
	};
}

/** Read an asset's analysis peaks; `null` until an analysis completes. */
export async function fetchPeaks(
	asset: Pick<Asset, "duration" | "id">
): Promise<WaveformPeaks | null> {
	const result = await request(
		z.object({ analysis: z.json() }),
		`/assets/${asset.id}/analysis`
	);
	return peaksFromAnalysis(result.analysis, asset.duration);
}

/** Shared filmstrip sprites for every clip on the timeline. */
export const filmstripCache = createVisualCache<FilmstripSprite>({
	maxEntries: 120,
});

/** Load (or reuse) the sprite for a plan. */
export const loadFilmstrip = (
	plan: FilmstripPlan,
	fetcher: (plan: FilmstripPlan) => Promise<FilmstripSprite> = fetchFilmstrip
): Promise<FilmstripSprite> =>
	filmstripCache.get(filmstripKey(plan), () => fetcher(plan));

/** Shared analysis peaks per asset. Missing analyses are not remembered. */
export const peaksCache = createVisualCache<WaveformPeaks | null>({
	keep: (value) => value !== null,
	maxEntries: 200,
});

/** Load (or reuse) the analysis peaks for an asset. */
export const loadPeaks = (
	asset: Pick<Asset, "duration" | "id">,
	fetcher: (
		asset: Pick<Asset, "duration" | "id">
	) => Promise<WaveformPeaks | null> = fetchPeaks
): Promise<WaveformPeaks | null> =>
	peaksCache.get(asset.id, () => fetcher(asset));

/** Backoff while an asset's analysis has not completed yet. */
export const waveformRetryPolicy = { baseMs: 2000, maxMs: 30_000 };

/** Delay before retry `attempt` (0-based): doubling from base, capped. */
export const peaksRetryDelay = (
	attempt: number,
	policy: { baseMs: number; maxMs: number } = waveformRetryPolicy
): number => Math.min(policy.maxMs, policy.baseMs * 2 ** Math.max(0, attempt));

type PeaksFetcher = (
	asset: Pick<Asset, "duration" | "id">
) => Promise<WaveformPeaks | null>;
type PeaksListener = (peaks: WaveformPeaks) => void;

interface PeaksWatch {
	asset: Pick<Asset, "duration" | "id">;
	attempt: number;
	fetcher: PeaksFetcher;
	generation: number;
	listeners: Set<PeaksListener>;
	timer?: ReturnType<typeof setTimeout>;
}

const peaksWatches = new Map<string, PeaksWatch>();

function pollPeaks(watch: PeaksWatch): void {
	const generation = watch.generation;
	const current = () =>
		peaksWatches.get(watch.asset.id) === watch &&
		watch.generation === generation;
	const retry = () => {
		if (!current()) {
			return;
		}
		watch.timer = setTimeout(() => {
			watch.timer = undefined;
			if (current()) {
				pollPeaks(watch);
			}
		}, peaksRetryDelay(watch.attempt));
		watch.attempt += 1;
	};
	loadPeaks(watch.asset, watch.fetcher).then((peaks) => {
		if (!current()) {
			return;
		}
		if (peaks === null) {
			retry();
			return;
		}
		watch.attempt = 0;
		for (const listener of watch.listeners) {
			listener(peaks);
		}
	}, retry);
}

/**
 * Keep `listener` supplied with an asset's peaks while it is subscribed.
 * Every clip of one asset shares a single watch: until the analysis has
 * completed it is re-read with a backoff, and `invalidatePeaks` reloads it
 * for every subscriber. Returns the unsubscribe function.
 */
export function watchPeaks(
	asset: Pick<Asset, "duration" | "id">,
	listener: PeaksListener,
	fetcher: PeaksFetcher = fetchPeaks
): () => void {
	let watch = peaksWatches.get(asset.id);
	if (watch) {
		watch.listeners.add(listener);
		const settled = peaksCache.peek(asset.id);
		if (settled) {
			listener(settled);
		}
	} else {
		watch = {
			asset,
			attempt: 0,
			fetcher,
			generation: 0,
			listeners: new Set(),
		};
		peaksWatches.set(asset.id, watch);
		watch.listeners.add(listener);
		pollPeaks(watch);
	}
	const owned = watch;
	return () => {
		owned.listeners.delete(listener);
		if (owned.listeners.size === 0 && peaksWatches.get(asset.id) === owned) {
			clearTimeout(owned.timer);
			peaksWatches.delete(asset.id);
		}
	};
}

/**
 * Forget an asset's peaks, for example after its analysis is re-run, and
 * reload them for every clip currently showing that asset.
 */
export function invalidatePeaks(assetId: string): void {
	peaksCache.delete(assetId);
	const watch = peaksWatches.get(assetId);
	if (!watch) {
		return;
	}
	clearTimeout(watch.timer);
	watch.timer = undefined;
	watch.generation += 1;
	watch.attempt = 0;
	pollPeaks(watch);
}
