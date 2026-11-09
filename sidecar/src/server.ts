import { readdirSync, rmSync } from "node:fs";
import { open, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { bearerOk } from "@ryu/sidecar-runtime";
import { isContentSealError } from "@ryu/sidecar-runtime/content";
import { SealUnavailableError } from "@ryu/sidecar-runtime/content-seal";
import { z } from "zod";
import { sourceBeats } from "../../shared/analysis.ts";
import { approvalPolicyRequestSchema } from "../../shared/approval-policy.ts";
import { audioPlaybackSchema } from "../../shared/audio.ts";
import {
	beatCutsRequestSchema,
	musicClipBeats,
	snapCutsToBeats,
} from "../../shared/beat-cuts.ts";
import {
	captionEditRequestSchema,
	editCaptions,
} from "../../shared/caption-edits.ts";
import {
	copyClipSettings,
	copyClipSettingsRequestSchema,
	setClipProperties,
	setClipPropertiesRequestSchema,
	swapClipMedia,
	swapClipMediaRequestSchema,
} from "../../shared/clip-edits.ts";
import {
	manageClipLinks,
	manageClipLinksRequestSchema,
} from "../../shared/clip-links.ts";
import {
	applyColor,
	colorEditRequestSchema,
} from "../../shared/color-edits.ts";
import { creditsForProject, creditsMarkdown } from "../../shared/credits.ts";
import { appendDecisionRequestSchema } from "../../shared/decisions.ts";
import {
	detachAllClipAudio,
	detachAudioRequestSchema,
	detachableClipIds,
	detachClipAudio,
	hasExtractableAudio,
} from "../../shared/detach-audio.ts";
import {
	applyEffects,
	effectEditRequestSchema,
} from "../../shared/effect-edits.ts";
import {
	fillerPlanRequestSchema,
	fillerRanges,
	findFillers,
	transcriptClipSpans,
} from "../../shared/filler-words.ts";
import { MAX_FONT_BYTES } from "../../shared/font-file.ts";
import {
	freezeFrame,
	freezeFrameRequestSchema,
	planFreezeFrame,
} from "../../shared/freeze-frame.ts";
import {
	generationOutcomeSchema,
	generationRequestSchema,
} from "../../shared/generation.ts";
import {
	highlightsRequestSchema,
	scoreHighlights,
} from "../../shared/highlights.ts";
import { importMediaRequestSchema } from "../../shared/import-media.ts";
import { insertClips, insertClipsRequestSchema } from "../../shared/insert.ts";
import {
	interchangeFilename,
	interchangeFormatSchema,
	interchangeText,
} from "../../shared/interchange.ts";
import {
	applyLayout,
	layoutRequestSchema,
	layoutSchema,
} from "../../shared/layouts.ts";
import { MAX_TRACK_INDEX, trackIndexSchema } from "../../shared/limits.ts";
import {
	mediaSearchRequestSchema,
	searchMedia,
} from "../../shared/media-search.ts";
import { projectPackage, projectPackageSchema } from "../../shared/package.ts";
import { productionActivity } from "../../shared/production-activity.ts";
import {
	canStartGeneration,
	productionBudgetStatus,
} from "../../shared/production-budget.ts";
import { productionPreflightSchema } from "../../shared/production-preflight.ts";
import { productionReadiness } from "../../shared/production-readiness.ts";
import {
	stageTransitionRequestSchema,
	transitionProductionStage,
} from "../../shared/production-stages.ts";
import {
	type Asset,
	activeCaptions,
	assetSchema,
	captionSchema,
	idSchema,
	type Project,
	projectDuration,
	projectSchema,
	rippleDeleteRange,
	SUBTITLE_EXPORT_FORMATS,
	subtitleText,
} from "../../shared/project.ts";
import { composeRecipe, recipeSchema } from "../../shared/recipes.ts";
import {
	removeWordRanges,
	removeWordsRequestSchema,
} from "../../shared/remove-words.ts";
import {
	appendResearchSource,
	removeResearchSource,
	researchMutationSchema,
} from "../../shared/research.ts";
import { reverseClips, reverseRequestSchema } from "../../shared/reverse.ts";
import { createSequenceRequestSchema } from "../../shared/sequences.ts";
import {
	applySpeedCurve,
	bakeSpeedCurve,
	bakeSpeedCurveRequestSchema,
	removeSpeedCurve,
	removeSpeedCurveRequestSchema,
	resetSpeedRamp,
	resetSpeedRampRequestSchema,
	speedCurveRequestSchema,
	speedRamp,
	speedRampRequestSchema,
} from "../../shared/speed-ramp.ts";
import {
	applySplitEditRequest,
	applySplitEdits,
	applySplitEditsRequestSchema,
	proposeSplitEdits,
	speechEvidenceFromTranscript,
	splitEditPlanRequestSchema,
	splitEditRequestSchema,
} from "../../shared/split-edits.ts";
import {
	generateStageWorld,
	stageWorldRequestSchema,
} from "../../shared/stage-world.ts";
import { stockProviderSchema } from "../../shared/stock.ts";
import { assembleStoryboard } from "../../shared/storyboard.ts";
import { studioErrorDetail } from "../../shared/studio-error.ts";
import {
	addClips,
	addClipsRequestSchema,
	moveClip,
	moveClipRequestSchema,
	setKeyframes,
	setKeyframesRequestSchema,
} from "../../shared/timeline-edits.ts";
import { timelineSummary } from "../../shared/timeline-summary.ts";
import { timelineTranscript } from "../../shared/timeline-transcript.ts";
import {
	timelineCreateRequestSchema,
	timelineSummaryFor,
} from "../../shared/timelines.ts";
import {
	editTitles,
	titleEditRequestSchema,
} from "../../shared/title-edits.ts";
import { trimEdit, trimEditRequestSchema } from "../../shared/trim-modes.ts";
import { undoRequestSchema } from "../../shared/undo.ts";
import { AnalysisQueue } from "./analysis.ts";
import { extractAudioWindow } from "./audio-window.ts";
import {
	captureTimelineFrame,
	inspectMediaAsset,
	renderTimelineFrame,
} from "./capture.ts";
import {
	completedWaveform,
	heardProject,
	timelineSceneCuts,
	timelineText,
	timelineWaveform,
} from "./edit-evidence.ts";
import { derivedAudioFor, extractAssetAudio } from "./extract-audio.ts";
import { fontLibraryFor } from "./font-library.ts";
import { captureSourceFrame } from "./freeze.ts";
import { importMediaAsset } from "./import-media.ts";
import { lutStoreFor } from "./lut-store.ts";
import { probe, thumbnail } from "./media.ts";
import { MediaBusyError, withMediaOperation } from "./media-operation.ts";
import { autoProxyOnImport, libraryAssets } from "./proxy.ts";
import { RenderQueue } from "./render.ts";
import {
	assertReversible,
	MAX_REVERSE_RENDERS,
	reverseAsset,
	reversedAssetFor,
} from "./reverse.ts";
import { studioRoutes } from "./routes/index.ts";
import { projectArchiveResponse } from "./routes/package-archive.ts";
import {
	type ClaimedUpload,
	describeOperation,
	dispatchStudioRoute,
	mergeRouteOperations,
	type OpenApiPaths,
	type StudioJsonSchema,
	type StudioRoute,
	type StudioRouteServices,
	studioJson,
} from "./routes/registry.ts";
import { createSequenceAsset, refreshSequenceAsset } from "./sequence.ts";
import { currentShotIndexes } from "./shot-stats.ts";
import { SoundtrackBusyError } from "./soundtrack.ts";
import {
	importArchiveVideo,
	importCoverrVideo,
	importNasaVideo,
	importOpenverseAudio,
	importOpenverseImage,
	importPexelsVideo,
	importPixabayVideo,
	importUnsplashImage,
	importWikimediaVideo,
	searchArchive,
	searchCoverr,
	searchNasa,
	searchOpenverseAudio,
	searchOpenverseImages,
	searchPexels,
	searchPixabay,
	searchUnsplashImages,
	searchWikimedia,
} from "./stock.ts";
import {
	ConflictError,
	MAX_MEDIA_ASSETS,
	type MediaReservation,
	type StudioStore,
} from "./store.ts";

const chunkSize = 512 * 1024;
const UPLOAD_IDLE_MS = 30 * 60_000;
const maxMediaBytes = 2 * 1024 * 1024 * 1024;
/** Most chunked uploads open at once. */
const MAX_OPEN_UPLOADS = 4;
const uploadSchema = z
	.object({
		name: z.string().trim().min(1).max(200),
		/**
		 * `media` (default) is finished into a media asset; `font` is claimed
		 * by `POST /fonts {uploadId}`, is limited to the font import size, and
		 * does not count toward the media asset limit.
		 */
		purpose: z.enum(["media", "font"]).default("media"),
		size: z.number().int().min(1).max(maxMediaBytes),
	})
	.strict()
	.refine((input) => input.purpose !== "font" || input.size <= MAX_FONT_BYTES, {
		message: `A font upload is at most ${(MAX_FONT_BYTES / 1_000_000).toFixed(1)} MB.`,
		path: ["size"],
	});
const chunkSchema = z
	.object({
		offset: z.number().int().nonnegative(),
		data: z.string().max(700_000),
	})
	.strict();
const prefix = "/api/video-studio";
/** Source audio extractions one detach request may start. */
const MAX_AUDIO_EXTRACTIONS = 16;
const nearTimeBodySchema = z.looseObject({
	nearTime: z.number().finite().min(0).max(7200).optional(),
});
const beatSourceBodySchema = z.looseObject({
	musicClipId: idSchema.optional(),
});
export const budgetPayloadSchema = z.json();
type BudgetPayload = z.infer<typeof budgetPayloadSchema>;
const budgetAuditEnvelopeSchema = z.object({ entries: z.array(z.json()) });
type BudgetAuditEntries = z.infer<typeof budgetAuditEnvelopeSchema>["entries"];
interface Upload {
	busy: boolean;
	id: string;
	name: string;
	offset: number;
	path: string;
	purpose: "font" | "media";
	reservation: MediaReservation;
	size: number;
	updated: number;
}

export function createStudioServer(options: {
	budgetAudit?: () => Promise<BudgetPayload>;
	budgetSpend?: () => Promise<BudgetPayload>;
	/** Route modules dispatched after the built-in handlers. */
	routes?: readonly StudioRoute[];
	store: StudioStore;
	token: string;
	port: number;
}) {
	const { store, token } = options;
	const routes = options.routes ?? studioRoutes;
	// Built and validated once: throws when a registry route would be
	// shadowed by a built-in handler, so a collision fails at startup.
	const openapiDocument = openapi(routes);
	const queue = new RenderQueue(store);
	const analyses = new AnalysisQueue(store);
	const soundtrackShutdown = new AbortController();
	const mediaShutdown = new AbortController();
	const mediaSignal = (request: Request) =>
		AbortSignal.any([request.signal, mediaShutdown.signal]);
	// Heavy video gets its standard preview proxy after import (W2-M1). It is
	// best effort and runs after the response; a later `POST /proxies` sweep
	// retries anything that failed or found the media queue busy.
	const proxyInBackground = (asset: Asset) => {
		if (asset.kind !== "video") {
			return;
		}
		autoProxyOnImport(store, asset, { signal: mediaShutdown.signal }).catch(
			() => undefined
		);
	};
	const uploads = new Map<string, Upload>();
	// The upload map is in memory, so partial files from a previous run are orphans
	// that would otherwise count toward the media quota forever.
	for (const entry of readdirSync(join(store.directory, "media"), {
		withFileTypes: true,
	})) {
		if (entry.isFile() && entry.name.endsWith(".upload")) {
			rmSync(join(store.directory, "media", entry.name), { force: true });
		}
	}
	const sweepStaleUploads = async () => {
		for (const [key, value] of uploads) {
			if (!value.busy && Date.now() - value.updated > UPLOAD_IDLE_MS) {
				uploads.delete(key);
				await rm(value.path, { force: true });
				value.reservation.release();
			}
		}
	};
	const uploadSweep = setInterval(() => {
		sweepStaleUploads().catch(() => undefined);
	}, 60_000);
	uploadSweep.unref();
	const json = studioJson;
	const revisionedProjectEdit = (
		id: string,
		revision: number,
		message: string,
		apply: (project: Project, assets: readonly Asset[]) => Project
	) => {
		const project = store.project(id);
		if (project.revision !== revision) {
			throw new ConflictError(message);
		}
		return json(store.save(apply(project, store.assets())));
	};
	/** Revision-checked read of a project before slow media work starts. */
	const currentProject = (id: string, revision: number, message: string) => {
		const project = store.project(id);
		if (project.revision !== revision) {
			throw new ConflictError(message);
		}
		return project;
	};
	const analysisFor = (assetId: string) => store.analysis(assetId);
	const transcriptFor = (assetId: string) => store.transcript(assetId);
	/** Bodies of read-only plan routes may be empty. */
	const optionalBody = async (request: Request): Promise<unknown> => {
		const text = await request.text();
		return text.trim() ? JSON.parse(text) : {};
	};
	/**
	 * Extract embedded audio for the given video assets under one media
	 * admission. Already-extracted sources are skipped.
	 */
	const extractMissingAudio = async (
		assetIds: Iterable<string>,
		signal: AbortSignal
	) => {
		const assets = store.assets();
		const missing = [...new Set(assetIds)]
			.map((assetId) => assets.find((asset) => asset.id === assetId))
			.filter(
				(asset): asset is Asset =>
					hasExtractableAudio(asset) && !derivedAudioFor(assets, asset.id)
			);
		if (!missing.length) {
			return;
		}
		if (missing.length > MAX_AUDIO_EXTRACTIONS) {
			throw new Error(
				`Detach audio from clips of at most ${MAX_AUDIO_EXTRACTIONS} different media files at once. Detach the rest in another request.`
			);
		}
		await withMediaOperation(60 * 60_000, { signal }, async (operation) => {
			for (const asset of missing) {
				await extractAssetAudio(store, asset, { operation });
			}
		});
	};
	const auditEntries = async (): Promise<BudgetAuditEntries> => {
		if (!options.budgetAudit) {
			return [];
		}
		try {
			const result = budgetAuditEnvelopeSchema.safeParse(
				await options.budgetAudit()
			);
			return result.success ? result.data.entries : [];
		} catch {
			return [];
		}
	};
	const readChunk = async (path: string, offset: number) => {
		const file = Bun.file(path);
		const size = file.size;
		if (offset > size) {
			throw new Error("Offset exceeds file size.");
		}
		return json({
			data: Buffer.from(
				await file.slice(offset, offset + chunkSize).arrayBuffer()
			).toString("base64"),
			offset,
			size,
			done: offset + chunkSize >= size,
		});
	};
	const claimUpload = (uploadId: string): ClaimedUpload => {
		const upload = uploads.get(uploadId);
		if (!upload) {
			throw new Error("Upload not found or expired.");
		}
		if (upload.busy) {
			throw new ConflictError("An upload chunk is already being processed.");
		}
		if (upload.offset !== upload.size) {
			throw new Error("The upload is incomplete.");
		}
		uploads.delete(upload.id);
		return {
			dispose: async () => {
				await rm(upload.path, { force: true });
				upload.reservation.release();
			},
			name: upload.name,
			path: upload.path,
			size: upload.size,
		};
	};
	const services: StudioRouteServices = {
		analyses,
		claimUpload,
		currentProject,
		extractMissingAudio,
		json,
		mediaSignal,
		optionalBody,
		queue,
		revisionedProjectEdit,
		soundtrackSignal: (request) =>
			AbortSignal.any([request.signal, soundtrackShutdown.signal]),
		store,
		uploadLimits: { chunkSize, maxMediaBytes },
	};
	const server = Bun.serve({
		hostname: "127.0.0.1",
		idleTimeout: 120,
		port: options.port,
		maxRequestBodySize: 2 * 1024 * 1024,
		async fetch(request) {
			const url = new URL(request.url);
			if (url.pathname === "/health") {
				return json({ ok: true });
			}
			if (!bearerOk(request.headers.get("authorization") ?? undefined, token)) {
				return json({ code: "UNAUTHORIZED", message: "Unauthorized" }, 401);
			}
			try {
				if (url.pathname === "/openapi.json") {
					return json(openapiDocument);
				}
				if (!url.pathname.startsWith(`${prefix}/`)) {
					return json({ code: "NOT_FOUND" }, 404);
				}
				const parts = url.pathname.slice(prefix.length + 1).split("/");
				const [resource, rawId, action, subaction] = parts;
				const id =
					rawId &&
					!(
						(resource === "assets" && rawId === "import") ||
						(resource === "stock" && rawId === "search") ||
						(resource === "budget" && rawId === "audit") ||
						(resource === "projects" && rawId === "package")
					)
						? idSchema.parse(rawId)
						: undefined;
				const method = request.method;
				if (resource === "generations") {
					if (!id && method === "GET") {
						return json({
							jobs: store.generationJobs(
								url.searchParams.get("projectId") ?? undefined
							),
						});
					}
					if (!id && method === "POST") {
						const input = generationRequestSchema.parse(await request.json());
						if (!store.generationJob(input.id)) {
							const receipts = await auditEntries();
							if (store.generationJob(input.id)) {
								return json(store.beginGeneration(input));
							}
							const project = store.project(input.projectId);
							const admission = canStartGeneration(
								project,
								store.generationBudgetJobs(project.id),
								input.kind,
								receipts
							);
							if (!admission.allowed) {
								return json(
									{
										code: "BUDGET_EXCEEDED",
										message:
											"This project budget cannot admit another generation at its configured estimate.",
										estimateMicroUsd: admission.estimateMicroUsd,
										budget: admission.status,
									},
									402
								);
							}
						}
						return json(store.beginGeneration(input));
					}
					if (id && method === "GET") {
						return json(store.generationJob(id));
					}
					if (id && method === "PUT") {
						return json(store.finishGeneration(id, await request.json()));
					}
				}
				if (resource === "timelines") {
					if (!id && method === "GET") {
						return json({
							timelines: store.projects().map(timelineSummaryFor),
						});
					}
					if (!id && method === "POST") {
						const input = timelineCreateRequestSchema.parse(
							await request.json()
						);
						const timeline = input.from
							? store.duplicate(input.from, input.title)
							: store.create(
									input.title ?? `Timeline ${store.projects().length + 1}`
								);
						return json(timeline, 201);
					}
					if (id && !action && method === "GET") {
						return json(store.project(id));
					}
				}
				if (resource === "budget" && !rawId && method === "GET") {
					if (!options.budgetSpend) {
						return json({
							reachable: false,
							error: "Gateway budget is unavailable from this host",
						});
					}
					try {
						return json(await options.budgetSpend());
					} catch (error) {
						return json({
							reachable: false,
							error:
								error instanceof Error
									? error.message
									: "Gateway budget unavailable",
						});
					}
				}
				if (resource === "budget" && rawId === "audit" && method === "GET") {
					if (!options.budgetAudit) {
						return json({
							reachable: false,
							error: "Gateway audit is unavailable from this host",
							entries: [],
						});
					}
					try {
						return json(await options.budgetAudit());
					} catch (error) {
						return json({
							reachable: false,
							error:
								error instanceof Error
									? error.message
									: "Gateway audit unavailable",
							entries: [],
						});
					}
				}
				if (resource === "stock" && rawId === "search" && method === "GET") {
					const query = url.searchParams.get("q") ?? "";
					const limit = Number(url.searchParams.get("limit") ?? "8");
					const provider = stockProviderSchema.parse(
						url.searchParams.get("provider") ?? "archive.org"
					);
					return json({
						provider,
						results:
							provider === "archive.org"
								? await searchArchive(query, Number.isFinite(limit) ? limit : 8)
								: provider === "coverr"
									? await searchCoverr(
											query,
											Number.isFinite(limit) ? limit : 8
										)
									: provider === "openverse.audio"
										? await searchOpenverseAudio(
												query,
												Number.isFinite(limit) ? limit : 8
											)
										: provider === "openverse.image"
											? await searchOpenverseImages(
													query,
													Number.isFinite(limit) ? limit : 8
												)
											: provider === "unsplash.image"
												? await searchUnsplashImages(
														query,
														Number.isFinite(limit) ? limit : 8
													)
												: provider === "wikimedia.commons"
													? await searchWikimedia(
															query,
															Number.isFinite(limit) ? limit : 8
														)
													: provider === "nasa"
														? await searchNasa(
																query,
																Number.isFinite(limit) ? limit : 8
															)
														: provider === "pexels"
															? await searchPexels(
																	query,
																	Number.isFinite(limit) ? limit : 8
																)
															: await searchPixabay(
																	query,
																	Number.isFinite(limit) ? limit : 8
																),
					});
				}
				if (resource === "stock" && !rawId && method === "POST") {
					const input = z
						.object({
							identifier: z.string().trim().min(1).max(200),
							provider: stockProviderSchema.default("archive.org"),
						})
						.strict()
						.parse(await request.json());
					return json(
						await (input.provider === "archive.org"
							? importArchiveVideo(store, input.identifier)
							: input.provider === "coverr"
								? importCoverrVideo(store, input.identifier)
								: input.provider === "openverse.audio"
									? importOpenverseAudio(store, input.identifier)
									: input.provider === "openverse.image"
										? importOpenverseImage(store, input.identifier)
										: input.provider === "unsplash.image"
											? importUnsplashImage(store, input.identifier)
											: input.provider === "wikimedia.commons"
												? importWikimediaVideo(store, input.identifier)
												: input.provider === "nasa"
													? importNasaVideo(store, input.identifier)
													: input.provider === "pexels"
														? importPexelsVideo(store, input.identifier)
														: importPixabayVideo(store, input.identifier)),
						201
					);
				}

				if (resource === "projects") {
					if (rawId === "package" && method === "POST") {
						const bundle = projectPackageSchema.parse(await request.json());
						const assets = store.assets();
						const available = new Set(assets.map((asset) => asset.id));
						const missing = bundle.assets
							.map((asset) => asset.id)
							.filter((assetId) => !available.has(assetId));
						if (missing.length) {
							throw new Error(
								`Package references media that is not on this node: ${missing.slice(0, 8).join(", ")}`
							);
						}
						const created = store.create(
							`${bundle.project.title} (imported)`,
							bundle.project.requireApproval
						);
						return json(
							store.save({
								...bundle.project,
								id: created.id,
								revision: created.revision,
								title: `${bundle.project.title} (imported)`,
								updatedAt: new Date().toISOString(),
							})
						);
					}
					if (!id && method === "GET") {
						return json({ projects: store.projects() });
					}
					if (!id && method === "POST") {
						return json(
							store.create(
								z
									.object({ title: z.string().trim().min(1).max(200) })
									.strict()
									.parse(await request.json()).title
							),
							201
						);
					}
					if (id && !action && method === "GET") {
						return json(store.project(id));
					}
					if (id && action === "timeline" && method === "GET") {
						return json(timelineSummary(store.project(id), store.assets()));
					}
					if (id && action === "transcript" && method === "GET") {
						const track = url.searchParams.has("track")
							? z.coerce
									.number()
									.pipe(trackIndexSchema)
									.parse(url.searchParams.get("track"))
							: undefined;
						return json(
							timelineTranscript(
								store.project(id),
								(assetId) => store.transcript(assetId),
								track
							)
						);
					}
					if (id && action === "remove-words" && method === "POST") {
						const input = removeWordsRequestSchema.parse(await request.json());
						return revisionedProjectEdit(
							id,
							input.revision,
							"The project changed. Reload before removing transcript ranges.",
							(project, assets) => removeWordRanges(project, assets, input)
						);
					}
					if (id && action === "duplicate" && method === "POST") {
						const input = z
							.object({ title: z.string().trim().min(1).max(200).optional() })
							.strict()
							.parse(await request.json());
						return json(store.duplicate(id, input.title), 201);
					}
					if (id && action === "sequence" && method === "POST") {
						const input = createSequenceRequestSchema.parse(
							await request.json()
						);
						const parent = store.project(id);
						if (parent.revision !== input.revision) {
							throw new ConflictError(
								"The project changed. Reload before creating a sequence clip."
							);
						}
						const source = store.project(input.sourceProjectId);
						return json(
							await createSequenceAsset(store, parent, source, input.name, {
								signal: mediaSignal(request),
							}),
							201
						);
					}
					if (id && action === "add" && method === "POST") {
						const input = addClipsRequestSchema.parse(await request.json());
						return revisionedProjectEdit(
							id,
							input.revision,
							"The project changed. Reload before adding clips.",
							(project, assets) => addClips(project, assets, input)
						);
					}
					if (id && action === "move" && method === "POST") {
						const input = moveClipRequestSchema.parse(await request.json());
						return revisionedProjectEdit(
							id,
							input.revision,
							"The project changed. Reload before moving the clip.",
							(project, assets) => moveClip(project, assets, input)
						);
					}
					if (id && action === "links" && method === "POST") {
						const input = manageClipLinksRequestSchema.parse(
							await request.json()
						);
						return revisionedProjectEdit(
							id,
							input.revision,
							"The project changed. Reload before updating clip links.",
							(project, assets) => manageClipLinks(project, assets, input)
						);
					}
					if (id && action === "detach-audio" && method === "POST") {
						const input = detachAudioRequestSchema.parse(await request.json());
						const message =
							"The project changed. Reload before detaching clip audio.";
						const project = currentProject(id, input.revision, message);
						const detachable = new Set(
							detachableClipIds(project, store.assets())
						);
						await extractMissingAudio(
							project.segments
								.filter(
									(segment) =>
										input.clipIds.includes(segment.id) &&
										detachable.has(segment.id)
								)
								.map((segment) => segment.assetId),
							mediaSignal(request)
						);
						return revisionedProjectEdit(
							id,
							input.revision,
							message,
							(current, assets) =>
								detachClipAudio(current, assets, input, (assetId) =>
									derivedAudioFor(assets, assetId)
								)
						);
					}
					if (id && action === "split-edit" && method === "POST") {
						const { nearTime, ...body } = nearTimeBodySchema.parse(
							await request.json()
						);
						const input = splitEditRequestSchema.parse(body);
						const project = currentProject(
							id,
							input.revision,
							"The project changed. Reload before changing the split edit."
						);
						const result = applySplitEditRequest(
							project,
							store.assets(),
							input,
							nearTime
						);
						return json({
							appliedOffset: result.appliedOffset,
							key: result.key,
							project: store.save(result.project),
						});
					}
					if (id && action === "split-edit-plan" && method === "POST") {
						const input = splitEditPlanRequestSchema.parse(
							await optionalBody(request)
						);
						const project = store.project(id);
						const plan = proposeSplitEdits(
							project,
							store.assets(),
							{
								waveformFor: (assetId) =>
									completedWaveform(analysisFor, assetId),
								wordsFor: (assetId) =>
									speechEvidenceFromTranscript(transcriptFor(assetId)),
							},
							input.options ?? {}
						);
						return json({ revision: project.revision, ...plan });
					}
					if (id && action === "split-edits" && method === "POST") {
						const input = applySplitEditsRequestSchema.parse(
							await request.json()
						);
						const message =
							"The project changed. Reload before applying split edits.";
						let project = currentProject(id, input.revision, message);
						if (input.detachAudio) {
							const detachable = new Set(
								detachableClipIds(project, store.assets())
							);
							await extractMissingAudio(
								project.segments
									.filter((segment) => detachable.has(segment.id))
									.map((segment) => segment.assetId),
								mediaSignal(request)
							);
							project = currentProject(id, input.revision, message);
						}
						const assets = store.assets();
						const prepared = input.detachAudio
							? detachAllClipAudio(project, assets, (assetId) =>
									derivedAudioFor(assets, assetId)
								)
							: project;
						const options: { crossfade?: number } = {};
						if (input.crossfade !== undefined) {
							options.crossfade = input.crossfade;
						}
						const result = applySplitEdits(
							prepared,
							assets,
							input.proposals,
							options
						);
						return json({
							applied: result.applied,
							project: store.save(result.project),
							skipped: result.skipped,
						});
					}
					if (id && action === "filler-plan" && method === "POST") {
						const input = fillerPlanRequestSchema.parse(
							await optionalBody(request)
						);
						const project = store.project(id);
						const timeline = timelineTranscript(
							project,
							transcriptFor,
							input.track
						);
						const options: Parameters<typeof findFillers>[1] = {
							protect: timelineTranscript(project, transcriptFor),
							spans: transcriptClipSpans(project, timeline),
						};
						if (input.fillers) {
							options.fillers = input.fillers;
						}
						if (input.minGapForLike !== undefined) {
							options.minGapForLike = input.minGapForLike;
						}
						if (input.multiWord !== undefined) {
							options.multiWord = input.multiWord;
						}
						if (input.padding !== undefined) {
							options.padding = input.padding;
						}
						if (input.repeatWindow !== undefined) {
							options.repeatWindow = input.repeatWindow;
						}
						const hits = findFillers(timeline, options);
						const merge: { maxEnd: number; mergeGap?: number } = {
							maxEnd: projectDuration(project),
						};
						if (input.mergeGap !== undefined) {
							merge.mergeGap = input.mergeGap;
						}
						return json({
							hits,
							ranges: fillerRanges(hits, merge),
							revision: project.revision,
						});
					}
					if (id && action === "trim-edit" && method === "POST") {
						const input = trimEditRequestSchema.parse(await request.json());
						const project = currentProject(
							id,
							input.revision,
							"The project changed. Reload before trimming."
						);
						const result = trimEdit(project, store.assets(), input);
						return json({
							applied: result.applied,
							project:
								result.applied === 0 ? project : store.save(result.project),
						});
					}
					if (id && action === "freeze-frame" && method === "POST") {
						const input = freezeFrameRequestSchema.parse(await request.json());
						const message =
							"The project changed. Reload before adding a freeze frame.";
						const project = currentProject(id, input.revision, message);
						const assets = store.assets();
						const plan = planFreezeFrame(project, assets, input);
						const source = assets.find((asset) => asset.id === plan.assetId);
						if (!source) {
							throw new Error("The clip's media is missing.");
						}
						// The still is registered and the edit saved in one synchronous
						// step; a conflict or refused edit discards the captured still.
						return await captureSourceFrame(
							store,
							source,
							plan.sourceTime,
							(still) =>
								revisionedProjectEdit(
									id,
									input.revision,
									message,
									(current, latest) =>
										freezeFrame(current, latest, input, still)
								),
							{ signal: mediaSignal(request) }
						);
					}
					if (id && action === "reverse" && method === "POST") {
						const input = reverseRequestSchema.parse(await request.json());
						const message =
							"The project changed. Reload before reversing clips.";
						const project = currentProject(id, input.revision, message);
						const assets = store.assets();
						// Dry pass: missing derivatives resolve to placeholders so every
						// structural check (locks, multicam, overlaps, validation) runs
						// before any media is rendered.
						const missing = new Map<string, Asset>();
						reverseClips(project, assets, input, (assetId) => {
							const found = reversedAssetFor(assets, assetId);
							if (found) {
								return found;
							}
							const source = assets.find((asset) => asset.id === assetId);
							if (!source) {
								return undefined;
							}
							missing.set(source.id, source);
							return {
								...source,
								derivation: "reverse",
								derivedFromAssetId: source.id,
								id: crypto.randomUUID(),
							};
						});
						if (missing.size > MAX_REVERSE_RENDERS) {
							throw new Error(
								`Reverse renders at most ${MAX_REVERSE_RENDERS} new media files per request. Reverse fewer clips at once.`
							);
						}
						for (const source of missing.values()) {
							assertReversible(source);
						}
						if (missing.size) {
							await withMediaOperation(
								60 * 60_000,
								{ signal: mediaSignal(request) },
								async (operation) => {
									for (const source of missing.values()) {
										await reverseAsset(store, source, { operation });
									}
								}
							);
						}
						return revisionedProjectEdit(
							id,
							input.revision,
							message,
							(current, latest) =>
								reverseClips(current, latest, input, (assetId) =>
									reversedAssetFor(latest, assetId)
								)
						);
					}
					if (
						id &&
						action === "speed-ramp" &&
						!subaction &&
						method === "POST"
					) {
						const input = speedRampRequestSchema.parse(await request.json());
						return revisionedProjectEdit(
							id,
							input.revision,
							"The project changed. Reload before ramping clip speed.",
							(project, assets) => speedRamp(project, assets, input)
						);
					}
					if (
						id &&
						action === "speed-ramp" &&
						subaction === "reset" &&
						method === "POST"
					) {
						const input = resetSpeedRampRequestSchema.parse(
							await request.json()
						);
						return revisionedProjectEdit(
							id,
							input.revision,
							"The project changed. Reload before resetting the speed ramp.",
							(project, assets) => resetSpeedRamp(project, assets, input)
						);
					}
					if (
						id &&
						action === "speed-curve" &&
						!subaction &&
						method === "POST"
					) {
						const input = speedCurveRequestSchema.parse(await request.json());
						return revisionedProjectEdit(
							id,
							input.revision,
							"The project changed. Reload before applying the speed curve.",
							(project, assets) => applySpeedCurve(project, assets, input)
						);
					}
					if (
						id &&
						action === "speed-curve" &&
						subaction === "remove" &&
						method === "POST"
					) {
						const input = removeSpeedCurveRequestSchema.parse(
							await request.json()
						);
						return revisionedProjectEdit(
							id,
							input.revision,
							"The project changed. Reload before removing the speed curve.",
							(project, assets) => removeSpeedCurve(project, assets, input)
						);
					}
					if (
						id &&
						action === "speed-curve" &&
						subaction === "bake" &&
						method === "POST"
					) {
						const input = bakeSpeedCurveRequestSchema.parse(
							await request.json()
						);
						return revisionedProjectEdit(
							id,
							input.revision,
							"The project changed. Reload before baking the speed curve.",
							(project, assets) => bakeSpeedCurve(project, assets, input)
						);
					}
					if (id && action === "beat-cuts" && method === "POST") {
						const { musicClipId, ...body } = beatSourceBodySchema.parse(
							await request.json()
						);
						const project = store.project(id);
						if (musicClipId && body.beats === undefined) {
							const music = project.segments.find(
								(segment) => segment.id === musicClipId
							);
							if (!music) {
								throw new Error("Music clip not found on this timeline.");
							}
							const analysis = store.analysis(music.assetId);
							if (analysis?.status !== "completed") {
								throw new Error(
									"Complete source analysis of the music before cutting to its beat."
								);
							}
							// Detected beats (and bar starts) when the analysis covers
							// the clip's source range; otherwise the waveform estimate.
							const derived = musicClipBeats(
								music,
								sourceBeats(analysis, {
									from: music.sourceIn,
									to: music.sourceOut,
								})
							);
							body.beats = derived.beats;
							if (body.downbeats === undefined && derived.downbeats) {
								body.downbeats = derived.downbeats;
							}
						}
						const input = beatCutsRequestSchema.parse(body);
						return revisionedProjectEdit(
							id,
							input.revision,
							"The project changed. Reload before cutting to the beat.",
							(current, assets) =>
								snapCutsToBeats(current, assets, input, {
									energyFor: (assetId) => {
										const waveform = completedWaveform(analysisFor, assetId);
										return waveform
											? { duration: waveform.duration, waveform: waveform.bins }
											: undefined;
									},
								})
						);
					}
					if (id && action === "highlights" && method === "POST") {
						const input = highlightsRequestSchema.parse(await request.json());
						const project = store.project(id);
						const assets = store.assets();
						const text = timelineText(
							timelineTranscript(heardProject(project), transcriptFor)
						);
						const scoring: Parameters<typeof scoreHighlights>[0] = {
							...input,
							...text,
							sceneCuts: timelineSceneCuts(project, assets, analysisFor),
						};
						const waveform = timelineWaveform(project, assets, analysisFor);
						if (waveform) {
							scoring.waveform = waveform;
						}
						return json({
							candidates: scoreHighlights(scoring),
							revision: project.revision,
						});
					}
					if (id && action === "keyframes" && method === "POST") {
						const input = setKeyframesRequestSchema.parse(await request.json());
						return revisionedProjectEdit(
							id,
							input.revision,
							"The project changed. Reload before updating keyframes.",
							(project, assets) => setKeyframes(project, assets, input)
						);
					}
					if (id && action === "readiness" && method === "GET") {
						const project = store.project(id);
						return json(
							productionReadiness(
								project,
								store.assets(),
								store.jobs().filter((job) => job.projectId === project.id)
							)
						);
					}
					if (id && action === "preflight" && method === "GET") {
						const project = store.project(id);
						const readiness = productionReadiness(
							project,
							store.assets(),
							store.jobs().filter((job) => job.projectId === project.id)
						);
						const checks = readiness.checks;
						const generations = store.generationJobs(project.id);
						const preflight = productionPreflightSchema.parse({
							blockers: checks.filter((check) => check.status === "blocked"),
							budget: productionBudgetStatus(
								project,
								store.generationBudgetJobs(project.id),
								await auditEntries()
							),
							decisions: project.decisions.length,
							exportReady: readiness.exportReady,
							generations: {
								needsReview: generations.filter((job) =>
									["incomplete", "interrupted"].includes(job.status)
								).length,
								pending: generations.filter((job) => job.status === "requested")
									.length,
							},
							nextStage:
								project.stages.find((stage) => stage.status !== "complete")
									?.id ?? null,
							ready: readiness.ready,
							revision: project.revision,
							stages: {
								completed: project.stages.filter(
									(stage) => stage.status === "complete"
								).length,
								total: 7,
							},
							warnings: checks.filter((check) => check.status === "optional"),
						});
						return json(preflight);
					}
					if (id && action === "stages" && method === "GET") {
						return json({ stages: store.project(id).stages });
					}
					if (id && action === "stages" && method === "POST") {
						const input = stageTransitionRequestSchema.parse(
							await request.json()
						);
						return revisionedProjectEdit(
							id,
							input.revision,
							"The project changed. Reload before updating production stages.",
							(project) => transitionProductionStage(project, input)
						);
					}
					if (id && action === "research" && method === "POST") {
						const input = researchMutationSchema.parse(await request.json());
						return revisionedProjectEdit(
							id,
							input.revision,
							"The project changed. Reload before updating research sources.",
							(project) => ({
								...project,
								researchSources:
									input.action === "append"
										? appendResearchSource(
												project.researchSources,
												input.source!
											)
										: removeResearchSource(
												project.researchSources,
												input.sourceId!
											),
							})
						);
					}
					if (id && action === "stage-world" && method === "POST") {
						const input = stageWorldRequestSchema.parse(await request.json());
						return revisionedProjectEdit(
							id,
							input.revision,
							"The project changed. Reload before generating a stage world.",
							(project) => {
								const world = generateStageWorld(
									input.prompt,
									input.startTime ?? 0
								);
								return {
									...project,
									spatialObjects: world.objects,
									stageCamera: world.camera,
									stageWorldPrompt: world.prompt,
								};
							}
						);
					}
					if (id && action === "activity" && method === "GET") {
						const project = store.project(id);
						return json(
							productionActivity(
								project,
								store.generationJobs(project.id),
								store.jobs().filter((job) => job.projectId === project.id)
							)
						);
					}
					if (id && action === "decisions" && method === "GET") {
						return json({ decisions: store.project(id).decisions });
					}
					if (id && action === "decisions" && method === "POST") {
						const input = appendDecisionRequestSchema.parse(
							await request.json()
						);
						return json(store.appendDecision(id, input));
					}
					if (id && action === "budget" && method === "GET") {
						const project = store.project(id);
						return json(
							productionBudgetStatus(
								project,
								store.generationBudgetJobs(project.id),
								await auditEntries()
							)
						);
					}
					if (id && action === "credits" && method === "GET") {
						const project = store.project(id);
						const credits = creditsForProject(
							project,
							store.assets(),
							await fontLibraryFor(store.directory).list()
						);
						return json({ ...credits, markdown: creditsMarkdown(credits) });
					}
					if (id && action === "package" && method === "GET") {
						if (url.searchParams.get("media") === "1") {
							return await projectArchiveResponse(store, id, json);
						}
						return json(
							projectPackage(
								store.project(id),
								store.assets(),
								await fontLibraryFor(store.directory).list()
							)
						);
					}
					if (id && action === "interchange" && method === "GET") {
						const format = interchangeFormatSchema.parse(
							url.searchParams.get("format") ?? "fcpxml"
						);
						const project = store.project(id);
						return json({
							filename: interchangeFilename(project, format),
							format,
							text: interchangeText(project, store.assets(), format),
						});
					}
					if (id && action === "clip-properties" && method === "POST") {
						const input = setClipPropertiesRequestSchema.parse(
							await request.json()
						);
						await lutStoreFor(store.directory).assertAvailable(input);
						const project = store.project(id);
						if (project.revision !== input.revision) {
							throw new ConflictError(
								"The project changed. Reload before editing clip properties."
							);
						}
						return json(
							store.save(setClipProperties(project, store.assets(), input))
						);
					}
					if (id && action === "copy-clip-settings" && method === "POST") {
						const input = copyClipSettingsRequestSchema.parse(
							await request.json()
						);
						const project = store.project(id);
						if (project.revision !== input.revision) {
							throw new ConflictError(
								"The project changed. Reload before copying clip settings."
							);
						}
						return json(
							store.save(copyClipSettings(project, store.assets(), input))
						);
					}
					if (id && action === "swap-clip-media" && method === "POST") {
						const input = swapClipMediaRequestSchema.parse(
							await request.json()
						);
						const project = store.project(id);
						if (project.revision !== input.revision) {
							throw new ConflictError(
								"The project changed. Reload before swapping clip media."
							);
						}
						return json(
							store.save(swapClipMedia(project, store.assets(), input))
						);
					}
					if (id && !action && method === "PUT") {
						const project = projectSchema.parse(await request.json());
						if (project.id !== id) {
							throw new Error("Project ID mismatch.");
						}
						return json(store.save(project));
					}
					if (id && action === "assemble" && method === "POST") {
						const input = z
							.object({
								revision: z.number().int().nonnegative(),
								includeTitles: z.boolean(),
							})
							.strict()
							.parse(await request.json());
						const project = store.project(id);
						if (project.revision !== input.revision) {
							throw new ConflictError(
								"The storyboard changed. Reload before assembling."
							);
						}
						return json(
							store.save(
								assembleStoryboard(project, store.assets(), input.includeTitles)
							)
						);
					}
					if (id && action === "recipe" && method === "POST") {
						const input = recipeSchema.parse(await request.json());
						const project = store.project(id);
						if (project.revision !== input.revision) {
							throw new ConflictError(
								"The project changed. Reload before applying a recipe."
							);
						}
						return json(
							store.save(composeRecipe(project, store.assets(), input))
						);
					}
					if (id && action === "ripple-delete" && method === "POST") {
						const input = z
							.object({
								end: z.number().finite().min(0).max(7200),
								revision: z.number().int().nonnegative(),
								start: z.number().finite().min(0).max(7200),
							})
							.strict()
							.parse(await request.json());
						const project = store.project(id);
						if (project.revision !== input.revision) {
							throw new ConflictError(
								"The project changed. Reload before ripple-deleting a range."
							);
						}
						return json(
							store.save(
								rippleDeleteRange(
									project,
									store.assets(),
									input.start,
									input.end
								)
							)
						);
					}
					if (id && action === "layout" && method === "POST") {
						const input = layoutRequestSchema.parse(await request.json());
						const project = store.project(id);
						if (project.revision !== input.revision) {
							throw new ConflictError(
								"The project changed. Reload before applying a layout."
							);
						}
						const selected = project.segments.filter((segment) =>
							input.segmentIds.includes(segment.id)
						);
						if (
							new Set(input.segmentIds).size !== input.segmentIds.length ||
							selected.length !== new Set(input.segmentIds).size ||
							selected.some(
								(segment) =>
									store.assets().find((asset) => asset.id === segment.assetId)
										?.kind === "audio"
							)
						) {
							throw new Error("Choose unique visual clips for the layout.");
						}
						return json(
							store.save(
								applyLayout(project, input.segmentIds, input.layout, {
									assets: store.assets(),
									fit: input.fit,
								})
							)
						);
					}
					if (id && action === "insert" && method === "POST") {
						const input = insertClipsRequestSchema.parse(await request.json());
						const project = store.project(id);
						if (project.revision !== input.revision) {
							throw new ConflictError(
								"The project changed. Reload before inserting clips."
							);
						}
						return json(
							store.save(
								insertClips(
									project,
									store.assets(),
									input.at,
									input.track,
									input.entries
								)
							)
						);
					}
					if (id && action === "capture-frame" && method === "POST") {
						const input = z
							.object({
								name: z.string().trim().max(200).optional(),
								revision: z.number().int().nonnegative(),
								time: z.number().finite().min(0).max(7200),
							})
							.strict()
							.parse(await request.json());
						const project = store.project(id);
						if (project.revision !== input.revision) {
							throw new ConflictError(
								"The project changed. Reload before capturing a frame."
							);
						}
						return json(
							await captureTimelineFrame(
								store,
								project,
								input.time,
								input.name ?? "",
								{ signal: mediaSignal(request) }
							)
						);
					}
					if (id && action === "inspect-frame" && method === "GET") {
						const time = z.coerce
							.number()
							.finite()
							.min(0)
							.max(7200)
							.parse(url.searchParams.get("time") ?? 0);
						// `ungraded=<clip id>,…` renders those clips with a neutral
						// colour grade (the looks panel previews looks from it).
						const ungraded = new Set(
							z
								.array(z.uuid())
								.max(8)
								.parse(
									(url.searchParams.get("ungraded") ?? "")
										.split(",")
										.filter(Boolean)
								)
						);
						const stored = store.project(id);
						const project = ungraded.size
							? {
									...stored,
									segments: stored.segments.map((segment) =>
										ungraded.has(segment.id)
											? {
													...segment,
													colorGrade: {
														exposure: 0,
														temperature: 0,
														tint: 0,
														vibrance: 0,
													},
												}
											: segment
									),
								}
							: stored;
						const frame = await renderTimelineFrame(store, project, time, {
							signal: mediaSignal(request),
						});
						return json({
							data: Buffer.from(frame).toString("base64"),
							height: project.height,
							mimeType: "image/png",
							projectId: project.id,
							time,
							width: project.width,
						});
					}
					if (id && action === "approval-policy" && method === "POST") {
						const input = approvalPolicyRequestSchema.parse(
							await request.json()
						);
						return json(
							store.setApprovalRequirement(
								id,
								input.revision,
								input.requireApproval
							)
						);
					}
					if (id && action === "approve-scene" && method === "POST") {
						const approval = z
							.object({
								sceneId: idSchema,
								revision: z.number().int().nonnegative(),
								approved: z.boolean(),
							})
							.strict()
							.parse(await request.json());
						return json(
							store.approveScene(
								id,
								approval.revision,
								approval.sceneId,
								approval.approved
							)
						);
					}
					if (id && action === "undo" && method === "POST") {
						const input = undoRequestSchema.parse(await request.json());
						const historyRevision =
							input.historyRevision ?? store.history(id)[0]?.revision;
						if (historyRevision === undefined) {
							throw new Error("There is no saved history entry to undo.");
						}
						return json(
							store.restoreHistory(id, input.revision, historyRevision)
						);
					}
					if (id && action === "subtitles" && method === "GET") {
						const format = z
							.enum(SUBTITLE_EXPORT_FORMATS)
							.parse(url.searchParams.get("format") ?? "srt");
						return json({
							text: subtitleText(activeCaptions(store.project(id)), format),
							format,
						});
					}
					if (id && action === "captions" && !subaction && method === "POST") {
						const input = captionEditRequestSchema.parse(await request.json());
						return revisionedProjectEdit(
							id,
							input.revision,
							"The project changed. Reload before editing captions.",
							(project, assets) => editCaptions(project, assets, input)
						);
					}
					if (id && action === "titles" && method === "POST") {
						const input = titleEditRequestSchema.parse(await request.json());
						return revisionedProjectEdit(
							id,
							input.revision,
							"The project changed. Reload before editing titles.",
							(project, assets) => editTitles(project, assets, input)
						);
					}
					if (id && action === "color" && method === "POST") {
						const input = colorEditRequestSchema.parse(await request.json());
						await lutStoreFor(store.directory).assertAvailable(input);
						return revisionedProjectEdit(
							id,
							input.revision,
							"The project changed. Reload before applying color.",
							(project, assets) => applyColor(project, assets, input)
						);
					}
					if (id && action === "effects" && method === "POST") {
						const input = effectEditRequestSchema.parse(await request.json());
						return revisionedProjectEdit(
							id,
							input.revision,
							"The project changed. Reload before applying effects.",
							(project, assets) => applyEffects(project, assets, input)
						);
					}
				}
				if (resource === "uploads") {
					await sweepStaleUploads();
					if (!id && method === "POST") {
						const input = uploadSchema.parse(await request.json());
						if (uploads.size >= MAX_OPEN_UPLOADS) {
							throw new Error(
								`${MAX_OPEN_UPLOADS} uploads are already open. Finish or wait for one first.`
							);
						}
						const media = input.purpose === "media";
						if (media && store.assets().length >= MAX_MEDIA_ASSETS) {
							throw new Error("Media upload limit reached.");
						}
						const reservation = store.reserveMediaStorage(input.size, {
							asset: media,
						});
						const uploadId = crypto.randomUUID();
						const upload: Upload = {
							...input,
							id: uploadId,
							offset: 0,
							updated: Date.now(),
							path: join(store.directory, "media", `${uploadId}.upload`),
							reservation,
							busy: false,
						};
						try {
							await Bun.write(upload.path, new Uint8Array());
						} catch (error) {
							reservation.release();
							throw error;
						}
						uploads.set(uploadId, upload);
						return json({ id: uploadId, chunkSize }, 201);
					}
					const upload = id ? uploads.get(id) : undefined;
					if (!upload) {
						return json(
							{ code: "NOT_FOUND", message: "Upload not found or expired." },
							404
						);
					}
					if (upload.busy) {
						throw new ConflictError(
							"An upload chunk is already being processed."
						);
					}
					if (action === "cancel" && method === "POST") {
						uploads.delete(upload.id);
						await rm(upload.path, { force: true });
						upload.reservation.release();
						return json({ canceled: true });
					}
					if (!action && method === "PUT") {
						// Claim the upload before reading the body so a concurrent chunk
						// cannot pass the offset check against the same stale offset.
						upload.busy = true;
						try {
							const input = chunkSchema.parse(await request.json());
							if (!/^[A-Za-z0-9+/]*={0,2}$/.test(input.data)) {
								throw new Error("Invalid media encoding.");
							}
							const bytes = Buffer.from(input.data, "base64");
							if (
								!bytes.length ||
								bytes.length > chunkSize ||
								input.offset !== upload.offset ||
								upload.offset + bytes.length > upload.size
							) {
								throw new ConflictError("Invalid upload offset or chunk size.");
							}
							const file = await open(upload.path, "a");
							try {
								await file.writeFile(bytes);
							} finally {
								await file.close();
							}
							upload.offset += bytes.length;
							upload.updated = Date.now();
							// Written bytes are counted on disk; keep reserving only the rest.
							upload.reservation.resize(upload.size - upload.offset);
						} finally {
							upload.busy = false;
						}
						return json({ offset: upload.offset });
					}
					if (action === "finish" && method === "POST") {
						if (upload.purpose === "font") {
							throw new Error(
								"This upload is a font: import it with POST /fonts {uploadId}."
							);
						}
						if (upload.offset !== upload.size) {
							throw new Error("The upload is incomplete.");
						}
						upload.busy = true;
						try {
							const info = await probe(upload.path);
							const asset = assetSchema.parse({
								...info,
								id: upload.id,
								name: upload.name,
								createdAt: new Date().toISOString(),
							});
							await rename(upload.path, store.mediaPath(asset.id));
							store.putAsset(asset);
							uploads.delete(upload.id);
							proxyInBackground(asset);
							if (asset.kind !== "audio") {
								await thumbnail(
									store.mediaPath(asset.id),
									join(store.directory, "media"),
									asset.id
								).catch(() => undefined);
							}
							upload.reservation.commit();
							return json(asset, 201);
						} catch (error) {
							await rm(upload.path, { force: true });
							upload.reservation.release();
							uploads.delete(upload.id);
							throw error;
						}
					}
				}
				if (resource === "search" && method === "GET") {
					const input = mediaSearchRequestSchema.parse({
						assetId: url.searchParams.get("assetId") ?? undefined,
						limit: url.searchParams.get("limit") ?? undefined,
						q: url.searchParams.get("q") ?? "",
					});
					return json(
						searchMedia(
							store.searchIndexes(),
							store.assets(),
							input,
							currentShotIndexes(store)
						)
					);
				}
				if (resource === "search-indexes" && method === "GET") {
					return json({ indexes: store.searchIndexes() });
				}
				if (resource === "assets") {
					if (rawId === "import" && method === "POST") {
						const input = importMediaRequestSchema.parse(await request.json());
						const imported = await importMediaAsset(store, input, {
							localImportRoot:
								Bun.env.RYU_VIDEO_STUDIO_IMPORT_ROOT?.trim() ||
								join(store.directory, "imports"),
							signal: mediaSignal(request),
						});
						proxyInBackground(imported);
						return json(imported, 201);
					}
					if (!id && method === "GET") {
						const all = store.assets();
						return json({
							assets:
								url.searchParams.get("includeProxies") === "1"
									? all
									: libraryAssets(all),
						});
					}
					const asset = store.assets().find((a) => a.id === id);
					if (!asset) {
						return json(
							{ code: "NOT_FOUND", message: "Media not found." },
							404
						);
					}
					if (action === "organize" && method === "POST") {
						const input = z
							.object({
								delete: z.boolean().default(false),
								folder: z.string().trim().max(300).optional(),
								name: z.string().trim().min(1).max(200).optional(),
								projectRevisions: z
									.record(idSchema, z.number().int().nonnegative())
									.optional(),
							})
							.strict()
							.parse(await request.json());
						const result = store.organizeAsset(asset.id, input);
						if (result.deleted) {
							await rm(store.mediaPath(asset.id), { force: true });
							await rm(join(store.directory, "media", `${asset.id}.jpg`), {
								force: true,
							});
						}
						return json(result);
					}
					if (action === "extract-audio" && method === "POST") {
						const result = await extractAssetAudio(store, asset, {
							signal: mediaSignal(request),
						});
						return json(result.asset, result.created ? 201 : 200);
					}
					if (action === "refresh-sequence" && method === "POST") {
						return json(
							await refreshSequenceAsset(store, asset, {
								signal: mediaSignal(request),
							})
						);
					}
					if (action === "index" && method === "POST") {
						const input = z
							.object({
								spaceId: z.string().min(1).max(200),
								spaceName: z.string().min(1).max(200),
								rebuild: z.boolean().default(false),
							})
							.strict()
							.parse(await request.json());
						return json(
							store.beginSearchIndex(
								asset,
								input.spaceId,
								input.spaceName,
								input.rebuild
							)
						);
					}
					if (action === "index" && method === "PUT") {
						const input = z
							.object({
								revision: z.number().int().nonnegative(),
								key: z.string().min(1).max(100),
								docId: z.string().min(1).max(200),
								ready: z.boolean(),
							})
							.strict()
							.parse(await request.json());
						return json(
							store.updateSearchEntry(
								asset.id,
								input.revision,
								input.key,
								input.docId,
								input.ready
							)
						);
					}
					if (action === "prune-index" && method === "POST") {
						const input = z
							.object({
								revision: z.number().int().nonnegative(),
								docId: z.string().min(1).max(200),
							})
							.strict()
							.parse(await request.json());
						return json(
							store.pruneSearchEntry(asset.id, input.revision, input.docId)
						);
					}
					if (action === "audio-window" && method === "POST") {
						const input = z
							.object({
								start: z.number().finite().min(0).max(7200),
								playback: audioPlaybackSchema.optional(),
							})
							.strict()
							.parse(await request.json());
						return json(
							await extractAudioWindow(
								store,
								asset,
								input.start,
								input.playback
							)
						);
					}
					if (action === "import-transcript" && method === "POST") {
						const input = z
							.object({
								revision: z.number().int().nonnegative().nullable(),
								cues: z.array(captionSchema).max(5000),
							})
							.strict()
							.parse(await request.json());
						return json(
							store.importTranscript(asset, input.revision, input.cues)
						);
					}
					if (action === "transcript" && method === "GET") {
						return json({ transcript: store.transcript(asset.id) });
					}
					if (action === "stop-transcript" && method === "POST") {
						const input = z
							.object({
								revision: z.number().int().nonnegative(),
								status: z.enum(["failed", "canceled"]),
								error: z.string().max(1000).optional(),
							})
							.strict()
							.parse(await request.json());
						return json(
							store.stopTranscript(
								asset.id,
								input.revision,
								input.status,
								input.error
							)
						);
					}
					if (action === "analyze" && method === "POST") {
						return json(analyses.start(asset), 202);
					}
					if (action === "analysis" && method === "GET") {
						return json({ analysis: store.analysis(asset.id) });
					}
					if (action === "cancel-analysis" && method === "POST") {
						analyses.cancel(asset.id);
						return json({ canceled: true });
					}
					if (action === "data" && method === "GET") {
						return await readChunk(
							store.mediaPath(asset.id),
							z.coerce
								.number()
								.int()
								.nonnegative()
								.parse(url.searchParams.get("offset") ?? 0)
						);
					}
					if (action === "thumbnail" && method === "GET") {
						return json({
							data: Buffer.from(
								await Bun.file(
									join(store.directory, "media", `${asset.id}.jpg`)
								).arrayBuffer()
							).toString("base64"),
						});
					}
					if (action === "inspect" && method === "GET") {
						const includeThumbnail = url.searchParams.get("thumbnail") !== "0";
						const sampleCount = z.coerce
							.number()
							.int()
							.min(0)
							.max(4)
							.parse(url.searchParams.get("samples") ?? 0);
						return json(
							await inspectMediaAsset(
								store,
								asset,
								sampleCount,
								includeThumbnail,
								{ signal: mediaSignal(request) }
							)
						);
					}
				}
				if (resource === "renders") {
					if (!id && method === "GET") {
						return json({ jobs: store.jobs() });
					}
					const job = store.jobs().find((j) => j.id === id);
					if (!job) {
						return json(
							{ code: "NOT_FOUND", message: "Export not found." },
							404
						);
					}
					if (!action && method === "GET") {
						return json(job);
					}
					if (action === "cancel" && method === "POST") {
						queue.cancel(job.id);
						return json({ canceled: true });
					}
					if (
						action === "data" &&
						method === "GET" &&
						job.status === "completed"
					) {
						return await readChunk(
							store.renderPath(job.id, job.codec),
							z.coerce
								.number()
								.int()
								.nonnegative()
								.parse(url.searchParams.get("offset") ?? 0)
						);
					}
				}
				const routed = await dispatchStudioRoute(
					routes,
					{ action, id, method, resource, subaction },
					{ ...services, method, request, url }
				);
				if (routed) {
					return routed;
				}
				return json({ code: "NOT_FOUND", message: "Route not found." }, 404);
			} catch (error) {
				if (error instanceof MediaBusyError) {
					return json({ code: "MEDIA_BUSY", message: error.message }, 429);
				}
				if (error instanceof SoundtrackBusyError) {
					return json({ code: "SOUNDTRACK_BUSY", message: error.message }, 429);
				}
				if (error instanceof SealUnavailableError) {
					return json(
						{ code: "SEALING_UNAVAILABLE", message: error.message },
						503
					);
				}
				if (isContentSealError(error)) {
					return json(
						{
							code: "DATA_UNREADABLE",
							message: "This saved item cannot be read with this app's key.",
						},
						503
					);
				}
				return json(
					{
						code:
							error instanceof ConflictError ? "CONFLICT" : "INVALID_REQUEST",
						// Errors that name a clip, track or scene carry a message code
						// and params, so the editor can show them in the host language.
						...studioErrorDetail(error),
						message:
							error instanceof z.ZodError
								? "The request does not match the Video Studio contract."
								: error instanceof Error
									? error.message
									: "Request failed.",
					},
					error instanceof ConflictError ? 409 : 400
				);
			}
		},
	});
	return {
		server,
		stop() {
			clearInterval(uploadSweep);
			mediaShutdown.abort();
			soundtrackShutdown.abort();
			queue.stop();
			analyses.stop();
			server.stop();
		},
	};
}

function splitEditBody(): StudioJsonSchema {
	const body: StudioJsonSchema = z.toJSONSchema(splitEditRequestSchema);
	body.properties = {
		...body.properties,
		nearTime: { type: "number", minimum: 0, maximum: 7200 },
	};
	return body;
}

function beatCutsBody(): StudioJsonSchema {
	const body: StudioJsonSchema = z.toJSONSchema(beatCutsRequestSchema);
	body.properties = {
		...body.properties,
		musicClipId: { type: "string", format: "uuid" },
	};
	if (Array.isArray(body.required)) {
		body.required = body.required.filter((name) => name !== "beats");
	}
	return body;
}

export function openapi(routes: readonly StudioRoute[] = studioRoutes) {
	const project = z.toJSONSchema(projectSchema);
	const operation = describeOperation;
	const paths: OpenApiPaths = {
		[`${prefix}/timelines`]: {
			get: operation(
				"video_studio_list_timelines",
				"List durable Video Studio timeline workspaces backed by Ryu projects."
			),
			post: operation(
				"video_studio_create_timeline",
				"Create an empty timeline or duplicate an existing timeline as a new revision-zero workspace.",
				{
					type: "object",
					properties: {
						from: { type: "string", format: "uuid" },
						title: { type: "string", minLength: 1, maxLength: 200 },
					},
				}
			),
		},
		[`${prefix}/timelines/{id}`]: {
			get: operation(
				"video_studio_get_timeline_workspace",
				"Read one durable timeline workspace. Use its project id for revisioned edits.",
				undefined,
				true
			),
		},
		[`${prefix}/projects/package`]: {
			post: operation(
				"video_studio_import_project_package",
				"Import a validated editable project package when all referenced media already exists on this node.",
				z.toJSONSchema(projectPackageSchema)
			),
		},
		[`${prefix}/search-indexes`]: {
			get: operation(
				"video_studio_search_indexes",
				"Read current and stale transcript-to-Space index mappings. Search authority remains in Core Spaces."
			),
		},
		[`${prefix}/assets/{id}/index`]: {
			post: operation(
				"video_studio_begin_index",
				"Prepare or resume indexing a completed transcript into a user-selected Space.",
				{
					type: "object",
					properties: {
						spaceId: { type: "string" },
						spaceName: { type: "string" },
						rebuild: { type: "boolean", default: false },
					},
					required: ["spaceId", "spaceName"],
				},
				true
			),
			put: operation(
				"video_studio_checkpoint_index",
				"Checkpoint an app-owned Space document for one source index entry.",
				{
					type: "object",
					properties: {
						revision: { type: "integer" },
						key: { type: "string" },
						docId: { type: "string" },
						ready: { type: "boolean" },
					},
					required: ["revision", "key", "docId", "ready"],
				},
				true
			),
		},
		[`${prefix}/assets/{id}/organize`]: {
			post: operation(
				"video_studio_organize_media",
				"Rename, move, or delete one imported media asset. Deletion removes its timeline clips and optionally checks supplied project revisions.",
				{
					type: "object",
					properties: {
						delete: { type: "boolean", default: false },
						folder: {
							type: "string",
							maxLength: 300,
							description:
								"Relative folder path; empty moves the asset to the root.",
						},
						name: { type: "string", minLength: 1, maxLength: 200 },
						projectRevisions: {
							type: "object",
							additionalProperties: { type: "integer", minimum: 0 },
						},
					},
				},
				true
			),
		},
		[`${prefix}/assets/{id}/extract-audio`]: {
			post: operation(
				"video_studio_extract_audio",
				"Extract a video's embedded audio into an app-owned derived audio asset on the same source timebase. Idempotent: an existing extraction is returned. Reversed media and nested sequences are refused (a sequence re-renders in place, so its extraction would go stale).",
				undefined,
				true
			),
		},
		[`${prefix}/assets/{id}/refresh-sequence`]: {
			post: operation(
				"video_studio_refresh_sequence_clip",
				"Re-render a sequence asset from its source timeline workspace after source edits.",
				{ type: "object", properties: {} },
				true
			),
		},
		[`${prefix}/assets/{id}/prune-index`]: {
			post: operation(
				"video_studio_prune_index",
				"Acknowledge cleanup of an obsolete generated index document.",
				{
					type: "object",
					properties: {
						revision: { type: "integer" },
						docId: { type: "string" },
					},
					required: ["revision", "docId"],
				},
				true
			),
		},

		[`${prefix}/assets/{id}/import-transcript`]: {
			post: operation(
				"video_studio_import_transcript",
				"Import source-timed captions with an expected transcript revision (null if none exists).",
				{
					type: "object",
					properties: {
						revision: { type: ["integer", "null"] },
						cues: { type: "array", items: z.toJSONSchema(captionSchema) },
						words: {
							type: "array",
							maxItems: 1000,
							items: z.toJSONSchema(captionSchema),
						},
					},
					required: ["revision", "cues"],
				},
				true
			),
		},

		[`${prefix}/assets/{id}/audio-window`]: {
			post: operation(
				"video_studio_audio_window",
				"Prepare up to 20 seconds of source audio as 16 kHz mono PCM WAV for the Ryu transcription service.",
				{
					type: "object",
					properties: {
						start: { type: "number", minimum: 0 },
						playback: z.toJSONSchema(audioPlaybackSchema),
					},
					required: ["start"],
				},
				true
			),
		},
		[`${prefix}/assets/{id}/transcript`]: {
			get: operation(
				"video_studio_read_transcript",
				"Read saved source transcript and resumable progress.",
				undefined,
				true
			),
		},
		[`${prefix}/assets/{id}/stop-transcript`]: {
			post: operation(
				"video_studio_stop_transcript",
				"Mark transcription canceled or failed while keeping its saved windows.",
				{
					type: "object",
					properties: {
						revision: { type: "integer" },
						status: { type: "string", enum: ["failed", "canceled"] },
						error: { type: "string" },
					},
					required: ["revision", "status"],
				},
				true
			),
		},

		[`${prefix}/budget`]: {
			get: operation(
				"video_studio_budget_spend",
				"Read the Gateway-owned charged-spend snapshot and configured caps. This is node-wide billing data, not project cost attribution.",
				undefined,
				true
			),
		},
		[`${prefix}/budget/audit`]: {
			get: operation(
				"video_studio_budget_audit",
				"Read redacted Gateway audit entries for provider, model, feature, request, and actual cost fields. This is node-wide data and is not automatically attributed to a project.",
				undefined,
				true
			),
		},
		[`${prefix}/stock/search`]: {
			get: {
				...operation(
					"video_studio_stock_search",
					"Search the allowlisted Archive.org, Wikimedia Commons, NASA Images and Video, Openverse image/audio catalogs, or configured Unsplash, Pexels, and Pixabay catalogs. Results include source rights and attribution metadata.",
					undefined,
					false,
					{
						name: "q",
						schema: { type: "string", minLength: 1, maxLength: 120 },
					}
				),
				parameters: [
					{
						name: "provider",
						in: "query",
						required: false,
						schema: {
							type: "string",
							enum: [
								"archive.org",
								"coverr",
								"openverse.audio",
								"openverse.image",
								"unsplash.image",
								"wikimedia.commons",
								"nasa",
								"pexels",
								"pixabay",
							],
							default: "archive.org",
						},
					},
					{
						name: "limit",
						in: "query",
						required: false,
						schema: { type: "integer", minimum: 1, maximum: 12, default: 8 },
					},
				],
			},
		},
		[`${prefix}/stock`]: {
			post: operation(
				"video_studio_stock_import",
				"Resolve an Archive.org, Wikimedia Commons, NASA, or Openverse image/audio identifier, or a configured Pexels or Pixabay video identifier; download supported media into app-owned storage and retain source attribution and rights metadata.",
				{
					type: "object",
					properties: {
						identifier: { type: "string", minLength: 1, maxLength: 200 },
						provider: {
							type: "string",
							enum: [
								"archive.org",
								"coverr",
								"openverse.audio",
								"openverse.image",
								"unsplash.image",
								"wikimedia.commons",
								"nasa",
								"pexels",
								"pixabay",
							],
							default: "archive.org",
						},
					},
					required: ["identifier"],
				}
			),
		},
		[`${prefix}/uploads`]: {
			post: operation(
				"video_studio_begin_upload",
				'Begin a chunked upload. Upload each chunk at the returned offset, then finish to validate and register the media; with purpose "font" (at most 24 MB, not counted toward the media asset limit) import it with POST /fonts {uploadId} instead of finishing it.',
				z.toJSONSchema(uploadSchema)
			),
		},
		[`${prefix}/uploads/{id}`]: {
			put: operation(
				"video_studio_upload_chunk",
				"Append one base64 media chunk at the exact expected offset. Maximum decoded chunk size is 512 KiB.",
				z.toJSONSchema(chunkSchema),
				true
			),
		},
		[`${prefix}/uploads/{id}/cancel`]: {
			post: operation(
				"video_studio_cancel_upload",
				"Abandon an unfinished chunked upload, deleting its partial file and releasing its storage reservation.",
				undefined,
				true
			),
		},
		[`${prefix}/uploads/{id}/finish`]: {
			post: operation(
				"video_studio_finish_upload",
				"Validate and register a complete uploaded media file.",
				undefined,
				true
			),
		},
		[`${prefix}/projects/{id}/undo`]: {
			post: operation(
				"video_studio_undo_project",
				"Restore the newest saved project revision as one revision-checked undo step, or pass historyRevision for deterministic rollback.",
				z.toJSONSchema(undoRequestSchema),
				true
			),
		},
		[`${prefix}/projects/{id}/approval-policy`]: {
			post: operation(
				"video_studio_set_approval_policy",
				"Require or disable scene review for the exact project revision. Requires the separate scene approval permission.",
				z.toJSONSchema(approvalPolicyRequestSchema),
				true
			),
		},
		[`${prefix}/projects/{id}/approve-scene`]: {
			post: operation(
				"video_studio_approve_scene",
				"Approve or reopen review of an exact scene revision. Requires the separate scene approval permission.",
				{
					type: "object",
					properties: {
						sceneId: { type: "string", format: "uuid" },
						revision: { type: "integer", minimum: 0 },
						approved: { type: "boolean" },
					},
					required: ["sceneId", "revision", "approved"],
				},
				true
			),
		},
		[`${prefix}/projects/{id}/subtitles`]: {
			get: operation(
				"video_studio_export_subtitles",
				"Export timed captions as SRT by default; the format query accepts srt, vtt, or txt (plain text, one cue per line).",
				undefined,
				true,
				{
					name: "format",
					schema: {
						type: "string",
						enum: [...SUBTITLE_EXPORT_FORMATS],
						default: "srt",
					},
				}
			),
		},
		[`${prefix}/projects/{id}/captions`]: {
			post: operation(
				"video_studio_edit_captions",
				"Append, replace, or remove timed captions on the source track or an existing localization track. Requires the current project revision.",
				z.toJSONSchema(captionEditRequestSchema),
				true
			),
		},
		[`${prefix}/projects/{id}/titles`]: {
			post: operation(
				"video_studio_edit_titles",
				"Append, replace, update, or remove timed titles and lower thirds without replacing the project body. action 'apply-template' places a text template (templateId, start, texts); customFont {id, family} from GET /fonts or systemFont (a family from GET /system-fonts) sets the font of every title it adds. A title's own customFont or systemFont overrides its fontFamily, which stays the fallback. Requires the current project revision.",
				z.toJSONSchema(titleEditRequestSchema),
				true
			),
		},
		[`${prefix}/projects/{id}/color`]: {
			post: operation(
				"video_studio_apply_color",
				"Apply, copy, or reset bounded color grade values on one or more visual clips without replacing the project body.",
				z.toJSONSchema(colorEditRequestSchema),
				true
			),
		},
		[`${prefix}/projects/{id}/effects`]: {
			post: operation(
				"video_studio_apply_effects",
				"Replace the bounded visual effect stack on one or more visual clips without replacing the project body.",
				z.toJSONSchema(effectEditRequestSchema),
				true
			),
		},
		[`${prefix}/assets/{id}/data`]: {
			get: operation(
				"video_studio_read_media_chunk",
				"Read up to 512 KiB of base64 media bytes. The offset query is a byte offset and defaults to zero.",
				undefined,
				true,
				{
					name: "offset",
					schema: { type: "integer", minimum: 0, default: 0 },
				}
			),
		},
		[`${prefix}/assets/{id}/thumbnail`]: {
			get: operation(
				"video_studio_media_thumbnail",
				"Read the generated JPEG thumbnail for a video or still image.",
				undefined,
				true
			),
		},
		[`${prefix}/assets/{id}/inspect`]: {
			get: operation(
				"video_studio_inspect_media",
				"Read one media asset with its source metadata, saved transcript, analysis, and optional generated thumbnail evidence.",
				undefined,
				true,
				[
					{
						name: "thumbnail",
						schema: { type: "string", enum: ["0", "1"], default: "1" },
					},
					{
						name: "samples",
						schema: { type: "integer", minimum: 0, maximum: 4, default: 0 },
					},
				]
			),
		},
		[`${prefix}/assets/{id}/cancel-analysis`]: {
			post: operation(
				"video_studio_cancel_analysis",
				"Cancel an active source-media analysis.",
				undefined,
				true
			),
		},
		[`${prefix}/renders`]: {
			get: operation(
				"video_studio_list_exports",
				"List recent export jobs and their verified output metadata plus post-render delivery review checks."
			),
		},
		[`${prefix}/renders/{id}/data`]: {
			get: operation(
				"video_studio_read_export_chunk",
				"Read a completed export in 512 KiB base64 chunks. The offset query is a byte offset and defaults to zero.",
				undefined,
				true,
				{
					name: "offset",
					schema: { type: "integer", minimum: 0, default: 0 },
				}
			),
		},

		[`${prefix}/projects`]: {
			get: operation(
				"video_studio_list_projects",
				"List durable video projects."
			),
			post: operation(
				"video_studio_create_project",
				"Create an empty video project.",
				{
					type: "object",
					properties: { title: { type: "string" } },
					required: ["title"],
				}
			),
		},
		[`${prefix}/projects/{id}`]: {
			get: operation(
				"video_studio_get_project",
				"Read the timeline, captions and storyboard shared with the editor.",
				undefined,
				true
			),
			put: operation(
				"video_studio_edit_project",
				"Save a complete project using its current revision. Conflicts return 409. Times are seconds. Import media before referencing asset IDs.",
				project,
				true
			),
		},
		[`${prefix}/projects/{id}/timeline`]: {
			get: operation(
				"video_studio_get_timeline",
				"Read stable track, clip, source-range, gap, marker, and frame metadata for the saved timeline.",
				undefined,
				true
			),
		},
		[`${prefix}/projects/{id}/transcript`]: {
			get: operation(
				"video_studio_timeline_transcript",
				"Read source transcript cues and measured words mapped through saved clip trims, speed, and timeline positions.",
				undefined,
				true,
				{
					name: "track",
					schema: { type: "integer", minimum: 0, maximum: MAX_TRACK_INDEX },
				}
			),
		},
		[`${prefix}/projects/{id}/remove-words`]: {
			post: operation(
				"video_studio_remove_word_ranges",
				"Remove transcript-selected timeline ranges and ripple later clips and timed layers left. Pass ranges in timeline seconds and the current project revision.",
				z.toJSONSchema(removeWordsRequestSchema),
				true
			),
		},
		[`${prefix}/projects/{id}/duplicate`]: {
			post: operation(
				"video_studio_duplicate_project",
				"Create an independent alternate cut from a saved project. Media references are shared, while the new project starts at revision zero.",
				{
					type: "object",
					properties: {
						title: { type: "string", minLength: 1, maxLength: 200 },
					},
				},
				true
			),
		},
		[`${prefix}/projects/{id}/sequence`]: {
			post: operation(
				"video_studio_create_sequence_clip",
				"Render another timeline workspace into an app-owned sequence clip for this project. The source remains editable and the clip can be refreshed after source edits.",
				{
					type: "object",
					properties: {
						name: { type: "string", minLength: 1, maxLength: 200 },
						revision: { type: "integer", minimum: 0 },
						sourceProjectId: { type: "string", format: "uuid" },
					},
					required: ["revision", "sourceProjectId"],
				},
				true
			),
		},
		[`${prefix}/projects/{id}/add`]: {
			post: operation(
				"video_studio_add_clips",
				"Place one or more source ranges at a timeline point without rippling later content. Requires the current project revision.",
				z.toJSONSchema(addClipsRequestSchema),
				true
			),
		},
		[`${prefix}/projects/{id}/move`]: {
			post: operation(
				"video_studio_move_clip",
				"Move one clip to a frame-quantized timeline position and track. Requires the current project revision.",
				z.toJSONSchema(moveClipRequestSchema),
				true
			),
		},
		[`${prefix}/projects/{id}/links`]: {
			post: operation(
				"video_studio_manage_clip_links",
				"Link or unlink audio and visual clips as one J-cut/L-cut editing group. Linked clips move together and remove together. Requires the current project revision.",
				z.toJSONSchema(manageClipLinksRequestSchema),
				true
			),
		},
		[`${prefix}/projects/{id}/detach-audio`]: {
			post: operation(
				"video_studio_detach_audio",
				"Move the embedded camera audio of video clips onto linked audio clips (extracting each source's audio once into app-owned storage; at most 16 distinct sources per request) and mute the video members, so their audio edit points can roll independently. Clips already linked to audio are left unchanged; reversed clips and nested sequences are refused. Requires the current project revision.",
				z.toJSONSchema(detachAudioRequestSchema),
				true
			),
		},
		[`${prefix}/projects/{id}/split-edit`]: {
			post: operation(
				"video_studio_split_edit",
				"Roll one cut's audio edit point into a J-cut (incoming audio leads the picture), an L-cut (outgoing audio trails it), or back to a straight cut. Choose the cut by cutKey, or by a linked clipId with an optional nearTime that picks the cut nearest that timeline time. The offset is frame-quantized and clamped to the source handles; the response carries the saved project and the appliedOffset actually used. Requires the current project revision.",
				splitEditBody(),
				true
			),
		},
		[`${prefix}/projects/{id}/split-edit-plan`]: {
			post: operation(
				"video_studio_plan_split_edits",
				"Read-only. Only cuts between linked audio/video groups are planned, so detach embedded camera audio first. Propose a J-cut, L-cut or straight cut for each linked audio/video edit from stored transcript word timings, falling back to analysed waveforms. Returns the current revision, proposals with signed offsets already clamped to source handles, and skipped cuts. Does not change the project.",
				z.toJSONSchema(splitEditPlanRequestSchema),
				true
			),
		},
		[`${prefix}/projects/{id}/split-edits`]: {
			post: operation(
				"video_studio_apply_split_edits",
				"Apply accepted split-edit proposals by cut key and signed offset (negative J, positive L) in one revision. Offsets are clamped to source handles; the response lists the applied offsets and skipped cuts. detachAudio detaches embedded camera audio before applying, but detaching mints new link groups, so proposal keys from a plan made before detaching never match: detach first (detach-audio, or this route with detachAudio and no proposals), then plan, then apply. Requires the current project revision.",
				z.toJSONSchema(applySplitEditsRequestSchema),
				true
			),
		},
		[`${prefix}/projects/{id}/filler-plan`]: {
			post: operation(
				"video_studio_plan_filler_words",
				"Read-only. Find filler words, repeats and stutters in the stored timeline transcript and return the current revision, hits, and merged timeline ranges ready for remove-words. Does not change the project.",
				z.toJSONSchema(fillerPlanRequestSchema),
				true
			),
		},
		[`${prefix}/projects/{id}/trim-edit`]: {
			post: operation(
				"video_studio_trim_edit",
				"Roll, slip, slide or ripple-trim clips by a timeline delta (slip uses source seconds). Deltas are frame-quantized and clamped to source handles and neighbouring clips; the response carries the project and the delta applied. Requires the current project revision.",
				z.toJSONSchema(trimEditRequestSchema),
				true
			),
		},
		[`${prefix}/projects/{id}/freeze-frame`]: {
			post: operation(
				"video_studio_freeze_frame",
				"Capture the clip's source frame at a timeline time as a still image and insert it as a freeze (rippling later layers) or hold it after the clip end. Timeline overlays are not baked in. Requires the current project revision.",
				z.toJSONSchema(freezeFrameRequestSchema),
				true
			),
		},
		[`${prefix}/projects/{id}/reverse`]: {
			post: operation(
				"video_studio_reverse_clips",
				"Play clips and their linked partners backwards using reversed media derivatives rendered locally in bounded chunks (reused when already present; sources up to ten minutes; at most four new renders per request, started only after the whole request validates). A clip with a J/L cut against a neighbour is refused because mirroring would overlap it. Reversing a reversed clip restores the original. Requires the current project revision.",
				z.toJSONSchema(reverseRequestSchema),
				true
			),
		},
		[`${prefix}/projects/{id}/speed-ramp`]: {
			post: operation(
				"video_studio_speed_ramp",
				"Approximate a speed curve preset or custom points (0.1x to 10x) by cutting a clip and its linked partners into contiguous constant-speed steps with exact source continuity. For one continuously remapped clip use video_studio_speed_curve. Requires the current project revision.",
				z.toJSONSchema(speedRampRequestSchema),
				true
			),
		},
		[`${prefix}/projects/{id}/speed-ramp/reset`]: {
			post: operation(
				"video_studio_reset_speed_ramp",
				"Merge the steps of a speed ramp back into one constant-speed clip, keeping the ramp's length unless a speed is given. Requires the current project revision.",
				z.toJSONSchema(resetSpeedRampRequestSchema),
				true
			),
		},
		[`${prefix}/projects/{id}/speed-curve`]: {
			post: operation(
				"video_studio_speed_curve",
				"Give a clip and its linked partners a continuous speed curve (a preset, or custom with 2 to 12 points from 0.1x to 10x): the clip stays one clip, time-remapped along the exact curve in the preview and export, and later clips move by ripple. Requires the current project revision.",
				z.toJSONSchema(speedCurveRequestSchema),
				true
			),
		},
		[`${prefix}/projects/{id}/speed-curve/remove`]: {
			post: operation(
				"video_studio_remove_speed_curve",
				"Return a curved clip and its curved linked partners to one constant speed, keeping the curve's length unless a speed is given. Requires the current project revision.",
				z.toJSONSchema(removeSpeedCurveRequestSchema),
				true
			),
		},
		[`${prefix}/projects/{id}/speed-curve/bake`]: {
			post: operation(
				"video_studio_bake_speed_curve",
				"Bake a curved clip into 4 to 24 contiguous constant-speed clips, each at the exact average speed of its slice of the curve, keeping the curve's length. Requires the current project revision.",
				z.toJSONSchema(bakeSpeedCurveRequestSchema),
				true
			),
		},
		[`${prefix}/projects/{id}/beat-cuts`]: {
			post: operation(
				"video_studio_beat_cuts",
				"Cut a track to the beat: snap existing edit points to the nearest beat within tolerance, or lay clips one per beat slot. Pass beats in timeline seconds, or musicClipId to use the analysed beats of that music clip: its detected beats and bar starts (downbeats, unless given) when the analysis covers the clip, else beats estimated from its waveform. Requires the current project revision.",
				beatCutsBody(),
				true
			),
		},
		[`${prefix}/projects/{id}/highlights`]: {
			post: operation(
				"video_studio_highlights",
				"Read-only. Score sentence-aligned windows of the timeline transcript, loudness, and scene cuts, and return the current revision with up to count ranked, non-overlapping highlight candidates. Does not change the project.",
				z.toJSONSchema(highlightsRequestSchema),
				true
			),
		},
		[`${prefix}/projects/{id}/keyframes`]: {
			post: operation(
				"video_studio_set_keyframes",
				"Replace one keyframe channel on a clip (clipId), title (titleId) or graphic (graphicId); name exactly one. Clips animate transform, crop, color, blur, effect, pan, volume and mask channels. Titles also animate x/y (canvas fractions), scale, rotation, opacity, fontSize, letterSpacing, lineHeight, backgroundPadding, backgroundRadius and the colors color and backgroundColor; graphics x/y, rotation, opacity, scale (about the box center), strokeWidth, cornerRadius, innerRadius and the colors fill and stroke. Color keyframes carry a #rrggbb color instead of a value and interpolate per RGB channel. Times are item-relative, each keyframe's interpolation (and Bezier controls) shapes the interval after it, and an empty list clears the channel. Requires the current project revision.",
				z.toJSONSchema(setKeyframesRequestSchema),
				true
			),
		},
		[`${prefix}/projects/{id}/readiness`]: {
			get: operation(
				"video_studio_production_readiness",
				"Read the production brief, scene, asset, approval, timeline, and delivery gates for the current project revision.",
				undefined,
				true
			),
		},
		[`${prefix}/projects/{id}/preflight`]: {
			get: operation(
				"video_studio_production_preflight",
				"Read one bounded preflight snapshot combining readiness blockers, stage progress, generation review state, budget admission, and logged decisions.",
				undefined,
				true
			),
		},
		[`${prefix}/projects/{id}/stages`]: {
			get: operation(
				"video_studio_get_stages",
				"Read durable production pipeline stage checkpoints.",
				undefined,
				true
			),
			post: operation(
				"video_studio_transition_stage",
				"Start, complete, block, or reset a production stage with the current project revision.",
				{
					type: "object",
					properties: {
						action: {
							type: "string",
							enum: ["start", "complete", "block", "reset"],
						},
						note: { type: "string", maxLength: 2000 },
						revision: { type: "integer", minimum: 0 },
						stage: {
							type: "string",
							enum: [
								"research",
								"proposal",
								"script",
								"scene_plan",
								"assets",
								"edit",
								"compose",
							],
						},
					},
					required: ["action", "revision", "stage"],
				},
				true
			),
		},
		[`${prefix}/projects/{id}/research`]: {
			post: operation(
				"video_studio_update_research_sources",
				"Append or remove HTTPS research citations attached to a project. Requires the current project revision.",
				z.toJSONSchema(researchMutationSchema),
				true
			),
		},
		[`${prefix}/projects/{id}/stage-world`]: {
			post: operation(
				"video_studio_generate_stage_world",
				"Generate a bounded editable 3D world from a direction, including stage blocks and a revisioned camera path. Requires the current project revision.",
				z.toJSONSchema(stageWorldRequestSchema),
				true
			),
		},
		[`${prefix}/projects/{id}/activity`]: {
			get: operation(
				"video_studio_production_activity",
				"Read the bounded production activity ledger derived from this project's saved revisions, generation requests, and export jobs.",
				undefined,
				true
			),
		},
		[`${prefix}/projects/{id}/decisions`]: {
			get: operation(
				"video_studio_get_decisions",
				"Read the append-only production decision log for this project.",
				undefined,
				true
			),
			post: operation(
				"video_studio_append_decision",
				"Append a provider, model, runtime, creative, or localization decision. Existing entries are never edited or deleted; requires the current project revision.",
				{
					type: "object",
					properties: {
						category: { type: "string", minLength: 1, maxLength: 80 },
						decision: { type: "string", minLength: 1, maxLength: 500 },
						optionsConsidered: {
							type: "array",
							items: { type: "string", minLength: 1, maxLength: 200 },
							maxItems: 12,
						},
						rationale: { type: "string", maxLength: 2000 },
						rejectedBecause: { type: "string", maxLength: 1000 },
						revision: { type: "integer", minimum: 0 },
						subject: { type: "string", minLength: 1, maxLength: 160 },
					},
					required: ["category", "decision", "revision", "subject"],
				},
				true
			),
		},
		[`${prefix}/projects/{id}/budget`]: {
			get: operation(
				"video_studio_production_budget",
				"Read this project's configured generation cap, exact Gateway receipts, reservations, and unsettled estimates.",
				undefined,
				true
			),
		},
		[`${prefix}/projects/{id}/credits`]: {
			get: operation(
				"video_studio_project_credits",
				"Read source attribution and rights for media used by this project, including a downloadable Markdown credits document.",
				undefined,
				true
			),
		},
		[`${prefix}/projects/{id}/package`]: {
			get: operation(
				"video_studio_project_package",
				"Export a validated editable project package with referenced asset metadata and provenance credits. Media bytes remain on the node. With media=1, build a self-contained archive instead (same as GET /projects/{id}/package-archive).",
				undefined,
				true,
				{ name: "media", schema: { type: "string", enum: ["1"] } }
			),
		},
		[`${prefix}/projects/{id}/interchange`]: {
			get: operation(
				"video_studio_project_interchange",
				"Export the saved timeline as Final Cut/Resolve FCPXML, Premiere XMEML or OpenTimelineIO JSON (format=otio) with app-owned asset references. Speed curves become FCPXML timeMap points and an XMEML variable-speed Time Remap graph; OTIO has no variable-speed effect, so a curve is its average LinearTimeWarp plus metadata.ryu.speedCurve.",
				undefined,
				true,
				{
					name: "format",
					schema: {
						type: "string",
						enum: interchangeFormatSchema.options,
						default: "fcpxml",
					},
				}
			),
		},
		[`${prefix}/projects/{id}/clip-properties`]: {
			post: operation(
				"video_studio_set_clip_properties",
				"Apply a bounded inspector patch to one timeline clip with the current project revision.",
				z.toJSONSchema(setClipPropertiesRequestSchema),
				true
			),
		},
		[`${prefix}/projects/{id}/copy-clip-settings`]: {
			post: operation(
				"video_studio_copy_clip_settings",
				"Copy a clip's treatment and compatible keyframes to one or more target clips.",
				z.toJSONSchema(copyClipSettingsRequestSchema),
				true
			),
		},
		[`${prefix}/projects/{id}/swap-clip-media`]: {
			post: operation(
				"video_studio_swap_clip_media",
				"Replace one clip's source media while preserving its timeline slot and authored treatment.",
				z.toJSONSchema(swapClipMediaRequestSchema),
				true
			),
		},
		[`${prefix}/generations`]: {
			get: {
				...operation(
					"video_studio_generation_history",
					"Read the latest 100 recorded generation requests and outcomes."
				),
				parameters: [
					{
						name: "projectId",
						in: "query",
						schema: { type: "string", format: "uuid" },
					},
				],
			},
			post: operation(
				"video_studio_record_generation_request",
				"Record intent before calling the Ryu media bridge. This does not run generation. Reusing an identical ID is idempotent.",
				z.toJSONSchema(generationRequestSchema)
			),
		},
		[`${prefix}/generations/{id}`]: {
			get: operation(
				"video_studio_get_generation_request",
				"Read an original generation request and its recorded outcome.",
				undefined,
				true
			),
			put: operation(
				"video_studio_record_generation_outcome",
				"Record imported outputs or an incomplete attempt. Completed outcomes require existing media IDs of the requested kind. No provider cost is inferred.",
				z.toJSONSchema(generationOutcomeSchema),
				true
			),
		},

		[`${prefix}/projects/{id}/assemble`]: {
			post: operation(
				"video_studio_assemble_storyboard",
				"Build a timeline from selected storyboard takes. Replaces the timeline and captions; prior revisions remain in history. Requires the current project revision.",
				{
					type: "object",
					properties: {
						revision: { type: "integer", minimum: 0 },
						includeTitles: { type: "boolean" },
					},
					required: ["revision", "includeTitles"],
				},
				true
			),
		},
		[`${prefix}/projects/{id}/recipe`]: {
			post: operation(
				"video_studio_apply_recipe",
				"Compose imported media into a montage, cinematic montage, narrated slideshow, waveform video, clip factory, or multicam cut. Replaces the timeline, titles and captions. Requires current revision and approved media when scene approval is required.",
				z.toJSONSchema(recipeSchema),
				true
			),
		},
		[`${prefix}/projects/{id}/ripple-delete`]: {
			post: operation(
				"video_studio_ripple_delete_range",
				"Remove a timeline interval and shift later clips and timed layers left. Requires the current project revision.",
				{
					type: "object",
					properties: {
						end: { type: "number", minimum: 0, maximum: 7200 },
						revision: { type: "integer", minimum: 0 },
						start: { type: "number", minimum: 0, maximum: 7200 },
					},
					required: ["end", "revision", "start"],
				},
				true
			),
		},
		[`${prefix}/projects/{id}/layout`]: {
			post: operation(
				"video_studio_apply_layout",
				'Apply a named composition layout to selected visual clips. Selection order determines slot order and requires the current project revision. Optional fit: "fit" letterboxes each clip in its cell (removing an earlier layout fill crop); "fill" crops each clip to cover its cell, replacing its crop; omitted keeps each clip\'s framing.',
				{
					type: "object",
					properties: {
						fit: { type: "string", enum: ["fit", "fill"] },
						layout: { type: "string", enum: layoutSchema.options },
						revision: { type: "integer", minimum: 0 },
						segmentIds: {
							type: "array",
							items: { type: "string", format: "uuid" },
							minItems: 1,
							maxItems: 16,
						},
					},
					required: ["layout", "revision", "segmentIds"],
				},
				true
			),
		},
		[`${prefix}/projects/{id}/insert`]: {
			post: operation(
				"video_studio_insert_clips",
				"Insert one or more clips at a timeline point and ripple later clips and timed layers right. Requires the current project revision.",
				z.toJSONSchema(insertClipsRequestSchema),
				true
			),
		},
		[`${prefix}/projects/{id}/capture-frame`]: {
			post: operation(
				"video_studio_capture_frame",
				"Capture the current composited timeline frame as a new app-owned PNG asset. Requires the current project revision.",
				{
					type: "object",
					properties: {
						name: { type: "string", maxLength: 200 },
						revision: { type: "integer", minimum: 0 },
						time: { type: "number", minimum: 0, maximum: 7200 },
					},
					required: ["revision", "time"],
				},
				true
			),
		},
		[`${prefix}/projects/{id}/inspect-frame`]: {
			get: operation(
				"video_studio_inspect_timeline",
				"Render one read-only composited timeline frame as base64 PNG data without creating a media asset. Optional ungraded=<clip id>,… (at most 8) renders those clips with a neutral colour grade.",
				undefined,
				true,
				[
					{
						name: "time",
						schema: { type: "number", minimum: 0, maximum: 7200, default: 0 },
					},
					// Comma-separated clip ids (at most 8) rendered with a neutral
					// colour grade, e.g. to preview looks that replace their grade.
					{ name: "ungraded", schema: { type: "string" } },
				]
			),
		},
		[`${prefix}/assets`]: {
			get: {
				...operation(
					"video_studio_list_media",
					"List imported media and source metadata. Preview proxies (derivation proxy) are hidden unless includeProxies=1; list one asset's proxies with GET /assets/{id}/proxies."
				),
				parameters: [
					{
						name: "includeProxies",
						in: "query",
						required: false,
						schema: { type: "string", enum: ["0", "1"] },
					},
				],
			},
		},
		[`${prefix}/search`]: {
			get: {
				...operation(
					"video_studio_search_media",
					"Search current app-owned transcript index ranges by spoken text, plus analyzed shots: words are matched against vision captions and tags (POST /assets/{id}/shots/descriptions) and look words against the measured colour, motion and framing labels, which still apply to shots without a description. Results include source asset, time ranges and `source` (`transcript` or `shot`); Core Spaces remains the authority for semantic indexing.",
					undefined,
					true
				),
				parameters: [
					{
						name: "q",
						in: "query",
						required: true,
						schema: { type: "string", minLength: 1, maxLength: 200 },
					},
					{
						name: "assetId",
						in: "query",
						required: false,
						schema: { type: "string", format: "uuid" },
					},
					{
						name: "limit",
						in: "query",
						required: false,
						schema: { type: "integer", minimum: 1, maximum: 50, default: 10 },
					},
				],
			},
		},
		[`${prefix}/assets/import`]: {
			post: operation(
				"video_studio_import_media",
				"Import one local file, HTTPS URL, or bounded inline media payload into app-owned storage. The source is probed before registration. Bundled stickers may declare `origin` (provider bundled) and `derivation: sticker` so they appear in project credits. Heavy video (wider than 1920 px or above 30 Mb/s) gets a 960 px preview proxy in the background unless proxy settings turn autoProxy off.",
				z.toJSONSchema(importMediaRequestSchema),
				true
			),
		},
		[`${prefix}/assets/{id}/analyze`]: {
			post: operation(
				"video_studio_analyze_media",
				"Analyze real scene changes and audio levels. Poll the asset analysis endpoint.",
				undefined,
				true
			),
		},
		[`${prefix}/assets/{id}/analysis`]: {
			get: operation(
				"video_studio_media_analysis",
				"Read source-derived scene cut timestamps and waveform data.",
				undefined,
				true
			),
		},
		[`${prefix}/renders/{id}`]: {
			get: operation(
				"video_studio_export_status",
				"Read export state and verified output metadata.",
				undefined,
				true
			),
		},
		[`${prefix}/renders/{id}/cancel`]: {
			post: operation(
				"video_studio_cancel_export",
				"Cancel an active render.",
				undefined,
				true
			),
		},
	};
	return {
		openapi: "3.1.0",
		info: { title: "Ryu Video Studio", version: "1.0.0" },
		paths: mergeRouteOperations(paths, routes),
	};
}
