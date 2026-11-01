import { z } from "zod";
import { MAX_TRACK_INDEX, MAX_TRACKS, trackIndexSchema } from "./limits.ts";
import {
	type Asset,
	dissolveOrphanedLinkGroups,
	type Project,
	type TrackSetting,
	trackSettingFor,
	validateProject,
} from "./project.ts";
import { studioError } from "./studio-error.ts";

export const reorderTracksRequestSchema = z
	.object({
		order: z.array(trackIndexSchema).min(1).max(MAX_TRACKS),
		revision: z.number().int().nonnegative(),
	})
	.strict();

/** Returns visible lanes in their current bottom-to-top order. */
export function trackOrderFor(
	project: Pick<Project, "segments" | "trackSettings">
): number[] {
	const highestTrack = Math.max(
		2,
		...project.segments.map((segment) => segment.track),
		...project.trackSettings.map((setting) => setting.track)
	);
	return Array.from(
		{ length: Math.min(MAX_TRACKS, highestTrack + 1) },
		(_, track) => track
	);
}

export function reorderTracks(project: Project, order: number[]): Project {
	const current = trackOrderFor(project);
	if (
		order.length !== current.length ||
		new Set(order).size !== order.length ||
		order.some((track) => !current.includes(track))
	) {
		throw new Error(
			`Track order must be a permutation of ${current.join(", ")}.`
		);
	}
	const nextTrack = new Map(order.map((track, index) => [track, index]));
	return {
		...project,
		segments: project.segments.map((segment) => ({
			...segment,
			track: nextTrack.get(segment.track) ?? segment.track,
		})),
		trackSettings: project.trackSettings
			.map((setting) => ({
				...setting,
				track: nextTrack.get(setting.track) ?? setting.track,
			}))
			.sort((a, b) => a.track - b.track),
	};
}

export const addTrackRequestSchema = z
	.object({
		/** Index the new empty track takes; tracks at or above it move up one. */
		at: trackIndexSchema,
		revision: z.number().int().nonnegative(),
	})
	.strict();
export type AddTrackRequest = z.infer<typeof addTrackRequestSchema>;

export const removeTrackRequestSchema = z
	.object({
		/** Also remove the clips on a non-empty track. */
		force: z.boolean().optional(),
		revision: z.number().int().nonnegative(),
		track: trackIndexSchema,
	})
	.strict();
export type RemoveTrackRequest = z.infer<typeof removeTrackRequestSchema>;

const defaultTrackName = (track: number) => `Track ${track + 1}`;

/**
 * Move a track setting to a new index. A name that is still the default for
 * its old index follows the new index, so `Track 2` never labels lane 3.
 */
function movedSetting(setting: TrackSetting, track: number): TrackSetting {
	return {
		...setting,
		name:
			setting.name === defaultTrackName(setting.track)
				? defaultTrackName(track)
				: setting.name,
		track,
	};
}

/**
 * Renumber every track-indexed field through `map`. Adjustment layers apply
 * to their track and every track below, so they use `mapLayer` when given.
 */
function renumberTracks(
	project: Project,
	map: (track: number) => number,
	mapLayer: (track: number) => number = map
): Project {
	const next: Project = {
		...project,
		segments: project.segments.map((segment) => {
			const track = map(segment.track);
			return track === segment.track ? segment : { ...segment, track };
		}),
		trackSettings: project.trackSettings
			.map((setting) => {
				const track = map(setting.track);
				return track === setting.track ? setting : movedSetting(setting, track);
			})
			.sort((a, b) => a.track - b.track),
	};
	if (project.adjustmentLayers) {
		next.adjustmentLayers = project.adjustmentLayers.map((layer) => {
			const track = mapLayer(layer.track);
			return track === layer.track ? layer : { ...layer, track };
		});
	}
	return next;
}

/**
 * Insert an empty track at `at` (0 is the bottom). Clips, settings, and
 * adjustment-layer ranges at or above it move up one so nothing changes
 * stacking order. The new track gets a default setting so it is listed even
 * above the highest occupied track.
 */
export function addTrack(
	project: Project,
	assets: readonly Asset[],
	at: number
): Project {
	const order = trackOrderFor(project);
	if (!Number.isInteger(at) || at < 0 || at > order.length) {
		throw new Error(`Add a track at a position from 0 to ${order.length}.`);
	}
	if (order.length >= MAX_TRACKS) {
		throw new Error(`A timeline holds at most ${MAX_TRACKS} tracks.`);
	}
	const shifted = renumberTracks(project, (track) =>
		track >= at ? track + 1 : track
	);
	if (
		shifted.segments.some((segment) => segment.track > MAX_TRACK_INDEX) ||
		shifted.trackSettings.some((setting) => setting.track > MAX_TRACK_INDEX)
	) {
		throw new Error(`A timeline holds at most ${MAX_TRACKS} tracks.`);
	}
	const created: TrackSetting = {
		locked: false,
		muted: false,
		name: defaultTrackName(at),
		solo: false,
		track: at,
	};
	return validateProject(
		{
			...shifted,
			trackSettings: [...shifted.trackSettings, created].sort(
				(a, b) => a.track - b.track
			),
		},
		[...assets]
	);
}

/** Drop clips and the references other layers hold to them. */
function withoutTrackClips(
	project: Project,
	removed: ReadonlySet<string>
): Project {
	const next: Project = {
		...project,
		avatars: project.avatars.map((avatar) => {
			const segmentId = avatar.lipSync?.segmentId;
			if (!(avatar.lipSync && segmentId && removed.has(segmentId))) {
				return avatar;
			}
			const { segmentId: _dropped, ...lipSync } = avatar.lipSync;
			return { ...avatar, lipSync };
		}),
		multicamGroups: project.multicamGroups
			.map((group) => ({
				...group,
				segmentIds: group.segmentIds.filter((id) => !removed.has(id)),
			}))
			.filter((group) => group.segmentIds.length > 0),
		segments: dissolveOrphanedLinkGroups(
			project.segments.filter((segment) => !removed.has(segment.id))
		),
	};
	if (project.template) {
		next.template = {
			...project.template,
			slots: project.template.slots.filter(
				(slot) => !removed.has(slot.segmentId)
			),
		};
	}
	return next;
}

/**
 * Remove a track and move every track above it down one. A track with clips
 * is refused unless `force`, which removes its clips too (linked partners on
 * other tracks stay and lose the link). Locked tracks are refused.
 */
export function removeTrack(
	project: Project,
	assets: readonly Asset[],
	track: number,
	options: { force?: boolean } = {}
): Project {
	const order = trackOrderFor(project);
	if (!order.includes(track)) {
		throw new Error(`Track ${track + 1} is not on this timeline.`);
	}
	const setting = trackSettingFor(project, track);
	if (setting.locked) {
		throw studioError((text) => new Error(text), "track.locked", {
			track: setting.name,
		});
	}
	const clips = project.segments.filter((segment) => segment.track === track);
	if (clips.length && !options.force) {
		throw studioError((text) => new Error(text), "track.has-clips", {
			count: clips.length,
			track: setting.name,
		});
	}
	const emptied = withoutTrackClips(
		{
			...project,
			trackSettings: project.trackSettings.filter(
				(candidate) => candidate.track !== track
			),
		},
		new Set(clips.map((segment) => segment.id))
	);
	// A layer over the removed track keeps covering the same remaining tracks.
	return validateProject(
		renumberTracks(
			emptied,
			(current) => (current > track ? current - 1 : current),
			(current) => (current >= track && current > 0 ? current - 1 : current)
		),
		[...assets]
	);
}
