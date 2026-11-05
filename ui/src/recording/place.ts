import { MAX_TRACK_INDEX } from "../../../shared/limits.ts";
import {
	type Asset,
	isTrackAudible,
	newSegment,
	type Project,
	type Segment,
	segmentDuration,
	trackSettingFor,
} from "../../../shared/project.ts";

type TrackProject = Pick<Project, "segments" | "trackSettings">;
type KindedAsset = Pick<Asset, "id" | "kind">;

const overlaps = (segment: Segment, start: number, end: number) =>
	segment.start < end - 1e-6 &&
	segment.start + segmentDuration(segment) > start + 1e-6;

interface TrackUsage {
	/** Tracks with a clip in the span. */
	busy: Set<number>;
	/** Tracks holding at least one clip anywhere. */
	used: Set<number>;
	/** Tracks holding at least one non-audio clip anywhere. */
	visual: Set<number>;
}

function trackUsage(
	project: TrackProject,
	assets: readonly KindedAsset[],
	start: number,
	end: number
): TrackUsage {
	const kinds = new Map(assets.map((asset) => [asset.id, asset.kind]));
	const usage: TrackUsage = {
		busy: new Set(),
		used: new Set(),
		visual: new Set(),
	};
	for (const segment of project.segments) {
		usage.used.add(segment.track);
		if (kinds.get(segment.assetId) !== "audio") {
			usage.visual.add(segment.track);
		}
		if (overlaps(segment, start, end)) {
			usage.busy.add(segment.track);
		}
	}
	return usage;
}

/**
 * The track a voiceover spanning `[start, start + duration)` goes on. The main
 * track (0) is never used, nor a locked or muted track, nor one with a clip
 * in the span. Audible tracks (honouring solo) come first; within them the
 * preference order is a track already holding only audio clips, then an
 * empty track, then any other free track. Only when no audible track is free
 * does it fall back to a free track that solo silences. Null when none is free.
 */
export function voiceoverTrack(
	project: TrackProject,
	assets: readonly KindedAsset[],
	start: number,
	duration: number
): number | null {
	const usage = trackUsage(project, assets, start, start + duration);
	const audible: number[] = [];
	const silenced: number[] = [];
	for (let track = 1; track <= MAX_TRACK_INDEX; track += 1) {
		const setting = trackSettingFor(project, track);
		if (usage.busy.has(track) || setting.locked || setting.muted) {
			continue;
		}
		(isTrackAudible(project, track) ? audible : silenced).push(track);
	}
	const pick = (free: readonly number[]) => {
		const audioOnly = free.find(
			(track) => usage.used.has(track) && !usage.visual.has(track)
		);
		if (audioOnly !== undefined) {
			return audioOnly;
		}
		return free.find((track) => !usage.used.has(track)) ?? free[0] ?? null;
	};
	return pick(audible) ?? pick(silenced);
}

/**
 * The track a screen or camera recording spanning the given range goes on:
 * the lowest unlocked track with no clip in the span that is above every
 * visual clip there, so the recording draws on top. With `withAudio`, the
 * lowest such track that is audible (not muted, and soloed when any track
 * is) wins, falling back to the lowest free one. Null when none is free.
 */
export function pictureTrack(
	project: TrackProject,
	assets: readonly KindedAsset[],
	start: number,
	duration: number,
	withAudio = false
): number | null {
	const end = start + duration;
	const kinds = new Map(assets.map((asset) => [asset.id, asset.kind]));
	const busy = new Set<number>();
	let lowest = 0;
	for (const segment of project.segments) {
		if (!overlaps(segment, start, end)) {
			continue;
		}
		busy.add(segment.track);
		if (kinds.get(segment.assetId) !== "audio") {
			lowest = Math.max(lowest, segment.track + 1);
		}
	}
	let fallback: number | null = null;
	for (let track = lowest; track <= MAX_TRACK_INDEX; track += 1) {
		if (busy.has(track) || trackSettingFor(project, track).locked) {
			continue;
		}
		if (!withAudio || isTrackAudible(project, track)) {
			return track;
		}
		fallback ??= track;
	}
	return fallback;
}

/**
 * Add a freshly imported recording as a clip at `time`: audio on a free
 * audio track, video on the first free track above the picture. `warning`
 * says when the only free track leaves the recording silent.
 */
export function placeRecording(
	project: Project,
	assets: readonly KindedAsset[],
	asset: Asset,
	time: number
): { project: Project; segment: Segment; warning?: string } {
	if (asset.kind === "image") {
		throw new Error("Recordings are placed as audio or video clips.");
	}
	if (!(Number.isFinite(asset.duration) && asset.duration > 0)) {
		throw new Error("The recording is empty. Record again.");
	}
	const start = Math.max(0, Number.isFinite(time) ? time : 0);
	const known = [...assets, asset];
	const track =
		asset.kind === "audio"
			? voiceoverTrack(project, known, start, asset.duration)
			: pictureTrack(project, known, start, asset.duration, asset.hasAudio);
	if (track === null) {
		throw new Error(
			"Every track is busy at the playhead. Free a track or move the playhead, then add the recording again."
		);
	}
	const segment = newSegment(asset, start, track);
	const placed = {
		project: { ...project, segments: [...project.segments, segment] },
		segment,
	};
	const audible = asset.kind === "audio" || asset.hasAudio;
	return audible && !isTrackAudible(project, track)
		? {
				...placed,
				warning:
					"Its track is muted or not soloed, so the recording is silent until you change that track's mute or solo.",
			}
		: placed;
}
