/**
 * Library hover-skim (W1-L1): pointer x over a tile maps to a source time,
 * and the tile shows the frame at that time from
 * `GET /assets/:id/skim-frame?time&height`. Times are quantized to a fixed
 * number of buckets per asset so frames cache well on both sides, requests
 * are coalesced (one in flight per tile, the latest position wins), and a
 * failing asset stops skimming instead of retrying on every move.
 */
import { safeMediaUrl } from "@ryu/ui/lib/safe-media-url.ts";
import { useCallback, useEffect, useRef, useState } from "react";
import { z } from "zod";
import type { Asset } from "../../../shared/project.ts";
import { request } from "../bridge.ts";

/** Distinct frames one asset can show while skimming. */
export const SKIM_BUCKETS = 32;
/** Frame height requested for tiles (the sidecar allows 48..360). */
export const SKIM_HEIGHT = 120;
/** Frames kept in memory across every tile. */
export const SKIM_CACHE_LIMIT = 256;

export const skimFrameResponseSchema = z.object({
	data: z
		.string()
		.max(2_000_000)
		.regex(/^[A-Za-z0-9+/]+={0,2}$/),
	time: z.number().finite().min(0),
});

/** Where the pointer sits across an element, from 0 (left) to 1 (right). */
export function pointerFraction(
	clientX: number,
	rect: { left: number; width: number }
): number {
	if (!(rect.width > 0)) {
		return 0;
	}
	return Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
}

/**
 * The source time a pointer fraction skims to: the centre of its bucket,
 * rounded to a millisecond. Stills always show time 0; audio has no frames.
 */
export function skimTime(
	fraction: number,
	asset: Pick<Asset, "duration" | "kind">,
	buckets = SKIM_BUCKETS
): number {
	if (asset.kind !== "video" || !(asset.duration > 0)) {
		return 0;
	}
	const count = Math.max(1, Math.floor(buckets));
	const clamped = Math.min(1, Math.max(0, fraction));
	const bucket = Math.min(count - 1, Math.floor(clamped * count));
	return Math.round(((bucket + 0.5) / count) * asset.duration * 1000) / 1000;
}

/** Sidecar path of one skim frame. */
export function skimFramePath(
	assetId: string,
	time: number,
	height = SKIM_HEIGHT
): string {
	const params = new URLSearchParams({
		height: String(height),
		time: String(time),
	});
	return `/assets/${assetId}/skim-frame?${params.toString()}`;
}

/** A small least-recently-used map of frame data URLs. */
export class SkimFrameCache {
	readonly #entries = new Map<string, string>();
	readonly #limit: number;
	constructor(limit = SKIM_CACHE_LIMIT) {
		this.#limit = Math.max(1, limit);
	}
	get size() {
		return this.#entries.size;
	}
	get(key: string): string | undefined {
		const value = this.#entries.get(key);
		if (value !== undefined) {
			this.#entries.delete(key);
			this.#entries.set(key, value);
		}
		return value;
	}
	set(key: string, value: string) {
		this.#entries.delete(key);
		this.#entries.set(key, value);
		while (this.#entries.size > this.#limit) {
			const oldest = this.#entries.keys().next().value;
			if (oldest === undefined) {
				break;
			}
			this.#entries.delete(oldest);
		}
	}
}

const sharedCache = new SkimFrameCache();

export type SkimFrameLoader = (path: string) => Promise<{ data: string }>;

const defaultLoader: SkimFrameLoader = (path) =>
	request(skimFrameResponseSchema, path);

export interface HoverSkim {
	/** Data URL of the frame on screen, or null before the first frame. */
	frame: string | null;
	/** Pointer leaves: keep the last frame but clear the skim time. */
	onPointerLeave: () => void;
	onPointerMove: (event: {
		clientX: number;
		currentTarget: {
			getBoundingClientRect: () => { left: number; width: number };
		};
	}) => void;
	/** Show the frame at an exact source time (the preview scrubber). */
	showTime: (time: number) => void;
	/** Source time under the pointer, or null when not skimming. */
	time: number | null;
	/** The asset failed to produce a frame; skimming is off for it. */
	unavailable: boolean;
}

/** Hover-skim state for one asset tile or preview. */
export function useHoverSkim(
	asset: Pick<Asset, "duration" | "id" | "kind">,
	{
		cache = sharedCache,
		height = SKIM_HEIGHT,
		load = defaultLoader,
	}: { cache?: SkimFrameCache; height?: number; load?: SkimFrameLoader } = {}
): HoverSkim {
	const [frame, setFrame] = useState<string | null>(null);
	const [time, setTime] = useState<number | null>(null);
	const [unavailable, setUnavailable] = useState(false);
	const wanted = useRef<number | null>(null);
	/** The time most recently shown; a slower, older fetch must not replace it. */
	const latest = useRef<number | null>(null);
	const inFlight = useRef(false);
	const failed = useRef(false);
	const mounted = useRef(true);
	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
		};
	}, []);

	const pump = useCallback(async () => {
		if (inFlight.current) {
			return;
		}
		inFlight.current = true;
		try {
			while (wanted.current !== null && !failed.current) {
				const target = wanted.current;
				const key = `${asset.id}:${height}:${target}`;
				let url = cache.get(key);
				if (url === undefined) {
					const result = await load(skimFramePath(asset.id, target, height));
					url = safeMediaUrl(`data:image/jpeg;base64,${result.data}`) ?? "";
					cache.set(key, url);
				}
				if (!mounted.current) {
					return;
				}
				if (latest.current === target) {
					setFrame(url || null);
				}
				if (wanted.current === target) {
					wanted.current = null;
				}
			}
		} catch {
			failed.current = true;
			if (mounted.current) {
				setUnavailable(true);
			}
		} finally {
			inFlight.current = false;
		}
	}, [asset.id, cache, height, load]);

	const showTime = useCallback(
		(next: number) => {
			if (asset.kind === "audio" || failed.current) {
				return;
			}
			setTime(next);
			latest.current = next;
			const key = `${asset.id}:${height}:${next}`;
			const cached = cache.get(key);
			if (cached !== undefined) {
				wanted.current = null;
				setFrame(cached || null);
				return;
			}
			wanted.current = next;
			void pump();
		},
		[asset.id, asset.kind, cache, height, pump]
	);

	const onPointerMove = useCallback<HoverSkim["onPointerMove"]>(
		(event) => {
			showTime(
				skimTime(
					pointerFraction(
						event.clientX,
						event.currentTarget.getBoundingClientRect()
					),
					asset
				)
			);
		},
		[asset, showTime]
	);

	const onPointerLeave = useCallback(() => {
		wanted.current = null;
		setTime(null);
	}, []);

	return { frame, onPointerLeave, onPointerMove, showTime, time, unavailable };
}
