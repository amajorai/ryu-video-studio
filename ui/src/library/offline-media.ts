/**
 * Offline media in the Companion: a shared, lazily loaded list of library
 * assets whose stored media file is missing or unreadable, and the actions
 * that relink them. The timeline badge and the relink dialog read the same
 * snapshot, so a relink clears every badge at once.
 */
import { useEffect, useSyncExternalStore } from "react";
import { z } from "zod";
import { type Asset, assetSchema } from "../../../shared/project.ts";
import {
	type OfflineAssetReport,
	offlineAssetReportSchema,
	relinkNameKey,
} from "../../../shared/relink.ts";
import { request, uploadMedia } from "../bridge.ts";
import type { EditorRuntime } from "../editor/runtime.ts";

const offlineResponseSchema = z.object({
	offline: z.array(offlineAssetReportSchema),
});
const relinkResultSchema = z.object({
	asset: assetSchema,
	dryRun: z.boolean(),
	proxyAssets: z.array(assetSchema).default([]),
	removedAssetId: z.string().nullable(),
	removedProxyAssetIds: z.array(z.string()).default([]),
	warnings: z.array(z.string()),
});
export type RelinkResponse = z.infer<typeof relinkResultSchema>;
const relinkBatchResultSchema = z.object({
	failures: z.array(
		z.object({
			assetId: z.string(),
			reason: z.string(),
			sourceAssetId: z.string(),
		})
	),
	relinked: z.array(relinkResultSchema),
	unmatched: z.array(z.object({ assetId: z.string(), reason: z.string() })),
	unusedSourceAssetIds: z.array(z.string()),
});
export type RelinkBatchResponse = z.infer<typeof relinkBatchResultSchema>;

/** A snapshot is considered fresh for this long before a new reader refetches. */
const FRESH_MS = 30_000;

interface OfflineSnapshot {
	loadedAt: number;
	reports: readonly OfflineAssetReport[];
}

const emptySnapshot: OfflineSnapshot = { loadedAt: 0, reports: [] };
let snapshot = emptySnapshot;
let inflight: Promise<OfflineSnapshot> | undefined;
const listeners = new Set<() => void>();

type Fetch = () => Promise<z.infer<typeof offlineResponseSchema>>;
const defaultFetch: Fetch = () =>
	request(offlineResponseSchema, "/offline-assets");

function publish(next: OfflineSnapshot) {
	snapshot = next;
	for (const listener of listeners) {
		listener();
	}
}

/**
 * Reload the offline list. Concurrent callers share one request; a failure
 * keeps the previous snapshot (an unreachable sidecar is not offline media).
 */
export function refreshOfflineMedia(
	fetchOffline: Fetch = defaultFetch
): Promise<OfflineSnapshot> {
	inflight ??= fetchOffline()
		.then(({ offline }) => {
			const next = { loadedAt: Date.now(), reports: offline };
			publish(next);
			return next;
		})
		.catch(() => snapshot)
		.finally(() => {
			inflight = undefined;
		});
	return inflight;
}

/** Forget the cached list (tests). */
export function resetOfflineMedia() {
	inflight = undefined;
	publish(emptySnapshot);
}

/** Seed the list directly (tests and callers that already hold a report). */
export function setOfflineMedia(reports: readonly OfflineAssetReport[]) {
	publish({ loadedAt: Date.now(), reports });
}

function subscribe(listener: () => void) {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

/** The offline report list, loaded on first use and refreshed when stale. */
export function useOfflineMedia(): readonly OfflineAssetReport[] {
	const current = useSyncExternalStore(
		subscribe,
		() => snapshot,
		() => snapshot
	);
	useEffect(() => {
		if (Date.now() - snapshot.loadedAt > FRESH_MS) {
			refreshOfflineMedia().catch(() => undefined);
		}
	}, []);
	return current.reports;
}

/** The offline report for one asset, if its media is offline. */
export function useOfflineReport(
	assetId: string | undefined
): OfflineAssetReport | undefined {
	const reports = useOfflineMedia();
	return assetId
		? reports.find((report) => report.assetId === assetId)
		: undefined;
}

type RelinkRuntime = Pick<EditorRuntime, "setAssets" | "setSources">;

/**
 * Apply a relink to the library: replace the relinked asset, drop the
 * consumed upload and the old proxies, and move the replacement's proxies
 * onto the relinked asset so the preview never shows the pre-relink media.
 */
export function applyRelinked(
	runtime: RelinkRuntime,
	result: Pick<RelinkResponse, "asset" | "removedAssetId"> &
		Partial<Pick<RelinkResponse, "proxyAssets" | "removedProxyAssetIds">>
) {
	const { asset, removedAssetId } = result;
	const removed = new Set(result.removedProxyAssetIds ?? []);
	if (removedAssetId) {
		removed.add(removedAssetId);
	}
	const replaced = new Map(
		[asset, ...(result.proxyAssets ?? [])].map((item) => [item.id, item])
	);
	runtime.setAssets((current) =>
		current
			.filter((item) => !removed.has(item.id))
			.map((item) => replaced.get(item.id) ?? item)
	);
	// A cached preview URL may point at the failed media or an old proxy.
	const stale = new Set([asset.id, ...removed]);
	runtime.setSources((current) => {
		if (!Object.keys(current).some((id) => stale.has(id))) {
			return current;
		}
		return Object.fromEntries(
			Object.entries(current).filter(([id]) => !stale.has(id))
		);
	});
}

export interface RelinkTransport {
	/** Remove an upload the sidecar refused, so it does not clutter the library. */
	discard: (assetId: string) => Promise<unknown>;
	relink: (
		assetId: string,
		sourceAssetId: string
	) => Promise<z.infer<typeof relinkResultSchema>>;
	relinkBatch: (
		sourceAssetIds: string[],
		targetAssetIds: string[]
	) => Promise<RelinkBatchResponse>;
	upload: (file: File, progress: (value: number) => void) => Promise<Asset>;
}

export const sidecarRelinkTransport: RelinkTransport = {
	discard: (assetId) =>
		request(z.json(), `/assets/${assetId}/organize`, "POST", {
			delete: true,
		}),
	relink: (assetId, sourceAssetId) =>
		request(relinkResultSchema, `/assets/${assetId}/relink`, "POST", {
			sourceAssetId,
		}),
	relinkBatch: (sourceAssetIds, targetAssetIds) =>
		request(relinkBatchResultSchema, "/relink", "POST", {
			sourceAssetIds,
			targetAssetIds,
		}),
	upload: uploadMedia,
};

/**
 * Upload `file` and relink offline `report` to it. When the sidecar refuses
 * the replacement (wrong kind or duration) the upload is removed again and
 * the refusal is thrown for the caller to show.
 */
export async function relinkWithFile(
	runtime: RelinkRuntime,
	report: OfflineAssetReport,
	file: File,
	progress: (value: number) => void = () => undefined,
	transport: RelinkTransport = sidecarRelinkTransport
): Promise<string[]> {
	const uploaded = await transport.upload(file, progress);
	try {
		const result = await transport.relink(report.assetId, uploaded.id);
		applyRelinked(runtime, result);
		await refreshOfflineMedia();
		return result.warnings;
	} catch (error) {
		await transport.discard(uploaded.id).catch(() => undefined);
		throw error;
	}
}

/**
 * Files from a folder pick whose name matches some offline asset. Matching
 * by duration happens in the sidecar after upload; this pre-filter only
 * avoids uploading files that cannot match.
 */
export function candidateFiles(
	reports: readonly OfflineAssetReport[],
	files: readonly File[]
): File[] {
	const wanted = new Set(reports.map((report) => relinkNameKey(report.name)));
	return files.filter((file) => wanted.has(relinkNameKey(file.name)));
}

export interface BatchRelinkSummary {
	failed: string[];
	relinked: number;
	unmatched: number;
	uploaded: number;
}

async function discardAll(transport: RelinkTransport, ids: Iterable<string>) {
	for (const id of ids) {
		await transport.discard(id).catch(() => undefined);
	}
}

/**
 * Folder relink: upload every file named like an offline asset, let the
 * sidecar match them by name and duration against exactly the listed
 * reports (so damaged files found by a probe are included), then remove
 * uploads it did not use. Any failure removes every upload made so far.
 */
export async function relinkFolder(
	runtime: RelinkRuntime,
	reports: readonly OfflineAssetReport[],
	files: readonly File[],
	progress: (done: number, total: number) => void = () => undefined,
	transport: RelinkTransport = sidecarRelinkTransport
): Promise<BatchRelinkSummary> {
	const candidates = candidateFiles(reports, files);
	if (!candidates.length) {
		return { failed: [], relinked: 0, unmatched: reports.length, uploaded: 0 };
	}
	const uploaded: Asset[] = [];
	let result: RelinkBatchResponse;
	try {
		for (const [index, file] of candidates.entries()) {
			progress(index, candidates.length);
			uploaded.push(await transport.upload(file, () => undefined));
		}
		progress(candidates.length, candidates.length);
		result = await transport.relinkBatch(
			uploaded.map((asset) => asset.id),
			reports.map((report) => report.assetId)
		);
	} catch (error) {
		await discardAll(
			transport,
			uploaded.map((asset) => asset.id)
		);
		throw error;
	}
	for (const relinked of result.relinked) {
		applyRelinked(runtime, relinked);
	}
	await discardAll(
		transport,
		new Set([
			...result.unusedSourceAssetIds,
			...result.failures.map((failure) => failure.sourceAssetId),
		])
	);
	await refreshOfflineMedia();
	return {
		failed: result.failures.map((failure) => failure.reason),
		relinked: result.relinked.length,
		unmatched: result.unmatched.length,
		uploaded: uploaded.length,
	};
}
