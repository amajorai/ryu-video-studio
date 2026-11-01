/**
 * Offline media and relink (G37). Pure and deterministic: the sidecar decides
 * which stored media files are missing or unreadable, then uses these helpers
 * to validate a replacement, match a batch of replacements by file name and
 * duration, and build the relinked asset record.
 *
 * Media is app-owned, so an offline asset means the store was damaged or a
 * package import was partial. A relink keeps the asset id, so every clip,
 * transcript, analysis and caption that points at it stays attached.
 */
import { z } from "zod";
import { type Asset, idSchema, type Project } from "./project.ts";

/** Largest duration difference a replacement may have, in seconds. */
export const RELINK_DURATION_TOLERANCE_SECONDS = 0.5;
/** Replacements one batch relink accepts. */
export const MAX_RELINK_BATCH = 200;

/** Why a stored media file cannot be used. */
export const offlineReasonSchema = z.enum([
	"missing",
	"empty",
	"not-a-file",
	"unreadable",
	"undecodable",
]);
export type OfflineReason = z.infer<typeof offlineReasonSchema>;

export const OFFLINE_REASON_LABELS: Record<OfflineReason, string> = {
	empty: "The stored media file is empty.",
	missing: "The stored media file is missing.",
	"not-a-file": "The stored media path is not a file.",
	undecodable: "The stored media file cannot be decoded.",
	unreadable: "The stored media file cannot be read.",
};

export const offlineProjectUseSchema = z
	.object({
		clipCount: z.number().int().nonnegative(),
		projectId: idSchema,
		title: z.string(),
	})
	.strict();
export type OfflineProjectUse = z.infer<typeof offlineProjectUseSchema>;

export const offlineAssetReportSchema = z
	.object({
		assetId: idSchema,
		duration: z.number().finite().nonnegative(),
		kind: z.enum(["video", "audio", "image"]),
		name: z.string(),
		projects: z.array(offlineProjectUseSchema),
		reason: offlineReasonSchema,
	})
	.strict();
export type OfflineAssetReport = z.infer<typeof offlineAssetReportSchema>;

/** `POST /assets/:id/relink`: relink one offline asset to an uploaded file. */
export const relinkRequestSchema = z
	.object({
		/** Validate only; nothing is moved or deleted. */
		dryRun: z.boolean().optional(),
		/** A library asset (normally a fresh upload) that holds the replacement. */
		sourceAssetId: idSchema,
	})
	.strict();
export type RelinkRequest = z.infer<typeof relinkRequestSchema>;

/** `POST /relink`: match uploaded replacements to offline assets and relink. */
export const relinkBatchRequestSchema = z
	.object({
		dryRun: z.boolean().optional(),
		sourceAssetIds: z.array(idSchema).min(1).max(MAX_RELINK_BATCH),
		/**
		 * Offline assets to match, normally the ids of a probed
		 * `GET /offline-assets?probe=1` report so damaged (undecodable) files
		 * are included. Omitted, every asset whose file is missing or
		 * unreadable is a candidate.
		 */
		targetAssetIds: z.array(idSchema).min(1).max(MAX_RELINK_BATCH).optional(),
	})
	.strict();
export type RelinkBatchRequest = z.infer<typeof relinkBatchRequestSchema>;

/** The parts of an asset a replacement is validated against. */
export type RelinkCandidate = Pick<Asset, "duration" | "kind" | "name">;

export type RelinkValidation =
	| { ok: true; warnings: string[] }
	| { ok: false; reason: string };

function formatSeconds(value: number): string {
	return `${Math.round(value * 100) / 100} s`;
}

/**
 * Check that `candidate` can stand in for `target`: the same kind of media
 * and, for timed media, a duration within the tolerance. Images have no
 * meaningful duration. Lost audio or a changed frame size is allowed with a
 * warning, since clips keep their own transform.
 */
export function validateReplacement(
	target: Asset,
	candidate: RelinkCandidate &
		Partial<Pick<Asset, "hasAudio" | "height" | "width">>
): RelinkValidation {
	if (target.sequenceProjectId) {
		return {
			ok: false,
			reason:
				"Nested sequences are rebuilt from their project and cannot be relinked.",
		};
	}
	if (candidate.kind !== target.kind) {
		return {
			ok: false,
			reason: `"${target.name}" is ${target.kind} media; the replacement is ${candidate.kind}.`,
		};
	}
	if (target.kind !== "image") {
		const delta = Math.abs(candidate.duration - target.duration);
		if (delta > RELINK_DURATION_TOLERANCE_SECONDS) {
			return {
				ok: false,
				reason: `"${target.name}" lasts ${formatSeconds(target.duration)}; the replacement lasts ${formatSeconds(candidate.duration)} (allowed difference ${formatSeconds(RELINK_DURATION_TOLERANCE_SECONDS)}).`,
			};
		}
	}
	const warnings: string[] = [];
	if (target.hasAudio && candidate.hasAudio === false) {
		warnings.push("The replacement has no audio, so its clips will be silent.");
	}
	if (
		target.kind !== "audio" &&
		candidate.width !== undefined &&
		candidate.height !== undefined &&
		(candidate.width !== target.width || candidate.height !== target.height)
	) {
		warnings.push(
			`The frame size changes from ${target.width}x${target.height} to ${candidate.width}x${candidate.height}.`
		);
	}
	return { ok: true, warnings };
}

/**
 * Comparable file-name stem: lower case, no directory, no extension, no
 * trailing copy marker such as " (2)" or " copy", and collapsed separators.
 */
export function relinkNameKey(name: string): string {
	const base = name.split(/[\\/]/).at(-1) ?? name;
	const dot = base.lastIndexOf(".");
	const stem = dot > 0 ? base.slice(0, dot) : base;
	return stem
		.toLowerCase()
		.replace(/(?:\s*\(\d+\)|[\s_-]+copy(?:\s*\d+)?)$/u, "")
		.replace(/[\s_.-]+/gu, " ")
		.trim();
}

export interface RelinkMatch {
	assetId: string;
	durationDelta: number;
	sourceAssetId: string;
}

export interface RelinkSkip {
	assetId: string;
	reason: string;
}

export interface RelinkBatchPlan {
	matches: RelinkMatch[];
	/** Offline assets with no acceptable replacement, with the reason. */
	unmatched: RelinkSkip[];
	/** Replacements that no offline asset used. */
	unusedSourceAssetIds: string[];
}

/**
 * Pair offline assets with replacements by file name, then duration. Each
 * replacement is used once. Pairs are assigned globally by the smallest
 * duration difference (ties by offline order, then replacement order), so
 * the result does not depend on which offline asset is considered first.
 */
export function matchRelinkBatch(
	offline: readonly Asset[],
	sources: readonly (RelinkCandidate & { id: string })[]
): RelinkBatchPlan {
	const pairs: (RelinkMatch & { offlineIndex: number; sourceIndex: number })[] =
		[];
	const reasons = new Map<string, string>();
	for (const [offlineIndex, asset] of offline.entries()) {
		const key = relinkNameKey(asset.name);
		const named = sources
			.map((source, sourceIndex) => ({ source, sourceIndex }))
			.filter(({ source }) => relinkNameKey(source.name) === key);
		if (!named.length) {
			reasons.set(asset.id, `No replacement is named like "${asset.name}".`);
			continue;
		}
		for (const { source, sourceIndex } of named) {
			const validation = validateReplacement(asset, source);
			if (!validation.ok) {
				reasons.set(asset.id, validation.reason);
				continue;
			}
			pairs.push({
				assetId: asset.id,
				durationDelta:
					asset.kind === "image"
						? 0
						: Math.abs(source.duration - asset.duration),
				offlineIndex,
				sourceAssetId: source.id,
				sourceIndex,
			});
		}
	}
	pairs.sort(
		(a, b) =>
			a.durationDelta - b.durationDelta ||
			a.offlineIndex - b.offlineIndex ||
			a.sourceIndex - b.sourceIndex
	);
	const usedAssets = new Set<string>();
	const usedSources = new Set<string>();
	const matches: RelinkMatch[] = [];
	for (const pair of pairs) {
		if (usedAssets.has(pair.assetId) || usedSources.has(pair.sourceAssetId)) {
			continue;
		}
		usedAssets.add(pair.assetId);
		usedSources.add(pair.sourceAssetId);
		matches.push({
			assetId: pair.assetId,
			durationDelta: pair.durationDelta,
			sourceAssetId: pair.sourceAssetId,
		});
	}
	const order = new Map(offline.map((asset, index) => [asset.id, index]));
	matches.sort(
		(a, b) => (order.get(a.assetId) ?? 0) - (order.get(b.assetId) ?? 0)
	);
	return {
		matches,
		unmatched: offline
			.filter((asset) => !usedAssets.has(asset.id))
			.map((asset) => ({
				assetId: asset.id,
				reason:
					reasons.get(asset.id) ??
					`Every replacement named like "${asset.name}" was used by another offline asset.`,
			})),
		unusedSourceAssetIds: sources
			.filter((source) => !usedSources.has(source.id))
			.map((source) => source.id),
	};
}

/** Latest source time any clip in `projects` reads from `assetId`. */
export function requiredSourceDuration(
	assetId: string,
	projects: readonly Project[]
): number {
	let required = 0;
	for (const project of projects) {
		for (const segment of project.segments) {
			if (segment.assetId === assetId) {
				required = Math.max(required, segment.sourceOut);
			}
		}
	}
	return required;
}

/**
 * The asset record after a relink: the target's identity, name, folder,
 * provenance and timecode, with the replacement's probed media properties.
 * The duration follows the replacement unless a clip already reads past its
 * end, in which case the original duration is kept so saved trims stay
 * valid (the render then ends that clip at the file's end).
 */
export function relinkedAsset(
	target: Asset,
	source: Asset,
	requiredDuration: number
): Asset {
	const {
		colorTransfer: _colorTransfer,
		frameRate: _frameRate,
		...kept
	} = target;
	const next: Asset = {
		...kept,
		duration:
			target.kind === "image" || requiredDuration <= source.duration + 0.05
				? source.duration
				: target.duration,
		hasAudio: source.hasAudio,
		height: source.height,
		width: source.width,
	};
	if (source.frameRate !== undefined) {
		next.frameRate = source.frameRate;
	}
	if (source.colorTransfer !== undefined) {
		next.colorTransfer = source.colorTransfer;
	}
	return next;
}

/** True for an app-owned preview proxy, which is never offline media. */
export function isProxyDerivative(asset: Pick<Asset, "derivation">): boolean {
	return asset.derivation === "proxy";
}

/**
 * Every library asset a render of `project` itself reads: clip media, the
 * project and per-clip canvas background images, and avatar lip-sync audio.
 */
export function projectRenderAssetIds(project: Project): string[] {
	const ids = new Set<string>();
	const addBackground = (background: Project["background"]) => {
		if (background?.type === "image") {
			ids.add(background.assetId);
		}
	};
	addBackground(project.background);
	for (const segment of project.segments) {
		ids.add(segment.assetId);
		addBackground(segment.background);
	}
	for (const avatar of project.avatars) {
		if (avatar.lipSync) {
			ids.add(avatar.lipSync.assetId);
		}
	}
	return [...ids];
}

/**
 * Every library asset `project` references in any field: what the render
 * reads plus multicam members, scene media, the reference profile and
 * caption sources. An asset in this set must never be consumed by a relink.
 */
export function projectAssetIds(project: Project): string[] {
	const ids = new Set(projectRenderAssetIds(project));
	for (const group of project.multicamGroups) {
		ids.add(group.masterAssetId);
		for (const member of group.members) {
			ids.add(member.assetId);
		}
	}
	for (const scene of project.scenes) {
		for (const id of scene.assetIds) {
			ids.add(id);
		}
	}
	if (project.referenceProfile) {
		ids.add(project.referenceProfile.assetId);
	}
	const addCaptions = (captions: Project["captions"]) => {
		for (const caption of captions) {
			if (caption.sourceAssetId) {
				ids.add(caption.sourceAssetId);
			}
		}
	};
	addCaptions(project.captions);
	for (const track of project.captionTracks) {
		addCaptions(track.captions);
	}
	return [...ids];
}

/**
 * Every asset a render of `projectId` reads (see `projectRenderAssetIds`)
 * plus, through nested sequence assets, what the projects they are built
 * from read. Sequence assets themselves are rebuilt during the render, so
 * they are not listed. Cycles and unknown projects are ignored.
 */
export function renderedAssetIds(
	projectId: string,
	projects: readonly Project[],
	assets: readonly Asset[]
): string[] {
	const byProject = new Map(projects.map((project) => [project.id, project]));
	const byAsset = new Map(assets.map((asset) => [asset.id, asset]));
	const result = new Set<string>();
	const visited = new Set<string>();
	const visit = (id: string) => {
		if (visited.has(id)) {
			return;
		}
		visited.add(id);
		const project = byProject.get(id);
		if (!project) {
			return;
		}
		for (const assetId of projectRenderAssetIds(project)) {
			const sequenceProjectId = byAsset.get(assetId)?.sequenceProjectId;
			if (sequenceProjectId) {
				visit(sequenceProjectId);
			} else {
				result.add(assetId);
			}
		}
	};
	visit(projectId);
	return [...result];
}

/** Message used when a render is refused because media is offline. */
export function offlineRenderMessage(names: readonly string[]): string {
	const shown = names.slice(0, 5).map((name) => `"${name}"`);
	const more = names.length > 5 ? ` and ${names.length - 5} more` : "";
	return `Relink offline media before exporting: ${shown.join(", ")}${more}.`;
}
