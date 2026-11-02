import { z } from "zod";
import type { Asset } from "./project.ts";
import { describeShot, MAX_SHOTS, type ShotIndex } from "./shot-index.ts";
import type { Transcript } from "./transcript.ts";

export const searchDocumentSchema = z
	.object({
		format: z.literal("ryu.video-studio.transcript.v1"),
		assetId: z.uuid(),
		transcriptRevision: z.number().int().nonnegative(),
		start: z.number().min(0).max(7200),
		end: z.number().min(0).max(7200),
		text: z.string().min(1).max(8000),
	})
	.strict();
export const indexEntrySchema = z
	.object({
		key: z.string().min(1).max(100),
		title: z.string().min(1).max(300),
		source: z.string().max(12_000),
		docId: z.string().min(1).max(200).nullable(),
		ready: z.boolean(),
	})
	.strict();
export const searchIndexSchema = z
	.object({
		assetId: z.uuid(),
		spaceId: z.string().min(1).max(200),
		spaceName: z.string().min(1).max(200),
		transcriptRevision: z.number().int().nonnegative(),
		revision: z.number().int().nonnegative(),
		entries: z.array(indexEntrySchema).max(400),
		obsolete: z.array(indexEntrySchema).max(800),
		updatedAt: z.iso.datetime(),
	})
	.strict();
export type SearchIndex = z.infer<typeof searchIndexSchema>;
export type SearchDocument = z.infer<typeof searchDocumentSchema>;
export function transcriptDocuments(asset: Asset, transcript: Transcript) {
	if (transcript.status !== "completed" || !transcript.cues.length) {
		throw new Error("Complete or import a source transcript before indexing.");
	}
	const groups: SearchDocument[] = [];
	for (const cue of [...transcript.cues].sort((a, b) => a.start - b.start)) {
		const last = groups.at(-1);
		if (
			last &&
			cue.end - last.start <= 30 &&
			last.text.length + cue.text.length < 8000
		) {
			last.end = Math.max(last.end, cue.end);
			last.text += `\n${cue.text}`;
		} else {
			groups.push({
				format: "ryu.video-studio.transcript.v1",
				assetId: asset.id,
				transcriptRevision: transcript.revision,
				start: cue.start,
				end: cue.end,
				text: cue.text,
			});
		}
	}
	if (groups.length > 400) {
		throw new Error("This transcript exceeds the searchable segment limit.");
	}
	return groups.map((group, index) => ({
		key: `${transcript.revision}:${index}`,
		title: `${asset.name} · ${group.start.toFixed(1)}–${group.end.toFixed(1)}s`,
		source: JSON.stringify(group),
		docId: null,
		ready: false,
	}));
}
export function verifiedSearchDocument(
	index: SearchIndex,
	docId: string,
	source: string
): SearchDocument | null {
	const entry = index.entries.find(
		(value) => value.ready && value.docId === docId
	);
	if (!entry || entry.source !== source) {
		return null;
	}
	let value: unknown;
	try {
		value = JSON.parse(source);
	} catch {
		return null;
	}
	const parsed = searchDocumentSchema.safeParse(value);
	if (
		!parsed.success ||
		parsed.data.assetId !== index.assetId ||
		parsed.data.transcriptRevision !== index.transcriptRevision ||
		parsed.data.end <= parsed.data.start
	) {
		return null;
	}
	return parsed.data;
}

/**
 * Visual shot documents. Each indexed shot becomes one app-owned Spaces
 * document whose text lists its labels and dominant colors, so Spaces search
 * finds moments like "dark blue motion" next to transcript matches.
 */
export const shotSearchDocumentSchema = z
	.object({
		format: z.literal("ryu.video-studio.shot.v1"),
		assetId: z.uuid(),
		shotsRevision: z.number().int().nonnegative(),
		start: z.number().min(0).max(7200),
		end: z.number().min(0).max(7200),
		labels: z.array(z.string().min(1).max(40)).max(24),
		text: z.string().min(1).max(8000),
	})
	.strict();
export type ShotSearchDocument = z.infer<typeof shotSearchDocumentSchema>;

export const shotSearchIndexSchema = z
	.object({
		assetId: z.uuid(),
		spaceId: z.string().min(1).max(200),
		spaceName: z.string().min(1).max(200),
		shotsRevision: z.number().int().nonnegative(),
		revision: z.number().int().nonnegative(),
		entries: z.array(indexEntrySchema).max(MAX_SHOTS),
		obsolete: z.array(indexEntrySchema).max(MAX_SHOTS * 2),
		updatedAt: z.iso.datetime(),
	})
	.strict();
export type ShotSearchIndex = z.infer<typeof shotSearchIndexSchema>;
export type IndexEntry = z.infer<typeof indexEntrySchema>;

/** A stale revision or a foreign document; the sidecar answers 409. */
export class SearchIndexConflictError extends Error {}

/** Index entries for every shot of a current shot index. */
export function shotDocuments(asset: Asset, shots: ShotIndex): IndexEntry[] {
	if (shots.assetId !== asset.id) {
		throw new Error("The shot index belongs to another source.");
	}
	if (!shots.shots.length) {
		throw new Error("Analyze shots before indexing them.");
	}
	return shots.shots.map((shot, index) => {
		const document: ShotSearchDocument = {
			format: "ryu.video-studio.shot.v1",
			assetId: asset.id,
			shotsRevision: shots.revision,
			start: shot.start,
			end: shot.end,
			labels: shot.labels,
			text: describeShot(shot, index, shots.shots.length),
		};
		return {
			key: `shot:${shots.revision}:${index}`,
			title: `${asset.name} · shot ${index + 1} · ${shot.start.toFixed(1)}–${shot.end.toFixed(1)}s`,
			source: JSON.stringify(shotSearchDocumentSchema.parse(document)),
			docId: null,
			ready: false,
		};
	});
}

/**
 * Start (or resume) projecting a shot index into a Space. Returns the
 * previous index unchanged when it already covers this shot revision and
 * Space; otherwise every mapped document moves to `obsolete` for cleanup.
 */
export function beginShotSearchIndex(
	previous: ShotSearchIndex | null,
	asset: Asset,
	shots: ShotIndex,
	space: { rebuild: boolean; spaceId: string; spaceName: string },
	now = new Date().toISOString()
): ShotSearchIndex {
	if (
		!space.rebuild &&
		previous &&
		previous.shotsRevision === shots.revision &&
		previous.spaceId === space.spaceId
	) {
		return previous;
	}
	return shotSearchIndexSchema.parse({
		assetId: asset.id,
		spaceId: space.spaceId,
		spaceName: space.spaceName,
		shotsRevision: shots.revision,
		revision: (previous?.revision ?? -1) + 1,
		entries: shotDocuments(asset, shots),
		obsolete: [
			...(previous?.obsolete ?? []),
			...(previous?.entries.filter((entry) => entry.docId) ?? []),
		].slice(-MAX_SHOTS * 2),
		updatedAt: now,
	});
}

/** Record a Spaces document for one entry; revision-checked. */
export function updateShotSearchEntry(
	index: ShotSearchIndex,
	change: { docId: string; key: string; ready: boolean; revision: number },
	now = new Date().toISOString()
): ShotSearchIndex {
	if (index.revision !== change.revision) {
		throw new SearchIndexConflictError(
			"The shot index changed. Resume indexing from its current state."
		);
	}
	const entry = index.entries.find((value) => value.key === change.key);
	if (!entry) {
		throw new Error("Index entry not found.");
	}
	if (entry.docId && entry.docId !== change.docId) {
		throw new SearchIndexConflictError(
			"This index entry already belongs to another document."
		);
	}
	if (
		index.entries.some(
			(value) => value.key !== change.key && value.docId === change.docId
		)
	) {
		throw new Error("A document cannot represent two index entries.");
	}
	return shotSearchIndexSchema.parse({
		...index,
		revision: index.revision + 1,
		entries: index.entries.map((value) =>
			value.key === change.key
				? { ...value, docId: change.docId, ready: change.ready }
				: value
		),
		updatedAt: now,
	});
}

/** Forget an obsolete document after the client deleted it; revision-checked. */
export function pruneShotSearchEntry(
	index: ShotSearchIndex,
	change: { docId: string; revision: number },
	now = new Date().toISOString()
): ShotSearchIndex {
	if (index.revision !== change.revision) {
		throw new SearchIndexConflictError(
			"The shot index changed during cleanup."
		);
	}
	return shotSearchIndexSchema.parse({
		...index,
		revision: index.revision + 1,
		obsolete: index.obsolete.filter((entry) => entry.docId !== change.docId),
		updatedAt: now,
	});
}

/** Parse a Spaces document that must match a ready entry of a shot index. */
export function verifiedShotDocument(
	index: ShotSearchIndex,
	docId: string,
	source: string
): ShotSearchDocument | null {
	const entry = index.entries.find(
		(value) => value.ready && value.docId === docId
	);
	if (!entry || entry.source !== source) {
		return null;
	}
	let value: unknown;
	try {
		value = JSON.parse(source);
	} catch {
		return null;
	}
	const parsed = shotSearchDocumentSchema.safeParse(value);
	if (
		!parsed.success ||
		parsed.data.assetId !== index.assetId ||
		parsed.data.shotsRevision !== index.shotsRevision ||
		parsed.data.end <= parsed.data.start
	) {
		return null;
	}
	return parsed.data;
}
