import type { Asset, Project } from "./project.ts";
import { activeCaptions, projectDuration, trackSettingFor } from "./project.ts";

export interface TimelineSummary {
	captions: number;
	duration: number;
	fps: Project["fps"];
	height: number;
	markers: Project["markers"];
	projectId: string;
	revision: number;
	title: string;
	totalFrames: number;
	tracks: TimelineTrackSummary[];
	width: number;
}

export interface TimelineTrackSummary {
	clips: TimelineClipSummary[];
	gaps: Array<{ end: number; start: number }>;
	locked: boolean;
	muted: boolean;
	name: string;
	solo: boolean;
	track: number;
	trackId: string;
}

export interface TimelineClipSummary {
	assetId: string;
	assetName: string;
	end: number;
	id: string;
	kind: Asset["kind"];
	sourceIn: number;
	sourceOut: number;
	speed: number;
	start: number;
	track: number;
	volume: number;
}

/** Return a compact, agent-friendly view of the saved editable timeline. */
export function timelineSummary(
	project: Project,
	assets: readonly Asset[]
): TimelineSummary {
	const duration = projectDuration(project);
	const assetById = new Map(assets.map((asset) => [asset.id, asset]));
	const trackNumbers = [
		...new Set(project.segments.map((segment) => segment.track)),
	].sort((a, b) => a - b);
	const tracks = trackNumbers.map((track) => {
		const setting = trackSettingFor(project, track);
		const clips = project.segments
			.filter((segment) => segment.track === track)
			.sort((a, b) => a.start - b.start)
			.map((segment) => {
				const asset = assetById.get(segment.assetId);
				const end =
					segment.start +
					(segment.sourceOut - segment.sourceIn) / segment.speed;
				return {
					assetId: segment.assetId,
					assetName: asset?.name ?? "Missing media",
					end: Number(end.toFixed(6)),
					id: segment.id,
					kind: asset?.kind ?? "video",
					sourceIn: segment.sourceIn,
					sourceOut: segment.sourceOut,
					speed: segment.speed,
					start: segment.start,
					track: segment.track,
					volume: segment.volume,
				};
			});
		const gaps: Array<{ end: number; start: number }> = [];
		let cursor = 0;
		for (const clip of clips) {
			if (clip.start > cursor + 0.000_001) {
				gaps.push({ end: clip.start, start: cursor });
			}
			cursor = Math.max(cursor, clip.end);
		}
		if (cursor < duration - 0.000_001) {
			gaps.push({ end: duration, start: cursor });
		}
		return {
			clips,
			gaps,
			locked: setting.locked,
			muted: setting.muted,
			name: setting.name,
			solo: setting.solo,
			track,
			trackId: `track-${track}`,
		};
	});
	return {
		captions: activeCaptions(project).length,
		duration: Number(duration.toFixed(6)),
		fps: project.fps,
		height: project.height,
		markers: project.markers,
		projectId: project.id,
		revision: project.revision,
		title: project.title,
		totalFrames: Math.round(duration * project.fps),
		tracks,
		width: project.width,
	};
}
