/**
 * AutoCut and vertical shorts (W4-G5): `POST /auto-edit` builds a new
 * beat-cut project from several sources, and `POST /projects/:id/shorts`
 * cuts the project's best highlights into vertical projects. Clips placed on
 * a canvas of another aspect then follow their subjects (W4-AI1 reframe).
 */
import { sourceBeats } from "../../../shared/analysis.ts";
import {
	type AutoCutSource,
	autoCutMedia,
	autoEditRequestSchema,
	buildAutoCutProject,
	buildShortProject,
	recordReframes,
	shortsRequestSchema,
} from "../../../shared/auto-edit.ts";
import { scoreHighlights } from "../../../shared/highlights.ts";
import {
	type Asset,
	newProject,
	type Project,
} from "../../../shared/project.ts";
import {
	hasOwnFraming,
	type ReframeClipResult,
	reframeToSubjects,
	type SubjectTrack,
} from "../../../shared/reframe.ts";
import { timelineTranscript } from "../../../shared/timeline-transcript.ts";
import {
	completedWaveform,
	heardProject,
	timelineSceneCuts,
	timelineText,
	timelineWaveform,
} from "../edit-evidence.ts";
import { trackSubjects } from "../saliency.ts";
import { readShotIndex, shotIndexIsCurrent } from "../shot-stats.ts";
import { ConflictError, type StudioStore } from "../store.ts";
import type { StudioRoute } from "./registry.ts";

/** The project library bound (`StudioStore.create`). */
const MAX_PROJECTS = 500;

/** Analysis, transcript and shot motion of one source, in source seconds. */
function autoCutSource(store: StudioStore, asset: Asset): AutoCutSource {
	const source: AutoCutSource = { asset };
	const analysis = store.analysis(asset.id);
	if (analysis?.status === "completed") {
		source.sceneCuts = analysis.sceneCuts;
	}
	const waveform = completedWaveform((id) => store.analysis(id), asset.id);
	if (waveform) {
		source.waveform = waveform;
	}
	const transcript = store.transcript(asset.id);
	if (transcript?.status === "completed") {
		source.words = transcript.words;
		source.cues = transcript.cues;
	}
	const shots = readShotIndex(store, asset.id);
	if (shots && shotIndexIsCurrent(store, shots)) {
		source.shots = shots.shots;
	}
	return source;
}

/** Save a built project as a new library project with its own id. */
function saveAsNew(
	store: StudioStore,
	built: Project,
	requireApproval: boolean
): Project {
	const created = store.create(built.title, requireApproval);
	return store.save({
		...built,
		id: created.id,
		requireApproval: created.requireApproval,
		revision: created.revision,
		updatedAt: created.updatedAt,
	});
}

/**
 * Re-frame the clips a build placed with a centred crop so they follow their
 * subjects (`POST /projects/:id/reframe` track mode). Tracking takes one
 * media admission; when it cannot run (for example two exports are busy),
 * the clips keep the centred crop and their results say so.
 */
async function followSubjects(
	store: StudioStore,
	project: Project,
	clipIds: readonly string[],
	signal: AbortSignal | undefined
): Promise<{ clips: ReframeClipResult[]; project: Project }> {
	if (clipIds.length === 0) {
		return { clips: [], project };
	}
	const wanted = new Set(clipIds);
	let tracks: Map<string, SubjectTrack>;
	try {
		tracks = await trackSubjects(
			store,
			project.segments.filter(
				(segment) => wanted.has(segment.id) && !hasOwnFraming(segment)
			),
			signal
		);
	} catch (error) {
		if (signal?.aborted) {
			throw error;
		}
		tracks = new Map();
	}
	return reframeToSubjects(project, store.assets(), clipIds, tracks);
}

function ensureRoom(store: StudioStore, count: number) {
	// Count rows in SQL rather than parsing every project.
	const stored = store.projectCount();
	if (stored + count > MAX_PROJECTS) {
		throw new Error(
			`The project library has room for ${Math.max(0, MAX_PROJECTS - stored)} more projects.`
		);
	}
}

export const routes: StudioRoute[] = [
	{
		scope: "root",
		path: "auto-edit",
		method: "POST",
		operation: {
			id: "video_studio_auto_edit",
			description:
				"AutoCut: create a new project that cuts the best moments of the listed video or image sources (assetIds, 1-20) to music. Moments are ranked by the highlights scorer (transcript sentences, keywords, loudness peaks, scene cuts) plus shot motion and loudness; analyse sources, index shots and transcribe them first for better picks (unanalysed sources are sampled evenly). With musicAssetId (an audio asset), the edit lasts min(duration, music length), cuts land on its beats (detected bar starts for smooth/minimal, every other bar for cinematic, beats for energetic; run GET /assets/:id/beats first for detected beats, otherwise the loudness estimate is used), the music sits on track 1 with a fade-out and source audio is muted. Without music a fixed grid per style is used. style: energetic (default, zoom/push every 4th cut), smooth (dissolve/blur), cinematic (dissolve/fade-black), minimal (hard cuts). aspect 16:9 (default), 9:16, 1:1 or 4:5 sets the canvas; clips of another aspect fill it and follow their subject like POST /projects/:id/reframe track mode (x or y pan keyframes over a crop band; takes one media admission slot, and a clip that cannot be tracked keeps a centred crop). captions: true builds captions from the transcripts of heard source clips only, so with a music bed (which mutes the sources) no captions are added. Returns the project, the beat slots, each placement (clip, source, range, score, reasons), transitions applied, caption count, beatSource (detected, estimate or none) and reframe (per reframed clip: clipId, mode track or center, axis, keyframes, note).",
			body: autoEditRequestSchema,
		},
		handle: async ({ json, mediaSignal, request, store }) => {
			const input = autoEditRequestSchema.parse(await request.json());
			const assets = store.assets();
			const media = autoCutMedia(input, assets);
			ensureRoom(store, 1);
			const musicAnalysis = media.music ? store.analysis(media.music.id) : null;
			const music = media.music
				? {
						asset: media.music,
						...(musicAnalysis?.status === "completed"
							? {
									beats: sourceBeats(musicAnalysis, {
										from: 0,
										to: Math.min(input.duration, musicAnalysis.duration),
									}),
								}
							: {}),
					}
				: undefined;
			const reframed = recordReframes();
			const result = buildAutoCutProject(
				newProject(input.title ?? "AutoCut"),
				assets,
				input,
				{
					...(music ? { music } : {}),
					sources: media.sources.map((asset) => autoCutSource(store, asset)),
				},
				{ reframe: reframed.adapter }
			);
			const framed = await followSubjects(
				store,
				result.project,
				reframed.clipIds,
				mediaSignal(request)
			);
			ensureRoom(store, 1);
			const project = saveAsNew(store, framed.project, false);
			return json({
				beatSource: result.beatSource,
				captions: result.captions,
				duration: result.duration,
				placements: result.placements,
				project,
				reframe: framed.clips,
				slots: result.slots,
				transitions: result.transitions,
			});
		},
	},
	{
		scope: "project",
		action: "shorts",
		method: "POST",
		operation: {
			id: "video_studio_shorts",
			description:
				"Vertical shorts: rank the saved timeline's highlights (the same scorer as POST /projects/:id/highlights, with minSeconds/maxSeconds, default 15-60, and optional keywords) and create one new project per highlight (count 1-10, default 3), leaving this project unchanged. Each short keeps only its window on every track, changes the canvas to aspect (9:16 default, 16:9, 1:1, 4:5), re-frames full-frame clips to follow their subject (POST /projects/:id/reframe track mode, one media admission slot per short; a clip that cannot be tracked keeps a centred crop), and, unless captions is false, rechunks captions one word at a time (built from clip transcripts when the window has none) with the Punch style. The publishPreset (default youtube-shorts for 9:16, youtube-1080p for 16:9, none otherwise) is stored in each short's export settings; export: true also queues an export of each short. Requires the current project revision. Returns the shorts with their source window, score, reasons and per-clip reframe results, and any export jobs or export errors.",
			body: shortsRequestSchema,
		},
		handle: async ({
			currentProject,
			id,
			json,
			mediaSignal,
			queue,
			request,
			store,
		}) => {
			const input = shortsRequestSchema.parse(await request.json());
			const source = currentProject(
				id,
				input.revision,
				"The project changed. Reload before making shorts."
			);
			const assets = store.assets();
			const analysisFor = (assetId: string) => store.analysis(assetId);
			const text = timelineText(
				timelineTranscript(heardProject(source), (assetId) =>
					store.transcript(assetId)
				)
			);
			const waveform = timelineWaveform(source, assets, analysisFor);
			const candidates = scoreHighlights({
				count: input.count,
				...text,
				...(input.keywords?.length ? { keywords: input.keywords } : {}),
				sceneCuts: timelineSceneCuts(source, assets, analysisFor),
				target: { max: input.maxSeconds, min: input.minSeconds },
				...(waveform ? { waveform } : {}),
			});
			if (candidates.length === 0) {
				throw new Error(
					"No highlights fit those lengths. Transcribe or analyse the sources, or widen the range."
				);
			}
			ensureRoom(store, candidates.length);
			const words = text.words.length > 0 ? text.words : text.cues;
			const built: { clips: ReframeClipResult[]; project: Project }[] = [];
			for (const [index, candidate] of candidates.entries()) {
				const reframed = recordReframes();
				const short = buildShortProject(source, assets, candidate, index + 1, {
					aspect: input.aspect,
					captions: input.captions,
					...(input.publishPreset
						? { publishPreset: input.publishPreset }
						: {}),
					reframe: reframed.adapter,
					words,
				});
				built.push(
					await followSubjects(
						store,
						short,
						reframed.clipIds,
						mediaSignal(request)
					)
				);
			}
			if (store.project(id).revision !== source.revision) {
				throw new ConflictError(
					"The project changed. Reload before making shorts."
				);
			}
			ensureRoom(store, built.length);
			const shorts = built.map(({ clips, project }, index) => {
				const saved = saveAsNew(store, project, source.requireApproval);
				const candidate = candidates[index];
				const short: Record<string, unknown> = {
					end: candidate?.end,
					project: saved,
					reasons: candidate?.reasons ?? [],
					reframe: clips,
					score: candidate?.score,
					start: candidate?.start,
					title: candidate?.title,
				};
				if (input.export) {
					try {
						short.job = queue.start(saved);
					} catch (error) {
						short.exportError =
							error instanceof Error ? error.message : "The export failed.";
					}
				}
				return short;
			});
			return json({ revision: source.revision, shorts });
		},
	},
];
