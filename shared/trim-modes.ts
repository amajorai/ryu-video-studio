import { z } from "zod";
import {
	type Asset,
	fitEdgeTransitions,
	type Project,
	retimeKeyframes,
	type Segment,
	segmentDuration,
	trackSettingFor,
	validateProject,
} from "./project.ts";
import { affectedTracks } from "./sync-lock.ts";
import { latestTimedEnd, shiftTimedLayers } from "./timed-layers.ts";
import { dropUncoveredRevealTransitions } from "./track-placement.ts";
import { followTrackedLayers } from "./tracked-layers.ts";

const PROJECT_LIMIT = 7200;
const MINIMUM_CLIP_SECONDS = 0.04;
const EPSILON = 1e-6;

const delta = z.number().finite().min(-PROJECT_LIMIT).max(PROJECT_LIMIT);
const revision = z.number().int().nonnegative();
const ignoreLinks = z.boolean().default(false);

export const trimEditRequestSchema = z.discriminatedUnion("mode", [
	z
		.object({
			mode: z.literal("roll"),
			outClipId: z.uuid(),
			inClipId: z.uuid(),
			delta,
			ignoreLinks,
			revision,
		})
		.strict(),
	z
		.object({
			mode: z.literal("slip"),
			clipId: z.uuid(),
			delta,
			ignoreLinks,
			revision,
		})
		.strict(),
	z
		.object({
			mode: z.literal("slide"),
			clipId: z.uuid(),
			delta,
			ignoreLinks,
			revision,
		})
		.strict(),
	z
		.object({
			mode: z.literal("ripple"),
			clipId: z.uuid(),
			edge: z.enum(["start", "end"]),
			delta,
			ignoreLinks,
			revision,
			/**
			 * Also ripple later clips on every other sync-locked track. Off by
			 * default: a ripple trim has always moved only the trimmed tracks.
			 */
			syncLock: z.boolean().optional(),
		})
		.strict(),
]);

export type TrimEditRequest = z.infer<typeof trimEditRequestSchema>;
export type TrimEditInput = z.input<typeof trimEditRequestSchema>;
export interface TrimEditResult {
	applied: number;
	project: Project;
}

/**
 * How one clip changes for a shared timeline delta `d`:
 * `start` moves the head edge (start and source in), `end` moves the tail edge,
 * `head` trims the head in place (start stays, ripple), `move` shifts the clip.
 */
type ClipEdit = "start" | "end" | "head" | "move";
type EditPlan = Map<string, ClipEdit>;
interface Bounds {
	high: number;
	low: number;
}
/** How fast each timeline edge of a clip moves per unit of `d`. */
interface EdgeRates {
	head: number;
	tail: number;
}

const editRates: Record<ClipEdit, EdgeRates> = {
	end: { head: 0, tail: 1 },
	head: { head: 0, tail: -1 },
	move: { head: 1, tail: 1 },
	start: { head: 1, tail: 0 },
};

const round6 = (value: number) => Number(value.toFixed(6));
const quantize = (value: number, fps: number) => Math.round(value * fps) / fps;
/** Snap toward zero to a whole frame so a clamped delta never overshoots its bound. */
const frameTowardZero = (value: number, fps: number) =>
	(Math.sign(value) * Math.floor(Math.abs(value) * fps + EPSILON)) / fps;
/**
 * Shortest clip a trim may leave, in whole frames. The guard rounds up past
 * the 0.04 s floor so float error in `segmentDuration` never dips below it.
 */
const minimumKept = (fps: number) =>
	Math.ceil((MINIMUM_CLIP_SECONDS + EPSILON) * fps) / fps;
const clipEnd = (segment: Segment) => segment.start + segmentDuration(segment);

function clip(project: Project, id: string) {
	const found = project.segments.find((segment) => segment.id === id);
	if (!found) {
		throw new Error("Clip not found on this timeline.");
	}
	return found;
}

function assetFor(assets: readonly Asset[], segment: Segment) {
	const asset = assets.find((candidate) => candidate.id === segment.assetId);
	if (!asset) {
		throw new Error("A timeline segment references missing media.");
	}
	return asset;
}

/** Image stills have no source limit, so only video and audio carry handles. */
const isStill = (asset: Asset) => asset.kind === "image";

function linkedGroup(
	project: Project,
	segment: Segment,
	skipLinks: boolean
): Segment[] {
	if (skipLinks || !segment.linkGroupId) {
		return [segment];
	}
	return project.segments.filter(
		(candidate) => candidate.linkGroupId === segment.linkGroupId
	);
}

function ensureUnlocked(project: Project, segments: Iterable<Segment>) {
	for (const segment of segments) {
		if (trackSettingFor(project, segment.track).locked) {
			throw new Error("Unlock every affected clip track before trimming.");
		}
	}
}

function addToPlan(
	plan: EditPlan,
	segments: readonly Segment[],
	edit: ClipEdit
) {
	for (const segment of segments) {
		const existing = plan.get(segment.id);
		if (existing && existing !== edit) {
			throw new Error("This trim would change one clip in two ways.");
		}
		plan.set(segment.id, edit);
	}
}

/** Timeline-second range that `d` may take for one clip under one edit. */
function editBounds(
	segment: Segment,
	asset: Asset,
	edit: ClipEdit,
	fps: number
): Bounds {
	const shortest = minimumKept(fps);
	const duration = segmentDuration(segment);
	const end = clipEnd(segment);
	const roomAfter = PROJECT_LIMIT - end;
	const sourceBefore = segment.sourceIn / segment.speed;
	const sourceAfter = (asset.duration - segment.sourceOut) / segment.speed;
	switch (edit) {
		case "move":
			return { low: -segment.start, high: roomAfter };
		case "end":
			return {
				low: -(duration - shortest),
				high: isStill(asset) ? roomAfter : Math.min(roomAfter, sourceAfter),
			};
		case "start":
			return {
				low: -(isStill(asset)
					? segment.start
					: Math.min(sourceBefore, segment.start)),
				high: duration - shortest,
			};
		case "head":
			return {
				low: -(isStill(asset) ? roomAfter : Math.min(sourceBefore, roomAfter)),
				high: duration - shortest,
			};
		default:
			throw new Error("Unknown trim edit.");
	}
}

/**
 * Keep every clip on its track from overlapping a neighbour: each adjacent
 * pair's gap changes at `rates(next).head - rates(previous).tail` per unit `d`.
 */
function overlapBounds(
	project: Project,
	rates: ReadonlyMap<string, EdgeRates>
): Bounds[] {
	const tracks = new Map<number, Segment[]>();
	for (const segment of project.segments) {
		const onTrack = tracks.get(segment.track) ?? [];
		onTrack.push(segment);
		tracks.set(segment.track, onTrack);
	}
	const bounds: Bounds[] = [];
	for (const segments of tracks.values()) {
		const ordered = [...segments].sort(
			(a, b) => a.start - b.start || clipEnd(a) - clipEnd(b)
		);
		for (let index = 1; index < ordered.length; index += 1) {
			const previous = ordered[index - 1];
			const next = ordered[index];
			if (!(previous && next)) {
				continue;
			}
			const rate =
				(rates.get(next.id)?.head ?? 0) - (rates.get(previous.id)?.tail ?? 0);
			const gap = Math.max(0, next.start - clipEnd(previous));
			if (rate < 0) {
				bounds.push({ low: Number.NEGATIVE_INFINITY, high: gap / -rate });
			} else if (rate > 0) {
				bounds.push({ low: -gap / rate, high: Number.POSITIVE_INFINITY });
			}
		}
	}
	return bounds;
}

function planRates(plan: EditPlan): Map<string, EdgeRates> {
	return new Map([...plan].map(([id, edit]) => [id, editRates[edit]]));
}

function clampDelta(requested: number, bounds: readonly Bounds[]): number {
	let low = Number.NEGATIVE_INFINITY;
	let high = Number.POSITIVE_INFINITY;
	for (const bound of bounds) {
		low = Math.max(low, bound.low);
		high = Math.min(high, bound.high);
	}
	if (low > high + EPSILON) {
		return 0;
	}
	return Math.max(Math.min(low, 0), Math.min(Math.max(high, 0), requested));
}

/**
 * Fit a trimmed clip's fades and edge transitions (reveal and exit durations)
 * to its new length, as the pointer group trim does.
 */
function clampFades(segment: Segment): Segment {
	const duration = segmentDuration(segment);
	const fadeIn = Math.min(segment.fadeIn, duration);
	const fadeOut = Math.min(segment.fadeOut, round6(duration - fadeIn));
	return fitEdgeTransitions(
		{ ...segment, fadeIn, fadeOut: Math.max(0, fadeOut) },
		true,
		true
	);
}

/**
 * Validate a trimmed timeline after dropping reveal transitions whose
 * predecessor overlap the trim removed, instead of failing the edit.
 */
function validTrim(
	project: Project,
	assets: readonly Asset[],
	segments: readonly Segment[],
	layers: Partial<Project> = {}
): Project {
	return validateProject(
		{
			...project,
			...layers,
			segments: dropUncoveredRevealTransitions(segments),
		},
		[...assets]
	);
}

/** Apply one clip edit; source moves by `d · speed` and keyframes keep their source moment. */
function applyEdit(
	segment: Segment,
	asset: Asset,
	edit: ClipEdit,
	shift: number
): Segment {
	if (edit === "move") {
		return { ...segment, start: round6(segment.start + shift) };
	}
	const sourceShift = shift * segment.speed;
	if (edit === "end") {
		const next = {
			...segment,
			sourceOut: round6(segment.sourceOut + sourceShift),
		};
		return clampFades({
			...next,
			keyframes: retimeKeyframes(segment, 0, segmentDuration(next)),
		});
	}
	const start =
		edit === "start" ? round6(segment.start + shift) : segment.start;
	// A still has no source timeline, so its head edit lengthens or shortens the hold.
	const next = isStill(asset)
		? { ...segment, start, sourceOut: round6(segment.sourceOut - sourceShift) }
		: {
				...segment,
				start,
				sourceIn: Math.max(0, round6(segment.sourceIn + sourceShift)),
			};
	return clampFades({
		...next,
		keyframes: retimeKeyframes(segment, shift, segmentDuration(next)),
	});
}

function planBounds(
	project: Project,
	assets: readonly Asset[],
	plan: EditPlan
): Bounds[] {
	return [...plan].map(([id, edit]) => {
		const segment = clip(project, id);
		return editBounds(segment, assetFor(assets, segment), edit, project.fps);
	});
}

function applyPlan(
	project: Project,
	assets: readonly Asset[],
	plan: EditPlan,
	shift: number
): Segment[] {
	return project.segments.map((segment) => {
		const edit = plan.get(segment.id);
		return edit
			? applyEdit(segment, assetFor(assets, segment), edit, shift)
			: segment;
	});
}

function planned(project: Project, plan: EditPlan) {
	return [...plan.keys()].map((id) => clip(project, id));
}

function noChange(project: Project): TrimEditResult {
	return { project, applied: 0 };
}

function roll(
	project: Project,
	assets: readonly Asset[],
	request: Extract<TrimEditRequest, { mode: "roll" }>
): TrimEditResult {
	const outgoing = clip(project, request.outClipId);
	const incoming = clip(project, request.inClipId);
	const tolerance = 0.5 / project.fps;
	if (
		outgoing.id === incoming.id ||
		Math.abs(clipEnd(outgoing) - incoming.start) > tolerance
	) {
		throw new Error("Roll needs two clips that meet at one edit point.");
	}
	const plan: EditPlan = new Map();
	addToPlan(plan, linkedGroup(project, outgoing, request.ignoreLinks), "end");
	addToPlan(plan, linkedGroup(project, incoming, request.ignoreLinks), "start");
	ensureUnlocked(project, planned(project, plan));
	const applied = frameTowardZero(
		clampDelta(quantize(request.delta, project.fps), [
			...planBounds(project, assets, plan),
			...overlapBounds(project, planRates(plan)),
		]),
		project.fps
	);
	if (Math.abs(applied) < EPSILON) {
		return noChange(project);
	}
	return {
		project: validTrim(
			project,
			assets,
			applyPlan(project, assets, plan, applied)
		),
		applied,
	};
}

function slip(
	project: Project,
	assets: readonly Asset[],
	request: Extract<TrimEditRequest, { mode: "slip" }>
): TrimEditResult {
	const target = clip(project, request.clipId);
	if (isStill(assetFor(assets, target))) {
		throw new Error("Slip needs video or audio media with source to move.");
	}
	const members = linkedGroup(project, target, request.ignoreLinks);
	const multicamIds = new Set(
		project.multicamGroups.flatMap((group) => group.segmentIds)
	);
	if (
		members.some(
			(segment) => segment.multicamGroupId || multicamIds.has(segment.id)
		)
	) {
		throw new Error("Slip is not available for multicam clips.");
	}
	ensureUnlocked(project, members);
	// Work in timeline seconds so linked clips at other speeds stay in sync.
	const requested = quantize(request.delta / target.speed, project.fps);
	const bounds = members.flatMap((segment) => {
		const asset = assetFor(assets, segment);
		if (isStill(asset)) {
			return [];
		}
		return [
			{
				low: -segment.sourceIn / segment.speed,
				high: (asset.duration - segment.sourceOut) / segment.speed,
			},
		];
	});
	const shift = clampDelta(requested, bounds);
	if (Math.abs(shift) < EPSILON) {
		return noChange(project);
	}
	const memberIds = new Set(members.map((segment) => segment.id));
	const segments = project.segments.map((segment) => {
		if (!memberIds.has(segment.id) || isStill(assetFor(assets, segment))) {
			return segment;
		}
		const sourceShift = shift * segment.speed;
		return {
			...segment,
			sourceIn: Math.max(0, round6(segment.sourceIn + sourceShift)),
			sourceOut: round6(segment.sourceOut + sourceShift),
		};
	});
	return {
		project: validateProject({ ...project, segments }, [...assets]),
		applied: round6(shift * target.speed),
	};
}

function slide(
	project: Project,
	assets: readonly Asset[],
	request: Extract<TrimEditRequest, { mode: "slide" }>
): TrimEditResult {
	const target = clip(project, request.clipId);
	const members = linkedGroup(project, target, request.ignoreLinks);
	const memberIds = new Set(members.map((segment) => segment.id));
	const tolerance = 0.5 / project.fps;
	const plan: EditPlan = new Map();
	addToPlan(plan, members, "move");
	for (const member of members) {
		const others = project.segments.filter(
			(segment) => segment.track === member.track && !memberIds.has(segment.id)
		);
		const before = others
			.filter((segment) => clipEnd(segment) <= member.start + tolerance)
			.sort((a, b) => clipEnd(b) - clipEnd(a))[0];
		const after = others
			.filter((segment) => segment.start >= clipEnd(member) - tolerance)
			.sort((a, b) => a.start - b.start)[0];
		if (before && Math.abs(clipEnd(before) - member.start) <= tolerance) {
			addToPlan(plan, linkedGroup(project, before, request.ignoreLinks), "end");
		}
		if (after && Math.abs(after.start - clipEnd(member)) <= tolerance) {
			addToPlan(
				plan,
				linkedGroup(project, after, request.ignoreLinks),
				"start"
			);
		}
	}
	ensureUnlocked(project, planned(project, plan));
	// Neighbours that do not touch, and partners' own neighbours, bound the slide.
	const applied = frameTowardZero(
		clampDelta(quantize(request.delta, project.fps), [
			...planBounds(project, assets, plan),
			...overlapBounds(project, planRates(plan)),
		]),
		project.fps
	);
	if (Math.abs(applied) < EPSILON) {
		return noChange(project);
	}
	return {
		project: validTrim(
			project,
			assets,
			applyPlan(project, assets, plan, applied)
		),
		applied,
	};
}

/**
 * Clips after each trimmed member on its track, plus their linked partners.
 * `syncPivot` adds every other sync-locked track, rippling from that time.
 */
function rippleFollowers(
	project: Project,
	members: readonly Segment[],
	skipLinks: boolean,
	syncPivot?: number
): Segment[] {
	const memberIds = new Set(members.map((segment) => segment.id));
	const pivots = new Map<number, number>();
	for (const member of members) {
		const end = clipEnd(member);
		pivots.set(member.track, Math.min(pivots.get(member.track) ?? end, end));
	}
	if (syncPivot !== undefined) {
		for (const track of affectedTracks(project, pivots.keys())) {
			if (!pivots.has(track)) {
				pivots.set(track, syncPivot);
			}
		}
	}
	const followers = new Map<string, Segment>();
	for (const segment of project.segments) {
		const pivot = pivots.get(segment.track);
		if (
			pivot === undefined ||
			memberIds.has(segment.id) ||
			segment.start < pivot - EPSILON
		) {
			continue;
		}
		for (const partner of linkedGroup(project, segment, skipLinks)) {
			if (!memberIds.has(partner.id)) {
				followers.set(partner.id, partner);
			}
		}
	}
	return [...followers.values()];
}

function ripple(
	project: Project,
	assets: readonly Asset[],
	request: Extract<TrimEditRequest, { mode: "ripple" }>
): TrimEditResult {
	const target = clip(project, request.clipId);
	const members = linkedGroup(project, target, request.ignoreLinks);
	const plan: EditPlan = new Map();
	addToPlan(plan, members, request.edge === "end" ? "end" : "head");
	const pivot = clipEnd(target);
	const followers = rippleFollowers(
		project,
		members,
		request.ignoreLinks,
		request.syncLock ? pivot : undefined
	);
	ensureUnlocked(project, [...members, ...followers]);
	const latestEnd = Math.max(
		latestTimedEnd(project, pivot),
		...followers.map(clipEnd)
	);
	// The duration change (`end`: +d, `head`: -d) must keep shifted content in range.
	const room = PROJECT_LIMIT - latestEnd;
	const rippleBound =
		request.edge === "end"
			? { low: Number.NEGATIVE_INFINITY, high: room }
			: { low: -room, high: Number.POSITIVE_INFINITY };
	// Followers move by `d` (end edge) or `-d` (head trim); partners on
	// unrippled tracks must neither pass the timeline start nor stationary clips.
	const direction = request.edge === "end" ? 1 : -1;
	const rates = planRates(plan);
	const followerBounds = followers.map((segment) => {
		rates.set(segment.id, { head: direction, tail: direction });
		return direction > 0
			? { low: -segment.start, high: Number.POSITIVE_INFINITY }
			: { low: Number.NEGATIVE_INFINITY, high: segment.start };
	});
	const applied = frameTowardZero(
		clampDelta(quantize(request.delta, project.fps), [
			...planBounds(project, assets, plan),
			...followerBounds,
			...overlapBounds(project, rates),
			rippleBound,
		]),
		project.fps
	);
	if (Math.abs(applied) < EPSILON) {
		return noChange(project);
	}
	const trimmed = applyPlan(project, assets, plan, applied);
	const newTarget = trimmed.find((segment) => segment.id === target.id);
	// Shift by the trimmed clip's real end change so later clips stay butted to it.
	const shift = newTarget ? clipEnd(newTarget) - pivot : direction * applied;
	const followerIds = new Set(followers.map((segment) => segment.id));
	const segments = trimmed.map((segment) =>
		followerIds.has(segment.id)
			? { ...segment, start: Math.max(0, round6(segment.start + shift)) }
			: segment
	);
	return {
		project: validTrim(
			project,
			assets,
			segments,
			shiftTimedLayers(project, pivot, shift, { dropTrimmedMarkers: true })
		),
		applied,
	};
}

/**
 * Roll, slip, slide or ripple-trim a clip edge; linked partners follow unless `ignoreLinks`.
 * Deltas are whole frames, clamped so no clip overlaps another on its track. Keyframe
 * trims are lossy: a shortened edge drops keyframes beyond it for an interpolated
 * boundary key, so extending the edge again does not restore them.
 */
export function trimEdit(
	project: Project,
	assets: readonly Asset[],
	input: TrimEditInput
): TrimEditResult {
	const request = trimEditRequestSchema.parse(input);
	const result = trimByMode(project, assets, request);
	// Tracked region layers move with the source moments they hide.
	const followed = followTrackedLayers(project, result.project);
	return followed === result.project
		? result
		: { ...result, project: validateProject(followed, [...assets]) };
}

function trimByMode(
	project: Project,
	assets: readonly Asset[],
	request: TrimEditRequest
): TrimEditResult {
	switch (request.mode) {
		case "roll":
			return roll(project, assets, request);
		case "slip":
			return slip(project, assets, request);
		case "slide":
			return slide(project, assets, request);
		case "ripple":
			return ripple(project, assets, request);
		default:
			throw new Error("Unknown trim mode.");
	}
}
