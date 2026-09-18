import { mkdir, open, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { bearerOk } from "@ryu/sidecar-runtime";
import { z } from "zod";
import { estimateBeatTimes, silenceRanges } from "../../shared/analysis.ts";
import { audioPlaybackSchema } from "../../shared/audio.ts";
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
import {
	appendDecision,
	appendDecisionRequestSchema,
} from "../../shared/decisions.ts";
import {
	applyEffects,
	effectEditRequestSchema,
} from "../../shared/effect-edits.ts";
import {
	generationOutcomeSchema,
	generationRequestSchema,
} from "../../shared/generation.ts";
import { importMediaRequestSchema } from "../../shared/import-media.ts";
import { insertClips, insertClipsRequestSchema } from "../../shared/insert.ts";
import {
	interchangeFilename,
	interchangeFormatSchema,
	interchangeText,
} from "../../shared/interchange.ts";
import { applyLayout, layoutSchema } from "../../shared/layouts.ts";
import {
	manageMarker,
	manageMarkerRequestSchema,
} from "../../shared/markers.ts";
import {
	mediaSearchRequestSchema,
	searchMedia,
} from "../../shared/media-search.ts";
import {
	changeMulticamAngles,
	createMulticamGroup,
	multicamRequestSchema,
	ungroupMulticam,
} from "../../shared/multicam.ts";
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
	projectSchema,
	rippleDeleteRange,
	subtitleText,
	updateTrackSetting,
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
import { createSequenceRequestSchema } from "../../shared/sequences.ts";
import {
	projectSettingsRequestSchema,
	updateProjectSettings,
} from "../../shared/settings.ts";
import { soundtrackRequestSchema } from "../../shared/soundtrack.ts";
import {
	generateStageWorld,
	stageWorldRequestSchema,
} from "../../shared/stage-world.ts";
import { stockProviderSchema } from "../../shared/stock.ts";
import { assembleStoryboard } from "../../shared/storyboard.ts";
import { syncClips, syncRequestSchema } from "../../shared/sync.ts";
import {
	addClips,
	addClipsRequestSchema,
	moveClip,
	moveClipRequestSchema,
	removeClips,
	removeClipsRequestSchema,
	setKeyframes,
	setKeyframesRequestSchema,
	splitClip,
	splitClipRequestSchema,
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
import {
	reorderTracks,
	reorderTracksRequestSchema,
} from "../../shared/track-edits.ts";
import { undoRequestSchema } from "../../shared/undo.ts";
import { upscaleRequestSchema } from "../../shared/upscale.ts";
import { AnalysisQueue } from "./analysis.ts";
import { extractAudioWindow } from "./audio-window.ts";
import { captureTimelineFrame, renderTimelineFrame } from "./capture.ts";
import { inspectColorAsset } from "./color-scopes.ts";
import { importMediaAsset } from "./import-media.ts";
import { probe, runMedia, thumbnail } from "./media.ts";
import { RenderQueue } from "./render.ts";
import { createSequenceAsset, refreshSequenceAsset } from "./sequence.ts";
import { generateSoundtrack } from "./soundtrack.ts";
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
import { upscaleAsset } from "./upscale.ts";

const chunkSize = 512 * 1024;
const maxMediaBytes = 2 * 1024 * 1024 * 1024;
const uploadSchema = z
	.object({
		name: z.string().trim().min(1).max(200),
		size: z.number().int().min(1).max(maxMediaBytes),
	})
	.strict();
const chunkSchema = z
	.object({
		offset: z.number().int().nonnegative(),
		data: z.string().max(700_000),
	})
	.strict();
const prefix = "/api/video-studio";
interface Upload {
	busy: boolean;
	id: string;
	name: string;
	offset: number;
	path: string;
	reservation: MediaReservation;
	size: number;
	updated: number;
}

export function createStudioServer(options: {
	budgetAudit?: () => Promise<unknown>;
	budgetSpend?: () => Promise<unknown>;
	store: StudioStore;
	token: string;
	port: number;
}) {
	const { store, token } = options;
	const queue = new RenderQueue(store);
	const analyses = new AnalysisQueue(store);
	const uploads = new Map<string, Upload>();
	const json = (body: unknown, status = 200) =>
		Response.json(body, { status, headers: { "cache-control": "no-store" } });
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
	const auditEntries = async (): Promise<unknown[]> => {
		if (!options.budgetAudit) {
			return [];
		}
		try {
			const result = await options.budgetAudit();
			return result &&
				typeof result === "object" &&
				"entries" in result &&
				Array.isArray(result.entries)
				? result.entries
				: [];
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
					return json(openapi());
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
							const project = store.project(input.projectId);
							const admission = canStartGeneration(
								project,
								store.generationJobs(project.id),
								input.kind,
								await auditEntries()
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
				if (resource === "soundtrack" && !rawId && method === "POST") {
					return json(
						await generateSoundtrack(store, await request.json()),
						201
					);
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

				if (resource === "capabilities" && method === "GET") {
					const available = await runMedia(["-version"]).then(
						() => true,
						() => false
					);
					return json({
						renderer: available,
						maxMediaBytes,
						chunkSize,
						codecs: ["h264", "h265", "prores"],
						formats: ["mp4", "mov"],
						maxDuration: 7200,
					});
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
						const created = store.create(`${bundle.project.title} (imported)`);
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
									.int()
									.min(0)
									.max(15)
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
							await createSequenceAsset(store, parent, source, input.name),
							201
						);
					}
					if (id && action === "markers" && method === "POST") {
						const input = manageMarkerRequestSchema.parse(await request.json());
						const project = store.project(id);
						if (project.revision !== input.revision) {
							throw new ConflictError(
								"The project changed. Reload before updating timeline markers."
							);
						}
						const result = manageMarker(project, store.assets(), input);
						return json({
							...(result.marker === undefined ? {} : { marker: result.marker }),
							project: store.save(result.project),
						});
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
					if (id && action === "split" && method === "POST") {
						const input = splitClipRequestSchema.parse(await request.json());
						return revisionedProjectEdit(
							id,
							input.revision,
							"The project changed. Reload before splitting the clip.",
							(project, assets) => splitClip(project, assets, input)
						);
					}
					if (id && action === "remove" && method === "POST") {
						const input = removeClipsRequestSchema.parse(await request.json());
						return revisionedProjectEdit(
							id,
							input.revision,
							"The project changed. Reload before removing clips.",
							(project, assets) => removeClips(project, assets, input)
						);
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
								generations,
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
												input.source
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
						const project = store.project(id);
						if (project.revision !== input.revision) {
							throw new ConflictError(
								"The project changed. Reload before appending a decision."
							);
						}
						return json(store.save(appendDecision(project, input)));
					}
					if (id && action === "budget" && method === "GET") {
						const project = store.project(id);
						return json(
							productionBudgetStatus(
								project,
								store.generationJobs(project.id),
								await auditEntries()
							)
						);
					}
					if (id && action === "credits" && method === "GET") {
						const project = store.project(id);
						const credits = creditsForProject(project, store.assets());
						return json({ ...credits, markdown: creditsMarkdown(credits) });
					}
					if (id && action === "package" && method === "GET") {
						return json(projectPackage(store.project(id), store.assets()));
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
					if (id && action === "settings" && method === "POST") {
						const input = projectSettingsRequestSchema.parse(
							await request.json()
						);
						const project = store.project(id);
						if (project.revision !== input.revision) {
							throw new ConflictError(
								"The project changed. Reload before updating settings."
							);
						}
						return json(
							store.save(updateProjectSettings(project, store.assets(), input))
						);
					}
					if (id && action === "multicam" && method === "GET") {
						return json({ groups: store.project(id).multicamGroups });
					}
					if (id && action === "multicam" && method === "POST") {
						const input = multicamRequestSchema.parse(await request.json());
						const project = store.project(id);
						if (project.revision !== input.revision) {
							throw new ConflictError(
								"The project changed. Reload before updating multicam."
							);
						}
						const result =
							input.action === "create"
								? createMulticamGroup(project, store.assets(), input)
								: input.action === "change"
									? changeMulticamAngles(project, store.assets(), input)
									: {
											project: ungroupMulticam(project, store.assets(), input),
										};
						const saved = store.save(result.project);
						return json(
							"group" in result
								? { group: result.group, project: saved }
								: { project: saved }
						);
					}
					if (id && action === "clip-properties" && method === "POST") {
						const input = setClipPropertiesRequestSchema.parse(
							await request.json()
						);
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
					if (
						id &&
						action === "tracks" &&
						subaction === "reorder" &&
						method === "POST"
					) {
						const input = reorderTracksRequestSchema.parse(
							await request.json()
						);
						const project = store.project(id);
						if (project.revision !== input.revision) {
							throw new ConflictError(
								"The project changed. Reload before reordering tracks."
							);
						}
						return json(store.save(reorderTracks(project, input.order)));
					}
					if (id && action === "tracks" && !subaction && method === "POST") {
						const input = z
							.object({
								locked: z.boolean().optional(),
								muted: z.boolean().optional(),
								name: z.string().trim().min(1).max(80).optional(),
								revision: z.number().int().nonnegative(),
								solo: z.boolean().optional(),
								track: z.number().int().min(0).max(15),
							})
							.strict()
							.parse(await request.json());
						const project = store.project(id);
						if (project.revision !== input.revision) {
							throw new ConflictError(
								"The project changed. Reload before updating a track."
							);
						}
						return json(
							store.save(
								updateTrackSetting(project, input.track, {
									...(input.locked === undefined
										? {}
										: { locked: input.locked }),
									...(input.muted === undefined ? {} : { muted: input.muted }),
									...(input.name === undefined ? {} : { name: input.name }),
									...(input.solo === undefined ? {} : { solo: input.solo }),
								})
							)
						);
					}
					if (id && action === "layout" && method === "POST") {
						const input = z
							.object({
								layout: layoutSchema,
								revision: z.number().int().nonnegative(),
								segmentIds: z.array(idSchema).min(1).max(16),
							})
							.strict()
							.parse(await request.json());
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
							store.save(applyLayout(project, input.segmentIds, input.layout))
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
					if (id && action === "sync" && method === "POST") {
						const input = syncRequestSchema.parse(await request.json());
						const project = store.project(id);
						if (project.revision !== input.revision) {
							throw new ConflictError(
								"The project changed. Reload before syncing clips."
							);
						}
						const analysesByAsset = new Map(
							store
								.assets()
								.map((asset) => [asset.id, store.analysis(asset.id)])
						);
						const result = syncClips(
							project,
							store.assets(),
							analysesByAsset,
							input
						);
						return json({
							...result,
							project: store.save(result.project),
						});
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
								input.name ?? ""
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
						const project = store.project(id);
						const frame = await renderTimelineFrame(store, project, time);
						return json({
							data: Buffer.from(frame).toString("base64"),
							height: project.height,
							mimeType: "image/png",
							projectId: project.id,
							time,
							width: project.width,
						});
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
					if (id && action === "history" && method === "GET") {
						return json({ history: store.history(id) });
					}
					if (id && action === "history" && method === "POST") {
						const input = z
							.object({
								historyRevision: z.number().int().nonnegative(),
								revision: z.number().int().nonnegative(),
							})
							.strict()
							.parse(await request.json());
						return json(
							store.restoreHistory(id, input.revision, input.historyRevision)
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
					if (id && action === "render" && method === "POST") {
						return json(queue.start(store.project(id)), 202);
					}
					if (id && action === "subtitles" && method === "GET") {
						const format = z
							.enum(["srt", "vtt"])
							.parse(url.searchParams.get("format") ?? "srt");
						return json({
							text: subtitleText(activeCaptions(store.project(id)), format),
							format,
						});
					}
					if (id && action === "captions" && method === "POST") {
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
					for (const [key, value] of uploads) {
						if (!value.busy && Date.now() - value.updated > 30 * 60_000) {
							await rm(value.path, { force: true });
							value.reservation.release();
							uploads.delete(key);
						}
					}
					if (!id && method === "POST") {
						if (
							uploads.size >= 4 ||
							store.assets().length >= MAX_MEDIA_ASSETS
						) {
							throw new Error("Media upload limit reached.");
						}
						const input = uploadSchema.parse(await request.json());
						const reservation = store.reserveMediaStorage(input.size);
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
					if (!action && method === "PUT") {
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
						upload.busy = true;
						try {
							const file = await open(upload.path, "a");
							try {
								await file.writeFile(bytes);
							} finally {
								await file.close();
							}
							upload.offset += bytes.length;
							upload.updated = Date.now();
						} finally {
							upload.busy = false;
						}
						return json({ offset: upload.offset });
					}
					if (action === "finish" && method === "POST") {
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
						searchMedia(store.searchIndexes(), store.assets(), input)
					);
				}
				if (resource === "search-indexes" && method === "GET") {
					return json({ indexes: store.searchIndexes() });
				}
				if (resource === "assets") {
					if (rawId === "import" && method === "POST") {
						const input = importMediaRequestSchema.parse(await request.json());
						return json(
							await importMediaAsset(store, input, {
								localImportRoot:
									Bun.env.RYU_VIDEO_STUDIO_IMPORT_ROOT?.trim() ||
									join(store.directory, "imports"),
							}),
							201
						);
					}
					if (!id && method === "GET") {
						return json({ assets: store.assets() });
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
					if (action === "upscale" && method === "POST") {
						const input = upscaleRequestSchema.parse(await request.json());
						return json(await upscaleAsset(store, asset, input), 201);
					}
					if (action === "refresh-sequence" && method === "POST") {
						return json(await refreshSequenceAsset(store, asset));
					}
					if (action === "scopes" && method === "GET") {
						const sampledAt = z.coerce
							.number()
							.finite()
							.min(0)
							.max(7200)
							.parse(url.searchParams.get("time") ?? 0);
						return json(await inspectColorAsset(store, asset, sampledAt));
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
					if (action === "transcript" && method === "POST") {
						const body = await request.text();
						const input = z
							.object({
								restart: z.boolean().default(false),
								revision: z.number().int().nonnegative().nullable().optional(),
							})
							.strict()
							.parse(body.trim() ? JSON.parse(body) : {});
						return json(
							input.restart
								? store.restartTranscript(asset, input.revision ?? null)
								: store.beginTranscript(asset)
						);
					}
					if (action === "transcript" && method === "PUT") {
						const input = z
							.object({
								revision: z.number().int().nonnegative(),
								offset: z.number().finite().nonnegative(),
								cues: z.array(captionSchema).max(1000),
								words: z.array(captionSchema).max(1000).default([]),
								timing: z.enum(["windows", "segments"]).default("windows"),
							})
							.strict()
							.parse(await request.json());
						return json(
							store.appendTranscript(
								asset.id,
								input.revision,
								input.offset,
								input.cues,
								input.timing,
								input.words
							)
						);
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
					if (action === "beats" && method === "GET") {
						const analysis = store.analysis(asset.id);
						if (analysis?.status !== "completed") {
							throw new Error(
								"Complete source analysis before estimating beat markers."
							);
						}
						return json({
							assetId: asset.id,
							times: estimateBeatTimes(analysis.waveform, analysis.duration),
						});
					}
					if (action === "silence" && method === "GET") {
						const analysis = store.analysis(asset.id);
						if (analysis?.status !== "completed") {
							throw new Error(
								"Complete source analysis before detecting silent ranges."
							);
						}
						return json({
							assetId: asset.id,
							ranges: silenceRanges(analysis.waveform, analysis.duration),
						});
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
						const thumbnailPath = join(
							store.directory,
							"media",
							`${asset.id}.jpg`
						);
						const thumbnailData =
							includeThumbnail && (await Bun.file(thumbnailPath).exists())
								? Buffer.from(
										await Bun.file(thumbnailPath).arrayBuffer()
									).toString("base64")
								: undefined;
						const frames: Array<{ data: string; time: number }> = [];
						if (asset.kind === "video" && sampleCount > 0) {
							const work = join(
								store.directory,
								"renders",
								`inspect-${crypto.randomUUID()}`
							);
							await mkdir(work, { recursive: true, mode: 0o700 });
							try {
								for (let index = 0; index < sampleCount; index++) {
									const time = Number(
										Math.min(
											Math.max(0, asset.duration - 1 / 30),
											(asset.duration * index) / Math.max(1, sampleCount - 1)
										).toFixed(3)
									);
									const path = join(work, `frame-${index}.jpg`);
									await runMedia(
										[
											"-hide_banner",
											"-loglevel",
											"error",
											"-nostdin",
											"-ss",
											String(time),
											"-i",
											store.mediaPath(asset.id),
											"-frames:v",
											"1",
											"-q:v",
											"3",
											path,
										],
										{ cwd: work }
									);
									frames.push({
										data: Buffer.from(
											await Bun.file(path).arrayBuffer()
										).toString("base64"),
										time,
									});
								}
							} finally {
								await rm(work, { recursive: true, force: true });
							}
						}
						return json({
							analysis: store.analysis(asset.id),
							asset,
							frames,
							thumbnail: thumbnailData,
							transcript: store.transcript(asset.id),
						});
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
				return json({ code: "NOT_FOUND", message: "Route not found." }, 404);
			} catch (error) {
				return json(
					{
						code:
							error instanceof ConflictError ? "CONFLICT" : "INVALID_REQUEST",
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
			queue.stop();
			analyses.stop();
			server.stop();
		},
	};
}

export function openapi() {
	const project = z.toJSONSchema(projectSchema);
	const operation = (
		id: string,
		description: string,
		body?: unknown,
		pathParameter = false,
		query?:
			| { name: string; schema: Record<string, unknown> }
			| Array<{ name: string; schema: Record<string, unknown> }>
	) => ({
		operationId: id,
		description,
		...(pathParameter || query
			? {
					parameters: [
						...(pathParameter
							? [
									{
										name: "id",
										in: "path",
										required: true,
										schema: { type: "string", format: "uuid" },
									},
								]
							: []),
						...(query
							? (Array.isArray(query) ? query : [query]).map((item) => ({
									name: item.name,
									in: "query",
									required: false,
									schema: item.schema,
								}))
							: []),
					],
				}
			: {}),
		...(body
			? {
					requestBody: {
						required: true,
						content: { "application/json": { schema: body } },
					},
				}
			: {}),
		responses: {
			"200": { description: "Successful operation" },
			"400": { description: "Invalid request" },
			"401": { description: "Unauthorized" },
			"409": { description: "Revision conflict" },
		},
	});
	return {
		openapi: "3.1.0",
		info: { title: "Ryu Video Studio", version: "1.0.0" },
		paths: {
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
			[`${prefix}/assets/{id}/upscale`]: {
				post: operation(
					"video_studio_upscale_media",
					"Create a new app-owned image or video derivative with a bounded local Lanczos upscale. The source remains unchanged; dimensions are capped at 3840 pixels on the long edge.",
					{
						type: "object",
						properties: {
							factor: { type: "integer", enum: [2, 4], default: 2 },
							name: { type: "string", minLength: 1, maxLength: 200 },
						},
					},
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
			[`${prefix}/assets/{id}/scopes`]: {
				get: operation(
					"video_studio_inspect_color",
					"Measure luma, chroma, saturation, hue, and clipping for one sampled image or video frame.",
					undefined,
					true,
					{
						name: "time",
						schema: { type: "number", minimum: 0, maximum: 7200 },
					}
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
				post: operation(
					"video_studio_begin_transcript",
					"Begin or resume source transcription. Returns the next source offset and revision.",
					{
						type: "object",
						properties: {
							restart: { type: "boolean", default: false },
							revision: { type: ["integer", "null"], minimum: 0 },
						},
					},
					true
				),
				put: operation(
					"video_studio_save_transcript_window",
					"Append source-timed cues for exactly the next 20-second window, using its current revision.",
					{
						type: "object",
						properties: {
							revision: { type: "integer" },
							offset: { type: "number" },
							timing: {
								type: "string",
								enum: ["windows", "segments"],
								default: "windows",
							},
							cues: { type: "array", items: z.toJSONSchema(captionSchema) },
						},
						required: ["revision", "offset", "cues"],
					},
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

			[`${prefix}/capabilities`]: {
				get: operation(
					"video_studio_capabilities",
					"Read renderer availability, supported export codecs and formats, and media limits."
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
			[`${prefix}/soundtrack`]: {
				post: operation(
					"video_studio_generate_soundtrack",
					"Generate a bounded local soundtrack WAV with a selected mood and tempo, then save it as an app-owned audio asset.",
					z.toJSONSchema(soundtrackRequestSchema)
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
					"Begin a chunked media upload. Upload each chunk at the returned offset, then finish to validate and register the media.",
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
			[`${prefix}/uploads/{id}/finish`]: {
				post: operation(
					"video_studio_finish_upload",
					"Validate and register a complete uploaded media file.",
					undefined,
					true
				),
			},
			[`${prefix}/projects/{id}/history`]: {
				get: operation(
					"video_studio_project_history",
					"Read up to 100 prior project revisions.",
					undefined,
					true
				),
				post: operation(
					"video_studio_restore_project_history",
					"Restore a selected saved project revision as a new current revision. Requires the current revision and a historyRevision returned by GET.",
					{
						type: "object",
						properties: {
							historyRevision: { type: "integer", minimum: 0 },
							revision: { type: "integer", minimum: 0 },
						},
						required: ["historyRevision", "revision"],
					},
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
					"Export timed captions as SRT by default; the format query accepts srt or vtt.",
					undefined,
					true,
					{
						name: "format",
						schema: { type: "string", enum: ["srt", "vtt"], default: "srt" },
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
					"Append, replace, update, or remove timed titles and lower thirds without replacing the project body. Requires the current project revision.",
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
						schema: { type: "integer", minimum: 0, maximum: 15 },
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
			[`${prefix}/projects/{id}/markers`]: {
				post: operation(
					"video_studio_manage_markers",
					"Create, update, or delete a revisioned point or range marker with review status and comments.",
					z.toJSONSchema(manageMarkerRequestSchema),
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
			[`${prefix}/projects/{id}/split`]: {
				post: operation(
					"video_studio_split_clip",
					"Split one clip at a timeline time while preserving source timing and keyframes. Requires the current project revision.",
					z.toJSONSchema(splitClipRequestSchema),
					true
				),
			},
			[`${prefix}/projects/{id}/remove`]: {
				post: operation(
					"video_studio_remove_clips",
					"Remove one or more unlocked clips and clean up empty multicam metadata. Requires the current project revision.",
					z.toJSONSchema(removeClipsRequestSchema),
					true
				),
			},
			[`${prefix}/projects/{id}/keyframes`]: {
				post: operation(
					"video_studio_set_keyframes",
					"Replace one clip's x, y, scale, rotation, or volume keyframe track. Times are clip-relative and the current project revision is required.",
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
					"Export a validated editable project package with referenced asset metadata and provenance credits. Media bytes remain on the node.",
					undefined,
					true
				),
			},
			[`${prefix}/projects/{id}/interchange`]: {
				get: {
					...operation(
						"video_studio_project_interchange",
						"Export the saved timeline as Final Cut/Resolve FCPXML or Premiere XMEML with app-owned asset references.",
						undefined,
						true
					),
					parameters: [
						{
							name: "format",
							in: "query",
							required: false,
							schema: {
								type: "string",
								enum: interchangeFormatSchema.options,
								default: "fcpxml",
							},
						},
					],
				},
			},
			[`${prefix}/projects/{id}/settings`]: {
				post: operation(
					"video_studio_update_project_settings",
					"Update bounded canvas, aspect ratio, quality preset, frame rate, export codec, export preset, or visual style settings with a current project revision. Explicit dimensions cannot be combined with aspect ratio or quality.",
					z.toJSONSchema(projectSettingsRequestSchema),
					true
				),
			},
			[`${prefix}/projects/{id}/multicam`]: {
				get: operation(
					"video_studio_get_multicam",
					"Read durable multicam groups and their current angle switches.",
					undefined,
					true
				),
				post: operation(
					"video_studio_manage_multicam",
					"Create, change, or ungroup a multicam session. Creation writes ordinary timeline clips plus a program-audio layer; angle changes require the current project revision.",
					z.toJSONSchema(multicamRequestSchema),
					true
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
			[`${prefix}/projects/{id}/tracks`]: {
				post: operation(
					"video_studio_update_track",
					"Update a timeline track name, mute, solo, or lock state. Requires the current project revision.",
					{
						type: "object",
						properties: {
							locked: { type: "boolean" },
							muted: { type: "boolean" },
							name: { type: "string", minLength: 1, maxLength: 80 },
							revision: { type: "integer", minimum: 0 },
							solo: { type: "boolean" },
							track: { type: "integer", minimum: 0, maximum: 15 },
						},
						required: ["revision", "track"],
					},
					true
				),
			},
			[`${prefix}/projects/{id}/tracks/reorder`]: {
				post: operation(
					"video_studio_reorder_tracks",
					"Reorder the visible timeline tracks from bottom to top. Clip lanes and their saved track settings move together and the operation requires the current project revision.",
					{
						type: "object",
						properties: {
							order: {
								type: "array",
								items: { type: "integer", minimum: 0, maximum: 15 },
								minItems: 1,
								maxItems: 16,
							},
							revision: { type: "integer", minimum: 0 },
						},
						required: ["order", "revision"],
					},
					true
				),
			},
			[`${prefix}/projects/{id}/layout`]: {
				post: operation(
					"video_studio_apply_layout",
					"Apply a named composition layout to selected visual clips. Selection order determines slot order and requires the current project revision.",
					{
						type: "object",
						properties: {
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
			[`${prefix}/projects/{id}/sync`]: {
				post: operation(
					"video_studio_sync_clips",
					"Align audio-bearing timeline clips to a reference using embedded source timecode, completed local audio envelopes, or a bounded manual offset. Requires the current project revision.",
					z.toJSONSchema(syncRequestSchema),
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
				get: {
					...operation(
						"video_studio_inspect_timeline",
						"Render one read-only composited timeline frame as base64 PNG data without creating a media asset.",
						undefined,
						true
					),
					parameters: [
						{
							name: "time",
							in: "query",
							required: false,
							schema: { type: "number", minimum: 0, maximum: 7200, default: 0 },
						},
					],
				},
			},
			[`${prefix}/projects/{id}/render`]: {
				post: operation(
					"video_studio_render",
					"Render the saved timeline to MP4. Approval gates are enforced. Poll the returned job ID.",
					undefined,
					true
				),
			},
			[`${prefix}/assets`]: {
				get: operation(
					"video_studio_list_media",
					"List imported media and source metadata."
				),
			},
			[`${prefix}/search`]: {
				get: {
					...operation(
						"video_studio_search_media",
						"Search current app-owned transcript index ranges by spoken text. Results include source asset and time ranges; Core Spaces remains the authority for semantic indexing.",
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
					"Import one local file, HTTPS URL, or bounded inline media payload into app-owned storage. The source is probed before registration.",
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
			[`${prefix}/assets/{id}/beats`]: {
				get: operation(
					"video_studio_estimate_beats",
					"Estimate recurring beat onsets from a completed source RMS envelope. Results are cues for review, not guaranteed tempo or beat truth.",
					undefined,
					true
				),
			},
			[`${prefix}/assets/{id}/silence`]: {
				get: operation(
					"video_studio_detect_silence",
					"Detect bounded silent source intervals from a completed RMS envelope. Review ranges before applying a ripple edit.",
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
		},
	};
}
