import { z } from "zod";
import { retimeKeyframes } from "./animation.ts";
import { MAX_TRACKS, trackIndexSchema } from "./limits.ts";
import {
	type Asset,
	newSegment,
	type Project,
	type Segment,
	sameMediaTimebase,
	segmentDuration,
	trackSettingFor,
	validateProject,
} from "./project.ts";

export const detachAudioRequestSchema = z
	.object({
		clipIds: z.array(z.uuid()).min(1).max(64),
		audioTrack: trackIndexSchema.optional(),
		revision: z.number().int().nonnegative(),
	})
	.strict();

export type DetachAudioRequest = z.infer<typeof detachAudioRequestSchema>;
export type DetachAudioInput = z.input<typeof detachAudioRequestSchema>;

/** Maps a video asset id to its already-extracted audio asset. */
export type AudioAssetLookup = (videoAssetId: string) => Asset | undefined;

const MINIMUM_CLIP_SECONDS = 0.04;

/** Keyframable properties that shape a clip's sound rather than its picture. */
export const AUDIO_KEYFRAME_PROPERTIES = [
	"volume",
	"pan",
] as const satisfies readonly Segment["keyframes"][number]["property"][];

function isAudioKeyframe(frame: Segment["keyframes"][number]): boolean {
	return (AUDIO_KEYFRAME_PROPERTIES as readonly string[]).includes(
		frame.property
	);
}

function assetById(assets: readonly Asset[], id: string) {
	return assets.find((asset) => asset.id === id);
}

const isVisual = (asset: Asset | undefined) =>
	asset?.kind === "video" || asset?.kind === "image";

/** True when the clip already belongs to a link group that carries audio. */
function linkedToAudio(
	project: Project,
	assets: readonly Asset[],
	segment: Segment
) {
	if (!segment.linkGroupId) {
		return false;
	}
	return project.segments.some(
		(member) =>
			member.id !== segment.id &&
			member.linkGroupId === segment.linkGroupId &&
			assetById(assets, member.assetId)?.kind === "audio"
	);
}

/**
 * True when a video asset's embedded audio can be extracted onto its own
 * timebase. Reversed derivatives and nested sequences are excluded: a
 * reversal is not original media, and a sequence re-renders in place under
 * the same id, so an extraction would silently go stale.
 */
export function hasExtractableAudio(asset: Asset | undefined): asset is Asset {
	return (
		asset?.kind === "video" &&
		asset.hasAudio &&
		asset.derivation !== "reverse" &&
		!asset.sequenceProjectId
	);
}

/** Clear refusal for a video whose embedded audio cannot be extracted. */
export function extractableAudioRefusal(asset: Asset): string | undefined {
	if (asset.kind !== "video") {
		return "Only video media has embedded audio to extract.";
	}
	if (!asset.hasAudio) {
		return "This video has no audio stream to extract.";
	}
	if (asset.derivation === "reverse") {
		return "Reversed clips keep their audio embedded. Detach audio before reversing, or reverse the original clip back first.";
	}
	if (asset.sequenceProjectId) {
		return "Nested sequences keep their audio embedded. Detach audio inside the sequence instead.";
	}
	return undefined;
}

/**
 * Video clips with extractable embedded audio, not linked to audio, on
 * unlocked tracks.
 */
export function detachableClipIds(
	project: Project,
	assets: readonly Asset[]
): string[] {
	return project.segments
		.filter((segment) => {
			const asset = assetById(assets, segment.assetId);
			return (
				hasExtractableAudio(asset) &&
				!trackSettingFor(project, segment.track).locked &&
				!linkedToAudio(project, assets, segment)
			);
		})
		.sort((a, b) => a.start - b.start || a.track - b.track)
		.map((segment) => segment.id);
}

function occupied(
	segments: readonly Segment[],
	track: number,
	start: number,
	end: number
) {
	return segments.some(
		(segment) =>
			segment.track === track &&
			segment.start < end - 1e-6 &&
			start < segment.start + segmentDuration(segment) - 1e-6
	);
}

function chooseAudioTrack(
	project: Project,
	assets: readonly Asset[],
	segments: readonly Segment[],
	range: { end: number; start: number },
	requested: number | undefined
) {
	if (requested !== undefined) {
		if (trackSettingFor(project, requested).locked) {
			throw new Error(`Unlock track ${requested + 1} before detaching audio.`);
		}
		if (occupied(segments, requested, range.start, range.end)) {
			throw new Error(
				`Track ${requested + 1} already has a clip where the audio would go.`
			);
		}
		return requested;
	}
	const visualTracks = new Set(
		segments
			.filter((segment) => isVisual(assetById(assets, segment.assetId)))
			.map((segment) => segment.track)
	);
	const lowestVisual = Math.max(-1, ...visualTracks);
	const candidates = Array.from({ length: MAX_TRACKS }, (_, index) => index)
		.filter((track) => !visualTracks.has(track))
		.sort(
			(a, b) => Number(a <= lowestVisual) - Number(b <= lowestVisual) || a - b
		);
	const track = candidates.find(
		(candidate) =>
			!(
				trackSettingFor(project, candidate).locked ||
				occupied(segments, candidate, range.start, range.end)
			)
	);
	if (track === undefined) {
		throw new Error("No free audio track for the detached audio.");
	}
	return track;
}

function detachedAudioSegment(
	video: Segment,
	audioAsset: Asset,
	track: number
): Segment {
	const sourceOut = Math.min(video.sourceOut, audioAsset.duration);
	const duration = (sourceOut - video.sourceIn) / video.speed;
	if (duration < MINIMUM_CLIP_SECONDS) {
		throw new Error("The extracted audio does not cover this clip.");
	}
	const fadeIn = Math.min(video.fadeIn, duration);
	return {
		...newSegment(audioAsset, video.start, track),
		sourceIn: video.sourceIn,
		sourceOut,
		speed: video.speed,
		volume: video.volume,
		fadeIn,
		fadeOut: Math.min(video.fadeOut, duration - fadeIn),
		audioProcessing: video.audioProcessing,
		duckUnderVoice: video.duckUnderVoice,
		...(video.ducking === undefined ? {} : { ducking: video.ducking }),
		...(video.pan === undefined ? {} : { pan: video.pan }),
		keyframes: video.keyframes
			.filter((frame) => isAudioKeyframe(frame) && frame.time <= duration)
			.map((frame) => ({ ...frame, id: crypto.randomUUID() })),
	};
}

function detachIds(
	project: Project,
	assets: readonly Asset[],
	clipIds: readonly string[],
	audioAssetFor: AudioAssetLookup,
	audioTrack: number | undefined
): Project {
	let segments = [...project.segments];
	const usedAssets = new Map(assets.map((asset) => [asset.id, asset]));
	for (const clipId of clipIds) {
		const video = segments.find((segment) => segment.id === clipId);
		if (!video) {
			throw new Error("Clip not found on this timeline.");
		}
		const videoAsset = assetById(assets, video.assetId);
		if (!(videoAsset?.kind === "video" && videoAsset.hasAudio)) {
			throw new Error("Only video clips with embedded audio can be detached.");
		}
		if (trackSettingFor(project, video.track).locked) {
			throw new Error("Unlock the clip track before detaching its audio.");
		}
		if (linkedToAudio({ ...project, segments }, assets, video)) {
			continue;
		}
		if (video.linkGroupId) {
			throw new Error("Unlink the clip before detaching its audio.");
		}
		const refusal = extractableAudioRefusal(videoAsset);
		if (refusal) {
			throw new Error(refusal);
		}
		const audioAsset = audioAssetFor(videoAsset.id);
		if (
			!(
				audioAsset?.kind === "audio" &&
				audioAsset.derivedFromAssetId === videoAsset.id &&
				sameMediaTimebase(audioAsset, videoAsset)
			)
		) {
			throw new Error("Extract the clip audio before detaching it.");
		}
		usedAssets.set(audioAsset.id, audioAsset);
		const end = video.start + segmentDuration(video);
		const track = chooseAudioTrack(
			project,
			assets,
			segments,
			{ end, start: video.start },
			audioTrack
		);
		const groupId = crypto.randomUUID();
		const audio = {
			...detachedAudioSegment(video, audioAsset, track),
			linkGroupId: groupId,
		};
		segments = [
			...segments.map((segment) =>
				segment.id === video.id
					? {
							...segment,
							linkGroupId: groupId,
							volume: 0,
							keyframes: segment.keyframes.filter(
								(frame) => frame.property !== "volume"
							),
						}
					: segment
			),
			audio,
		];
	}
	return validateProject({ ...project, segments }, [...usedAssets.values()]);
}

/** Split embedded camera audio onto a linked audio clip and mute the video member. */
export function detachClipAudio(
	project: Project,
	assets: readonly Asset[],
	input: DetachAudioInput,
	audioAssetFor: AudioAssetLookup
): Project {
	const request = detachAudioRequestSchema.parse(input);
	if (new Set(request.clipIds).size !== request.clipIds.length) {
		throw new Error("Choose each clip once.");
	}
	return detachIds(
		project,
		assets,
		request.clipIds,
		audioAssetFor,
		request.audioTrack
	);
}

/** Detach every detachable video clip's audio in timeline order. */
export function detachAllClipAudio(
	project: Project,
	assets: readonly Asset[],
	audioAssetFor: AudioAssetLookup
): Project {
	const clipIds = detachableClipIds(project, assets);
	if (!clipIds.length) {
		return project;
	}
	return detachIds(project, assets, clipIds, audioAssetFor, undefined);
}

export const reattachAudioRequestSchema = z
	.object({
		clipIds: z.array(z.uuid()).min(1).max(64),
		revision: z.number().int().nonnegative(),
	})
	.strict();

export type ReattachAudioRequest = z.infer<typeof reattachAudioRequestSchema>;
export type ReattachAudioInput = z.input<typeof reattachAudioRequestSchema>;

/** A detached link group: the camera clip and the audio extracted from it. */
export interface DetachedAudioPair {
	audio: Segment;
	groupId: string;
	video: Segment;
}

/** True when `audio` is an extraction of `video`'s embedded camera audio. */
function isDerivedAudioOf(audio: Asset | undefined, video: Asset | undefined) {
	return (
		audio?.kind === "audio" &&
		audio.derivation === "audio" &&
		video?.kind === "video" &&
		audio.derivedFromAssetId === video.id
	);
}

/**
 * Pair each derived-audio member of a link group with the camera clip it was
 * extracted from (the nearest start when a group holds several).
 */
function groupPairs(
	members: readonly Segment[],
	assets: readonly Asset[]
): DetachedAudioPair[] {
	const pairs: DetachedAudioPair[] = [];
	for (const audio of members) {
		const audioAsset = assetById(assets, audio.assetId);
		const video = members
			.filter((member) =>
				isDerivedAudioOf(audioAsset, assetById(assets, member.assetId))
			)
			.sort(
				(a, b) =>
					Math.abs(a.start - audio.start) - Math.abs(b.start - audio.start) ||
					a.start - b.start
			)[0];
		if (video && audio.linkGroupId) {
			pairs.push({ audio, groupId: audio.linkGroupId, video });
		}
	}
	return pairs;
}

/**
 * The detached camera audio pairs a clip belongs to, whether the clip is the
 * camera clip or its extracted audio. Empty when nothing can be recovered.
 */
export function detachedAudioPairs(
	project: Project,
	assets: readonly Asset[],
	clipId: string
): DetachedAudioPair[] {
	const segment = project.segments.find((item) => item.id === clipId);
	if (!segment?.linkGroupId) {
		return [];
	}
	const members = project.segments.filter(
		(member) => member.linkGroupId === segment.linkGroupId
	);
	return groupPairs(members, assets).filter(
		(pair) => pair.audio.id === clipId || pair.video.id === clipId
	);
}

/** Which audio operation the inspector offers for a clip. */
export type DetachAudioState = "detach" | "recover" | "unavailable";

/** Recover when the clip is part of a detached pair, detach when it can be split. */
export function detachAudioState(
	project: Project,
	assets: readonly Asset[],
	clipId: string
): DetachAudioState {
	if (detachedAudioPairs(project, assets, clipId).length) {
		return "recover";
	}
	return detachableClipIds(project, assets).includes(clipId)
		? "detach"
		: "unavailable";
}

/**
 * The first locked track holding a member of the clip's detached pairs, which
 * blocks recovery; undefined when every member's track is unlocked.
 */
export function recoverBlockingTrack(
	project: Project,
	assets: readonly Asset[],
	clipId: string
): number | undefined {
	return detachedAudioPairs(project, assets, clipId)
		.flatMap((pair) => [pair.video.track, pair.audio.track])
		.sort((a, b) => a - b)
		.find((track) => trackSettingFor(project, track).locked);
}

/** Clips whose detached camera audio can be recovered, in timeline order. */
export function recoverableClipIds(
	project: Project,
	assets: readonly Asset[]
): string[] {
	return project.segments
		.filter(
			(segment) =>
				detachedAudioPairs(project, assets, segment.id).some(
					(pair) => pair.video.id === segment.id
				) && recoverBlockingTrack(project, assets, segment.id) === undefined
		)
		.sort((a, b) => a.start - b.start || a.track - b.track)
		.map((segment) => segment.id);
}

/** Audio-only settings the detached member may carry; kept when it defines them. */
const CARRIED_AUDIO_FIELDS = [
	"audioProcessing",
	"muted",
	"preservePitch",
	"pan",
	"channelMode",
	"ducking",
	"audioCleanup",
	"audioEffects",
	"speakerId",
] as const satisfies readonly (keyof Segment)[];

/**
 * Restore the camera clip's sound from its detached audio member: volume,
 * volume and pan keyframes (retimed to the camera clip), and audio settings.
 */
export function restoredVideo(video: Segment, audio: Segment): Segment {
	const duration = segmentDuration(video);
	const audioFrames = retimeKeyframes(
		{ ...audio, keyframes: audio.keyframes.filter(isAudioKeyframe) },
		video.start - audio.start,
		duration
	);
	const restored: Segment = {
		...video,
		volume: audio.volume,
		duckUnderVoice: audio.duckUnderVoice,
		keyframes: [
			...video.keyframes.filter((frame) => !isAudioKeyframe(frame)),
			...audioFrames,
		],
	};
	for (const field of CARRIED_AUDIO_FIELDS) {
		if (audio[field] !== undefined) {
			Object.assign(restored, { [field]: audio[field] });
		}
	}
	return restored;
}

/** Drop the link group from members that no longer pair audio with picture. */
function dissolveBrokenGroups(
	segments: readonly Segment[],
	assets: readonly Asset[],
	groupIds: ReadonlySet<string>
): Segment[] {
	const intact = new Set<string>();
	for (const groupId of groupIds) {
		const kinds = new Set(
			segments
				.filter((segment) => segment.linkGroupId === groupId)
				.map((segment) => assetById(assets, segment.assetId)?.kind)
		);
		if (kinds.has("audio") && kinds.size > 1) {
			intact.add(groupId);
		}
	}
	return segments.map((segment) => {
		if (
			!segment.linkGroupId ||
			intact.has(segment.linkGroupId) ||
			!groupIds.has(segment.linkGroupId)
		) {
			return segment;
		}
		return { ...segment, linkGroupId: undefined };
	});
}

/**
 * Recover detached camera audio: remove each extracted audio member, restore
 * its camera clip's volume, volume and pan keyframes and audio settings, and dissolve
 * the link group. Either member of a pair may be named.
 */
export function reattachAudio(
	project: Project,
	assets: readonly Asset[],
	input: ReattachAudioInput
): Project {
	const request = reattachAudioRequestSchema.parse(input);
	if (new Set(request.clipIds).size !== request.clipIds.length) {
		throw new Error("Choose each clip once.");
	}
	const pairs = new Map<string, DetachedAudioPair>();
	for (const clipId of request.clipIds) {
		if (!project.segments.some((segment) => segment.id === clipId)) {
			throw new Error("Clip not found on this timeline.");
		}
		const found = detachedAudioPairs(project, assets, clipId);
		if (!found.length) {
			throw new Error(
				"Only clips with detached camera audio can recover their audio."
			);
		}
		for (const pair of found) {
			pairs.set(pair.audio.id, pair);
		}
	}
	const restoredVideos = new Map<string, Segment>();
	for (const pair of pairs.values()) {
		for (const member of [pair.video, pair.audio]) {
			if (trackSettingFor(project, member.track).locked) {
				throw new Error(
					`Unlock track ${member.track + 1} before recovering clip audio.`
				);
			}
		}
		if (restoredVideos.has(pair.video.id)) {
			throw new Error(
				"This camera clip has more than one detached audio clip. Delete the extra audio first."
			);
		}
		restoredVideos.set(pair.video.id, restoredVideo(pair.video, pair.audio));
	}
	const segments = project.segments
		.filter((segment) => !pairs.has(segment.id))
		.map((segment) => restoredVideos.get(segment.id) ?? segment);
	const groupIds = new Set([...pairs.values()].map((pair) => pair.groupId));
	return validateProject(
		{ ...project, segments: dissolveBrokenGroups(segments, assets, groupIds) },
		[...assets]
	);
}
