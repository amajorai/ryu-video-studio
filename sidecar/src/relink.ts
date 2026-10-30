/**
 * Offline media detection and relink (G37) for app-owned media.
 *
 * Detection is a cheap file check (exists, is a regular non-empty file, can
 * be opened and read), with an optional FFprobe pass that also catches files
 * that are present but no longer decode. Relink moves a replacement that was
 * uploaded as its own library asset onto the offline asset's media path,
 * keeping the offline asset's id so every clip and derived record stays
 * attached, and then removes the replacement's now-empty record.
 */

import { closeSync, openSync, readSync, statSync } from "node:fs";
import { rename, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Asset, Project } from "../../shared/project.ts";
import {
	isProxyDerivative,
	matchRelinkBatch,
	type OfflineAssetReport,
	type OfflineProjectUse,
	type OfflineReason,
	projectAssetIds,
	type RelinkBatchRequest,
	type RelinkRequest,
	relinkedAsset,
	requiredSourceDuration,
	validateReplacement,
} from "../../shared/relink.ts";
import { studioError } from "../../shared/studio-error.ts";
import { probe, thumbnail } from "./media.ts";
import { ConflictError, type StudioStore } from "./store.ts";

/**
 * Why the file at `path` cannot be used as media, or `null` when it can be
 * opened and its first byte read. Synchronous so the store can gate a render
 * inside its own transaction-free checks.
 */
export function mediaFileState(path: string): OfflineReason | null {
	let size: number;
	try {
		const stats = statSync(path);
		if (!stats.isFile()) {
			return "not-a-file";
		}
		size = stats.size;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT"
			? "missing"
			: "unreadable";
	}
	if (size === 0) {
		return "empty";
	}
	let descriptor: number | undefined;
	try {
		descriptor = openSync(path, "r");
		return readSync(descriptor, Buffer.alloc(1), 0, 1, 0) === 1
			? null
			: "unreadable";
	} catch {
		return "unreadable";
	} finally {
		if (descriptor !== undefined) {
			closeSync(descriptor);
		}
	}
}

/** Projects that place `assetId` on their timeline, with their clip counts. */
export function projectUses(
	assetId: string,
	projects: readonly Project[]
): OfflineProjectUse[] {
	return projects.flatMap((project) => {
		const clipCount = project.segments.filter(
			(segment) => segment.assetId === assetId
		).length;
		return clipCount
			? [{ clipCount, projectId: project.id, title: project.title }]
			: [];
	});
}

/**
 * True when any project references the asset in any field (clips,
 * backgrounds, lip-sync, multicam, scenes, reference profile, captions).
 */
export function assetReferenced(
	assetId: string,
	projects: readonly Project[]
): boolean {
	return projects.some((project) => projectAssetIds(project).includes(assetId));
}

/** Library assets that can be offline media: not proxies, not sequences. */
function relinkableAssets(store: StudioStore): Asset[] {
	return store
		.assets()
		.filter((asset) => !(asset.sequenceProjectId || isProxyDerivative(asset)));
}

/**
 * Why `asset`'s media is offline, or `null` when it is usable. The cheap file
 * check runs first; with `probe`, a present file that FFprobe cannot read
 * is `undecodable`.
 */
async function assetOfflineReason(
	store: StudioStore,
	asset: Asset,
	options: OfflineScanOptions
): Promise<OfflineReason | null> {
	const path = store.mediaPath(asset.id);
	const reason = mediaFileState(path);
	if (reason || !options.probe) {
		return reason;
	}
	options.signal?.throwIfAborted();
	try {
		await probe(path, options.signal);
		return null;
	} catch (error) {
		if (options.signal?.aborted) {
			throw error;
		}
		return "undecodable";
	}
}

export interface OfflineScanOptions {
	/** Also run FFprobe on present files to find ones that no longer decode. */
	probe?: boolean;
	signal?: AbortSignal;
}

/** Every offline library asset, with the projects that use it. */
export async function offlineAssetReports(
	store: StudioStore,
	options: OfflineScanOptions = {}
): Promise<OfflineAssetReport[]> {
	const found = new Map<string, OfflineReason>();
	const assets = relinkableAssets(store);
	for (const asset of assets) {
		const reason = await assetOfflineReason(store, asset, options);
		if (reason) {
			found.set(asset.id, reason);
		}
	}
	const projects = store.projects();
	return assets
		.filter((asset) => found.has(asset.id))
		.map((asset) => ({
			assetId: asset.id,
			duration: asset.duration,
			kind: asset.kind,
			name: asset.name,
			projects: projectUses(asset.id, projects),
			reason: found.get(asset.id) ?? "missing",
		}));
}

export interface RelinkResult {
	asset: Asset;
	dryRun: boolean;
	/** The replacement's preview proxies, now proxies of the relinked asset. */
	proxyAssets: Asset[];
	/** The replacement's record, removed after its media moved. */
	removedAssetId: string | null;
	/** The target's preview proxies of its old media, now deleted. */
	removedProxyAssetIds: string[];
	warnings: string[];
}

function findAsset(store: StudioStore, id: string): Asset {
	const asset = store.assets().find((candidate) => candidate.id === id);
	if (!asset) {
		throw new Error("Media not found.");
	}
	return asset;
}

/**
 * Validate that `source` may replace offline `target`, returning the
 * validation warnings. Throws with a user-facing reason when it may not.
 */
async function checkRelink(
	store: StudioStore,
	target: Asset,
	source: Asset,
	projects: readonly Project[]
): Promise<string[]> {
	if (target.id === source.id) {
		throw new Error("Choose a different file to relink this media to.");
	}
	if (target.sequenceProjectId) {
		throw new Error(
			"Nested sequences are rebuilt from their project and cannot be relinked."
		);
	}
	if (isProxyDerivative(target)) {
		throw new Error(
			"A preview proxy is rebuilt from its media and cannot be relinked."
		);
	}
	if ((await assetOfflineReason(store, target, { probe: true })) === null) {
		throw studioError(
			(text) => new ConflictError(text),
			"relink.target-online",
			{ name: target.name }
		);
	}
	if (source.sequenceProjectId) {
		throw new Error("A nested sequence cannot be used as a replacement.");
	}
	if (isProxyDerivative(source)) {
		throw new Error("A preview proxy cannot be used as a replacement.");
	}
	const sourceState = mediaFileState(store.mediaPath(source.id));
	if (sourceState) {
		throw studioError((text) => new Error(text), "relink.replacement-offline", {
			name: source.name,
		});
	}
	if (assetReferenced(source.id, projects)) {
		throw studioError(
			(text) => new ConflictError(text),
			"relink.replacement-in-use",
			{ name: source.name }
		);
	}
	const validation = validateReplacement(target, source);
	if (!validation.ok) {
		throw new Error(validation.reason);
	}
	return validation.warnings;
}

function proxiesOf(assets: readonly Asset[], id: string): Asset[] {
	return assets.filter(
		(asset) => isProxyDerivative(asset) && asset.derivedFromAssetId === id
	);
}

async function moveMedia(
	store: StudioStore,
	target: Asset,
	source: Asset,
	projects: readonly Project[]
): Promise<
	Pick<RelinkResult, "asset" | "proxyAssets" | "removedProxyAssetIds">
> {
	const mediaDirectory = join(store.directory, "media");
	const next = relinkedAsset(
		target,
		source,
		requiredSourceDuration(target.id, projects)
	);
	const targetPath = store.mediaPath(target.id);
	await rm(targetPath, { force: true, recursive: true });
	await rename(store.mediaPath(source.id), targetPath);
	let committed: ReturnType<StudioStore["commitRelink"]>;
	try {
		committed = store.commitRelink(next, source.id);
	} catch (error) {
		// Put the replacement back so its own record still points at a file.
		await rename(targetPath, store.mediaPath(source.id)).catch(() => undefined);
		throw error;
	}
	// The target's old proxies encode the media that went offline; remove
	// their files so the preview can never show pre-relink media.
	for (const id of committed.removedProxyAssetIds) {
		await rm(store.mediaPath(id), { force: true, recursive: true });
		await rm(join(mediaDirectory, `${id}.jpg`), { force: true });
	}
	const sourceThumbnail = join(mediaDirectory, `${source.id}.jpg`);
	const targetThumbnail = join(mediaDirectory, `${target.id}.jpg`);
	await rm(targetThumbnail, { force: true });
	if (target.kind !== "audio") {
		await rename(sourceThumbnail, targetThumbnail).catch(() =>
			thumbnail(targetPath, mediaDirectory, target.id).catch(() => undefined)
		);
	}
	await rm(sourceThumbnail, { force: true });
	return { asset: next, ...committed };
}

/**
 * Relink offline `targetId` to the media of library asset `sourceAssetId`
 * (normally a fresh upload). The replacement must be the same kind, last
 * within ±0.5 s for timed media, and be unused by any project.
 */
export async function relinkAsset(
	store: StudioStore,
	targetId: string,
	input: RelinkRequest
): Promise<RelinkResult> {
	const target = findAsset(store, targetId);
	const source = findAsset(store, input.sourceAssetId);
	const projects = store.projects();
	const warnings = await checkRelink(store, target, source, projects);
	if (input.dryRun) {
		return {
			asset: relinkedAsset(
				target,
				source,
				requiredSourceDuration(target.id, projects)
			),
			dryRun: true,
			proxyAssets: [],
			removedAssetId: null,
			removedProxyAssetIds: [],
			warnings,
		};
	}
	return {
		...(await moveMedia(store, target, source, projects)),
		dryRun: false,
		removedAssetId: source.id,
		warnings,
	};
}

export interface RelinkBatchResult {
	dryRun: boolean;
	failures: { assetId: string; reason: string; sourceAssetId: string }[];
	matches: { assetId: string; durationDelta: number; sourceAssetId: string }[];
	relinked: RelinkResult[];
	unmatched: { assetId: string; reason: string }[];
	unusedSourceAssetIds: string[];
}

/**
 * Batch relink: pair offline assets with uploaded replacements by file name
 * and duration, then relink each pair. The candidates are `targetAssetIds`
 * when given (a probed report, so damaged files are included; each is
 * re-checked before its relink), otherwise every asset whose file is
 * missing or unreadable. Replacements that matched nothing are left in the
 * library for the caller to keep or delete.
 */
export async function relinkBatch(
	store: StudioStore,
	input: RelinkBatchRequest
): Promise<RelinkBatchResult> {
	const assets = store.assets();
	const sourceIds = [...new Set(input.sourceAssetIds)];
	const sources = sourceIds.map((id) => {
		const source = assets.find((candidate) => candidate.id === id);
		if (!source) {
			throw new Error("A replacement was not found in the library.");
		}
		return source;
	});
	const sourceSet = new Set(sourceIds);
	const targetSet = input.targetAssetIds && new Set(input.targetAssetIds);
	const offline = (
		targetSet
			? relinkableAssets(store).filter((asset) => targetSet.has(asset.id))
			: store.offlineAssets().map(({ asset }) => asset)
	).filter((asset) => !sourceSet.has(asset.id));
	const plan = matchRelinkBatch(offline, sources);
	const result: RelinkBatchResult = {
		dryRun: input.dryRun === true,
		failures: [],
		matches: plan.matches,
		relinked: [],
		unmatched: plan.unmatched,
		unusedSourceAssetIds: plan.unusedSourceAssetIds,
	};
	for (const match of plan.matches) {
		try {
			result.relinked.push(
				await relinkAsset(store, match.assetId, {
					dryRun: input.dryRun,
					sourceAssetId: match.sourceAssetId,
				})
			);
		} catch (error) {
			result.failures.push({
				assetId: match.assetId,
				reason: error instanceof Error ? error.message : String(error),
				sourceAssetId: match.sourceAssetId,
			});
		}
	}
	return result;
}
