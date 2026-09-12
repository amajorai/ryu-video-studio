import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { analysisSchema, type MediaAnalysis } from "../../shared/analysis.ts";
import {
	type GenerationJob,
	generationJobSchema,
	generationOutcomeSchema,
	generationRequestSchema,
} from "../../shared/generation.ts";
import {
	type Asset,
	assetSchema,
	dissolveOrphanedLinkGroups,
	type ExportCodec,
	idSchema,
	newProject,
	type Project,
	projectSchema,
	validateProject,
} from "../../shared/project.ts";
import type { RenderReview } from "../../shared/render-review.ts";
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
export class StudioStore {
	readonly db: Database;
	constructor(readonly directory: string) {
		mkdirSync(directory, { recursive: true, mode: 0o700 });
		mkdirSync(join(directory, "media"), { recursive: true, mode: 0o700 });
		mkdirSync(join(directory, "renders"), { recursive: true, mode: 0o700 });
		this.db = new Database(join(directory, "studio.sqlite"), { create: true });
		this.db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;");
		const version = this.db.query("PRAGMA user_version").get() as {
			user_version: number;
		};
		if (version.user_version > 5) {
			throw new Error("Video Studio data was created by a newer version.");
		}
		this.db.transaction(() => {
			this.db.exec(
				"CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS assets (id TEXT PRIMARY KEY, data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS history (project_id TEXT NOT NULL, revision INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(project_id, revision)); CREATE TABLE IF NOT EXISTS analyses (id TEXT PRIMARY KEY, data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS transcripts (id TEXT PRIMARY KEY, data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS search_indexes (id TEXT PRIMARY KEY, data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS generation_jobs (id TEXT PRIMARY KEY, data TEXT NOT NULL); PRAGMA user_version=5;"
			);
		})();
		for (const row of this.db
			.query(
				"SELECT data FROM generation_jobs WHERE json_extract(data, '$.status')='requested'"
			)
			.all() as { data: string }[]) {
			const job = generationJobSchema.parse(JSON.parse(row.data));
			this.writeGeneration({
				...job,
				status: "interrupted",
				message:
					"The app restarted before the outcome was recorded. Check the provider before starting another request.",
				updatedAt: new Date().toISOString(),
			});
		}

		for (const row of this.db.query("SELECT data FROM analyses").all() as {
			data: string;
		}[]) {
			const analysis = analysisSchema.parse(JSON.parse(row.data));
			if (analysis.status === "running") {
				this.putAnalysis({
					...analysis,
					status: "failed",
					error: "Analysis was interrupted by a restart. Run it again.",
				});
			}
		}
		for (const row of this.db.query("SELECT data FROM transcripts").all() as {
			data: string;
		}[]) {
			const transcript = transcriptSchema.parse(JSON.parse(row.data));
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
	private writeGeneration(value: GenerationJob) {
		const job = generationJobSchema.parse(value);
		this.db
			.query("INSERT OR REPLACE INTO generation_jobs VALUES (?,?)")
			.run(job.id, JSON.stringify(job));
		return job;
	}
	generationJobs(projectId?: string): GenerationJob[] {
		return (
			(projectId
				? this.db
						.query(
							"SELECT data FROM generation_jobs WHERE json_extract(data, '$.request.projectId')=? ORDER BY rowid DESC LIMIT 100"
						)
						.all(idSchema.parse(projectId))
				: this.db
						.query(
							"SELECT data FROM generation_jobs ORDER BY rowid DESC LIMIT 100"
						)
						.all()) as { data: string }[]
		).map((row) => generationJobSchema.parse(JSON.parse(row.data)));
	}
	generationJob(id: string): GenerationJob | null {
		const row = this.db
			.query("SELECT data FROM generation_jobs WHERE id=?")
			.get(idSchema.parse(id)) as { data: string } | null;
		return row ? generationJobSchema.parse(JSON.parse(row.data)) : null;
	}
	beginGeneration(value: unknown) {
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
	finishGeneration(id: string, value: unknown) {
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
			return this.writeGeneration({
				...job,
				...input,
				updatedAt: new Date().toISOString(),
			});
		})();
	}

	analysis(id: string): MediaAnalysis | null {
		const row = this.db
			.query("SELECT data FROM analyses WHERE id=?")
			.get(idSchema.parse(id)) as { data: string } | null;
		return row ? analysisSchema.parse(JSON.parse(row.data)) : null;
	}
	putAnalysis(value: MediaAnalysis) {
		const result = analysisSchema.parse(value);
		this.db
			.query("INSERT OR REPLACE INTO analyses VALUES (?,?)")
			.run(result.assetId, JSON.stringify(result));
	}
	transcript(id: string): Transcript | null {
		const row = this.db
			.query("SELECT data FROM transcripts WHERE id=?")
			.get(idSchema.parse(id)) as { data: string } | null;
		return row ? transcriptSchema.parse(JSON.parse(row.data)) : null;
	}
	private putTranscript(value: Transcript): Transcript {
		const result = transcriptSchema.parse(value);
		this.db
			.query("INSERT OR REPLACE INTO transcripts VALUES (?,?)")
			.run(result.assetId, JSON.stringify(result));
		return result;
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
	restartTranscript(asset: Asset, revision: number | null): Transcript {
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
			updatedAt: new Date().toISOString(),
		});
	}
	beginTranscript(asset: Asset): Transcript {
		if (!asset.hasAudio) {
			throw new Error("This media has no audio to transcribe.");
		}
		const current = this.transcript(asset.id);
		if (current?.status === "completed" || current?.status === "running") {
			return current;
		}
		return this.putTranscript(
			current
				? {
						...current,
						status: "running",
						revision: current.revision + 1,
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
		return (
			this.db
				.query("SELECT data FROM search_indexes ORDER BY rowid DESC LIMIT 2000")
				.all() as { data: string }[]
		).map((row) => {
			const index = searchIndexSchema.parse(JSON.parse(row.data));
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
			.run(index.assetId, JSON.stringify(index));
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
			const { current, ...index } = old;
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
		const { current, ...index } = found;
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
		const { current, ...index } = found;
		return this.putSearchIndex({
			...index,
			revision: revision + 1,
			obsolete: index.obsolete.filter((entry) => entry.docId !== docId),
			updatedAt: new Date().toISOString(),
		});
	}
	assets(): Asset[] {
		return (
			this.db
				.query("SELECT data FROM assets ORDER BY rowid DESC LIMIT 2000")
				.all() as { data: string }[]
		).map((r) => assetSchema.parse(JSON.parse(r.data)));
	}
	putAsset(asset: Asset) {
		this.db
			.query("INSERT INTO assets VALUES (?, ?)")
			.run(asset.id, JSON.stringify(assetSchema.parse(asset)));
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
	): {
		asset: Asset;
		clipsRemoved: number;
		deleted: boolean;
		projects: Project[];
	} {
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
				)
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
					this.writeRevision(project, {
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
					});
				}
			})();
			return {
				asset,
				clipsRemoved,
				deleted: true,
				projects: this.projects(),
			};
		}
		const next = assetSchema.parse({
			...asset,
			...(input.name === undefined ? {} : { name: input.name }),
			...(input.folder === undefined
				? {}
				: input.folder
					? { folder: input.folder }
					: { folder: undefined }),
		});
		this.db
			.query("UPDATE assets SET data=? WHERE id=?")
			.run(JSON.stringify(next), idSchema.parse(id));
		return { asset: next, clipsRemoved: 0, deleted: false, projects };
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
		return (
			this.db
				.query("SELECT data FROM projects ORDER BY rowid DESC LIMIT 500")
				.all() as { data: string }[]
		).map((r) => projectSchema.parse(JSON.parse(r.data)));
	}
	project(id: string): Project {
		const row = this.db
			.query("SELECT data FROM projects WHERE id=?")
			.get(idSchema.parse(id)) as { data: string } | null;
		if (!row) {
			throw new Error("Project not found.");
		}
		return projectSchema.parse(JSON.parse(row.data));
	}
	create(title: string): Project {
		if (this.projects().length >= 500) {
			throw new Error("Project library is full.");
		}
		const p = projectSchema.parse(newProject(title));
		this.db
			.query("INSERT INTO projects VALUES (?,?)")
			.run(p.id, JSON.stringify(p));
		return p;
	}
	duplicate(id: string, title?: string): Project {
		if (this.projects().length >= 500) {
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
		this.db
			.query("INSERT INTO projects VALUES (?,?)")
			.run(copy.id, JSON.stringify(copy));
		return copy;
	}
	save(input: unknown): Project {
		const p = validateProject(input, this.assets());
		return this.db.transaction(() => {
			const current = this.project(p.id);
			if (current.revision !== p.revision) {
				throw new ConflictError(
					"This project changed in another editor. Reload before saving."
				);
			}
			// Approval belongs to the exact scene content, never a mutable title or take.
			p.scenes = p.scenes.map((scene) => {
				const old = current.scenes.find((s) => s.id === scene.id);
				const changed =
					old &&
					(old.duration !== scene.duration ||
						old.sourceIn !== scene.sourceIn ||
						JSON.stringify(old.audioOffsets ?? {}) !==
							JSON.stringify(scene.audioOffsets ?? {}) ||
						(old.muteVisualAudio ?? false) !==
							(scene.muteVisualAudio ?? false) ||
						old.script !== scene.script ||
						old.prompt !== scene.prompt ||
						old.title !== scene.title ||
						JSON.stringify(old.assetIds) !== JSON.stringify(scene.assetIds));
				const approved = Boolean(old?.approved) && !changed;
				return {
					...scene,
					approved,
					reviewStatus: approved
						? "approved"
						: changed
							? "in-review"
							: (scene.reviewStatus ?? "in-review"),
				};
			});
			return this.writeRevision(current, p);
		})();
	}
	private writeRevision(current: Project, p: Project): Project {
		this.db
			.query("INSERT INTO history VALUES (?,?,?)")
			.run(current.id, current.revision, JSON.stringify(current));
		p.revision += 1;
		p.updatedAt = new Date().toISOString();
		this.db
			.query("UPDATE projects SET data=? WHERE id=?")
			.run(JSON.stringify(p), p.id);
		this.db
			.query("DELETE FROM history WHERE project_id=? AND revision < ?")
			.run(p.id, Math.max(0, p.revision - 100));
		return p;
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
		return (
			this.db
				.query(
					"SELECT data FROM history WHERE project_id=? ORDER BY revision DESC LIMIT 100"
				)
				.all(idSchema.parse(id)) as { data: string }[]
		).map((r) => projectSchema.parse(JSON.parse(r.data)));
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
				validateProject(
					{ ...target, revision: current.revision },
					this.assets()
				)
			);
		})();
	}
	jobs(): RenderJob[] {
		return (
			this.db
				.query("SELECT data FROM jobs ORDER BY rowid DESC LIMIT 500")
				.all() as { data: string }[]
		).map((r) => JSON.parse(r.data) as RenderJob);
	}
	putJob(job: RenderJob) {
		this.db
			.query("INSERT OR REPLACE INTO jobs VALUES (?,?)")
			.run(job.id, JSON.stringify(job));
	}
	close() {
		this.db.close();
	}
}
