import { Database } from "bun:sqlite";
import {
	chmodSync,
	type Dirent,
	lstatSync,
	mkdirSync,
	readdirSync,
	rmSync,
	statSync,
	unlinkSync,
} from "node:fs";
import { join } from "node:path";
import {
	type RowIds,
	type SealedColumn,
	StoreSeal,
} from "@ryu/sidecar-runtime/content-seal";
import type { PluginKeys } from "@ryu/sidecar-runtime/seal";
import { z } from "zod";
import { analysisSchema, type MediaAnalysis } from "../../shared/analysis.ts";
import { pruneDanglingLipSync } from "../../shared/avatar-lipsync.ts";
import {
	backgroundReferencesAsset,
	clearAssetBackgrounds,
} from "../../shared/background.ts";
import {
	appendDecisionRequestSchema,
	appendDecision as appendProductionDecision,
} from "../../shared/decisions.ts";
import {
	type GenerationJob,
	generationJobSchema,
	generationOutcomeSchema,
	generationRequestSchema,
	stampGeneratedAsset,
} from "../../shared/generation.ts";
import {
	type Asset,
	type Avatar,
	assetSchema,
	dissolveOrphanedLinkGroups,
	type ExportCodec,
	exportCodecSchema,
	idSchema,
	newProject,
	type Project,
	projectSchema,
	validateProject,
} from "../../shared/project.ts";
import {
	isProxyDerivative,
	type OfflineReason,
	offlineRenderMessage,
	renderedAssetIds,
} from "../../shared/relink.ts";
import {
	type RenderReview,
	renderReviewSchema,
} from "../../shared/render-review.ts";
import {
	type SearchIndex,
	searchIndexSchema,
	transcriptDocuments,
} from "../../shared/search-index.ts";
import {
	TRANSCRIPT_WINDOW_SECONDS,
	type Transcript,
	transcriptSchema,
} from "../../shared/transcript.ts";
import { mediaFileState } from "./relink.ts";

export interface RenderJob {
	codec?: ExportCodec;
	createdAt: string;
	error?: string;
	id: string;
	progress: number;
	projectId: string;
	review?: RenderReview;
	revision: number;
	status: "pending" | "running" | "completed" | "failed" | "canceled";
}
export class ConflictError extends Error {}

/**
 * A project delete the library refuses for a reason other than a stale
 * revision: an export is still running, or another project uses this one as
 * a nested sequence.
 */
export class ProjectDeleteRefusedError extends Error {
	readonly code: "RENDER_ACTIVE" | "PROJECT_IN_USE";
	constructor(code: "RENDER_ACTIVE" | "PROJECT_IN_USE", message: string) {
		super(message);
		this.name = "ProjectDeleteRefusedError";
		this.code = code;
	}
}

export interface DeletedProject {
	id: string;
	/** Render jobs whose records and output files were removed. */
	jobIds: string[];
	/**
	 * Nested-sequence media that pointed at the project. They stay in the
	 * library as ordinary video media with the sequence link cleared.
	 */
	sequenceAssetIds: string[];
	title: string;
}

/** A render was refused because media it reads is offline. */
export class OfflineMediaError extends Error {
	readonly assets: Asset[];
	constructor(assets: Asset[]) {
		super(offlineRenderMessage(assets.map((asset) => asset.name)));
		this.name = "OfflineMediaError";
		this.assets = assets;
	}
}

const storedRowSchema = z.object({ data: z.string() });
const storedRowsSchema = z.array(storedRowSchema);
const storedIdRowsSchema = z.array(
	z.object({ id: z.string(), data: z.string() })
);
const historyRowsSchema = z.array(
	z.object({ project_id: z.string(), revision: z.number(), data: z.string() })
);

/** Registered content-store name (KDF input; never renamed). */
export const STUDIO_CONTENT_STORE = "studio.sqlite";
/** Highest schema version this build reads (6 seals content columns). */
const STORE_VERSION = 6;

function dataColumn(table: string): SealedColumn {
	return { table, column: "data", kind: "text", orderKey: "id", bind: ["id"] };
}
/**
 * Content tables sealed per row as one `encb:v1:` JSON document bound to the
 * row id: project documents (captions, scripts, scene prompts), their history
 * snapshots, transcripts (spoken words), search indexes (transcript text),
 * generation requests (prompts) and media analyses. Assets (names, kinds,
 * durations) and render jobs stay plaintext; media, imports and renders are
 * plaintext files in 0700 directories (ffmpeg reads them many times).
 */
const PROJECT_DATA = dataColumn("projects");
const TRANSCRIPT_DATA = dataColumn("transcripts");
const SEARCH_INDEX_DATA = dataColumn("search_indexes");
const GENERATION_DATA = dataColumn("generation_jobs");
const ANALYSIS_DATA = dataColumn("analyses");
/** History rows have no id column: bind the composite key, walk the rowid. */
const HISTORY_DATA: SealedColumn = {
	table: "history",
	column: "data",
	kind: "text",
	orderKey: "rowid",
	bind: ["project_id", "revision"],
};

export interface StudioStoreOptions {
	/** The app's captured keys; omitted (tests, tools) keeps plaintext. */
	keys?: PluginKeys | null;
}
const storeVersionSchema = z.object({ user_version: z.number().int() });
const assetCountSchema = z.object({ count: z.number().int() });
const createdRowsSchema = z.array(
	z.object({ created_at: z.iso.datetime(), id: z.string() })
);
const historyCreatedSchema = z.object({ updatedAt: z.string() });
const renderJobSchema: z.ZodType<RenderJob> = z
	.object({
		codec: exportCodecSchema.optional(),
		createdAt: z.string(),
		error: z.string().optional(),
		id: z.string(),
		progress: z.number(),
		projectId: z.string(),
		review: renderReviewSchema.optional(),
		revision: z.number(),
		status: z.enum(["pending", "running", "completed", "failed", "canceled"]),
	})
	.passthrough();
type GenerationRequestInput = z.input<typeof generationRequestSchema>;
type GenerationOutcomeInput = z.input<typeof generationOutcomeSchema>;
type SavedProjectInput = z.input<typeof projectSchema>;
type ProductionDecisionInput = z.input<typeof appendDecisionRequestSchema>;

/** Aggregate admission bounds for app-owned media storage on one node. */
export const MAX_MEDIA_STORAGE_BYTES = 10 * 1024 * 1024 * 1024;
export const MAX_MEDIA_ASSETS = 2000;

interface MediaReservationState {
	assets: number;
	bytes: number;
}

export interface MediaReservation {
	commit(): void;
	release(): void;
	resize(bytes: number): void;
}

const mediaReservations = new WeakMap<StudioStore, MediaReservationState>();

/** Total size of the regular files directly in `directory` (0 when missing). */
function directoryFileBytes(directory: string): number {
	let entries: Dirent[];
	try {
		entries = readdirSync(directory, { withFileTypes: true });
	} catch {
		return 0;
	}
	let total = 0;
	for (const entry of entries) {
		if (!entry.isFile()) {
			continue;
		}
		try {
			total += statSync(join(directory, entry.name)).size;
		} catch {
			// Removed while counting.
		}
	}
	return total;
}

interface OrganizeAssetResult {
	asset: Asset;
	clipsRemoved: number;
	deleted: boolean;
	projects: Project[];
}

const sameLipSyncLink = (
	a: Avatar["lipSync"] | undefined,
	b: Avatar["lipSync"] | undefined
) =>
	a !== undefined &&
	b !== undefined &&
	a.assetId === b.assetId &&
	a.segmentId === b.segmentId;

/**
 * Drop only the lip-sync links that were already dangling in the stored row
 * (legacy rows saved before W3-G3 validated them). A link the request adds,
 * changes, or breaks (by removing its clip) is kept, so `validateProject`
 * still refuses one that points at missing audio.
 */
function pruneStoredDanglingLipSync(
	project: Project,
	stored: Project,
	assets: readonly Asset[]
): Project {
	const pruned = pruneDanglingLipSync(project, assets);
	if (pruned === project) {
		return project;
	}
	const repaired = pruneDanglingLipSync(stored, assets);
	const staleLinks = new Map(
		stored.avatars
			.filter((avatar, index) => !repaired.avatars[index]?.lipSync)
			.map((avatar) => [avatar.id, avatar.lipSync])
	);
	return {
		...project,
		avatars: project.avatars.map((avatar, index) =>
			sameLipSyncLink(avatar.lipSync, staleLinks.get(avatar.id))
				? (pruned.avatars[index] ?? avatar)
				: avatar
		),
	};
}

/**
 * Plaintext file trees kept owner-only on every open: media, imports and
 * renders, plus poster frames, imported fonts and LUTs, and shot indexes.
 */
const PRIVATE_FOLDERS = [
	"media",
	"imports",
	"renders",
	"posters",
	"fonts",
	"luts",
	"shots",
] as const;

/**
 * Media, imports and renders stay plaintext (multi-GB files that ffmpeg reads
 * many times), so they are kept owner-only instead: folders 0700, files 0600.
 * `mkdirSync`'s mode does not narrow a folder that already exists or a file a
 * tool wrote under the umask, so the trees are narrowed on every open.
 * Symlinks are never followed. Windows relies on the per-user folder's ACL.
 */
export function restrictPrivateTree(root: string): void {
	if (process.platform === "win32") {
		return;
	}
	const pending = [root];
	while (pending.length > 0) {
		const current = pending.pop() as string;
		try {
			chmodSync(current, 0o700);
			for (const entry of readdirSync(current, { withFileTypes: true })) {
				const path = join(current, entry.name);
				if (entry.isDirectory()) {
					pending.push(path);
				} else if (entry.isFile()) {
					chmodSync(path, 0o600);
				}
			}
		} catch {
			// A file removed while walking, or one this account cannot change,
			// keeps its mode; the containing folder is still owner-only.
		}
	}
}

/**
 * Remove the work files a crashed or killed job left behind. They hold
 * plaintext copies of sealed content (caption and transcript text in
 * `captions.ass`, rendered frames, audio windows, probe results), and no job
 * survives a restart, so every one is stale when the store opens:
 * - every folder under `renders/` (export, capture, inspection and sequence
 *   work folders; finished exports and their thumbnails are files);
 * - `audio-window-*` folders in the data dir;
 * - `tmp/probe-*.json` results.
 * Entries are examined with lstat and a symlink is removed, never followed.
 */
export function sweepCrashLeftovers(directory: string): void {
	const remove = (path: string, isWorkFolder: boolean) => {
		try {
			const entry = lstatSync(path);
			if (entry.isSymbolicLink()) {
				unlinkSync(path);
			} else if (entry.isDirectory() && isWorkFolder) {
				rmSync(path, { recursive: true, force: true });
			} else if (entry.isFile() && !isWorkFolder) {
				unlinkSync(path);
			}
		} catch {
			// Already gone, or not removable by this account: leave it.
		}
	};
	const list = (folder: string): string[] => {
		try {
			return readdirSync(folder);
		} catch {
			return [];
		}
	};
	for (const name of list(join(directory, "renders"))) {
		const path = join(directory, "renders", name);
		try {
			const entry = lstatSync(path);
			if (entry.isDirectory() || entry.isSymbolicLink()) {
				remove(path, true);
			}
		} catch {
			// Removed meanwhile.
		}
	}
	for (const name of list(directory)) {
		if (name.startsWith("audio-window-")) {
			remove(join(directory, name), true);
		}
	}
	for (const name of list(join(directory, "tmp"))) {
		if (name.startsWith("probe-") && name.endsWith(".json")) {
			remove(join(directory, "tmp", name), false);
		}
	}
}

export class StudioStore {
	readonly db: Database;
	readonly seal: StoreSeal;
	constructor(
		readonly directory: string,
		options: StudioStoreOptions = {}
	) {
		mkdirSync(directory, { recursive: true, mode: 0o700 });
		mkdirSync(join(directory, "media"), { recursive: true, mode: 0o700 });
		mkdirSync(join(directory, "imports"), { recursive: true, mode: 0o700 });
		mkdirSync(join(directory, "renders"), { recursive: true, mode: 0o700 });
		mkdirSync(join(directory, "posters"), { recursive: true, mode: 0o700 });
		chmodSync(directory, 0o700);
		sweepCrashLeftovers(directory);
		for (const folder of PRIVATE_FOLDERS) {
			restrictPrivateTree(join(directory, folder));
		}
		this.db = new Database(join(directory, "studio.sqlite"), { create: true });
		this.db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;");
		const version = storeVersionSchema.parse(
			this.db.query("PRAGMA user_version").get()
		);
		if (version.user_version > STORE_VERSION) {
			throw new Error("Video Studio data was created by a newer version.");
		}
		this.db.transaction(() => {
			this.db.exec(
				"CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS assets (id TEXT PRIMARY KEY, data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS history (project_id TEXT NOT NULL, revision INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(project_id, revision)); CREATE TABLE IF NOT EXISTS analyses (id TEXT PRIMARY KEY, data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS transcripts (id TEXT PRIMARY KEY, data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS search_indexes (id TEXT PRIMARY KEY, data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS generation_jobs (id TEXT PRIMARY KEY, data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS project_meta (id TEXT PRIMARY KEY, created_at TEXT NOT NULL);"
			);
			// Version 6: the fields SQL filtered on with json_extract are lifted
			// into plaintext columns before the JSON is sealed. ALTER TABLE keeps
			// every row and its explicit id; no rebuild is needed.
			const columns = this.db
				.query("PRAGMA table_info(generation_jobs)")
				.all() as { name: string }[];
			for (const name of ["status", "project_id"]) {
				if (!columns.some((column) => column.name === name)) {
					this.db.exec(`ALTER TABLE generation_jobs ADD COLUMN ${name} TEXT`);
				}
			}
			this.db.exec(
				"UPDATE generation_jobs SET status=json_extract(data, '$.status'), project_id=json_extract(data, '$.request.projectId') WHERE status IS NULL AND json_valid(data); CREATE INDEX IF NOT EXISTS generation_jobs_project ON generation_jobs(project_id);"
			);
		})();
		this.seal = StoreSeal.open(
			this.db,
			join(directory, "studio.sqlite"),
			STUDIO_CONTENT_STORE,
			options.keys ?? null,
			[
				PROJECT_DATA,
				HISTORY_DATA,
				TRANSCRIPT_DATA,
				SEARCH_INDEX_DATA,
				GENERATION_DATA,
				ANALYSIS_DATA,
			]
		);
		this.db.exec(`PRAGMA user_version=${STORE_VERSION}`);
		for (const row of storedIdRowsSchema.parse(
			this.db
				.query("SELECT id, data FROM generation_jobs WHERE status='requested'")
				.all()
		)) {
			const opened = this.seal.tryOpenText(
				GENERATION_DATA,
				{ id: row.id },
				row.data
			);
			if (opened === null) {
				continue;
			}
			const job = generationJobSchema.parse(JSON.parse(opened));
			this.writeGeneration({
				...job,
				status: "interrupted",
				message:
					"The app restarted before the outcome was recorded. Check the provider before starting another request.",
				updatedAt: new Date().toISOString(),
			});
		}

		for (const row of storedIdRowsSchema.parse(
			this.db.query("SELECT id, data FROM analyses").all()
		)) {
			const opened = this.seal.tryOpenText(
				ANALYSIS_DATA,
				{ id: row.id },
				row.data
			);
			if (opened === null) {
				continue;
			}
			const analysis = analysisSchema.parse(JSON.parse(opened));
			if (analysis.status === "running") {
				this.putAnalysis({
					...analysis,
					status: "failed",
					error: "Analysis was interrupted by a restart. Run it again.",
				});
			}
		}
		for (const row of storedIdRowsSchema.parse(
			this.db.query("SELECT id, data FROM transcripts").all()
		)) {
			const opened = this.seal.tryOpenText(
				TRANSCRIPT_DATA,
				{ id: row.id },
				row.data
			);
			if (opened === null) {
				continue;
			}
			const transcript = transcriptSchema.parse(JSON.parse(opened));
			if (transcript.status === "running") {
				this.putTranscript({
					...transcript,
					status: "failed",
					revision: transcript.revision + 1,
					error:
						"Transcription was interrupted. Resume from its last saved window.",
				});
			}
		}
		for (const job of this.jobs()) {
			if (job.status === "pending" || job.status === "running") {
				this.putJob({
					...job,
					status: "failed",
					error: "Rendering was interrupted by a restart. Retry the export.",
				});
			}
		}
	}
	/** Seal one row's JSON document (plaintext only in compat mode). */
	private sealData(column: SealedColumn, ids: RowIds, json: string): string {
		return this.seal.sealText(column, ids, json);
	}
	/** Open one row's document; a sealed value that does not open throws. */
	private openData(column: SealedColumn, ids: RowIds, stored: string): string {
		return this.seal.openText(column, ids, stored);
	}
	/** Open listed rows; a row that does not open is skipped and counted. */
	private openList(
		column: SealedColumn,
		rows: { data: string; id: string }[]
	): string[] {
		const opened: string[] = [];
		for (const row of rows) {
			const value = this.seal.tryOpenText(column, { id: row.id }, row.data);
			if (value !== null) {
				opened.push(value);
			}
		}
		return opened;
	}
	private writeGeneration(value: GenerationJob) {
		const job = generationJobSchema.parse(value);
		this.db
			.query(
				"INSERT OR REPLACE INTO generation_jobs(id, data, status, project_id) VALUES (?,?,?,?)"
			)
			.run(
				job.id,
				this.sealData(GENERATION_DATA, { id: job.id }, JSON.stringify(job)),
				job.status,
				job.request.projectId
			);
		return job;
	}
	generationJobs(projectId?: string): GenerationJob[] {
		const rows = storedIdRowsSchema.parse(
			projectId
				? this.db
						.query(
							"SELECT id, data FROM generation_jobs WHERE project_id=? ORDER BY rowid DESC LIMIT 100"
						)
						.all(idSchema.parse(projectId))
				: this.db
						.query(
							"SELECT id, data FROM generation_jobs ORDER BY rowid DESC LIMIT 100"
						)
						.all()
		);
		return this.openList(GENERATION_DATA, rows).map((data) =>
			generationJobSchema.parse(JSON.parse(data))
		);
	}
	generationJob(id: string): GenerationJob | null {
		const key = idSchema.parse(id);
		const row = storedRowSchema
			.nullable()
			.parse(
				this.db.query("SELECT data FROM generation_jobs WHERE id=?").get(key)
			);
		return row
			? generationJobSchema.parse(
					JSON.parse(this.openData(GENERATION_DATA, { id: key }, row.data))
				)
			: null;
	}
	*generationBudgetJobs(projectId: string): IterableIterator<GenerationJob> {
		for (const row of this.db
			.query("SELECT id, data FROM generation_jobs WHERE project_id=?")
			.iterate(idSchema.parse(projectId))) {
			const parsed = z
				.object({ id: z.string(), data: z.string() })
				.safeParse(row);
			if (!parsed.success) {
				throw new Error("A saved generation record is malformed.");
			}
			// Budget accounting must not under-count: a row that does not open
			// fails the check instead of being skipped.
			yield generationJobSchema.parse(
				JSON.parse(
					this.openData(
						GENERATION_DATA,
						{ id: parsed.data.id },
						parsed.data.data
					)
				)
			);
		}
	}
	beginGeneration(value: GenerationRequestInput) {
		const input = generationRequestSchema.parse(value);
		return this.db.transaction(() => {
			const existing = this.generationJob(input.id);
			if (existing) {
				if (JSON.stringify(existing.request) !== JSON.stringify(input)) {
					throw new ConflictError(
						"The generation request ID already belongs to another request."
					);
				}
				return { job: existing, created: false };
			}
			const project = this.project(input.projectId);
			const now = new Date().toISOString();
			return {
				job: this.writeGeneration({
					id: input.id,
					request: input,
					projectRevision: project.revision,
					status: "requested",
					assetIds: [],
					message: "",
					createdAt: now,
					updatedAt: now,
				}),
				created: true,
			};
		})();
	}
	finishGeneration(id: string, value: GenerationOutcomeInput) {
		const input = generationOutcomeSchema.parse(value);
		return this.db.transaction(() => {
			const job = this.generationJob(id);
			if (!job) {
				throw new Error("Generation request not found.");
			}
			if (job.status === "completed" || job.status === "incomplete") {
				if (
					job.status === input.status &&
					job.message === input.message &&
					JSON.stringify(job.assetIds) === JSON.stringify(input.assetIds)
				) {
					return job;
				}
				throw new ConflictError(
					"This generation outcome has already been recorded."
				);
			}
			if (new Set(input.assetIds).size !== input.assetIds.length) {
				throw new Error("Duplicate generated media IDs.");
			}
			if (
				input.status === "completed" &&
				(!input.assetIds.length ||
					input.assetIds.some(
						(id) =>
							!this.assets().some(
								(asset) => asset.id === id && asset.kind === job.request.kind
							)
					))
			) {
				throw new Error(
					"A completed generation must reference saved media of the requested type."
				);
			}
			if (input.status === "incomplete" && input.assetIds.length) {
				throw new Error("Incomplete generation cannot claim saved output.");
			}
			if (input.status === "completed") {
				// Provenance (W3-G1): stamp each saved output with the request
				// that produced it, in the same transaction as the outcome.
				const saved = new Map(this.assets().map((asset) => [asset.id, asset]));
				for (const assetId of input.assetIds) {
					const asset = saved.get(assetId);
					if (asset) {
						this.upsertAsset(stampGeneratedAsset(asset, job.request));
					}
				}
			}
			return this.writeGeneration({
				...job,
				...input,
				updatedAt: new Date().toISOString(),
			});
		})();
	}

	analysis(id: string): MediaAnalysis | null {
		const key = idSchema.parse(id);
		const row = storedRowSchema
			.nullable()
			.parse(this.db.query("SELECT data FROM analyses WHERE id=?").get(key));
		return row
			? analysisSchema.parse(
					JSON.parse(this.openData(ANALYSIS_DATA, { id: key }, row.data))
				)
			: null;
	}
	putAnalysis(value: MediaAnalysis) {
		const result = analysisSchema.parse(value);
		this.db
			.query("INSERT OR REPLACE INTO analyses VALUES (?,?)")
			.run(
				result.assetId,
				this.sealData(
					ANALYSIS_DATA,
					{ id: result.assetId },
					JSON.stringify(result)
				)
			);
	}
	transcript(id: string): Transcript | null {
		const key = idSchema.parse(id);
		const row = storedRowSchema
			.nullable()
			.parse(this.db.query("SELECT data FROM transcripts WHERE id=?").get(key));
		return row
			? transcriptSchema.parse(
					JSON.parse(this.openData(TRANSCRIPT_DATA, { id: key }, row.data))
				)
			: null;
	}
	private putTranscript(value: Transcript): Transcript {
		const result = transcriptSchema.parse(value);
		this.db
			.query("INSERT OR REPLACE INTO transcripts VALUES (?,?)")
			.run(
				result.assetId,
				this.sealData(
					TRANSCRIPT_DATA,
					{ id: result.assetId },
					JSON.stringify(result)
				)
			);
		return result;
	}
	/**
	 * Rewrite a finished transcript's cue and word text (timing unchanged),
	 * bumping its revision. Returns null when there is no finished transcript
	 * or nothing changed.
	 */
	rewriteTranscriptText(
		assetId: string,
		rewrite: (cues: Transcript["cues"]) => Transcript["cues"]
	): Transcript | null {
		const current = this.transcript(assetId);
		if (current?.status !== "completed") {
			return null;
		}
		const cues = rewrite(current.cues);
		const words = rewrite(current.words);
		if (cues === current.cues && words === current.words) {
			return null;
		}
		return this.putTranscript({
			...current,
			cues,
			revision: current.revision + 1,
			updatedAt: new Date().toISOString(),
			words,
		});
	}
	importTranscript(
		asset: Asset,
		revision: number | null,
		cues: Transcript["cues"]
	): Transcript {
		const current = this.transcript(asset.id);
		if ((current?.revision ?? null) !== revision) {
			throw new ConflictError(
				"The source transcript changed. Reload before importing."
			);
		}
		if (
			cues.some(
				(cue) =>
					cue.start < 0 ||
					cue.end > asset.duration + 0.001 ||
					cue.end <= cue.start ||
					cue.text.includes("\0")
			) ||
			new Set(cues.map((cue) => cue.id)).size !== cues.length
		) {
			throw new Error("Imported transcript timing exceeds the source.");
		}
		return this.putTranscript({
			assetId: asset.id,
			origin: "imported",
			timing: "imported",
			revision: (current?.revision ?? -1) + 1,
			status: "completed",
			nextOffset: asset.duration,
			duration: asset.duration,
			cues,
			words: [],
			updatedAt: new Date().toISOString(),
		});
	}
	restartTranscript(
		asset: Asset,
		revision: number | null,
		language?: string
	): Transcript {
		const current = this.transcript(asset.id);
		if (!asset.hasAudio) {
			throw new Error("This media has no audio to transcribe.");
		}
		if (
			!current ||
			current.revision !== revision ||
			current.status === "running"
		) {
			throw new ConflictError(
				"Stop transcription and reload its current revision before replacing it."
			);
		}
		return this.putTranscript({
			assetId: asset.id,
			origin: "ryu-transcription",
			timing: "windows",
			revision: current.revision + 1,
			status: "running",
			nextOffset: 0,
			duration: asset.duration,
			cues: [],
			words: [],
			...(language ? { language } : {}),
			updatedAt: new Date().toISOString(),
		});
	}
	beginTranscript(asset: Asset, language?: string): Transcript {
		if (!asset.hasAudio) {
			throw new Error("This media has no audio to transcribe.");
		}
		const current = this.transcript(asset.id);
		if (current?.status === "completed" || current?.status === "running") {
			return current;
		}
		// Every saved window must share one language, so the stored hint stays
		// true: resuming in a different language means starting again.
		if (
			current?.language &&
			language &&
			language !== current.language &&
			current.nextOffset > 0
		) {
			throw new ConflictError(
				`This transcript was started with language "${current.language}". Resume it with that language, or transcribe it again to change the language.`
			);
		}
		return this.putTranscript(
			current
				? {
						...current,
						status: "running",
						revision: current.revision + 1,
						...(language ? { language } : {}),
						error: undefined,
						updatedAt: new Date().toISOString(),
					}
				: {
						assetId: asset.id,
						origin: "ryu-transcription",
						timing: "windows",
						revision: 0,
						status: "running",
						nextOffset: 0,
						duration: asset.duration,
						cues: [],
						words: [],
						...(language ? { language } : {}),
						updatedAt: new Date().toISOString(),
					}
		);
	}
	appendTranscript(
		id: string,
		revision: number,
		offset: number,
		cues: Transcript["cues"],
		timing: "windows" | "segments" = "windows",
		words: Transcript["cues"] = []
	): Transcript {
		return this.db.transaction(() => {
			const current = this.transcript(id);
			if (
				!current ||
				current.revision !== revision ||
				current.nextOffset !== offset ||
				current.status !== "running"
			) {
				throw new ConflictError(
					"Transcription changed in another session. Reload its progress before continuing."
				);
			}
			const end = Math.min(
				current.duration,
				offset + TRANSCRIPT_WINDOW_SECONDS
			);
			if (
				[...cues, ...words].some(
					(cue) =>
						cue.start < offset ||
						cue.end > end + 0.001 ||
						cue.end <= cue.start ||
						cue.text.includes("\0")
				)
			) {
				throw new Error("Transcript timing is outside its source window.");
			}
			const all = [...current.cues, ...cues];
			const allWords = [...current.words, ...words];
			if (new Set(allWords.map((word) => word.id)).size !== allWords.length) {
				throw new Error("Duplicate transcript word ID.");
			}
			if (new Set(all.map((cue) => cue.id)).size !== all.length) {
				throw new Error("Duplicate transcript cue ID.");
			}
			return this.putTranscript({
				...current,
				revision: revision + 1,
				nextOffset: end,
				status: end >= current.duration ? "completed" : "running",
				cues: all,
				words: allWords,
				timing: current.cues.length
					? cues.length
						? current.timing === "segments" && timing === "segments"
							? "segments"
							: "windows"
						: current.timing
					: timing,
				updatedAt: new Date().toISOString(),
			});
		})();
	}
	stopTranscript(
		id: string,
		revision: number,
		status: "failed" | "canceled",
		error?: string
	): Transcript {
		const current = this.transcript(id);
		if (
			!current ||
			current.revision !== revision ||
			current.status !== "running"
		) {
			throw new ConflictError(
				"Transcription changed before it could be stopped."
			);
		}
		return this.putTranscript({
			...current,
			revision: revision + 1,
			status,
			error,
			updatedAt: new Date().toISOString(),
		});
	}
	searchIndexes(): Array<SearchIndex & { current: boolean }> {
		const rows = storedIdRowsSchema.parse(
			this.db
				.query(
					"SELECT id, data FROM search_indexes ORDER BY rowid DESC LIMIT 2000"
				)
				.all()
		);
		return this.openList(SEARCH_INDEX_DATA, rows).map((data) => {
			const index = searchIndexSchema.parse(JSON.parse(data));
			const transcript = this.transcript(index.assetId);
			return {
				...index,
				current:
					transcript?.status === "completed" &&
					transcript.revision === index.transcriptRevision,
			};
		});
	}
	private putSearchIndex(value: SearchIndex): SearchIndex {
		const index = searchIndexSchema.parse(value);
		this.db
			.query("INSERT OR REPLACE INTO search_indexes VALUES (?,?)")
			.run(
				index.assetId,
				this.sealData(
					SEARCH_INDEX_DATA,
					{ id: index.assetId },
					JSON.stringify(index)
				)
			);
		return index;
	}
	beginSearchIndex(
		asset: Asset,
		spaceId: string,
		spaceName: string,
		rebuild = false
	): SearchIndex {
		const transcript = this.transcript(asset.id);
		if (!transcript) {
			throw new Error("No source transcript is available.");
		}
		const old = this.searchIndexes().find(
			(index) => index.assetId === asset.id
		);
		if (
			!rebuild &&
			old &&
			old.transcriptRevision === transcript.revision &&
			old.spaceId === spaceId
		) {
			const { current: _current, ...index } = old;
			return index;
		}
		return this.putSearchIndex({
			assetId: asset.id,
			spaceId,
			spaceName,
			transcriptRevision: transcript.revision,
			revision: (old?.revision ?? -1) + 1,
			entries: transcriptDocuments(asset, transcript),
			obsolete: [
				...(old?.obsolete ?? []),
				...(old?.entries.filter((entry) => entry.docId) ?? []),
			],
			updatedAt: new Date().toISOString(),
		});
	}
	updateSearchEntry(
		assetId: string,
		revision: number,
		key: string,
		docId: string,
		ready: boolean
	): SearchIndex {
		const found = this.searchIndexes().find(
			(index) => index.assetId === assetId
		);
		if (!found || found.revision !== revision || !found.current) {
			throw new ConflictError(
				"The source index changed. Resume indexing from its current state."
			);
		}
		const entry = found.entries.find((value) => value.key === key);
		if (!entry) {
			throw new Error("Index entry not found.");
		}
		if (entry.docId && entry.docId !== docId) {
			throw new ConflictError(
				"This index entry already belongs to another document."
			);
		}
		if (
			found.entries.some((value) => value.key !== key && value.docId === docId)
		) {
			throw new Error("A document cannot represent two index entries.");
		}
		const { current: _current, ...index } = found;
		return this.putSearchIndex({
			...index,
			revision: revision + 1,
			entries: index.entries.map((value) =>
				value.key === key ? { ...value, docId, ready } : value
			),
			updatedAt: new Date().toISOString(),
		});
	}
	pruneSearchEntry(
		assetId: string,
		revision: number,
		docId: string
	): SearchIndex {
		const found = this.searchIndexes().find(
			(index) => index.assetId === assetId
		);
		if (!found || found.revision !== revision) {
			throw new ConflictError("The source index changed during cleanup.");
		}
		const { current: _current, ...index } = found;
		return this.putSearchIndex({
			...index,
			revision: revision + 1,
			obsolete: index.obsolete.filter((entry) => entry.docId !== docId),
			updatedAt: new Date().toISOString(),
		});
	}
	assets(): Asset[] {
		return storedRowsSchema
			.parse(
				this.db
					.query("SELECT data FROM assets ORDER BY rowid DESC LIMIT 2000")
					.all()
			)
			.map((r) => assetSchema.parse(JSON.parse(r.data)));
	}
	/**
	 * Bytes stored under the media allowance: media files plus imported font
	 * files (`fonts/`, not the render sets that hard-link them).
	 */
	mediaStorageBytes(): number {
		return (
			directoryFileBytes(join(this.directory, "media")) +
			directoryFileBytes(join(this.directory, "fonts"))
		);
	}
	/** Bytes still admissible under the node quota after stored files and pending reservations. */
	mediaStorageHeadroom(): number {
		const pending = mediaReservations.get(this)?.bytes ?? 0;
		return Math.max(
			0,
			MAX_MEDIA_STORAGE_BYTES - this.mediaStorageBytes() - pending
		);
	}
	/**
	 * Admit `bytes` against the media storage allowance. `asset: false` is for
	 * bytes that do not become a media asset (imported fonts), so the media
	 * asset limit does not apply and no asset slot is held.
	 */
	reserveMediaStorage(
		bytes: number,
		options: { asset?: boolean } = {}
	): MediaReservation {
		const slots = options.asset === false ? 0 : 1;
		if (!Number.isSafeInteger(bytes) || bytes <= 0) {
			throw new Error(
				"Media storage admission requires a positive byte count."
			);
		}
		const current = mediaReservations.get(this) ?? { assets: 0, bytes: 0 };
		if (
			this.mediaStorageBytes() + current.bytes + bytes >
			MAX_MEDIA_STORAGE_BYTES
		) {
			throw new Error("Media storage quota reached.");
		}
		if (slots && this.assets().length + current.assets >= MAX_MEDIA_ASSETS) {
			throw new Error("Media asset limit reached.");
		}
		current.bytes += bytes;
		current.assets += slots;
		mediaReservations.set(this, current);
		let reserved = bytes;
		let active = true;
		const release = () => {
			if (!active) {
				return;
			}
			active = false;
			current.bytes -= reserved;
			current.assets -= slots;
			if (current.bytes === 0 && current.assets === 0) {
				mediaReservations.delete(this);
			}
		};
		return {
			commit: release,
			release,
			resize: (nextBytes) => {
				if (!(active && Number.isSafeInteger(nextBytes)) || nextBytes < 0) {
					throw new Error("Invalid media storage reservation resize.");
				}
				if (nextBytes > reserved) {
					throw new Error("Media storage reservation cannot grow.");
				}
				current.bytes += nextBytes - reserved;
				reserved = nextBytes;
			},
		};
	}
	putAsset(asset: Asset) {
		// `assets()` reads at most MAX_MEDIA_ASSETS rows, so an insert past the
		// limit would silently hide the oldest asset from every lookup.
		const { count } = assetCountSchema.parse(
			this.db.query("SELECT COUNT(*) AS count FROM assets").get()
		);
		if (count >= MAX_MEDIA_ASSETS) {
			// Every caller places the media at `mediaPath(id)` before inserting, so a
			// refused insert must not strand an unreferenced file that counts against
			// the storage quota. Never touch files that belong to an existing row.
			const id = idSchema.parse(asset.id);
			if (!this.db.query("SELECT 1 FROM assets WHERE id=?").get(id)) {
				rmSync(this.mediaPath(id), { force: true });
				rmSync(join(this.directory, "media", `${id}.jpg`), { force: true });
			}
			throw new Error("Media asset limit reached.");
		}
		this.db
			.query("INSERT INTO assets VALUES (?, ?)")
			.run(asset.id, JSON.stringify(assetSchema.parse(asset)));
	}
	/**
	 * Remove an asset row that no project references yet, such as media
	 * registered for an edit that was then refused. Files are the caller's.
	 */
	discardAsset(id: string) {
		this.db.query("DELETE FROM assets WHERE id = ?").run(id);
	}
	upsertAsset(asset: Asset) {
		this.db
			.query("INSERT OR REPLACE INTO assets VALUES (?, ?)")
			.run(asset.id, JSON.stringify(assetSchema.parse(asset)));
	}
	organizeAsset(
		id: string,
		input: {
			delete?: boolean;
			folder?: string;
			name?: string;
			projectRevisions?: Record<string, number>;
		}
	): OrganizeAssetResult {
		const asset = this.assets().find((candidate) => candidate.id === id);
		if (!asset) {
			throw new Error("Media not found.");
		}
		const projects = this.projects();
		const affected = projects.filter(
			(project) =>
				project.segments.some((segment) => segment.assetId === id) ||
				project.multicamGroups.some((group) =>
					group.members.some((member) => member.assetId === id)
				) ||
				backgroundReferencesAsset(project, id) ||
				project.avatars.some((avatar) => avatar.lipSync?.assetId === id)
		);
		if (input.delete) {
			for (const project of affected) {
				const expected = input.projectRevisions?.[project.id];
				if (expected !== undefined && expected !== project.revision) {
					throw new ConflictError(
						"A project using this media changed. Reload before deleting the asset."
					);
				}
			}
			let clipsRemoved = 0;
			this.db.transaction(() => {
				this.db.query("DELETE FROM assets WHERE id=?").run(idSchema.parse(id));
				this.db
					.query("DELETE FROM analyses WHERE id=?")
					.run(idSchema.parse(id));
				this.db
					.query("DELETE FROM transcripts WHERE id=?")
					.run(idSchema.parse(id));
				this.db
					.query("DELETE FROM search_indexes WHERE id=?")
					.run(idSchema.parse(id));
				const remaining = this.assets();
				for (const project of affected) {
					const dissolvedGroups = new Set(
						project.multicamGroups
							.filter((group) =>
								group.members.some((member) => member.assetId === id)
							)
							.map((group) => group.id)
					);
					const nextSegments = project.segments
						.filter((segment) => segment.assetId !== id)
						.map((segment) =>
							dissolvedGroups.has(segment.multicamGroupId ?? "")
								? { ...segment, multicamGroupId: undefined }
								: segment
						);
					const nextScenes = project.scenes.map((scene) => {
						const assetIds = scene.assetIds.filter((assetId) => assetId !== id);
						const audioOffsets = Object.fromEntries(
							Object.entries(scene.audioOffsets ?? {}).filter(
								([assetId]) => assetId !== id
							)
						);
						const changed =
							assetIds.length !== scene.assetIds.length ||
							Object.keys(audioOffsets).length !==
								Object.keys(scene.audioOffsets ?? {}).length;
						return changed
							? {
									...scene,
									approved: false,
									assetIds,
									audioOffsets: Object.keys(audioOffsets).length
										? audioOffsets
										: undefined,
									reviewStatus: "in-review" as const,
								}
							: scene;
					});
					const referenceProfile =
						project.referenceProfile?.assetId === id
							? undefined
							: project.referenceProfile;
					clipsRemoved += project.segments.length - nextSegments.length;
					const next: Project = {
						...project,
						captions: project.captions.filter(
							(caption) => caption.sourceAssetId !== id
						),
						captionTracks: project.captionTracks.map((track) => ({
							...track,
							captions: track.captions.filter(
								(caption) => caption.sourceAssetId !== id
							),
						})),
						multicamGroups: project.multicamGroups.filter(
							(group) => !dissolvedGroups.has(group.id)
						),
						referenceProfile,
						scenes: nextScenes,
						segments: dissolveOrphanedLinkGroups(nextSegments),
					};
					// Lip-sync links to the deleted media or its clips go too (W3-G3),
					// and canvas/clip backgrounds drawing it reset (W2-V8).
					this.writeRevision(
						project,
						pruneDanglingLipSync(clearAssetBackgrounds(next, id), remaining)
					);
				}
			})();
			this.removeShotFiles(asset.id);
			return {
				asset,
				clipsRemoved,
				deleted: true,
				projects: this.projects(),
			};
		}
		const nextInput = { ...asset };
		if (input.name !== undefined) {
			nextInput.name = input.name;
		}
		if (input.folder !== undefined) {
			nextInput.folder = input.folder || undefined;
		}
		const next = assetSchema.parse(nextInput);
		this.db
			.query("UPDATE assets SET data=? WHERE id=?")
			.run(JSON.stringify(next), idSchema.parse(id));
		return { asset: next, clipsRemoved: 0, deleted: false, projects };
	}
	/**
	 * Delete a deleted asset's shot stats and shot-to-Spaces projection
	 * (`<data>/shots/<id>.json` and `<id>.space.json`, W3-X5), like the
	 * transcript search index row the delete removes.
	 */
	private removeShotFiles(assetId: string) {
		const directory = join(this.directory, "shots");
		for (const suffix of [".json", ".space.json"]) {
			rmSync(join(directory, `${idSchema.parse(assetId)}${suffix}`), {
				force: true,
			});
		}
	}
	/**
	 * Library assets whose stored media file is missing or unreadable.
	 * Nested sequence assets and preview proxies are rebuilt from their
	 * source and never listed.
	 */
	offlineAssets(): { asset: Asset; reason: OfflineReason }[] {
		const result: { asset: Asset; reason: OfflineReason }[] = [];
		for (const asset of this.assets()) {
			if (asset.sequenceProjectId || isProxyDerivative(asset)) {
				continue;
			}
			const reason = mediaFileState(this.mediaPath(asset.id));
			if (reason) {
				result.push({ asset, reason });
			}
		}
		return result;
	}
	/**
	 * Offline assets a render of `projectId` reads, empty when it can run:
	 * clip media, canvas background images and avatar lip-sync audio, of the
	 * project and of every nested sequence project it is built from.
	 */
	offlineRenderAssets(projectId: string) {
		const assets = this.assets();
		const needed = new Set(
			renderedAssetIds(projectId, this.projects(), assets)
		);
		return assets.filter(
			(asset) =>
				needed.has(asset.id) &&
				!asset.sequenceProjectId &&
				mediaFileState(this.mediaPath(asset.id)) !== null
		);
	}
	/**
	 * Commit a relink: replace the target asset record and drop the
	 * replacement's own record (its media file already moved onto the
	 * target). Derived data of the replacement goes with it. The target's
	 * preview proxies (of the old media) are deleted, and the replacement's
	 * proxies (of the new media) become the target's. Returns both sets so
	 * the caller can remove the deleted proxies' files.
	 */
	commitRelink(
		next: Asset,
		sourceId: string
	): { proxyAssets: Asset[]; removedProxyAssetIds: string[] } {
		const target = idSchema.parse(next.id);
		const source = idSchema.parse(sourceId);
		if (target === source) {
			throw new Error("An asset cannot be relinked to itself.");
		}
		return this.db.transaction(() => {
			const updated = this.db
				.query("UPDATE assets SET data=? WHERE id=?")
				.run(JSON.stringify(assetSchema.parse(next)), target);
			if (updated.changes !== 1) {
				throw new Error("Media not found.");
			}
			for (const table of [
				"assets",
				"analyses",
				"transcripts",
				"search_indexes",
			]) {
				this.db.query(`DELETE FROM ${table} WHERE id=?`).run(source);
			}
			const removedProxyAssetIds: string[] = [];
			const proxyAssets: Asset[] = [];
			for (const asset of this.assets()) {
				if (!isProxyDerivative(asset)) {
					continue;
				}
				if (asset.derivedFromAssetId === target) {
					this.db.query("DELETE FROM assets WHERE id=?").run(asset.id);
					removedProxyAssetIds.push(asset.id);
				} else if (asset.derivedFromAssetId === source) {
					const moved = assetSchema.parse({
						...asset,
						derivedFromAssetId: target,
					});
					this.db
						.query("UPDATE assets SET data=? WHERE id=?")
						.run(JSON.stringify(moved), asset.id);
					proxyAssets.push(moved);
				}
			}
			return { proxyAssets, removedProxyAssetIds };
		})();
	}
	mediaPath(id: string) {
		return join(this.directory, "media", idSchema.parse(id));
	}
	renderPath(id: string, codec: ExportCodec = "h264") {
		const extension = codec === "prores" ? "mov" : "mp4";
		return join(
			this.directory,
			"renders",
			`${idSchema.parse(id)}.${extension}`
		);
	}
	projects(): Project[] {
		// Read the library once for every row's lip-sync repair, and only when
		// some row links an avatar to audio.
		let assets: Asset[] | undefined;
		const loadAssets = () => {
			assets ??= this.assets();
			return assets;
		};
		const rows = storedIdRowsSchema.parse(
			this.db
				.query("SELECT id, data FROM projects ORDER BY rowid DESC LIMIT 500")
				.all()
		);
		return this.openList(PROJECT_DATA, rows).map((data) =>
			this.loadedProject(projectSchema.parse(JSON.parse(data)), loadAssets)
		);
	}
	/** How many projects the library holds, without parsing (or opening) them. */
	projectCount(): number {
		return z
			.object({ count: z.number() })
			.parse(this.db.query("SELECT COUNT(*) AS count FROM projects").get())
			.count;
	}
	/** A stored project as written, before the load-time lip-sync repair. */
	private storedProject(id: string): Project {
		const key = idSchema.parse(id);
		const row = storedRowSchema
			.nullable()
			.parse(this.db.query("SELECT data FROM projects WHERE id=?").get(key));
		if (!row) {
			throw new Error("Project not found.");
		}
		return projectSchema.parse(
			JSON.parse(this.openData(PROJECT_DATA, { id: key }, row.data))
		);
	}
	private sealProject(project: Project): string {
		return this.sealData(
			PROJECT_DATA,
			{ id: project.id },
			JSON.stringify(project)
		);
	}
	/**
	 * Parse a stored project, dropping avatar lip-sync links to media or clips
	 * that no longer exist (W3-G3), so projects saved with a dangling link
	 * before that check still open and save. The library is read only when an
	 * avatar has a link to check.
	 */
	private loadedProject(project: Project, loadAssets: () => Asset[]): Project {
		if (!project.avatars.some((avatar) => avatar.lipSync)) {
			return project;
		}
		return pruneDanglingLipSync(project, loadAssets());
	}
	project(id: string): Project {
		return this.loadedProject(this.storedProject(id), () => this.assets());
	}
	create(title: string, requireApproval = false): Project {
		if (this.projectCount() >= 500) {
			throw new Error("Project library is full.");
		}
		const p = projectSchema.parse({ ...newProject(title), requireApproval });
		this.db.transaction(() => {
			this.db
				.query("INSERT INTO projects VALUES (?,?)")
				.run(p.id, this.sealProject(p));
			this.recordCreated(p.id, p.updatedAt);
		})();
		return p;
	}
	duplicate(id: string, title?: string): Project {
		if (this.projectCount() >= 500) {
			throw new Error("Project library is full.");
		}
		const source = this.project(id);
		const copy = projectSchema.parse({
			...source,
			id: crypto.randomUUID(),
			revision: 0,
			title: title?.trim() || `${source.title} copy`,
			updatedAt: new Date().toISOString(),
		});
		// The copy is opened from the source and sealed for its own id.
		this.db.transaction(() => {
			this.db
				.query("INSERT INTO projects VALUES (?,?)")
				.run(copy.id, this.sealProject(copy));
			this.recordCreated(copy.id, copy.updatedAt);
		})();
		return copy;
	}
	private recordCreated(id: string, createdAt: string) {
		this.db
			.query("INSERT OR REPLACE INTO project_meta VALUES (?,?)")
			.run(id, createdAt);
	}
	/**
	 * When each project was created. Projects saved before the library kept a
	 * creation time fall back to their oldest retained history revision, and
	 * then to their last update.
	 */
	projectCreatedTimes(): Map<string, string> {
		const created = new Map<string, string>();
		for (const row of createdRowsSchema.parse(
			this.db.query("SELECT id, created_at FROM project_meta").all()
		)) {
			created.set(row.id, row.created_at);
		}
		// History rows are sealed, so the oldest revision's `updatedAt` is read
		// by opening the row (not with json_extract on the stored value). A row
		// that does not open is skipped and the caller's fallback applies.
		for (const row of historyRowsSchema.parse(
			this.db
				.query(
					"SELECT h.project_id AS project_id, h.revision AS revision, h.data AS data FROM history h JOIN (SELECT project_id, MIN(revision) AS revision FROM history GROUP BY project_id) oldest ON oldest.project_id = h.project_id AND oldest.revision = h.revision"
				)
				.all()
		)) {
			if (created.has(row.project_id)) {
				continue;
			}
			const data = this.seal.tryOpenText(
				HISTORY_DATA,
				{ project_id: row.project_id, revision: row.revision },
				row.data
			);
			if (data === null) {
				continue;
			}
			const oldest = historyCreatedSchema.safeParse(JSON.parse(data));
			if (oldest.success) {
				created.set(row.project_id, oldest.data.updatedAt);
			}
		}
		return created;
	}
	/** Cached poster frame for one project revision. */
	posterPath(id: string, revision: number) {
		return join(
			this.directory,
			"posters",
			`${idSchema.parse(id)}-${z.number().int().nonnegative().parse(revision)}.png`
		);
	}
	/** Remove cached posters of `id`, except the one for `keepRevision`. */
	prunePosters(id: string, keepRevision?: number) {
		const project = idSchema.parse(id);
		const keep =
			keepRevision === undefined ? undefined : `${project}-${keepRevision}.png`;
		let entries: string[];
		try {
			entries = readdirSync(join(this.directory, "posters"));
		} catch {
			return;
		}
		for (const name of entries) {
			if (name.startsWith(`${project}-`) && name !== keep) {
				rmSync(join(this.directory, "posters", name), { force: true });
			}
		}
	}
	/**
	 * Delete a project from the library with its history, render job records,
	 * and render outputs. Refused while one of its exports is pending or
	 * running, while another project uses it as a nested sequence, or when
	 * `revision` is not the current revision.
	 */
	deleteProject(id: string, revision: number): DeletedProject {
		const projectId = idSchema.parse(id);
		const deleted = this.db.transaction((): DeletedProject => {
			const current = this.project(projectId);
			if (current.revision !== revision) {
				throw new ConflictError(
					"This project changed in another editor. Reload before deleting it."
				);
			}
			const jobs = storedRowsSchema
				.parse(
					this.db
						.query(
							"SELECT data FROM jobs WHERE json_extract(data, '$.projectId')=?"
						)
						.all(projectId)
				)
				.map((row) => renderJobSchema.parse(JSON.parse(row.data)));
			if (
				jobs.some((job) => job.status === "pending" || job.status === "running")
			) {
				throw new ProjectDeleteRefusedError(
					"RENDER_ACTIVE",
					"An export of this project is still running. Cancel it or wait for it to finish before deleting the project."
				);
			}
			const sequenceAssets = this.assets().filter(
				(asset) => asset.sequenceProjectId === projectId
			);
			const sequenceIds = new Set(sequenceAssets.map((asset) => asset.id));
			const user = this.projects().find(
				(project) =>
					project.id !== projectId &&
					project.segments.some((segment) => sequenceIds.has(segment.assetId))
			);
			if (user) {
				throw new ProjectDeleteRefusedError(
					"PROJECT_IN_USE",
					`"${user.title}" uses this project as a nested sequence. Remove that clip before deleting the project.`
				);
			}
			// Media stays in the library: a nested-sequence render of this
			// project becomes ordinary video media (its last render, without the
			// link back), so its file, thumbnail, analyses and quota stay reachable
			// and deletable from the media library.
			for (const asset of sequenceAssets) {
				const { sequenceProjectId: _detached, ...media } = asset;
				this.db
					.query("UPDATE assets SET data=? WHERE id=?")
					.run(JSON.stringify(assetSchema.parse(media)), asset.id);
			}
			for (const job of jobs) {
				this.db.query("DELETE FROM jobs WHERE id=?").run(job.id);
			}
			this.db.query("DELETE FROM history WHERE project_id=?").run(projectId);
			this.db.query("DELETE FROM project_meta WHERE id=?").run(projectId);
			this.db.query("DELETE FROM projects WHERE id=?").run(projectId);
			return {
				id: projectId,
				jobIds: jobs.map((job) => job.id),
				sequenceAssetIds: [...sequenceIds],
				title: current.title,
			};
		})();
		// Files go after the rows commit so a refused or failed delete keeps
		// every output; a file that is already gone is not an error.
		for (const jobId of deleted.jobIds) {
			for (const path of [
				this.renderPath(jobId, "h264"),
				this.renderPath(jobId, "prores"),
				join(this.directory, "renders", `${jobId}.jpg`),
				join(this.directory, "renders", jobId),
			]) {
				rmSync(path, { force: true, recursive: true });
			}
		}
		this.prunePosters(projectId);
		return deleted;
	}
	save(input: SavedProjectInput): Project {
		const assets = this.assets();
		const parsed = projectSchema.parse(input);
		const p = validateProject(
			pruneStoredDanglingLipSync(parsed, this.storedProject(parsed.id), assets),
			assets
		);
		return this.db.transaction(() => {
			const current = this.project(p.id);
			if (current.revision !== p.revision) {
				throw new ConflictError(
					"This project changed in another editor. Reload before saving."
				);
			}
			p.decisions = current.decisions;
			return this.writeRevision(
				current,
				this.reconcileSceneApprovals(current, p)
			);
		})();
	}
	appendDecision(id: string, input: ProductionDecisionInput): Project {
		const request = appendDecisionRequestSchema.parse(input);
		return this.db.transaction(() => {
			const current = this.project(id);
			if (current.revision !== request.revision) {
				throw new ConflictError(
					"The project changed. Reload before appending a decision."
				);
			}
			return this.writeRevision(
				current,
				appendProductionDecision(current, request)
			);
		})();
	}
	private reconcileSceneApprovals(current: Project, p: Project): Project {
		// All editorial writes, including undo, preserve only current approvals
		// for the exact scene content. Historical snapshots carry no authority.
		p.requireApproval = current.requireApproval;
		p.scenes = p.scenes.map((scene) => {
			const old = current.scenes.find((s) => s.id === scene.id);
			const changed =
				old &&
				(old.duration !== scene.duration ||
					old.sourceIn !== scene.sourceIn ||
					JSON.stringify(old.audioOffsets ?? {}) !==
						JSON.stringify(scene.audioOffsets ?? {}) ||
					(old.muteVisualAudio ?? false) !== (scene.muteVisualAudio ?? false) ||
					old.script !== scene.script ||
					old.prompt !== scene.prompt ||
					old.title !== scene.title ||
					JSON.stringify(old.assetIds) !== JSON.stringify(scene.assetIds));
			const approved = Boolean(old?.approved) && !changed;
			return {
				...scene,
				reviewNotes: old?.approved ? old.reviewNotes : scene.reviewNotes,
				approved,
				reviewStatus: approved
					? "approved"
					: changed || scene.reviewStatus === "approved"
						? "in-review"
						: (scene.reviewStatus ?? "in-review"),
			};
		});
		return p;
	}
	private writeRevision(current: Project, p: Project): Project {
		this.db
			.query("INSERT INTO history VALUES (?,?,?)")
			.run(
				current.id,
				current.revision,
				this.sealData(
					HISTORY_DATA,
					{ project_id: current.id, revision: current.revision },
					JSON.stringify(current)
				)
			);
		p.revision += 1;
		p.updatedAt = new Date().toISOString();
		this.db
			.query("UPDATE projects SET data=? WHERE id=?")
			.run(this.sealProject(p), p.id);
		this.db
			.query("DELETE FROM history WHERE project_id=? AND revision < ?")
			.run(p.id, Math.max(0, p.revision - 100));
		return p;
	}
	setApprovalRequirement(
		id: string,
		revision: number,
		requireApproval: boolean
	): Project {
		return this.db.transaction(() => {
			const current = this.project(id);
			if (current.revision !== revision) {
				throw new ConflictError(
					"The approval policy changed. Reload before updating it."
				);
			}
			return this.writeRevision(current, { ...current, requireApproval });
		})();
	}
	approveScene(
		id: string,
		revision: number,
		sceneId: string,
		approved: boolean
	): Project {
		return this.db.transaction(() => {
			const current = this.project(id);
			if (current.revision !== revision) {
				throw new ConflictError(
					"The scene changed before approval. Reload and review it again."
				);
			}
			const scene = current.scenes.find((s) => s.id === sceneId);
			if (!scene) {
				throw new Error("Scene not found.");
			}
			if (approved && !scene.assetIds.length) {
				throw new Error("Select a take before approving the scene.");
			}
			const reviewStatus = approved
				? ("approved" as const)
				: ("in-review" as const);
			const next = {
				...current,
				scenes: current.scenes.map((s) =>
					s.id === sceneId
						? {
								...s,
								approved,
								reviewStatus,
							}
						: s
				),
			};
			return this.writeRevision(current, next);
		})();
	}
	history(id: string): Project[] {
		const rows = historyRowsSchema.parse(
			this.db
				.query(
					"SELECT project_id, revision, data FROM history WHERE project_id=? ORDER BY revision DESC LIMIT 100"
				)
				.all(idSchema.parse(id))
		);
		const projects: Project[] = [];
		for (const row of rows) {
			const data = this.seal.tryOpenText(
				HISTORY_DATA,
				{ project_id: row.project_id, revision: row.revision },
				row.data
			);
			if (data !== null) {
				projects.push(projectSchema.parse(JSON.parse(data)));
			}
		}
		return projects;
	}
	restoreHistory(
		id: string,
		revision: number,
		historyRevision: number
	): Project {
		return this.db.transaction(() => {
			const current = this.project(id);
			if (current.revision !== revision) {
				throw new ConflictError(
					"This project changed. Reload before restoring its history."
				);
			}
			const target = this.history(id).find(
				(project) => project.revision === historyRevision
			);
			if (!target) {
				throw new Error(
					"The requested project history revision is unavailable."
				);
			}
			return this.writeRevision(
				current,
				this.reconcileSceneApprovals(
					current,
					validateProject(
						{
							...target,
							decisions: current.decisions,
							revision: current.revision,
						},
						this.assets()
					)
				)
			);
		})();
	}
	jobs(): RenderJob[] {
		return storedRowsSchema
			.parse(
				this.db
					.query("SELECT data FROM jobs ORDER BY rowid DESC LIMIT 500")
					.all()
			)
			.map((r) => renderJobSchema.parse(JSON.parse(r.data)));
	}
	/**
	 * Store a render job. Queuing a new pending job is refused with
	 * `OfflineMediaError` when media its project (or a nested sequence) reads
	 * is offline, so an export never starts against a damaged store.
	 */
	putJob(job: RenderJob) {
		if (
			job.status === "pending" &&
			!this.db.query("SELECT 1 FROM jobs WHERE id=?").get(job.id)
		) {
			const offline = this.offlineRenderAssets(job.projectId);
			if (offline.length) {
				throw new OfflineMediaError(offline);
			}
		}
		this.db
			.query("INSERT OR REPLACE INTO jobs VALUES (?,?)")
			.run(job.id, JSON.stringify(job));
	}
	close() {
		this.db.close();
	}
}
