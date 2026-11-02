import { z } from "zod";
import {
	type Asset,
	animatedValue,
	newSegment,
	type Project,
	type Segment,
	segmentDuration,
	splitSegment,
	trackSettingFor,
	validateProject,
} from "./project.ts";

const MINIMUM_CLIP_SECONDS = 0.04;
/** Distance kept from a clip's source out point so the captured frame exists. */
const LAST_FRAME_SECONDS = 0.04;
const EPSILON = 1e-6;

export const freezeFrameRequestSchema = z
	.object({
		clipId: z.uuid(),
		at: z.number().finite().min(0).max(7200),
		duration: z.number().finite().min(0.1).max(30),
		mode: z.enum(["insert", "hold-end"]).default("insert"),
		revision: z.number().int().nonnegative(),
	})
	.strict();

export type FreezeFrameRequest = z.infer<typeof freezeFrameRequestSchema>;
export type FreezeFrameInput = z.input<typeof freezeFrameRequestSchema>;

/** Where the still is captured from and where it lands on the timeline. */
export interface FreezeFramePlan {
	assetId: string;
	clip: Segment;
	/** Clip-relative timeline seconds whose transform the still inherits. */
	clipOffset: number;
	/** Timeline seconds where the still starts and later layers ripple from. */
	insertAt: number;
	/** Source seconds of the frame to capture from the clip's media. */
	sourceTime: number;
}

function assetById(assets: readonly Asset[], id: string) {
	return assets.find((asset) => asset.id === id);
}

/** Resolve the frame to capture and the insertion point for a freeze request. */
export function planFreezeFrame(
	project: Project,
	assets: readonly Asset[],
	input: FreezeFrameInput
): FreezeFramePlan {
	const request = freezeFrameRequestSchema.parse(input);
	const clip = project.segments.find(
		(segment) => segment.id === request.clipId
	);
	if (!clip) {
		throw new Error("Clip not found on this timeline.");
	}
	const asset = assetById(assets, clip.assetId);
	if (asset?.kind !== "video") {
		throw new Error("Freeze frames can only be made from video clips.");
	}
	if (trackSettingFor(project, clip.track).locked) {
		throw new Error("Unlock the clip track before adding a freeze frame.");
	}
	if (clip.multicamGroupId) {
		throw new Error("Freeze frames cannot be made from multicam clips.");
	}
	const duration = segmentDuration(clip);
	const end = clip.start + duration;
	// sourceOut may overrun the media slightly; capture from frames that exist.
	const lastSource = Math.max(
		clip.sourceIn,
		Math.min(clip.sourceOut, asset.duration) - LAST_FRAME_SECONDS
	);
	if (request.mode === "hold-end") {
		return {
			assetId: clip.assetId,
			clip,
			clipOffset: duration,
			insertAt: end,
			sourceTime: lastSource,
		};
	}
	if (request.at < clip.start - EPSILON || request.at > end + EPSILON) {
		throw new Error("Place the playhead inside the clip to freeze a frame.");
	}
	const clipOffset = Math.min(duration, Math.max(0, request.at - clip.start));
	let insertAt = clip.start + clipOffset;
	if (clipOffset < MINIMUM_CLIP_SECONDS) {
		insertAt = clip.start;
	} else if (duration - clipOffset < MINIMUM_CLIP_SECONDS) {
		insertAt = end;
	}
	return {
		assetId: clip.assetId,
		clip,
		clipOffset,
		insertAt,
		sourceTime: Math.min(lastSource, clip.sourceIn + clipOffset * clip.speed),
	};
}

/** A still segment that looks like the clip at `clipOffset` without animation. */
function stillSegment(
	clip: Segment,
	still: Asset,
	clipOffset: number,
	insertAt: number,
	duration: number
): Segment {
	return {
		...newSegment(still, insertAt, clip.track),
		sourceIn: 0,
		sourceOut: duration,
		volume: 0,
		opacity: animatedValue(clip, "opacity", clipOffset),
		scale: animatedValue(clip, "scale", clipOffset),
		x: animatedValue(clip, "x", clipOffset),
		y: animatedValue(clip, "y", clipOffset),
		rotation: animatedValue(clip, "rotation", clipOffset),
		crop: { ...clip.crop },
		edgeRounding: clip.edgeRounding,
		edgeSoftness: clip.edgeSoftness,
		colorGrade: { ...clip.colorGrade },
		effects: clip.effects.map((effect) => ({ ...effect })),
		brightness: clip.brightness,
		contrast: clip.contrast,
		saturation: clip.saturation,
		visualEffect: clip.visualEffect,
		...stillPlacement(clip, clipOffset),
	};
}

/**
 * Flip, scale X/Y and fit of the clip at `clipOffset` (W2-V2). Absent fields
 * stay absent, so legacy clips produce legacy stills.
 */
function stillPlacement(
	clip: Segment,
	clipOffset: number
): Pick<Segment, "fit" | "flipH" | "flipV" | "scaleX" | "scaleY"> {
	const animated = (property: "scaleX" | "scaleY") =>
		clip[property] !== undefined ||
		clip.keyframes.some((frame) => frame.property === property);
	return {
		...(clip.flipH === undefined ? {} : { flipH: clip.flipH }),
		...(clip.flipV === undefined ? {} : { flipV: clip.flipV }),
		...(clip.fit === undefined ? {} : { fit: clip.fit }),
		...(animated("scaleX")
			? { scaleX: animatedValue(clip, "scaleX", clipOffset) }
			: {}),
		...(animated("scaleY")
			? { scaleY: animatedValue(clip, "scaleY", clipOffset) }
			: {}),
	};
}

/**
 * Which side of `at` a segment lands on. Pieces shorter than a frame are not
 * split off; the offsets use splitSegment's own arithmetic so a "split"
 * verdict always passes its check.
 */
function rippleSide(
	start: number,
	duration: number,
	at: number
): "left" | "right" | "split" {
	const offset = at - start;
	if (offset < MINIMUM_CLIP_SECONDS) {
		return duration - offset > 0 ? "right" : "left";
	}
	if (duration - offset < MINIMUM_CLIP_SECONDS) {
		return "left";
	}
	return "split";
}

const segmentSide = (segment: Segment, at: number) =>
	rippleSide(segment.start, segmentDuration(segment), at);

/** Split or shift every segment around `at` so `gap` seconds open up there. */
function rippleSegments(
	segments: readonly Segment[],
	at: number,
	gap: number
): Segment[] {
	const result: Segment[] = [];
	const rightGroups = new Map<string, string>();
	const splitGroups = new Set<string>();
	const sides: { right: boolean; segment: Segment }[] = [];
	for (const segment of segments) {
		const side = segmentSide(segment, at);
		if (side === "left") {
			sides.push({ right: false, segment });
			continue;
		}
		if (side === "right") {
			sides.push({
				right: true,
				segment: { ...segment, start: segment.start + gap },
			});
			continue;
		}
		if (segment.multicamGroupId) {
			throw new Error("A freeze frame cannot cut through a multicam clip.");
		}
		const [left, right] = splitSegment(segment, at);
		if (segment.linkGroupId) {
			splitGroups.add(segment.linkGroupId);
		}
		sides.push(
			{ right: false, segment: left },
			{ right: true, segment: { ...right, start: right.start + gap } }
		);
	}
	for (const { right, segment } of sides) {
		const groupId = segment.linkGroupId;
		if (!(right && groupId && splitGroups.has(groupId))) {
			result.push(segment);
			continue;
		}
		const next = rightGroups.get(groupId) ?? crypto.randomUUID();
		rightGroups.set(groupId, next);
		result.push({ ...segment, linkGroupId: next });
	}
	return result;
}

/** Shift multicam groups that sit wholly after `at`; refuse ones it would cut. */
function rippleMulticamGroups(
	project: Project,
	at: number,
	gap: number
): Project["multicamGroups"] {
	return project.multicamGroups.map((group) => {
		const sides = new Set([
			rippleSide(group.start, group.duration, at),
			...project.segments
				.filter((segment) => segment.multicamGroupId === group.id)
				.map((segment) => segmentSide(segment, at)),
		]);
		if (sides.has("split") || sides.size > 1) {
			throw new Error("A freeze frame cannot cut through a multicam clip.");
		}
		if (!sides.has("right")) {
			return group;
		}
		return {
			...group,
			start: group.start + gap,
			switches: group.switches.map((switchPoint) => ({
				...switchPoint,
				end: switchPoint.end + gap,
				start: switchPoint.start + gap,
			})),
		};
	});
}

/** Clear link groups that no longer pair audio with visual media. */
function dissolveUnpairedGroups(
	segments: readonly Segment[],
	assets: readonly Asset[]
): Segment[] {
	const kinds = new Map<string, { audio: number; visual: number }>();
	for (const segment of segments) {
		if (!segment.linkGroupId) {
			continue;
		}
		const counts = kinds.get(segment.linkGroupId) ?? { audio: 0, visual: 0 };
		if (assetById(assets, segment.assetId)?.kind === "audio") {
			counts.audio += 1;
		} else {
			counts.visual += 1;
		}
		kinds.set(segment.linkGroupId, counts);
	}
	return segments.map((segment) => {
		const counts = segment.linkGroupId
			? kinds.get(segment.linkGroupId)
			: undefined;
		return counts && !(counts.audio && counts.visual)
			? { ...segment, linkGroupId: undefined }
			: segment;
	});
}

/** Hold one video frame as a still clip, rippling every later timed layer right. */
export function freezeFrame(
	project: Project,
	assets: readonly Asset[],
	input: FreezeFrameInput,
	stillAsset: Asset
): Project {
	const request = freezeFrameRequestSchema.parse(input);
	if (stillAsset.kind !== "image") {
		throw new Error("A freeze frame needs a captured still image.");
	}
	const plan = planFreezeFrame(project, assets, request);
	const gap = request.duration;
	const at = plan.insertAt;
	const mapTime = (value: number) => (value < at ? value : value + gap);
	const timed = <T extends { end: number; start: number }>(
		items: readonly T[]
	) =>
		items.map((item) => ({
			...item,
			end: mapTime(item.end),
			start: mapTime(item.start),
		}));
	const mapCaptions = (items: Project["captions"]) =>
		items.map((caption) => ({
			...caption,
			end: mapTime(caption.end),
			start: mapTime(caption.start),
			words: caption.words?.map((word) => ({
				...word,
				end: mapTime(word.end),
				start: mapTime(word.start),
			})),
		}));
	const usedAssets = [
		...assets.filter((asset) => asset.id !== stillAsset.id),
		stillAsset,
	];
	const still = stillSegment(plan.clip, stillAsset, plan.clipOffset, at, gap);
	const segments = dissolveUnpairedGroups(
		[...rippleSegments(project.segments, at, gap), still],
		usedAssets
	);
	return validateProject(
		{
			...project,
			captions: mapCaptions(project.captions),
			captionTracks: project.captionTracks.map((track) => ({
				...track,
				captions: mapCaptions(track.captions),
			})),
			graphics: timed(project.graphics),
			markers: project.markers.map((marker) => ({
				...marker,
				time: mapTime(marker.time),
			})),
			multicamGroups: rippleMulticamGroups(project, at, gap),
			segments: segments.sort((a, b) => a.track - b.track || a.start - b.start),
			titles: timed(project.titles),
			avatars: timed(project.avatars),
			spatialObjects: timed(project.spatialObjects),
			meshes: timed(project.meshes),
		},
		usedAssets
	);
}
