import { z } from "zod";
import type { SourceBeats } from "./analysis.ts";
import { trackIndexSchema } from "./limits.ts";
import {
	type Asset,
	dissolveOrphanedLinkGroups,
	type Project,
	retimeKeyframes,
	type Segment,
	segmentDuration,
	trackSettingFor,
	validateProject,
} from "./project.ts";

const PROJECT_LIMIT = 7200;
const MINIMUM_CLIP_SECONDS = 0.04;
/** Minimum clip length plus a guard so float rounding never dips below the floor. */
const MINIMUM_KEPT = MINIMUM_CLIP_SECONDS + 1e-6;
const EPSILON = 1e-6;

const timelineTime = z.number().finite().min(0).max(PROJECT_LIMIT);

export const beatCutsRequestSchema = z
	.object({
		/** Beat times in timeline seconds. */
		beats: z.array(timelineTime).min(2).max(2000),
		track: trackIndexSchema,
		/** Use every beat, every second beat, or one beat per bar of four. */
		every: z.union([z.literal(1), z.literal(2), z.literal(4)]).default(1),
		/**
		 * Which beats form the cut grid: every beat, bar starts (`downbeats`,
		 * else every fourth beat), or every `every`-th beat. Omitted means
		 * `every-n`, the original behaviour.
		 */
		snap: z.enum(["beat", "downbeat", "every-n"]).optional(),
		/** Bar starts in timeline seconds, from beat detection. */
		downbeats: z.array(timelineTime).max(2000).optional(),
		/** Furthest an edit point may move to reach a beat (snap-edits). */
		tolerance: z.number().finite().min(0).max(2).default(0.25),
		mode: z.enum(["snap-edits", "fill-sequence"]),
		/** Edits touching these clips (snap-edits) or the clips to lay out, in order (fill-sequence). */
		clipIds: z.array(z.uuid()).min(1).max(64).optional(),
		/** When fill-sequence has more beat slots than clips: stop, or reuse clips from the top. */
		whenClipsRunOut: z.enum(["stop", "cycle"]).default("stop"),
		ignoreLinks: z.boolean().default(false),
		revision: z.number().int().nonnegative(),
	})
	.strict();

export type BeatCutsRequest = z.infer<typeof beatCutsRequestSchema>;
export type BeatCutsInput = z.input<typeof beatCutsRequestSchema>;

/** Measured loudness of an asset (`MediaAnalysis` waveform bins across `duration`). */
export interface AssetEnergy {
	duration: number;
	waveform: readonly number[];
}

export interface BeatCutsOptions {
	/** Loudness for a clip's media; fill-sequence then picks each clip's loudest window. */
	energyFor?: (assetId: string) => AssetEnergy | undefined;
}

const round6 = (value: number) => Number(value.toFixed(6));
/** Round up to the microsecond so a rounded source range never plays short. */
const ceil6 = (value: number) => Math.ceil(value * 1e6 - EPSILON) / 1e6;
const quantize = (value: number, fps: number) => Math.round(value * fps) / fps;
const clipEnd = (segment: Segment) => segment.start + segmentDuration(segment);

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
	segments: readonly Segment[],
	segment: Segment,
	skipLinks: boolean
): Segment[] {
	if (skipLinks || !segment.linkGroupId) {
		return [segment];
	}
	return segments.filter(
		(candidate) => candidate.linkGroupId === segment.linkGroupId
	);
}

function ensureUnlocked(project: Project, segments: Iterable<Segment>) {
	for (const segment of segments) {
		if (trackSettingFor(project, segment.track).locked) {
			throw new Error(
				"Unlock every affected track before cutting to the beat."
			);
		}
	}
}

/** Map source-time beats of a music clip onto the timeline, keeping those it plays. */
export function timelineBeats(
	segment: Segment,
	sourceBeats: readonly number[]
): number[] {
	return sourceBeats
		.filter(
			(beat) =>
				beat >= segment.sourceIn - EPSILON &&
				beat <= segment.sourceOut + EPSILON
		)
		.map((beat) =>
			round6(segment.start + (beat - segment.sourceIn) / segment.speed)
		);
}

/**
 * The beat-cuts `beats`/`downbeats` for a music clip, in timeline seconds.
 * Pass `sourceBeats(analysis, { from: segment.sourceIn, to: segment.sourceOut })`
 * so a detection that did not analyze the clip's span falls back to the
 * estimate. Downbeats are included only for detected beats.
 */
export function musicClipBeats(
	segment: Segment,
	source: SourceBeats
): { beats: number[]; downbeats?: number[] } {
	const beats = timelineBeats(segment, source.times).slice(0, 2000);
	if (!(source.detected && source.downbeats)) {
		return { beats };
	}
	return {
		beats,
		downbeats: timelineBeats(segment, source.downbeats).slice(0, 2000),
	};
}

/**
 * Sorted, de-duplicated beats, keeping every `every`-th one from the first.
 * Beats closer than the shortest clip length (plus a rounding guard) merge.
 */
export function beatGrid(beats: readonly number[], every: number): number[] {
	const sorted = [...beats]
		.filter((beat) => Number.isFinite(beat))
		.sort((a, b) => a - b);
	const unique: number[] = [];
	for (const beat of sorted) {
		const previous = unique.at(-1);
		if (previous === undefined || beat - previous >= MINIMUM_KEPT) {
			unique.push(beat);
		}
	}
	return unique.filter((_, index) => index % every === 0);
}

/**
 * The cut grid for a request: every beat, the bar starts (detected downbeats
 * when given, else every fourth beat), or every `every`-th beat.
 */
export function cutGrid(
	request: Pick<BeatCutsRequest, "beats" | "downbeats" | "every" | "snap">
): number[] {
	const snap = request.snap ?? "every-n";
	if (snap === "beat") {
		return beatGrid(request.beats, 1);
	}
	if (snap === "downbeat") {
		const bars = beatGrid(request.downbeats ?? [], 1);
		return bars.length >= 2 ? bars : beatGrid(request.beats, 4);
	}
	return beatGrid(request.beats, request.every);
}

function nearestBeat(grid: readonly number[], time: number) {
	let best: number | undefined;
	for (const beat of grid) {
		if (best === undefined || Math.abs(beat - time) < Math.abs(best - time)) {
			best = beat;
		}
	}
	return best;
}

function clampFades(segment: Segment): Segment {
	const duration = segmentDuration(segment);
	const fadeIn = Math.min(segment.fadeIn, duration);
	const fadeOut = Math.min(segment.fadeOut, round6(duration - fadeIn));
	return { ...segment, fadeIn, fadeOut: Math.max(0, fadeOut) };
}

/** Whether moving a clip edge by `shift` timeline seconds stays inside its media. */
function edgeFits(
	segment: Segment,
	asset: Asset,
	edge: "start" | "end",
	shift: number
): boolean {
	const duration = segmentDuration(segment);
	if (edge === "end") {
		const sourceAfter = (asset.duration - segment.sourceOut) / segment.speed;
		return (
			shift >= -(duration - MINIMUM_KEPT) &&
			shift <= (isStill(asset) ? Number.POSITIVE_INFINITY : sourceAfter) &&
			clipEnd(segment) + shift <= PROJECT_LIMIT
		);
	}
	const before = isStill(asset)
		? segment.start
		: Math.min(segment.sourceIn / segment.speed, segment.start);
	return shift >= -before - EPSILON && shift <= duration - MINIMUM_KEPT;
}

/** Roll one clip edge; source moves by `shift · speed`, keyframes keep their source moment. */
function rollEdge(
	segment: Segment,
	asset: Asset,
	edge: "start" | "end",
	shift: number
): Segment {
	const sourceShift = shift * segment.speed;
	if (edge === "end") {
		const next = {
			...segment,
			sourceOut: round6(segment.sourceOut + sourceShift),
		};
		return clampFades({
			...next,
			keyframes: retimeKeyframes(segment, 0, segmentDuration(next)),
		});
	}
	const start = Math.max(0, round6(segment.start + shift));
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

/**
 * Roll each edit point on the track to the nearest beat within tolerance. An
 * edit whose clips lack the handles to reach the beat is left where it is.
 */
function snapEdits(
	project: Project,
	assets: readonly Asset[],
	request: BeatCutsRequest,
	grid: readonly number[]
): Project {
	const selected = request.clipIds ? new Set(request.clipIds) : undefined;
	const byId = new Map(
		project.segments.map((segment) => [segment.id, segment])
	);
	const tolerance = 0.5 / project.fps;
	const order = project.segments
		.filter((segment) => segment.track === request.track)
		.sort((a, b) => a.start - b.start)
		.map((segment) => segment.id);
	let changed = false;
	for (let index = 0; index < order.length - 1; index++) {
		const outgoing = byId.get(order[index] ?? "");
		const incoming = byId.get(order[index + 1] ?? "");
		if (
			!(outgoing && incoming) ||
			Math.abs(clipEnd(outgoing) - incoming.start) > tolerance ||
			(selected && !selected.has(outgoing.id) && !selected.has(incoming.id))
		) {
			continue;
		}
		const cut = incoming.start;
		const beat = nearestBeat(grid, cut);
		if (
			beat === undefined ||
			Math.abs(beat - cut) > request.tolerance + EPSILON
		) {
			continue;
		}
		const shift = round6(quantize(beat, project.fps) - cut);
		if (Math.abs(shift) < EPSILON) {
			continue;
		}
		const current = [...byId.values()];
		const plan = new Map<string, "start" | "end">();
		let conflict = false;
		for (const [edge, members] of [
			["end", linkedGroup(current, outgoing, request.ignoreLinks)],
			["start", linkedGroup(current, incoming, request.ignoreLinks)],
		] as const) {
			for (const member of members) {
				conflict ||= (plan.get(member.id) ?? edge) !== edge;
				plan.set(member.id, edge);
			}
		}
		if (conflict) {
			continue;
		}
		const members = [...plan.keys()].flatMap((id) => byId.get(id) ?? []);
		ensureUnlocked(project, members);
		const fits = members.every((member) =>
			edgeFits(
				member,
				assetFor(assets, member),
				plan.get(member.id) ?? "end",
				shift
			)
		);
		if (!fits) {
			continue;
		}
		for (const member of members) {
			byId.set(
				member.id,
				rollEdge(
					member,
					assetFor(assets, member),
					plan.get(member.id) ?? "end",
					shift
				)
			);
		}
		changed = true;
	}
	if (!changed) {
		return project;
	}
	return validateProject(
		{
			...project,
			segments: project.segments.map(
				(segment) => byId.get(segment.id) ?? segment
			),
		},
		[...assets]
	);
}

/** Mean loudness across `[from, to]` source seconds of a waveform. */
function windowEnergy(energy: AssetEnergy, from: number, to: number): number {
	const bins = energy.waveform.length;
	const width = energy.duration / bins;
	let total = 0;
	for (let index = 0; index < bins; index++) {
		const binStart = index * width;
		const overlap = Math.min(to, binStart + width) - Math.max(from, binStart);
		if (overlap > 0) {
			total += (energy.waveform[index] ?? 0) * overlap;
		}
	}
	return total / Math.max(EPSILON, to - from);
}

/** Source start of a `length`-second window inside `[low, high]`: loudest, else centred. */
function chooseWindow(
	low: number,
	high: number,
	length: number,
	energy: AssetEnergy | undefined
): number {
	const centred = (low + high - length) / 2;
	if (
		!energy ||
		energy.waveform.length < 2 ||
		!(energy.duration > 0) ||
		high - low - length < EPSILON
	) {
		return centred;
	}
	const step = Math.max(
		energy.duration / energy.waveform.length,
		(high - low - length) / 600
	);
	let best = { distance: 0, score: Number.NEGATIVE_INFINITY, start: centred };
	for (let start = low; start <= high - length + EPSILON; start += step) {
		const from = Math.min(start, high - length);
		const score = windowEnergy(energy, from, from + length);
		const distance = Math.abs(from - centred);
		if (
			score > best.score + EPSILON ||
			(Math.abs(score - best.score) <= EPSILON && distance < best.distance)
		) {
			best = { distance, score, start: from };
		}
	}
	return best.start;
}

/** The source window a clip plays for one beat slot of `length` timeline seconds. */
function slotSource(
	segment: Segment,
	asset: Asset,
	length: number,
	energy: AssetEnergy | undefined
): number {
	const needed = length * segment.speed;
	if (isStill(asset) || needed <= segment.sourceOut - segment.sourceIn) {
		return isStill(asset)
			? segment.sourceIn
			: chooseWindow(segment.sourceIn, segment.sourceOut, needed, energy);
	}
	if (asset.duration + EPSILON < needed) {
		throw new Error("A selected clip is shorter than one beat interval.");
	}
	const centre = (segment.sourceIn + segment.sourceOut) / 2;
	return Math.max(0, Math.min(asset.duration - needed, centre - needed / 2));
}

/** Place `segment` at `start` playing `length` seconds from source time `sourceIn`. */
function placed(
	segment: Segment,
	start: number,
	sourceIn: number,
	length: number,
	reuse: boolean,
	linkGroupId: string | undefined
): Segment {
	const headShift = (sourceIn - segment.sourceIn) / segment.speed;
	const keyframes = retimeKeyframes(segment, headShift, length).filter(
		(frame) => frame.time <= length
	);
	return clampFades({
		...segment,
		id: reuse ? crypto.randomUUID() : segment.id,
		keyframes: reuse
			? keyframes.map((frame) => ({ ...frame, id: crypto.randomUUID() }))
			: keyframes,
		linkGroupId,
		sourceIn: round6(sourceIn),
		sourceOut: ceil6(round6(sourceIn) + length * segment.speed),
		start: round6(start),
	});
}

/** Source start for one member so it plays the same moment as the primary's window. */
function memberSource(
	member: Segment,
	asset: Asset,
	primary: Segment,
	primaryIn: number,
	anchor: number
): number {
	if (member.id === primary.id) {
		return primaryIn;
	}
	if (isStill(asset)) {
		return member.sourceIn;
	}
	return member.sourceIn + (anchor - member.start) * member.speed;
}

/** A selected clip and the linked partners that travel with it. */
interface FillUnit {
	members: Segment[];
	primary: Segment;
}

function fillUnits(project: Project, request: BeatCutsRequest): FillUnit[] {
	const ids =
		request.clipIds ??
		project.segments
			.filter((segment) => segment.track === request.track)
			.sort((a, b) => a.start - b.start)
			.map((segment) => segment.id);
	if (new Set(ids).size !== ids.length) {
		throw new Error("Choose each clip once.");
	}
	const claimed = new Set<string>();
	const units: FillUnit[] = [];
	for (const id of ids) {
		const primary = project.segments.find((segment) => segment.id === id);
		if (!primary) {
			throw new Error("Clip not found on this timeline.");
		}
		const members = linkedGroup(project.segments, primary, request.ignoreLinks);
		if (members.some((member) => claimed.has(member.id))) {
			throw new Error("Choose one clip from each linked group.");
		}
		if (members.some((member) => member.multicamGroupId)) {
			throw new Error("Multicam clips cannot be cut to the beat.");
		}
		for (const member of members) {
			claimed.add(member.id);
		}
		units.push({ members, primary });
	}
	if (!units.length) {
		throw new Error("Choose clips to cut to the beat.");
	}
	return units;
}

/**
 * Lay clips back to back on the track, one per beat slot, each playing its
 * middle (or loudest) section. Linked partners stay in sync on their own
 * tracks; clips left over after the last slot follow at their own length.
 */
function fillSequence(
	project: Project,
	assets: readonly Asset[],
	request: BeatCutsRequest,
	grid: readonly number[],
	options: BeatCutsOptions
): Project {
	const units = fillUnits(project, request);
	const slots = grid.slice(1).map((end, index) => ({
		end,
		start: grid[index] ?? 0,
	}));
	const count =
		request.whenClipsRunOut === "cycle"
			? slots.length
			: Math.min(slots.length, units.length);
	const removed = new Set(
		units.flatMap((unit) => unit.members.map((member) => member.id))
	);
	ensureUnlocked(
		project,
		units.flatMap((unit) => unit.members)
	);
	if (trackSettingFor(project, request.track).locked) {
		throw new Error("Unlock every affected track before cutting to the beat.");
	}
	const laid: Segment[] = [];
	const used = new Set<string>();
	for (let index = 0; index < count; index++) {
		const slot = slots[index];
		const unit = units[index % units.length];
		if (!(slot && unit)) {
			break;
		}
		const length = slot.end - slot.start;
		const primaryAsset = assetFor(assets, unit.primary);
		const sourceIn = slotSource(
			unit.primary,
			primaryAsset,
			length,
			options.energyFor?.(unit.primary.assetId)
		);
		const reuse = used.has(unit.primary.id);
		used.add(unit.primary.id);
		// A clip moved without its partners (ignore links) leaves its link group.
		let groupId: string | undefined;
		if (unit.members.length > 1) {
			groupId = reuse ? crypto.randomUUID() : unit.primary.linkGroupId;
		}
		// The original timeline moment the chosen window starts at keeps partners in sync.
		const anchor =
			unit.primary.start +
			(sourceIn - unit.primary.sourceIn) / unit.primary.speed;
		for (const member of unit.members) {
			const asset = assetFor(assets, member);
			const memberIn = memberSource(
				member,
				asset,
				unit.primary,
				sourceIn,
				anchor
			);
			if (
				!isStill(asset) &&
				(memberIn < -EPSILON ||
					memberIn + length * member.speed > asset.duration + EPSILON)
			) {
				throw new Error(
					"Linked media does not cover the beat slot. Unlink the clips or ignore links."
				);
			}
			laid.push(
				placed(
					{
						...member,
						track: member.id === unit.primary.id ? request.track : member.track,
					},
					slot.start,
					Math.max(0, memberIn),
					length,
					reuse,
					groupId
				)
			);
		}
	}
	const fillEnd = slots[count - 1]?.end ?? grid[0] ?? 0;
	let cursor = fillEnd;
	for (const unit of units.slice(count)) {
		const shift = cursor - unit.primary.start;
		for (const member of unit.members) {
			laid.push({
				...member,
				linkGroupId: unit.members.length > 1 ? member.linkGroupId : undefined,
				start: round6(member.start + shift),
				track: member.id === unit.primary.id ? request.track : member.track,
			});
		}
		cursor += segmentDuration(unit.primary);
	}
	const kept = project.segments.filter((segment) => !removed.has(segment.id));
	const span = { end: cursor, start: grid[0] ?? 0 };
	const tracks = new Set(laid.map((segment) => segment.track));
	const blocked = kept.find(
		(segment) =>
			tracks.has(segment.track) &&
			segment.start < span.end - EPSILON &&
			clipEnd(segment) > span.start + EPSILON
	);
	if (blocked) {
		throw new Error(
			`Clear track ${blocked.track + 1} where the beat sequence goes, or choose another track.`
		);
	}
	return validateProject(
		{
			...project,
			segments: dissolveOrphanedLinkGroups(
				[...kept, ...laid].sort(
					(a, b) => a.track - b.track || a.start - b.start
				)
			),
		},
		[...assets]
	);
}

/**
 * Cut a track to the beat. `snap-edits` rolls existing edit points onto the
 * nearest beat within tolerance; `fill-sequence` lays clips one per beat slot.
 */
export function snapCutsToBeats(
	project: Project,
	assets: readonly Asset[],
	input: BeatCutsInput,
	options: BeatCutsOptions = {}
): Project {
	const request = beatCutsRequestSchema.parse(input);
	if (trackSettingFor(project, request.track).locked) {
		throw new Error("Unlock the track before cutting to the beat.");
	}
	const grid = cutGrid(request);
	if (grid.length < 2) {
		throw new Error("Cutting to the beat needs at least two beats.");
	}
	return request.mode === "snap-edits"
		? snapEdits(project, assets, request, grid)
		: fillSequence(project, assets, request, grid, options);
}
