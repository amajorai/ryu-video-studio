import { z } from "zod";
import {
	type Asset,
	animatedValue,
	animationPoints,
	type Keyframe,
	type Project,
	type Segment,
	segmentDuration,
	trackSettingFor,
	validateProject,
} from "./project.ts";

/** Source seconds a reversed derivative may differ from its original. */
export const REVERSE_DURATION_TOLERANCE = 0.05;
const DURATION_TOLERANCE = REVERSE_DURATION_TOLERANCE;
const OVERLAP_EPSILON = 1e-6;
const keyframeProperties = [
	"x",
	"y",
	"scale",
	"rotation",
	"opacity",
	"volume",
] as const;
const keyframeTime = (value: number) => Number(value.toFixed(6));

export const reverseRequestSchema = z
	.object({
		clipIds: z.array(z.uuid()).min(1).max(32),
		revision: z.number().int().nonnegative(),
	})
	.strict();

export type ReverseRequest = z.infer<typeof reverseRequestSchema>;
export type ReverseInput = z.input<typeof reverseRequestSchema>;

/** Maps an original asset id to its already-rendered reversed derivative. */
export type ReversedAssetLookup = (assetId: string) => Asset | undefined;

function assetById(assets: readonly Asset[], id: string) {
	return assets.find((asset) => asset.id === id);
}

/**
 * Mirror one property's animation so clip time `t` plays at `duration - t`.
 * Mirrored times never pass `limit`, the reversed clip's own duration, so
 * rounding a repeating-decimal duration cannot push a frame past the clip.
 */
function mirroredProperty(
	segment: Segment,
	property: Keyframe["property"],
	duration: number,
	limit: number
): { base: number; frames: Keyframe[] } | undefined {
	if (!segment.keyframes.some((frame) => frame.property === property)) {
		return undefined;
	}
	const mirrorTime = (time: number) =>
		Math.min(limit, keyframeTime(Math.max(0, duration - time)));
	const base = animatedValue(segment, property, duration);
	const mirrored = animationPoints(segment, property)
		.map((point) => ({
			...point,
			id: point.id === "initial" ? crypto.randomUUID() : point.id,
			time: mirrorTime(point.time),
		}))
		.sort((a, b) => a.time - b.time);
	const end = mirrorTime(0);
	const frames = mirrored.filter((frame, index) => {
		if (frame.time === 0 && frame.value === base) {
			return false;
		}
		const previous = mirrored[index - 1];
		return !(
			frame.time === end &&
			previous !== undefined &&
			previous.value === frame.value
		);
	});
	return { base, frames };
}

/**
 * Map a clip onto the reversed copy of its media: source time `t` becomes
 * `D - t`, keyframes are mirrored inside the clip and fades swap ends.
 */
export function reversedSegment(
	segment: Segment,
	original: Asset,
	reversed: Asset
): Segment {
	// Both directions mirror around the untouched media's duration.
	const sourceDuration =
		original.derivation === "reverse" ? reversed.duration : original.duration;
	const duration = segmentDuration(segment);
	const mirroredIn = sourceDuration - segment.sourceOut;
	// A clip may overrun its media by validateProject's tolerance. Slide that
	// range back inside the reversed media instead of trimming it, so the clip
	// keeps its length and linked partners and keyframes stay aligned.
	const sourceIn = Math.max(0, mirroredIn);
	const sourceOut =
		mirroredIn < 0
			? segment.sourceOut - segment.sourceIn
			: sourceDuration - segment.sourceIn;
	const next: Segment = {
		...segment,
		assetId: reversed.id,
		sourceIn,
		sourceOut,
		fadeIn: segment.fadeOut,
		fadeOut: segment.fadeIn,
		keyframes: [],
	};
	const limit = Math.min(duration, segmentDuration(next));
	const keyframes: Keyframe[] = [];
	for (const property of keyframeProperties) {
		const mirrored = mirroredProperty(segment, property, duration, limit);
		if (!mirrored) {
			continue;
		}
		next[property] = mirrored.base;
		keyframes.push(...mirrored.frames);
	}
	return { ...next, keyframes };
}

/** The asset a clip should switch to, undoing an earlier reverse when possible. */
function reverseTarget(
	assets: readonly Asset[],
	current: Asset,
	reversedFor: ReversedAssetLookup
): Asset {
	if (current.derivation === "reverse" && current.derivedFromAssetId) {
		const original = assetById(assets, current.derivedFromAssetId);
		if (original) {
			return original;
		}
	}
	const reversed = reversedFor(current.id);
	if (
		!(
			reversed &&
			reversed.derivation === "reverse" &&
			reversed.derivedFromAssetId === current.id &&
			reversed.kind === current.kind &&
			Math.abs(reversed.duration - current.duration) <= DURATION_TOLERANCE
		)
	) {
		throw new Error("Render the reversed media before reversing this clip.");
	}
	return reversed;
}

/** The clip plus every linked member, which must all reverse together. */
function reverseUnits(
	project: Project,
	clipIds: readonly string[]
): Segment[][] {
	const units: Segment[][] = [];
	const seen = new Set<string>();
	for (const clipId of clipIds) {
		const clip = project.segments.find((segment) => segment.id === clipId);
		if (!clip) {
			throw new Error("Clip not found on this timeline.");
		}
		if (seen.has(clip.id)) {
			continue;
		}
		const members = clip.linkGroupId
			? project.segments.filter(
					(segment) => segment.linkGroupId === clip.linkGroupId
				)
			: [clip];
		for (const member of members) {
			seen.add(member.id);
		}
		units.push(members);
	}
	return units;
}

/** Refuse when mirroring a linked member moves it onto another clip on its track. */
function assertNoMovedOverlap(
	before: readonly Segment[],
	after: readonly Segment[]
) {
	const previousStart = new Map(
		before.map((segment) => [segment.id, segment.start])
	);
	for (const moved of after) {
		if (previousStart.get(moved.id) === moved.start) {
			continue;
		}
		const movedEnd = moved.start + segmentDuration(moved);
		const collides = after.some(
			(other) =>
				other.id !== moved.id &&
				other.track === moved.track &&
				other.start < movedEnd - OVERLAP_EPSILON &&
				moved.start < other.start + segmentDuration(other) - OVERLAP_EPSILON
		);
		if (collides) {
			throw new Error(
				"Reversing would overlap another clip on the same track."
			);
		}
	}
}

/**
 * Play clips backwards. Linked members mirror around their shared span so
 * picture and sound stay in sync. A member that overhangs its picture (a
 * J/L cut against a neighbour) would mirror onto that neighbour, which
 * `assertNoMovedOverlap` refuses. Reversing an
 * already reversed clip restores the original media.
 */
export function reverseClips(
	project: Project,
	assets: readonly Asset[],
	input: ReverseInput,
	reversedFor: ReversedAssetLookup
): Project {
	const request = reverseRequestSchema.parse(input);
	if (new Set(request.clipIds).size !== request.clipIds.length) {
		throw new Error("Choose each clip once.");
	}
	const usedAssets = new Map(assets.map((asset) => [asset.id, asset]));
	const replaced = new Map<string, Segment>();
	for (const members of reverseUnits(project, request.clipIds)) {
		const playable = members.filter(
			(member) => assetById(assets, member.assetId)?.kind !== "image"
		);
		if (!playable.length) {
			throw new Error("Choose a video or audio clip to reverse.");
		}
		const spanStart = Math.min(...members.map((member) => member.start));
		const spanEnd = Math.max(
			...members.map((member) => member.start + segmentDuration(member))
		);
		for (const member of members) {
			if (trackSettingFor(project, member.track).locked) {
				throw new Error("Unlock every linked clip track before reversing.");
			}
			if (member.multicamGroupId) {
				throw new Error("Multicam clips cannot be reversed.");
			}
		}
		for (const member of members) {
			const current = assetById(assets, member.assetId);
			if (!current) {
				throw new Error("A timeline segment references missing media.");
			}
			const end = member.start + segmentDuration(member);
			const mirroredStart = Number(
				Math.max(0, spanStart + spanEnd - end).toFixed(6)
			);
			if (current.kind === "image") {
				replaced.set(member.id, {
					...reversedSegment(member, current, current),
					assetId: member.assetId,
					sourceIn: member.sourceIn,
					sourceOut: member.sourceOut,
					start: mirroredStart,
				});
				continue;
			}
			const target = reverseTarget(assets, current, reversedFor);
			usedAssets.set(target.id, target);
			replaced.set(member.id, {
				...reversedSegment(member, current, target),
				start: mirroredStart,
			});
		}
	}
	const segments = project.segments.map(
		(segment) => replaced.get(segment.id) ?? segment
	);
	assertNoMovedOverlap(project.segments, segments);
	return validateProject({ ...project, segments }, [...usedAssets.values()]);
}
