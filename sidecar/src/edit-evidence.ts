import { z } from "zod";
import type { MediaAnalysis } from "../../shared/analysis.ts";
import type { TimelineTranscript } from "../../shared/filler-words.ts";
import {
	type Asset,
	type Project,
	projectDuration,
	segmentDuration,
} from "../../shared/project.ts";
import { clipHeard } from "../../shared/sync-lock.ts";

/** Timeline energy resolution: ten bins per second, bounded for long timelines. */
const BINS_PER_SECOND = 10;
const MAX_TIMELINE_BINS = 7200;
const MAX_SCENE_CUTS = 2000;

export type AnalysisLookup = (assetId: string) => MediaAnalysis | null;

/** Completed analysis waveform for an asset, in the shape the shared planners take. */
export function completedWaveform(
	analysisFor: AnalysisLookup,
	assetId: string
): { bins: number[]; duration: number } | undefined {
	const analysis = analysisFor(assetId);
	if (
		analysis?.status !== "completed" ||
		!analysis.waveform.length ||
		!(analysis.duration > 0)
	) {
		return undefined;
	}
	return { bins: analysis.waveform, duration: analysis.duration };
}

const timedTextSchema = z.object({
	end: z.number().finite(),
	start: z.number().finite(),
	text: z.string(),
});
type TimedText = z.infer<typeof timedTextSchema>;

function timedText(values: readonly unknown[]): TimedText[] {
	const result: TimedText[] = [];
	for (const value of values) {
		const parsed = timedTextSchema.safeParse(value);
		if (parsed.success && parsed.data.end > parsed.data.start) {
			result.push(parsed.data);
		}
	}
	return result;
}

/**
 * The project with only the clips the listener hears (`clipHeard`: not muted
 * or hidden, on an audible track, below the high-speed mute, with volume),
 * so highlight scoring and short captions ignore speech nobody hears.
 */
export function heardProject(project: Project): Project {
	return {
		...project,
		segments: project.segments.filter((segment) => clipHeard(project, segment)),
	};
}

/** Timeline-time words and cues across every transcribed clip, in time order. */
export function timelineText(timeline: TimelineTranscript): {
	cues: TimedText[];
	words: TimedText[];
} {
	const order = (a: TimedText, b: TimedText) =>
		a.start - b.start || a.end - b.end;
	return {
		cues: timeline.clips.flatMap((clip) => timedText(clip.cues)).sort(order),
		words: timeline.clips.flatMap((clip) => timedText(clip.words)).sort(order),
	};
}

/**
 * Loudness across the timeline from each audible clip's stored analysis,
 * taking the loudest contributing clip per bin. Undefined when no audible
 * clip has completed analysis.
 */
export function timelineWaveform(
	project: Project,
	assets: readonly Asset[],
	analysisFor: AnalysisLookup
): { bins: number[]; duration: number } | undefined {
	const duration = projectDuration(project);
	if (!(duration > 0)) {
		return undefined;
	}
	const byId = new Map(assets.map((asset) => [asset.id, asset]));
	const sources = project.segments.flatMap((segment) => {
		const asset = byId.get(segment.assetId);
		const waveform = completedWaveform(analysisFor, segment.assetId);
		return asset?.hasAudio && clipHeard(project, segment) && waveform
			? [{ segment, waveform }]
			: [];
	});
	if (!sources.length) {
		return undefined;
	}
	const count = Math.min(
		MAX_TIMELINE_BINS,
		Math.max(1, Math.ceil(duration * BINS_PER_SECOND))
	);
	const bins = Array.from({ length: count }, () => 0);
	for (const { segment, waveform } of sources) {
		const end = segment.start + segmentDuration(segment);
		const first = Math.max(0, Math.floor((segment.start / duration) * count));
		const last = Math.min(count - 1, Math.ceil((end / duration) * count));
		const gain = Math.min(1, segment.volume);
		for (let index = first; index <= last; index++) {
			const time = ((index + 0.5) / count) * duration;
			if (time < segment.start || time >= end) {
				continue;
			}
			const sourceTime =
				segment.sourceIn + (time - segment.start) * segment.speed;
			const bin = Math.floor(
				(sourceTime / waveform.duration) * waveform.bins.length
			);
			const level = waveform.bins[bin];
			if (level !== undefined) {
				bins[index] = Math.max(bins[index] ?? 0, level * gain);
			}
		}
	}
	return { bins, duration };
}

/** Visual edit points plus analysed source scene cuts, mapped to timeline time. */
export function timelineSceneCuts(
	project: Project,
	assets: readonly Asset[],
	analysisFor: AnalysisLookup
): number[] {
	const byId = new Map(assets.map((asset) => [asset.id, asset]));
	const cuts = new Set<number>();
	for (const segment of project.segments) {
		const asset = byId.get(segment.assetId);
		if (!(asset?.kind === "video" || asset?.kind === "image")) {
			continue;
		}
		const end = segment.start + segmentDuration(segment);
		cuts.add(Number(segment.start.toFixed(3)));
		cuts.add(Number(end.toFixed(3)));
		const analysis = analysisFor(segment.assetId);
		if (analysis?.status !== "completed") {
			continue;
		}
		for (const cut of analysis.sceneCuts) {
			if (cut > segment.sourceIn && cut < segment.sourceOut) {
				cuts.add(
					Number(
						(segment.start + (cut - segment.sourceIn) / segment.speed).toFixed(
							3
						)
					)
				);
			}
		}
	}
	return [...cuts]
		.filter((cut) => cut > 0)
		.sort((a, b) => a - b)
		.slice(0, MAX_SCENE_CUTS);
}
