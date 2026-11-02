/**
 * Voice-activity silence for the Cleanup panel and the clip overlay.
 *
 * The panel owns the parameters; the timeline overlay reads the same settings
 * so its red non-speech spans always match the live count. Settings persist
 * per viewer; VAD results are cached per asset and parameter set, and the
 * sidecar caches the expensive frame analysis, so slider changes stay cheap.
 */
import { useEffect, useState, useSyncExternalStore } from "react";
import { z } from "zod";
import type { Asset, Project, Segment } from "../../shared/project.ts";
import {
	audibleSegments,
	type ResolvedVadParams,
	sourceSpansToTimeline,
	type TimeRange,
	unionRanges,
	vadParamsSchema,
	vadSilenceQuery,
} from "../../shared/vad.ts";
import { request } from "./bridge.ts";
import { readViewerValue, writeViewerValue } from "./editor/viewer-storage.ts";

export type SourceRange = [number, number];

export interface SilenceSettings {
	/** Draw non-speech spans on timeline clips. */
	overlay: boolean;
	params: ResolvedVadParams;
	/** Confirm transcript dead air with voice activity. */
	vad: boolean;
}

/** Panel defaults: the dead-air minimum pause, VAD threshold and speech length. */
export const DEFAULT_SILENCE_SETTINGS: SilenceSettings = {
	overlay: false,
	params: { minPause: 0.6, minSpeech: 0.1, padding: 0.05, threshold: 10 },
	vad: true,
};

const STORAGE_KEY = "cleanup.silence";
const settingsSchema = z.object({
	overlay: z.boolean(),
	params: vadParamsSchema.required(),
	vad: z.boolean(),
});

export const vadSilenceResponseSchema = z.object({
	assetId: z.string(),
	method: z.literal("vad"),
	noiseFloorDb: z.number(),
	ranges: z.array(z.tuple([z.number(), z.number()])),
});

let settings: SilenceSettings = readViewerValue(
	STORAGE_KEY,
	settingsSchema,
	DEFAULT_SILENCE_SETTINGS
);
const listeners = new Set<() => void>();

export function silenceSettings(): SilenceSettings {
	return settings;
}

export function setSilenceSettings(
	update: Partial<Omit<SilenceSettings, "params">> & {
		params?: Partial<ResolvedVadParams>;
	}
) {
	settings = {
		...settings,
		...update,
		params: { ...settings.params, ...update.params },
	};
	writeViewerValue(STORAGE_KEY, settings);
	for (const listener of listeners) {
		listener();
	}
}

function subscribe(listener: () => void) {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

export function useSilenceSettings(): SilenceSettings {
	return useSyncExternalStore(subscribe, silenceSettings, silenceSettings);
}

/**
 * The clip overlay shows VAD non-speech, so it needs voice activity on as
 * well as the overlay toggle, and only applies to media with audio.
 */
export function silenceOverlayEnabled(
	current: Pick<SilenceSettings, "overlay" | "vad">,
	asset: Pick<Asset, "hasAudio"> | undefined
): boolean {
	return current.overlay && current.vad && (asset?.hasAudio ?? false);
}

type Fetcher = (path: string) => Promise<SourceRange[]>;

const defaultFetcher: Fetcher = async (path) =>
	(await request(vadSilenceResponseSchema, path)).ranges;

const CACHE_LIMIT = 96;
const cache = new Map<string, Promise<SourceRange[]>>();

/** The silence route path for an asset and parameter set. */
export function silencePath(assetId: string, params: ResolvedVadParams) {
	return `/assets/${assetId}/silence?${vadSilenceQuery(params)}`;
}

/**
 * VAD non-speech source spans for a silence path, shared by every caller
 * asking for the same asset and parameters. A failed request is forgotten so
 * it can be retried.
 */
export function loadSilence(
	path: string,
	fetcher: Fetcher = defaultFetcher
): Promise<SourceRange[]> {
	const existing = cache.get(path);
	if (existing) {
		return existing;
	}
	const pending = fetcher(path).catch((error: unknown) => {
		cache.delete(path);
		throw error;
	});
	cache.set(path, pending);
	while (cache.size > CACHE_LIMIT) {
		const oldest = cache.keys().next().value;
		if (oldest === undefined) {
			break;
		}
		cache.delete(oldest);
	}
	return pending;
}

export function clearSilenceCache() {
	cache.clear();
}

/** Spans for one asset, or null while loading, disabled, or unavailable. */
export function useAssetSilence(
	assetId: string | undefined,
	params: ResolvedVadParams,
	enabled: boolean
): SourceRange[] | null {
	const [result, setResult] = useState<{
		path: string;
		ranges: SourceRange[];
	} | null>(null);
	const path = enabled && assetId ? silencePath(assetId, params) : null;
	useEffect(() => {
		if (!path) {
			return;
		}
		let active = true;
		loadSilence(path)
			.then((ranges) => {
				if (active) {
					setResult({ path, ranges });
				}
			})
			.catch(() => {
				// The overlay is advisory; media without audio simply shows nothing.
			});
		return () => {
			active = false;
		};
	}, [path]);
	return path && result?.path === path ? result.ranges : null;
}

/** A non-speech band positioned as percentages of the clip's width. */
export interface SilenceBand {
	end: number;
	leftPercent: number;
	start: number;
	widthPercent: number;
}

/** Map source spans through a clip's source range and speed onto its width. */
export function clipSilenceBands(
	segment: Pick<Segment, "sourceIn" | "sourceOut" | "speed" | "start">,
	ranges: readonly SourceRange[]
): SilenceBand[] {
	const duration = (segment.sourceOut - segment.sourceIn) / segment.speed;
	if (!(duration > 0)) {
		return [];
	}
	return sourceSpansToTimeline(segment, ranges).map((range) => ({
		end: range.end,
		leftPercent: ((range.start - segment.start) / duration) * 100,
		start: range.start,
		widthPercent: ((range.end - range.start) / duration) * 100,
	}));
}

export interface TimelineSilenceSummary {
	/** Non-speech spans that land on timeline clips. */
	count: number;
	/** Timeline seconds covered by those spans (overlaps counted once). */
	seconds: number;
}

/** Live count of VAD pauses across the audible clips of a timeline. */
export function timelineSilenceSummary(
	project: Pick<Project, "segments" | "trackSettings">,
	rangesByAsset: ReadonlyMap<string, readonly SourceRange[]>
): TimelineSilenceSummary {
	const spans: TimeRange[] = [];
	for (const segment of audibleSegments(project)) {
		const ranges = rangesByAsset.get(segment.assetId);
		if (ranges) {
			spans.push(...sourceSpansToTimeline(segment, ranges));
		}
	}
	const seconds = unionRanges(spans).reduce(
		(total, range) => total + (range.end - range.start),
		0
	);
	return { count: spans.length, seconds: Number(seconds.toFixed(2)) };
}

/** Distinct audible sources on the timeline that VAD can analyze. */
export function audibleSourceIds(
	project: Pick<Project, "segments" | "trackSettings">,
	assets: readonly Asset[] | undefined
): string[] {
	const byId = new Map(assets?.map((asset) => [asset.id, asset]));
	const ids = audibleSegments(project)
		.map((segment) => segment.assetId)
		.filter((id) => {
			const asset = byId.get(id);
			return assets === undefined || (asset?.hasAudio ?? false);
		});
	return [...new Set(ids)];
}
