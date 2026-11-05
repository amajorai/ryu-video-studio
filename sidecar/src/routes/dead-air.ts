import {
	type ClipEnvelope,
	confirmDeadAirWithVoiceActivity,
	type DeadAirPlanRequest,
	deadAirPlanRequestSchema,
	deadAirRanges,
	timelineWaveform,
} from "../../../shared/dead-air.ts";
import {
	type TimelineRange,
	transcriptClipSpans,
} from "../../../shared/filler-words.ts";
import { type Project, projectDuration } from "../../../shared/project.ts";
import { timelineTranscript } from "../../../shared/timeline-transcript.ts";
import {
	audibleSegments,
	resolveVadParams,
	sourceSpansToTimeline,
	vadSpeech,
} from "../../../shared/vad.ts";
import { withMediaOperation } from "../media-operation.ts";
import type { StudioStore } from "../store.ts";
import { vadRefusal, voiceActivityFeatures } from "../vad.ts";
import type { StudioRoute } from "./registry.ts";

/** Distinct sources analyzed for speech in one plan request. */
const MAX_VAD_SOURCES = 12;
const VAD_PLAN_TIMEOUT_MS = 15 * 60_000;
const DEFAULT_KEEP_PAUSE = 0.2;
const DEFAULT_PADDING = 0.05;

export interface VoiceActivitySummary {
	/** Sources whose speech confirmed the plan. */
	analyzed: number;
	/** Sources skipped (no audio, over the source limit, or extraction failed). */
	skipped: number;
}

/**
 * Timeline speech across every audible clip, detected by VAD on each
 * distinct source. Sources that cannot be analyzed are counted as skipped.
 */
async function timelineSpeech(
	store: StudioStore,
	project: Project,
	input: DeadAirPlanRequest,
	signal: AbortSignal
): Promise<{ speech: TimelineRange[]; summary: VoiceActivitySummary }> {
	const params = resolveVadParams({
		minPause: input.minPause,
		minSpeech: input.minSpeech,
		threshold: input.threshold,
	});
	const assets = new Map(store.assets().map((asset) => [asset.id, asset]));
	const audible = audibleSegments(project);
	const sourceIds = [...new Set(audible.map((segment) => segment.assetId))];
	const speechBySource = new Map<string, [number, number][]>();
	let skipped = 0;
	await withMediaOperation(
		VAD_PLAN_TIMEOUT_MS,
		{ signal },
		async (operation) => {
			for (const id of sourceIds) {
				const asset = assets.get(id);
				if (
					!asset ||
					vadRefusal(asset) ||
					speechBySource.size >= MAX_VAD_SOURCES
				) {
					skipped += asset?.kind === "image" ? 0 : 1;
					continue;
				}
				try {
					const features = await voiceActivityFeatures(store, asset, {
						operation,
					});
					speechBySource.set(id, vadSpeech(features, params));
				} catch {
					// A canceled or expired request stops; one bad source is only skipped.
					operation.check();
					skipped += 1;
				}
			}
		}
	);
	const speech = audible.flatMap((segment) => {
		const spans = speechBySource.get(segment.assetId);
		return spans ? sourceSpansToTimeline(segment, spans) : [];
	});
	return { speech, summary: { analyzed: speechBySource.size, skipped } };
}

export const routes: StudioRoute[] = [
	{
		scope: "project",
		action: "dead-air-plan",
		method: "POST",
		operation: {
			id: "video_studio_plan_dead_air",
			description:
				"Read-only. Find pauses longer than minPause between transcript words and at clip edges, keeping a natural breath, and return the current revision, timeline ranges ready for remove-words, and the seconds they remove. With vad: true, each pause is intersected with voice-activity detection across every audible clip (threshold dB above the adaptive noise floor, minSpeech seconds) and refined around the source waveform, and the response adds vad: {analyzed, skipped}. Does not change the project.",
			body: deadAirPlanRequestSchema,
		},
		handle: async ({ id, json, mediaSignal, optionalBody, request, store }) => {
			const input = deadAirPlanRequestSchema.parse(await optionalBody(request));
			const project = store.project(id);
			const transcriptFor = (assetId: string) => store.transcript(assetId);
			const timeline = timelineTranscript(project, transcriptFor, input.track);
			const options: Parameters<typeof deadAirRanges>[1] = {
				protect: timelineTranscript(project, transcriptFor),
				spans: transcriptClipSpans(project, timeline),
			};
			if (input.keepPause !== undefined) {
				options.keepPause = input.keepPause;
			}
			if (input.minPause !== undefined) {
				options.minPause = input.minPause;
			}
			if (input.padding !== undefined) {
				options.padding = input.padding;
			}
			const plan = deadAirRanges(timeline, options);
			if (!input.vad) {
				return json({ revision: project.revision, ...plan });
			}
			const { speech, summary } = await timelineSpeech(
				store,
				project,
				input,
				mediaSignal(request)
			);
			const scanned = new Set(timeline.clips.map((clip) => clip.clipId));
			const envelopes: ClipEnvelope[] = project.segments.flatMap((segment) => {
				const analysis = store.analysis(segment.assetId);
				if (!scanned.has(segment.id) || analysis?.status !== "completed") {
					return [];
				}
				return [
					{
						clip: segment,
						duration: analysis.duration,
						waveform: analysis.waveform,
					},
				];
			});
			const confirmed = confirmDeadAirWithVoiceActivity(plan, {
				padding:
					(input.keepPause ?? DEFAULT_KEEP_PAUSE) / 2 +
					(input.padding ?? DEFAULT_PADDING),
				speech,
				...(envelopes.length > 0
					? {
							waveform: timelineWaveform(envelopes, projectDuration(project)),
						}
					: {}),
			});
			return json({
				revision: project.revision,
				...confirmed,
				vad: summary,
			});
		},
	},
];
