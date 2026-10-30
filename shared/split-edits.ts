import { z } from "zod";
import { MAX_TRACK_INDEX } from "./limits.ts";
import {
	type Asset,
	type Caption,
	type Project,
	retimeKeyframes,
	type Segment,
	sameMediaTimebase,
	segmentDuration,
	sharesSourceTime,
	trackSettingFor,
	validateProject,
} from "./project.ts";
import type { Transcript } from "./transcript.ts";

const EPSILON = 1e-6;
const MINIMUM_CLIP_SECONDS = 0.04;
const DECLICK_SECONDS = 0.01;
const MAX_SPLIT_OFFSET = 4;
const MAX_CROSSFADE = 0.5;
const DEFAULT_CROSSFADE = 0.08;

const cutKeySchema = z
	.string()
	.regex(
		/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}>[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
	);
const crossfadeSchema = z.number().finite().min(0).max(MAX_CROSSFADE);

const splitEditOptionsObject = z
	.object({
		maxOffset: z.number().finite().min(0.04).max(MAX_SPLIT_OFFSET).default(1.5),
		minOffset: z
			.number()
			.finite()
			.min(MINIMUM_CLIP_SECONDS)
			.max(MAX_SPLIT_OFFSET)
			.default(0.12),
		padding: z.number().finite().min(0).max(1).default(0.08),
		maxWordGap: z.number().finite().min(0).max(2).default(0.35),
		crossfade: crossfadeSchema.default(DEFAULT_CROSSFADE),
		energyFallback: z.boolean().default(true),
		replaceExisting: z.boolean().default(false),
	})
	.strict();
export const splitEditOptionsSchema = splitEditOptionsObject.refine(
	(options) => options.minOffset <= options.maxOffset,
	"The minimum split offset cannot exceed the maximum."
);
export type SplitEditOptions = z.infer<typeof splitEditOptionsSchema>;

export const splitEditRequestSchema = z
	.object({
		cutKey: cutKeySchema.optional(),
		clipId: z.uuid().optional(),
		kind: z.enum(["j", "l", "none"]),
		offset: z.number().finite().min(0).max(MAX_SPLIT_OFFSET).default(0),
		crossfade: crossfadeSchema.optional(),
		revision: z.number().int().nonnegative(),
	})
	.strict()
	.refine(
		(request) => request.cutKey !== undefined || request.clipId !== undefined,
		"Choose a cut or a linked clip for the split edit."
	);
export type SplitEditRequest = z.infer<typeof splitEditRequestSchema>;
export type SplitEditInput = z.input<typeof splitEditRequestSchema>;

export const splitEditPlanRequestSchema = z
	.object({
		options: splitEditOptionsObject.partial().optional(),
	})
	.strict();
export type SplitEditPlanRequest = z.infer<typeof splitEditPlanRequestSchema>;

export const applySplitEditsRequestSchema = z
	.object({
		proposals: z
			.array(
				z
					.object({
						key: cutKeySchema,
						offset: z
							.number()
							.finite()
							.min(-MAX_SPLIT_OFFSET)
							.max(MAX_SPLIT_OFFSET),
					})
					.strict()
			)
			.max(500),
		crossfade: crossfadeSchema.optional(),
		detachAudio: z.boolean().optional(),
		revision: z.number().int().nonnegative(),
	})
	.strict();
export type ApplySplitEditsRequest = z.infer<
	typeof applySplitEditsRequestSchema
>;

export interface CutSide {
	audio: Segment;
	groupId: string;
	video: Segment;
}

export interface CutPoint {
	/** Same media continues across the cut (a plain split), so J/L is inaudible. */
	continuousSource: boolean;
	/** Signed: <0 is an existing J-cut, >0 an existing L-cut, 0 a straight cut. */
	currentOffset: number;
	/** Timeline seconds of source available past / before the video edit. */
	handles: { outAudioAfter: number; inAudioBefore: number };
	incoming: CutSide;
	/** `${outGroupId}>${inGroupId}` */
	key: string;
	outgoing: CutSide;
	/** Timeline seconds of the video edit. */
	time: number;
	videoTrack: number;
}

export type CutSkipReason =
	| "complex-group"
	| "locked-track"
	| "unaligned-audio";
export interface CutSkip {
	key: string;
	reason: CutSkipReason;
}

export type SplitEditKind = "j" | "l" | "none";
export type SplitEditReason =
	| "clipped-incoming-speech"
	| "clipped-outgoing-speech"
	| "energy-lead"
	| "energy-tail"
	| "no-handle"
	| "both-sides-speaking"
	| "continuous-source"
	| "already-split"
	| "no-evidence";

export interface SplitEditProposal {
	confidence: number;
	cutTime: number;
	evidence: {
		outWords: number;
		inWords: number;
		source: "transcript" | "waveform" | "none";
	};
	key: string;
	kind: SplitEditKind;
	/** Signed seconds, already clamped to the source handles. */
	offset: number;
	reason: SplitEditReason;
}

/** Source-time speech for one asset; `measured` is false for cue-only transcripts. */
export interface SpeechEvidence {
	measured: boolean;
	words: readonly Caption[];
}
export interface WaveformEvidence {
	bins: readonly number[];
	duration: number;
}
export interface SplitEditEvidence {
	waveformFor: (assetId: string) => WaveformEvidence | undefined;
	wordsFor: (assetId: string) => SpeechEvidence | undefined;
}

export interface SplitEditResult {
	appliedOffset: number;
	key: string;
	project: Project;
}

export interface SplitEditsResult {
	applied: { key: string; offset: number }[];
	project: Project;
	skipped: { key: string; reason: string }[];
}

const round = (value: number, digits = 6) => Number(value.toFixed(digits));
const segmentEnd = (segment: Segment) =>
	segment.start + segmentDuration(segment);
/** Timeline time at which the segment's source time 0 would play. */
const sourceAnchor = (segment: Segment) =>
	segment.start - segment.sourceIn / segment.speed;
const isVisual = (asset: Asset | undefined) =>
	asset?.kind === "video" || asset?.kind === "image";

function assetLookup(assets: readonly Asset[]) {
	const byId = new Map(assets.map((asset) => [asset.id, asset]));
	return (id: string) => byId.get(id);
}

/** Pick speech for an asset, falling back to the media it was derived from. */
export function speechEvidenceFromTranscript(
	transcript: Transcript | null | undefined
): SpeechEvidence | undefined {
	if (transcript?.status !== "completed") {
		return undefined;
	}
	if (transcript.words.length) {
		return { words: transcript.words, measured: true };
	}
	return { words: transcript.cues, measured: false };
}

function resolveDerived<T>(
	asset: Asset,
	lookup: (assetId: string) => T | undefined
): T | undefined {
	const own = lookup(asset.id);
	if (own !== undefined) {
		return own;
	}
	if (asset.derivedFromAssetId && sharesSourceTime(asset)) {
		return lookup(asset.derivedFromAssetId);
	}
	return undefined;
}

interface GroupEntry {
	audio: Segment | undefined;
	groupId: string;
	reason: CutSkipReason | undefined;
	visual: Segment;
}

function linkGroupEntries(
	project: Project,
	assetFor: (id: string) => Asset | undefined
): GroupEntry[] {
	const groups = new Map<string, Segment[]>();
	for (const segment of project.segments) {
		if (segment.linkGroupId) {
			groups.set(segment.linkGroupId, [
				...(groups.get(segment.linkGroupId) ?? []),
				segment,
			]);
		}
	}
	const entries: GroupEntry[] = [];
	for (const [groupId, members] of groups) {
		const visuals = members.filter((member) =>
			isVisual(assetFor(member.assetId))
		);
		const audios = members.filter(
			(member) => assetFor(member.assetId)?.kind === "audio"
		);
		let reason: CutSkipReason | undefined;
		if (members.length !== 2 || visuals.length !== 1 || audios.length !== 1) {
			reason = "complex-group";
		} else if (
			members.some((member) => trackSettingFor(project, member.track).locked)
		) {
			reason = "locked-track";
		}
		for (const visual of visuals) {
			entries.push({ groupId, visual, audio: audios[0], reason });
		}
	}
	return entries;
}

function estimateCurrentEdit(
	outA: Segment,
	inA: Segment,
	outAsset: Asset,
	frame: number
) {
	const outEnd = segmentEnd(outA);
	if (outEnd - inA.start <= frame) {
		return (outEnd + inA.start) / 2;
	}
	const outExhausted = outA.sourceOut >= outAsset.duration - EPSILON;
	const inExhausted = inA.sourceIn <= EPSILON || inA.start <= EPSILON;
	if (outExhausted && !inExhausted) {
		return outEnd;
	}
	if (inExhausted && !outExhausted) {
		return inA.start;
	}
	return (outEnd + inA.start) / 2;
}

function audioAligned(outA: Segment, inA: Segment, cut: number, frame: number) {
	const outEnd = segmentEnd(outA);
	const reach = MAX_SPLIT_OFFSET + MAX_CROSSFADE + frame;
	return (
		outA.start < cut - EPSILON &&
		segmentEnd(inA) > cut + EPSILON &&
		Math.abs(outEnd - cut) <= reach &&
		Math.abs(inA.start - cut) <= reach &&
		inA.start - outEnd <= frame &&
		outEnd - inA.start <= MAX_CROSSFADE + frame
	);
}

function buildCut(
	out: GroupEntry & { audio: Segment },
	incoming: GroupEntry & { audio: Segment },
	assetFor: (id: string) => Asset | undefined,
	frame: number
): CutPoint | undefined {
	const outAsset = assetFor(out.audio.assetId);
	const inAsset = assetFor(incoming.audio.assetId);
	const outVisualAsset = assetFor(out.visual.assetId);
	const inVisualAsset = assetFor(incoming.visual.assetId);
	if (!(outAsset && inAsset && outVisualAsset && inVisualAsset)) {
		return undefined;
	}
	const time = round(incoming.visual.start);
	const outA = out.audio;
	const inA = incoming.audio;
	const outMaxEnd = sourceAnchor(outA) + outAsset.duration / outA.speed;
	const inMinStart = Math.max(0, sourceAnchor(inA));
	const edit = estimateCurrentEdit(outA, inA, outAsset, frame);
	const rawOffset = Math.round((edit - time) / frame) * frame;
	const continuousSource =
		sameMediaTimebase(outVisualAsset, inVisualAsset) &&
		out.visual.speed === incoming.visual.speed &&
		Math.abs(out.visual.sourceOut - incoming.visual.sourceIn) <=
			out.visual.speed * frame + EPSILON &&
		sameMediaTimebase(outAsset, inAsset) &&
		outA.speed === inA.speed &&
		Math.abs(sourceAnchor(outA) - sourceAnchor(inA)) <= frame + EPSILON;
	return {
		key: `${out.groupId}>${incoming.groupId}`,
		time,
		videoTrack: incoming.visual.track,
		outgoing: { groupId: out.groupId, video: out.visual, audio: outA },
		incoming: { groupId: incoming.groupId, video: incoming.visual, audio: inA },
		continuousSource,
		handles: {
			outAudioAfter: round(Math.max(0, outMaxEnd - time)),
			inAudioBefore: round(Math.max(0, time - inMinStart)),
		},
		currentOffset: Math.abs(rawOffset) < frame / 2 ? 0 : round(rawOffset),
	};
}

/** Find every video edit between two simple linked audio/video groups, plus skipped edits. */
export function scanCutPoints(
	project: Project,
	assets: readonly Asset[],
	fps: number = project.fps
): { cuts: CutPoint[]; skipped: CutSkip[] } {
	const frame = 1 / Math.max(1, fps);
	const assetFor = assetLookup(assets);
	const byTrack = new Map<number, GroupEntry[]>();
	for (const entry of linkGroupEntries(project, assetFor)) {
		byTrack.set(entry.visual.track, [
			...(byTrack.get(entry.visual.track) ?? []),
			entry,
		]);
	}
	const cuts: CutPoint[] = [];
	const skipped = new Map<string, CutSkipReason>();
	for (const entries of byTrack.values()) {
		const sorted = [...entries].sort(
			(a, b) =>
				a.visual.start - b.visual.start ||
				segmentEnd(a.visual) - segmentEnd(b.visual)
		);
		for (const [index, out] of sorted.entries()) {
			const incoming = sorted[index + 1];
			if (
				!incoming ||
				incoming.groupId === out.groupId ||
				Math.abs(segmentEnd(out.visual) - incoming.visual.start) >
					frame + EPSILON
			) {
				continue;
			}
			const key = `${out.groupId}>${incoming.groupId}`;
			const reason = out.reason ?? incoming.reason;
			if (reason || !(out.audio && incoming.audio)) {
				skipped.set(key, reason ?? "complex-group");
				continue;
			}
			const outPair = { ...out, audio: out.audio };
			const inPair = { ...incoming, audio: incoming.audio };
			if (
				!audioAligned(out.audio, incoming.audio, incoming.visual.start, frame)
			) {
				skipped.set(key, "unaligned-audio");
				continue;
			}
			const cut = buildCut(outPair, inPair, assetFor, frame);
			if (cut) {
				cuts.push(cut);
			}
		}
	}
	return {
		cuts: cuts.sort((a, b) => a.time - b.time || a.key.localeCompare(b.key)),
		skipped: [...skipped]
			.map(([key, reason]) => ({ key, reason }))
			.sort((a, b) => a.key.localeCompare(b.key)),
	};
}

/** Every editable cut between simple linked audio/video groups, in time order. */
export function findCutPoints(
	project: Project,
	assets: readonly Asset[],
	fps: number = project.fps
): CutPoint[] {
	return scanCutPoints(project, assets, fps).cuts;
}

/** Resolve the cut at either edge of a linked clip, nearest `nearTime` when given. */
export function resolveCutForClip(
	project: Project,
	assets: readonly Asset[],
	clipId: string,
	nearTime?: number
): CutPoint {
	const clip = project.segments.find((segment) => segment.id === clipId);
	if (!clip) {
		throw new Error("Clip not found on this timeline.");
	}
	if (!clip.linkGroupId) {
		throw new Error(
			"Link or detach the clip's audio before making a split edit."
		);
	}
	const groupId = clip.linkGroupId;
	const candidates = findCutPoints(project, assets).filter(
		(cut) =>
			cut.outgoing.groupId === groupId || cut.incoming.groupId === groupId
	);
	const reference = nearTime ?? clip.start;
	const nearest = candidates.reduce<CutPoint | undefined>(
		(best, cut) =>
			!best ||
			Math.abs(cut.time - reference) < Math.abs(best.time - reference) - EPSILON
				? cut
				: best,
		undefined
	);
	if (!nearest) {
		throw new Error(
			"No cut to another linked clip touches this clip on its video track."
		);
	}
	return nearest;
}

function overlapLength(a: Segment, b: Segment) {
	return Math.min(segmentEnd(a), segmentEnd(b)) - Math.max(a.start, b.start);
}

function collides(
	segments: readonly Segment[],
	moving: Segment,
	track: number,
	partner: { id: string; allowed: number }
) {
	return segments.some(
		(other) =>
			other.id !== moving.id &&
			other.track === track &&
			overlapLength(other, moving) > EPSILON &&
			!(
				other.id === partner.id &&
				overlapLength(other, moving) <= partner.allowed + EPSILON
			)
	);
}

function alternateTrack(
	project: Project,
	assetFor: (id: string) => Asset | undefined,
	segments: readonly Segment[],
	moving: Segment,
	partner: { id: string; allowed: number }
) {
	const visualTracks = new Set(
		segments
			.filter(
				(segment) =>
					segment.id !== moving.id && isVisual(assetFor(segment.assetId))
			)
			.map((segment) => segment.track)
	);
	const below = Array.from(
		{ length: MAX_TRACK_INDEX - moving.track },
		(_, index) => moving.track + index + 1
	);
	const above = Array.from(
		{ length: moving.track },
		(_, index) => moving.track - index - 1
	);
	const track = [...below, ...above].find(
		(candidate) =>
			!(
				visualTracks.has(candidate) ||
				trackSettingFor(project, candidate).locked ||
				collides(segments, moving, candidate, partner)
			)
	);
	if (track === undefined) {
		throw new Error("No free audio track for the split edit.");
	}
	return track;
}

/** Round to 6 decimals without exceeding `limit`. */
function roundAtMost(value: number, limit: number) {
	let rounded = round(Math.min(value, limit));
	while (rounded > limit) {
		rounded = round(rounded - EPSILON);
	}
	return rounded;
}

/**
 * Set one edge fade so fadeIn + fadeOut fits the clip. The existing opposite
 * fade wins, but is shortened when the rolled clip leaves no de-click room.
 */
function withFade(segment: Segment, edge: "in" | "out", fade: number): Segment {
	const duration = segmentDuration(segment);
	const opposite = edge === "in" ? segment.fadeOut : segment.fadeIn;
	const reserve = Math.min(Math.max(0, fade), DECLICK_SECONDS);
	const oppositeFade = Math.max(
		0,
		roundAtMost(opposite, Math.max(0, duration - reserve))
	);
	const edgeFade = Math.max(
		0,
		roundAtMost(fade, Math.max(0, duration - oppositeFade))
	);
	return edge === "in"
		? { ...segment, fadeIn: edgeFade, fadeOut: oppositeFade }
		: { ...segment, fadeIn: oppositeFade, fadeOut: edgeFade };
}

/** Roll the audio edit point of one cut; segments are returned unvalidated. */
function rollAudioEdit(
	project: Project,
	assets: readonly Asset[],
	cut: CutPoint,
	opts: { offset: number; crossfade: number; fps: number }
): { segments: Segment[]; appliedOffset: number } {
	const assetFor = assetLookup(assets);
	const outA = project.segments.find(
		(segment) => segment.id === cut.outgoing.audio.id
	);
	const inA = project.segments.find(
		(segment) => segment.id === cut.incoming.audio.id
	);
	const outAsset = outA && assetFor(outA.assetId);
	if (!(outA && inA && outAsset)) {
		throw new Error("The cut no longer exists on this timeline.");
	}
	const frame = 1 / Math.max(1, opts.fps);
	const t = cut.time;
	const outAnchor = sourceAnchor(outA);
	const inAnchor = sourceAnchor(inA);
	const outMaxEnd = Math.min(7200, outAnchor + outAsset.duration / outA.speed);
	const inMinStart = Math.max(0, inAnchor);
	const maxL = Math.max(
		0,
		Math.min(outMaxEnd - t, segmentEnd(inA) - MINIMUM_CLIP_SECONDS - t)
	);
	const maxJ = Math.max(
		0,
		Math.min(t - inMinStart, t - outA.start - MINIMUM_CLIP_SECONDS)
	);
	const requested = Math.max(-maxJ, Math.min(maxL, opts.offset));
	const frames = Math.floor(Math.abs(requested) / frame + EPSILON);
	const appliedOffset = round(Math.sign(requested) * frames * frame);
	const edit = t + appliedOffset;
	const half = Math.max(0, Math.min(MAX_CROSSFADE, opts.crossfade)) / 2;
	const outExtend = Math.max(0, Math.min(half, outMaxEnd - edit));
	const inExtend = Math.max(0, Math.min(half, edit - inMinStart));
	const overlap = outExtend + inExtend;
	const fade =
		overlap > EPSILON
			? overlap
			: appliedOffset !== 0 || opts.crossfade > 0
				? DECLICK_SECONDS
				: 0;

	const outEnd = edit + outExtend;
	// Round down so the rolled outgoing audio never ends past `outEnd`; at slow
	// speeds a rounded-up source time would leak into its partner's start.
	let outSourceOut = Math.min(
		outAsset.duration,
		round((outEnd - outAnchor) * outA.speed)
	);
	while (
		outA.start + (outSourceOut - outA.sourceIn) / outA.speed >
		outEnd + 1e-9
	) {
		outSourceOut = round(outSourceOut - EPSILON);
	}
	const outDuration = (outSourceOut - outA.sourceIn) / outA.speed;
	let nextOut: Segment = withFade(
		{
			...outA,
			sourceOut: outSourceOut,
			keyframes: retimeKeyframes(outA, 0, outDuration),
		},
		"out",
		fade
	);
	const inStart = round(Math.max(0, edit - inExtend));
	const inSourceIn = Math.max(0, round((inStart - inAnchor) * inA.speed));
	const inDuration = (inA.sourceOut - inSourceIn) / inA.speed;
	let nextIn: Segment = withFade(
		{
			...inA,
			start: inStart,
			sourceIn: inSourceIn,
			keyframes: retimeKeyframes(inA, inStart - inA.start, inDuration),
		},
		"in",
		fade
	);

	let segments = project.segments.map((segment) => {
		if (segment.id === nextOut.id) {
			return nextOut;
		}
		return segment.id === nextIn.id ? nextIn : segment;
	});
	if (
		collides(segments, nextIn, nextIn.track, {
			id: nextOut.id,
			allowed: overlap,
		})
	) {
		nextIn = {
			...nextIn,
			track: alternateTrack(project, assetFor, segments, nextIn, {
				id: nextOut.id,
				allowed: overlap,
			}),
		};
		segments = segments.map((segment) =>
			segment.id === nextIn.id ? nextIn : segment
		);
	}
	if (
		collides(segments, nextOut, nextOut.track, {
			id: nextIn.id,
			allowed: overlap,
		})
	) {
		nextOut = {
			...nextOut,
			track: alternateTrack(project, assetFor, segments, nextOut, {
				id: nextIn.id,
				allowed: overlap,
			}),
		};
		segments = segments.map((segment) =>
			segment.id === nextOut.id ? nextOut : segment
		);
	}
	return { segments, appliedOffset };
}

function currentCut(
	project: Project,
	assets: readonly Asset[],
	key: string,
	fps: number
) {
	return scanCutPoints(project, assets, fps).cuts.find(
		(cut) => cut.key === key
	);
}

/**
 * Roll one cut's audio edit point: negative offsets make a J-cut, positive an
 * L-cut, 0 restores a straight cut. Offsets are frame-quantized and clamped to
 * the source handles; source media is never fabricated. Keyframes trimmed off
 * a rolled edge are replaced by an interpolated edge keyframe and are not
 * brought back by a later roll.
 */
export function applySplitEdit(
	project: Project,
	assets: readonly Asset[],
	cut: CutPoint,
	opts: { offset: number; crossfade?: number; fps?: number }
): SplitEditResult {
	const fps = opts.fps ?? project.fps;
	const fresh = currentCut(project, assets, cut.key, fps);
	if (!fresh) {
		throw new Error("The cut no longer exists on this timeline.");
	}
	const rolled = rollAudioEdit(project, assets, fresh, {
		crossfade: opts.crossfade ?? DEFAULT_CROSSFADE,
		fps,
		offset: opts.offset,
	});
	return {
		appliedOffset: rolled.appliedOffset,
		key: fresh.key,
		project: validateProject({ ...project, segments: rolled.segments }, [
			...assets,
		]),
	};
}

/** Apply a manual J/L/straight split edit from a validated route request. */
export function applySplitEditRequest(
	project: Project,
	assets: readonly Asset[],
	input: SplitEditInput,
	nearTime?: number
): SplitEditResult {
	const request = splitEditRequestSchema.parse(input);
	const cut = request.cutKey
		? currentCut(project, assets, request.cutKey, project.fps)
		: resolveCutForClip(project, assets, request.clipId ?? "", nearTime);
	if (!cut) {
		throw new Error("The cut no longer exists on this timeline.");
	}
	const signed =
		request.kind === "j"
			? -request.offset
			: request.kind === "l"
				? request.offset
				: 0;
	return applySplitEdit(project, assets, cut, {
		crossfade: request.crossfade,
		offset: signed,
	});
}

/** Apply accepted proposals in time order, re-resolving each cut by key. */
export function applySplitEdits(
	project: Project,
	assets: readonly Asset[],
	proposals: readonly { key: string; offset: number }[],
	opts: { crossfade?: number; fps?: number } = {}
): SplitEditsResult {
	const fps = opts.fps ?? project.fps;
	if (
		new Set(proposals.map((proposal) => proposal.key)).size !== proposals.length
	) {
		throw new Error("Choose each cut once.");
	}
	const initial = new Map(
		scanCutPoints(project, assets, fps).cuts.map((cut) => [cut.key, cut.time])
	);
	const skipped: { key: string; reason: string }[] = [];
	const ordered = proposals
		.filter((proposal) => {
			if (initial.has(proposal.key)) {
				return true;
			}
			skipped.push({ key: proposal.key, reason: "missing-cut" });
			return false;
		})
		.sort(
			(a, b) =>
				(initial.get(a.key) ?? 0) - (initial.get(b.key) ?? 0) ||
				a.key.localeCompare(b.key)
		);
	let next = project;
	const applied: { key: string; offset: number }[] = [];
	for (const proposal of ordered) {
		const cut = currentCut(next, assets, proposal.key, fps);
		if (!cut) {
			skipped.push({ key: proposal.key, reason: "missing-cut" });
			continue;
		}
		const rolled = rollAudioEdit(next, assets, cut, {
			crossfade: opts.crossfade ?? DEFAULT_CROSSFADE,
			fps,
			offset: proposal.offset,
		});
		next = { ...next, segments: rolled.segments };
		applied.push({ key: proposal.key, offset: rolled.appliedOffset });
	}
	return {
		applied,
		project: applied.length ? validateProject(next, [...assets]) : project,
		skipped,
	};
}

interface TimedWord {
	end: number;
	start: number;
}

function mapWords(words: readonly Caption[], segment: Segment): TimedWord[] {
	const anchor = sourceAnchor(segment);
	return words
		.filter((word) => word.end > word.start)
		.map((word) => ({
			end: anchor + word.end / segment.speed,
			start: anchor + word.start / segment.speed,
		}))
		.sort((a, b) => a.start - b.start || a.end - b.end);
}

/** Speech that continues past the cut in the outgoing source, within its handle. */
function phraseAfterCut(
	words: readonly TimedWord[],
	cut: number,
	limit: number,
	maxGap: number
): TimedWord[] {
	const phrase: TimedWord[] = [];
	for (const word of words) {
		if (word.end <= cut + EPSILON) {
			continue;
		}
		const previous = phrase.at(-1);
		const gap = previous ? word.start - previous.end : word.start - cut;
		if (gap > maxGap + EPSILON || word.end > limit + EPSILON) {
			break;
		}
		phrase.push(word);
	}
	return phrase;
}

/** Speech that starts before the cut in the incoming source, within its handle. */
function phraseBeforeCut(
	words: readonly TimedWord[],
	cut: number,
	limit: number,
	maxGap: number
): TimedWord[] {
	const phrase: TimedWord[] = [];
	for (const word of [...words].reverse()) {
		if (word.start >= cut - EPSILON) {
			continue;
		}
		const previous = phrase.at(-1);
		const gap = previous ? previous.start - word.end : cut - word.end;
		if (gap > maxGap + EPSILON || word.start < limit - EPSILON) {
			break;
		}
		phrase.push(word);
	}
	return phrase;
}

interface CutContext {
	capJ: number;
	capL: number;
	cut: CutPoint;
	inAsset: Asset;
	outAsset: Asset;
}

type Decision = Omit<SplitEditProposal, "key" | "cutTime">;

const noneDecision = (
	reason: SplitEditReason,
	source: SplitEditProposal["evidence"]["source"] = "none",
	confidence = 1
): Decision => ({
	confidence,
	evidence: { inWords: 0, outWords: 0, source },
	kind: "none",
	offset: 0,
	reason,
});

function transcriptDecision(
	context: CutContext,
	outSpeech: SpeechEvidence,
	inSpeech: SpeechEvidence,
	options: SplitEditOptions
): Decision {
	const { cut, capL, capJ } = context;
	const t = cut.time;
	const outWords = mapWords(outSpeech.words, cut.outgoing.audio);
	const inWords = mapWords(inSpeech.words, cut.incoming.audio);
	const measured = outSpeech.measured && inSpeech.measured;
	const tail = phraseAfterCut(
		outWords,
		t,
		t + cut.handles.outAudioAfter,
		options.maxWordGap
	);
	const lead = phraseBeforeCut(
		inWords,
		t,
		t - cut.handles.inAudioBefore,
		options.maxWordGap
	);
	const lastTail = tail.at(-1);
	const firstLead = lead.at(-1);
	const needL = lastTail ? lastTail.end + options.padding - t : 0;
	const needJ = firstLead ? t - (firstLead.start - options.padding) : 0;
	const evidence = {
		inWords: lead.length,
		outWords: tail.length,
		source: "transcript" as const,
	};
	const confidenceFor = (count: number) =>
		round((measured ? 1 : 0.5) * Math.min(1, 0.5 + 0.25 * count), 3);
	const wantsL = tail.length > 0 && needL >= options.minOffset;
	const wantsJ = lead.length > 0 && needJ >= options.minOffset;
	if (wantsL && wantsJ) {
		return {
			...noneDecision("both-sides-speaking", "transcript", confidenceFor(2)),
			evidence,
		};
	}
	if (!(wantsL || wantsJ)) {
		return {
			...noneDecision("no-evidence", "transcript", measured ? 1 : 0.5),
			evidence,
		};
	}
	if (wantsL) {
		if (capL < options.minOffset) {
			return { ...noneDecision("no-handle", "transcript"), evidence };
		}
		let amount = Math.min(needL, capL);
		const displaced = inWords.find(
			(word) => word.end > t + EPSILON && word.start < t + amount
		);
		if (displaced) {
			amount = Math.min(amount, displaced.start - options.padding - t);
		}
		if (amount < options.minOffset) {
			return {
				...noneDecision("both-sides-speaking", "transcript", confidenceFor(1)),
				evidence,
			};
		}
		return {
			confidence: confidenceFor(tail.length),
			evidence,
			kind: "l",
			offset: round(amount, 3),
			reason: "clipped-outgoing-speech",
		};
	}
	if (capJ < options.minOffset) {
		return { ...noneDecision("no-handle", "transcript"), evidence };
	}
	let amount = Math.min(needJ, capJ);
	const displaced = outWords.findLast(
		(word) => word.start < t - EPSILON && word.end > t - amount
	);
	if (displaced) {
		amount = Math.min(amount, t - (displaced.end + options.padding));
	}
	if (amount < options.minOffset) {
		return {
			...noneDecision("both-sides-speaking", "transcript", confidenceFor(1)),
			evidence,
		};
	}
	return {
		confidence: confidenceFor(lead.length),
		evidence,
		kind: "j",
		offset: -round(amount, 3),
		reason: "clipped-incoming-speech",
	};
}

interface Envelope {
	binSeconds: number;
	bins: readonly number[];
	duration: number;
	threshold: number;
}

function envelope(wave: WaveformEvidence): Envelope | undefined {
	if (!(wave.bins.length && wave.duration > 0)) {
		return undefined;
	}
	const bins = wave.bins.map((value) =>
		Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0
	);
	const peak = Math.max(...bins);
	return {
		binSeconds: wave.duration / bins.length,
		bins,
		duration: wave.duration,
		threshold:
			peak >= 0.08 ? Math.max(0.025, 0.14 * peak) : Number.POSITIVE_INFINITY,
	};
}

const binAt = (env: Envelope, sourceTime: number) =>
	Math.floor(sourceTime / env.binSeconds + EPSILON);
const loudBin = (env: Envelope, index: number) =>
	index >= 0 &&
	index < env.bins.length &&
	(env.bins[index] ?? 0) >= env.threshold;

/** Source seconds from `sourceTime` to the end of a run of bins matching `loud`. */
function runForward(env: Envelope, sourceTime: number, loud: boolean) {
	let index = binAt(env, sourceTime);
	if (index >= env.bins.length || loudBin(env, index) !== loud) {
		return 0;
	}
	while (index < env.bins.length && loudBin(env, index) === loud) {
		index += 1;
	}
	return Math.min(env.duration, index * env.binSeconds) - sourceTime;
}

/** Source seconds back from `sourceTime` to the start of a run of bins matching `loud`. */
function runBackward(env: Envelope, sourceTime: number, loud: boolean) {
	let index =
		binAt(env, sourceTime) - (sourceTime % env.binSeconds < EPSILON ? 1 : 0);
	if (index < 0 || loudBin(env, index) !== loud) {
		return 0;
	}
	while (index >= 0 && loudBin(env, index) === loud) {
		index -= 1;
	}
	return sourceTime - (index + 1) * env.binSeconds;
}

function energyDecision(
	context: CutContext,
	outWave: WaveformEvidence,
	inWave: WaveformEvidence,
	options: SplitEditOptions
): Decision {
	const { cut, capL, capJ } = context;
	const outEnv = envelope(outWave);
	const inEnv = envelope(inWave);
	const outA = cut.outgoing.audio;
	const inA = cut.incoming.audio;
	if (
		!(outEnv && inEnv) ||
		outEnv.binSeconds / outA.speed > options.maxOffset / 2 ||
		inEnv.binSeconds / inA.speed > options.maxOffset / 2
	) {
		return noneDecision("no-evidence", "waveform", 0);
	}
	const outCut = (cut.time - sourceAnchor(outA)) * outA.speed;
	const inCut = (cut.time - sourceAnchor(inA)) * inA.speed;
	const tailLoud = runForward(outEnv, outCut, true) / outA.speed;
	const headQuiet = runForward(inEnv, inCut, false) / inA.speed;
	const leadLoud = runBackward(inEnv, inCut, true) / inA.speed;
	const outQuiet = runBackward(outEnv, outCut, false) / outA.speed;
	const tailSpeaks = tailLoud > 0 && tailLoud >= options.minOffset;
	const leadSpeaks = leadLoud > 0 && leadLoud >= options.minOffset;
	const wantsL = tailSpeaks && headQuiet > 0;
	const wantsJ = leadSpeaks && outQuiet > 0;
	if (tailSpeaks && leadSpeaks) {
		return noneDecision("both-sides-speaking", "waveform", 0.4);
	}
	if (wantsL) {
		const amount = Math.min(tailLoud, headQuiet, capL);
		if (amount < options.minOffset) {
			return noneDecision(
				capL < options.minOffset ? "no-handle" : "both-sides-speaking",
				"waveform",
				0.4
			);
		}
		return {
			...noneDecision("energy-tail", "waveform", 0.4),
			kind: "l",
			offset: round(amount, 3),
		};
	}
	if (wantsJ) {
		const amount = Math.min(leadLoud, outQuiet, capJ);
		if (amount < options.minOffset) {
			return noneDecision(
				capJ < options.minOffset ? "no-handle" : "both-sides-speaking",
				"waveform",
				0.4
			);
		}
		return {
			...noneDecision("energy-lead", "waveform", 0.4),
			kind: "j",
			offset: -round(amount, 3),
		};
	}
	return noneDecision("no-evidence", "waveform", 0.4);
}

function decide(
	context: CutContext,
	evidence: SplitEditEvidence,
	options: SplitEditOptions
): Decision {
	const { cut, outAsset, inAsset, capL, capJ } = context;
	if (cut.continuousSource) {
		return noneDecision("continuous-source");
	}
	if (cut.currentOffset !== 0 && !options.replaceExisting) {
		return noneDecision("already-split");
	}
	if (capL < options.minOffset && capJ < options.minOffset) {
		return noneDecision("no-handle");
	}
	const outSpeech = resolveDerived(outAsset, evidence.wordsFor);
	const inSpeech = resolveDerived(inAsset, evidence.wordsFor);
	if (outSpeech && inSpeech) {
		return transcriptDecision(context, outSpeech, inSpeech, options);
	}
	if (!options.energyFallback) {
		return noneDecision("no-evidence", "none", 0);
	}
	const outWave = resolveDerived(outAsset, evidence.waveformFor);
	const inWave = resolveDerived(inAsset, evidence.waveformFor);
	if (!(outWave && inWave)) {
		return noneDecision("no-evidence", "none", 0);
	}
	return energyDecision(context, outWave, inWave, options);
}

/**
 * Propose a J-cut, L-cut or straight cut for every eligible edit from measured
 * speech, falling back to the waveform. Pure and deterministic.
 */
export function proposeSplitEdits(
	project: Project,
	assets: readonly Asset[],
	evidence: SplitEditEvidence,
	options: Partial<SplitEditOptions> = {}
): { proposals: SplitEditProposal[]; skipped: CutSkip[] } {
	const resolved = splitEditOptionsSchema.parse(options);
	const assetFor = assetLookup(assets);
	const { cuts, skipped } = scanCutPoints(project, assets);
	const proposals: SplitEditProposal[] = [];
	for (const cut of cuts) {
		const outAsset = assetFor(cut.outgoing.audio.assetId);
		const inAsset = assetFor(cut.incoming.audio.assetId);
		if (!(outAsset && inAsset)) {
			continue;
		}
		const capL = Math.max(
			0,
			Math.min(
				cut.handles.outAudioAfter,
				segmentEnd(cut.incoming.audio) - MINIMUM_CLIP_SECONDS - cut.time,
				resolved.maxOffset
			)
		);
		const capJ = Math.max(
			0,
			Math.min(
				cut.handles.inAudioBefore,
				cut.time - cut.outgoing.audio.start - MINIMUM_CLIP_SECONDS,
				resolved.maxOffset
			)
		);
		proposals.push({
			cutTime: cut.time,
			key: cut.key,
			...decide({ capJ, capL, cut, inAsset, outAsset }, evidence, resolved),
		});
	}
	return {
		proposals: proposals.sort(
			(a, b) => a.cutTime - b.cutTime || a.key.localeCompare(b.key)
		),
		skipped,
	};
}
