/**
 * Visual shot analysis for media search.
 *
 * One FFmpeg pass decodes the first video stream at a low frame rate into
 * 32x18 rgb24 frames; `shotStatsFromFrames` (shared, pure) turns them into
 * per-shot colors, brightness, motion and labels over the scene cuts of the
 * completed source analysis. Results and the Spaces projection state live in
 * `<data>/shots/<assetId>.json` and `<assetId>.space.json`.
 */
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { frameAtTime } from "../../shared/generation-inputs.ts";
import type { Asset } from "../../shared/project.ts";
import {
	beginShotSearchIndex,
	pruneShotSearchEntry,
	SearchIndexConflictError,
	type ShotSearchIndex,
	shotSearchIndexSchema,
	updateShotSearchEntry,
} from "../../shared/search-index.ts";
import {
	applyShotDescriptions,
	SHOT_FRAME_BYTES,
	SHOT_FRAME_HEIGHT,
	SHOT_FRAME_WIDTH,
	type ShotDescriptionBatch,
	type ShotIndex,
	searchShots,
	shotIndexSchema,
	shotRanges,
	shotSampleRate,
	shotStatsFromFrames,
} from "../../shared/shot-index.ts";
import { prepareKeyframe, takeGenerationInput } from "./generation-inputs.ts";
import { MEDIA_FORMATS, runMedia } from "./media.ts";
import { type MediaOperation, withMediaOperation } from "./media-operation.ts";
import { ConflictError, type StudioStore } from "./store.ts";

const OPERATION_TIMEOUT_MS = 10 * 60_000;
const assetIdPattern =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

function shotsDirectory(store: StudioStore): string {
	const directory = join(store.directory, "shots");
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	return directory;
}

function shotFile(store: StudioStore, assetId: string, suffix: string) {
	if (!assetIdPattern.test(assetId)) {
		throw new Error("Invalid media id.");
	}
	return join(shotsDirectory(store), `${assetId}${suffix}`);
}

function readJson(path: string): unknown {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return null;
	}
}

/** Write through a temporary file and rename, so readers never see a partial file. */
function writeJson(path: string, value: unknown) {
	const temporary = `${path}.${crypto.randomUUID()}.tmp`;
	writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
	renameSync(temporary, path);
}

export function readShotIndex(
	store: StudioStore,
	assetId: string
): ShotIndex | null {
	const parsed = shotIndexSchema.safeParse(
		readJson(shotFile(store, assetId, ".json"))
	);
	return parsed.success && parsed.data.assetId === assetId ? parsed.data : null;
}

/** True while the shot index still matches the asset's completed analysis. */
export function shotIndexIsCurrent(
	store: StudioStore,
	index: ShotIndex
): boolean {
	const analysis = store.analysis(index.assetId);
	return (
		analysis?.status === "completed" &&
		analysis.createdAt === index.analysisCreatedAt &&
		store.assets().some((asset) => asset.id === index.assetId)
	);
}

export function readShotSearchIndex(
	store: StudioStore,
	assetId: string
): ShotSearchIndex | null {
	const parsed = shotSearchIndexSchema.safeParse(
		readJson(shotFile(store, assetId, ".space.json"))
	);
	return parsed.success && parsed.data.assetId === assetId ? parsed.data : null;
}

function writeShotSearchIndex(store: StudioStore, index: ShotSearchIndex) {
	writeJson(shotFile(store, index.assetId, ".space.json"), index);
	return index;
}

/** Every stored shot-to-Spaces projection, with whether it is current. */
export function shotSearchIndexes(
	store: StudioStore
): Array<ShotSearchIndex & { current: boolean }> {
	const results: Array<ShotSearchIndex & { current: boolean }> = [];
	for (const name of readdirSync(shotsDirectory(store)).sort()) {
		const assetId = name.endsWith(".space.json")
			? name.slice(0, -".space.json".length)
			: "";
		if (!assetIdPattern.test(assetId)) {
			continue;
		}
		const index = readShotSearchIndex(store, assetId);
		if (!index) {
			continue;
		}
		const shots = readShotIndex(store, assetId);
		results.push({
			...index,
			current: Boolean(
				shots &&
					shots.revision === index.shotsRevision &&
					shotIndexIsCurrent(store, shots)
			),
		});
	}
	return results;
}

/** Every current shot index; used by local label search. */
export function currentShotIndexes(store: StudioStore): ShotIndex[] {
	const indexes: ShotIndex[] = [];
	for (const asset of store.assets()) {
		const index = readShotIndex(store, asset.id);
		if (index && shotIndexIsCurrent(store, index)) {
			indexes.push(index);
		}
	}
	return indexes;
}

/** Decode the first video stream to packed 32x18 rgb24 frames. */
export async function decodeShotFrames(
	store: StudioStore,
	asset: Asset,
	sampleRate: number,
	operation: MediaOperation
): Promise<Uint8Array[]> {
	const seconds = Math.min(7200, Math.max(0, asset.duration));
	const directory = mkdtempSync(join(store.directory, "shots-"));
	try {
		const output = join(directory, "frames.rgb");
		const expected = Math.ceil(seconds * sampleRate) + 2;
		await runMedia(
			[
				"-hide_banner",
				"-loglevel",
				"error",
				"-nostdin",
				"-y",
				"-protocol_whitelist",
				"file,pipe",
				"-format_whitelist",
				MEDIA_FORMATS,
				"-i",
				store.mediaPath(asset.id),
				"-t",
				seconds.toFixed(6),
				"-map",
				"0:v:0",
				"-an",
				"-sn",
				"-dn",
				"-vf",
				`fps=${sampleRate},scale=${SHOT_FRAME_WIDTH}:${SHOT_FRAME_HEIGHT}:flags=area,format=rgb24`,
				"-f",
				"rawvideo",
				output,
			],
			{
				maxOutputBytes: expected * SHOT_FRAME_BYTES + 65_536,
				outputPath: output,
				signal: operation.signal,
				timeoutMs: operation.remainingMs(),
			}
		);
		const bytes = new Uint8Array(await Bun.file(output).arrayBuffer());
		const frames: Uint8Array[] = [];
		for (
			let offset = 0;
			offset + SHOT_FRAME_BYTES <= bytes.length;
			offset += SHOT_FRAME_BYTES
		) {
			frames.push(bytes.subarray(offset, offset + SHOT_FRAME_BYTES));
		}
		return frames;
	} finally {
		rmSync(directory, { force: true, recursive: true });
	}
}

/** Concurrent requests for one asset share a single analysis. */
const inFlight = new WeakMap<StudioStore, Map<string, Promise<ShotIndex>>>();

/**
 * Shot statistics for a video with completed scene analysis: the stored
 * index while it matches that analysis, otherwise a fresh decode.
 */
export async function analyzeShots(
	store: StudioStore,
	asset: Asset,
	options: { refresh?: boolean; signal?: AbortSignal } = {}
): Promise<ShotIndex> {
	if (asset.kind !== "video") {
		throw new Error("Visual shot search indexes video sources only.");
	}
	const analysis = store.analysis(asset.id);
	if (analysis?.status !== "completed") {
		throw new Error("Complete source analysis before indexing shots.");
	}
	const stored = readShotIndex(store, asset.id);
	if (
		stored &&
		!options.refresh &&
		stored.analysisCreatedAt === analysis.createdAt
	) {
		return stored;
	}
	const pending = inFlight.get(store) ?? new Map<string, Promise<ShotIndex>>();
	inFlight.set(store, pending);
	const running = pending.get(asset.id);
	if (running) {
		return await running;
	}
	const work = withMediaOperation(
		OPERATION_TIMEOUT_MS,
		{ signal: options.signal },
		async (operation) => {
			const ranges = shotRanges(analysis.sceneCuts, analysis.duration);
			const sampleRate = shotSampleRate(analysis.duration);
			const frames = await decodeShotFrames(
				store,
				asset,
				sampleRate,
				operation
			);
			operation.check();
			const shots = shotStatsFromFrames(frames, sampleRate, ranges);
			const latest = store.analysis(asset.id);
			if (latest?.createdAt !== analysis.createdAt) {
				throw new ConflictError(
					"Source analysis changed while shots were measured. Try again."
				);
			}
			const index = shotIndexSchema.parse({
				format: "ryu.video-studio.shots.v1",
				assetId: asset.id,
				analysisCreatedAt: analysis.createdAt,
				revision: (readShotIndex(store, asset.id)?.revision ?? -1) + 1,
				sampleRate,
				shots,
				updatedAt: new Date().toISOString(),
			});
			writeJson(shotFile(store, asset.id, ".json"), index);
			return index;
		}
	);
	pending.set(asset.id, work);
	try {
		return await work;
	} finally {
		pending.delete(asset.id);
	}
}

function currentShotsFor(store: StudioStore, asset: Asset): ShotIndex {
	const shots = readShotIndex(store, asset.id);
	if (!(shots && shotIndexIsCurrent(store, shots))) {
		throw new Error("Analyze shots for the current source analysis first.");
	}
	return shots;
}

function conflictAware<T>(run: () => T): T {
	try {
		return run();
	} catch (error) {
		if (error instanceof SearchIndexConflictError) {
			throw new ConflictError(error.message);
		}
		throw error;
	}
}

export function beginShotIndexing(
	store: StudioStore,
	asset: Asset,
	space: { rebuild: boolean; spaceId: string; spaceName: string }
): ShotSearchIndex {
	const shots = currentShotsFor(store, asset);
	const previous = readShotSearchIndex(store, asset.id);
	const next = beginShotSearchIndex(previous, asset, shots, space);
	return next === previous ? next : writeShotSearchIndex(store, next);
}

export function updateShotIndexEntry(
	store: StudioStore,
	asset: Asset,
	change: { docId: string; key: string; ready: boolean; revision: number }
): ShotSearchIndex {
	const shots = currentShotsFor(store, asset);
	const index = readShotSearchIndex(store, asset.id);
	if (!index || index.shotsRevision !== shots.revision) {
		throw new ConflictError(
			"The shot index changed. Resume indexing from its current state."
		);
	}
	return writeShotSearchIndex(
		store,
		conflictAware(() => updateShotSearchEntry(index, change))
	);
}

export function pruneShotIndexEntry(
	store: StudioStore,
	asset: Asset,
	change: { docId: string; revision: number }
): ShotSearchIndex {
	const index = readShotSearchIndex(store, asset.id);
	if (!index) {
		throw new ConflictError("The shot index changed during cleanup.");
	}
	return writeShotSearchIndex(
		store,
		conflictAware(() => pruneShotSearchEntry(index, change))
	);
}

/** Label search over current shot indexes, with asset names attached. */
export function searchStoredShots(
	store: StudioStore,
	query: string,
	options: { assetId?: string; limit?: number } = {}
) {
	const names = new Map(store.assets().map((asset) => [asset.id, asset.name]));
	const found = searchShots(currentShotIndexes(store), query, options);
	return {
		query,
		labels: found.labels,
		excluded: found.excluded,
		ignored: found.ignored,
		textTerms: found.textTerms,
		results: found.results.map((match) => ({
			...match,
			assetName: names.get(match.assetId) ?? "Missing media",
		})),
	};
}

/** One shot keyframe for a vision model, inline as a small JPEG. */
export interface ShotKeyframe {
	end: number;
	frame: number;
	/** `data:image/jpeg;base64,…`, at most 384 px on its long side. */
	image: string;
	index: number;
	start: number;
}

/**
 * JPEG keyframes (the middle frame of each shot) for shots `offset` to
 * `offset + limit` of a current shot index, for a vision model batch (G76).
 */
export async function shotKeyframes(
	store: StudioStore,
	asset: Asset,
	range: { limit: number; offset: number },
	options: { signal?: AbortSignal } = {}
): Promise<{
	analysisCreatedAt: string;
	keyframes: ShotKeyframe[];
	revision: number;
	total: number;
}> {
	const shots = currentShotsFor(store, asset);
	const picked = shots.shots.slice(range.offset, range.offset + range.limit);
	return await withMediaOperation(
		OPERATION_TIMEOUT_MS,
		{ signal: options.signal },
		async (operation) => {
			const keyframes: ShotKeyframe[] = [];
			for (const [position, shot] of picked.entries()) {
				operation.check();
				const frame = frameAtTime(asset, (shot.start + shot.end) / 2);
				const prepared = await prepareKeyframe(store, asset, frame, {
					operation,
				});
				const bytes = await takeGenerationInput(prepared.id);
				keyframes.push({
					end: shot.end,
					frame,
					image: `data:image/jpeg;base64,${Buffer.from(bytes).toString("base64")}`,
					index: range.offset + position,
					start: shot.start,
				});
			}
			return {
				analysisCreatedAt: shots.analysisCreatedAt,
				keyframes,
				revision: shots.revision,
				total: shots.shots.length,
			};
		}
	);
}

/**
 * Store vision captions and tags on a current shot index. The request names
 * the analysis and revision it described, so descriptions of an older index
 * are refused instead of landing on different shots.
 */
export function describeStoredShots(
	store: StudioStore,
	asset: Asset,
	input: {
		analysisCreatedAt: string;
		model: string;
		provider: string;
		revision: number;
		shots: ShotDescriptionBatch["shots"];
	}
): ShotIndex {
	const shots = currentShotsFor(store, asset);
	if (
		shots.revision !== input.revision ||
		shots.analysisCreatedAt !== input.analysisCreatedAt
	) {
		throw new ConflictError(
			"The shot index changed. Describe the current shots again."
		);
	}
	if (input.shots.some((shot) => shot.index >= shots.shots.length)) {
		throw new Error("A description names a shot this index does not have.");
	}
	const next = applyShotDescriptions(shots, input.shots, {
		model: input.model,
		provider: input.provider,
	});
	writeJson(shotFile(store, asset.id, ".json"), next);
	return next;
}
