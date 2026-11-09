/**
 * AutoCut and vertical shorts (W4-G5).
 *
 * AutoCut ranks highlight moments across several sources (the transcript and
 * loudness highlight scorer plus shot motion and loudness), splits a music
 * bed into beat slots (detected bar starts when available), fills each slot
 * with the next best moment, alternates reveal transitions by style, and can
 * add captions from the heard sources' transcripts. Shorts cut each project
 * highlight into its own vertical project: the window is kept, full-frame
 * clips are reframed to the new aspect, captions are rechunked one word at a
 * time, and a publish preset is stored for the export.
 *
 * Everything here is pure and deterministic (ids come from an injectable
 * factory); the sidecar route module gathers analysis, transcripts and shot
 * stats and saves the result.
 */
import { z } from "zod";
import type { SourceBeats } from "./analysis.ts";
import { beatGrid } from "./beat-cuts.ts";
import { type ChunkWord, rechunk } from "./caption-chunking.ts";
import { captionPreset } from "./caption-style.ts";
import { highlightToRanges, scoreHighlights } from "./highlights.ts";
import { MAX_TRACKS } from "./limits.ts";
import {
	type Asset,
	activeCaptions,
	type Caption,
	type Crop,
	newSegment,
	type Project,
	type ProjectFps,
	projectDuration,
	projectFpsSchema,
	type Segment,
	segmentDuration,
	validateProject,
	withActiveCaptions,
} from "./project.ts";
import {
	type PublishPresetId,
	publishPresetFor,
	publishPresetIdSchema,
} from "./publish-presets.ts";
import { removeWordRanges } from "./remove-words.ts";
import type { CaptionChunking } from "./schema/caption-style.ts";
import { bounded, idSchema } from "./schema/primitives.ts";
import type { TransitionIn } from "./schema/transition.ts";
import { clipHeard } from "./sync-lock.ts";
import { applyRevealTransition } from "./transitions.ts";

/** Most sources one AutoCut ranks. */
export const MAX_AUTO_EDIT_SOURCES = 20;
/** Most beat slots one AutoCut fills (the slot length grows past it). */
export const MAX_AUTO_EDIT_SLOTS = 300;
/** Shortest and longest AutoCut, in seconds. */
export const MIN_AUTO_EDIT_SECONDS = 5;
export const MAX_AUTO_EDIT_SECONDS = 600;
/** Slowest speed used to stretch a source that is shorter than its slot. */
export const MIN_FILL_SPEED = 0.25;
/** Moments ranked per source. */
const MOMENTS_PER_SOURCE = 10;
/** Mean shot motion that counts as full motion (twice the `motion` label threshold). */
const FULL_MOTION = 0.08;
/** Extra score weights on top of the highlight score. */
const MOTION_WEIGHT = 0.2;
const LOUDNESS_WEIGHT = 0.1;
/** Score given to a still image so ranked video moments come first. */
const STILL_SCORE = 0.2;
const EPSILON = 1e-6;
/** Shortest timeline range the ripple edit accepts. */
const MIN_RANGE = 0.04;

export const autoEditAspectSchema = z.enum(["16:9", "9:16", "1:1", "4:5"]);
export type AutoEditAspect = z.infer<typeof autoEditAspectSchema>;

export const autoEditStyleSchema = z.enum([
	"energetic",
	"smooth",
	"cinematic",
	"minimal",
]);
export type AutoEditStyle = z.infer<typeof autoEditStyleSchema>;

const keywordsSchema = z.array(z.string().trim().min(1).max(40)).max(20);

export const autoEditRequestSchema = z
	.object({
		assetIds: z
			.array(idSchema)
			.min(1)
			.max(MAX_AUTO_EDIT_SOURCES)
			.refine(
				(ids) => new Set(ids).size === ids.length,
				"List each source once."
			),
		musicAssetId: idSchema.optional(),
		duration: bounded(MIN_AUTO_EDIT_SECONDS, MAX_AUTO_EDIT_SECONDS),
		style: autoEditStyleSchema.default("energetic"),
		aspect: autoEditAspectSchema.default("16:9"),
		captions: z.boolean().default(false),
		keywords: keywordsSchema.optional(),
		title: z.string().trim().min(1).max(200).optional(),
	})
	.strict();
export type AutoEditRequest = z.infer<typeof autoEditRequestSchema>;
export type AutoEditInput = z.input<typeof autoEditRequestSchema>;

export const shortsRequestSchema = z
	.object({
		count: z.number().int().min(1).max(10).default(3),
		aspect: autoEditAspectSchema.default("9:16"),
		captions: z.boolean().default(true),
		minSeconds: bounded(1, 600).default(15),
		maxSeconds: bounded(1, 600).default(60),
		keywords: keywordsSchema.optional(),
		/** Publish preset stored on each short; default follows the aspect. */
		publishPreset: publishPresetIdSchema.optional(),
		/** Queue an export of every short with its publish preset. */
		export: z.boolean().default(false),
		revision: z.number().int().nonnegative(),
	})
	.strict()
	.refine((input) => input.maxSeconds >= input.minSeconds, {
		message: "The longest short must be at least the shortest.",
	});
export type ShortsRequest = z.infer<typeof shortsRequestSchema>;
export type ShortsInput = z.input<typeof shortsRequestSchema>;

/** How a style cuts: grid, slot lengths and the transitions it alternates. */
export interface AutoCutStyleProfile {
	/** Slot length when there is no music or no beats. */
	fallbackSlot: number;
	/** Beat grid used for cut points. */
	grid: "beat" | "bar" | "two-bars";
	/** Slots longer than this are split evenly. */
	maxSlot: number;
	/** Slots shorter than this merge with the next one. */
	minSlot: number;
	/** Every `transitionEvery`-th cut gets a transition (0 = none). */
	transitionEvery: number;
	/** Transitions cycled through on the cuts that get one. */
	transitions: readonly TransitionIn[];
}

const reveal = (
	type: TransitionIn["type"],
	duration: number,
	softness = 0.1
): TransitionIn => ({ duration, softness, type });

export const AUTO_CUT_STYLES: Readonly<
	Record<AutoEditStyle, AutoCutStyleProfile>
> = {
	energetic: {
		fallbackSlot: 1.5,
		grid: "beat",
		maxSlot: 4,
		minSlot: 0.8,
		transitions: [
			reveal("zoom", 0.25),
			reveal("push-left", 0.3),
			reveal("push-right", 0.3),
		],
		transitionEvery: 4,
	},
	smooth: {
		fallbackSlot: 3,
		grid: "bar",
		maxSlot: 6,
		minSlot: 2,
		transitions: [reveal("dissolve", 0.5), reveal("blur", 0.5)],
		transitionEvery: 1,
	},
	cinematic: {
		fallbackSlot: 4,
		grid: "two-bars",
		maxSlot: 8,
		minSlot: 3,
		transitions: [reveal("dissolve", 0.8), reveal("fade-black", 0.8)],
		transitionEvery: 1,
	},
	minimal: {
		fallbackSlot: 2.5,
		grid: "bar",
		maxSlot: 5,
		minSlot: 1.5,
		transitions: [],
		transitionEvery: 0,
	},
};

const round3 = (value: number) => Math.round(value * 1000) / 1000;

/** Canvas for an aspect at a 1080-pixel short edge. */
export function canvasForAspect(aspect: AutoEditAspect): {
	height: number;
	width: number;
} {
	switch (aspect) {
		case "9:16":
			return { height: 1920, width: 1080 };
		case "1:1":
			return { height: 1080, width: 1080 };
		case "4:5":
			return { height: 1350, width: 1080 };
		default:
			return { height: 1080, width: 1920 };
	}
}

/** The publish preset whose output frame matches the aspect, if one does. */
export function defaultPublishPreset(
	aspect: AutoEditAspect
): PublishPresetId | undefined {
	if (aspect === "9:16") {
		return "youtube-shorts";
	}
	if (aspect === "16:9") {
		return "youtube-1080p";
	}
	return undefined;
}

export interface AutoCutSlot {
	end: number;
	start: number;
}

/** Cut points from the analysed music for a style's grid. */
function gridTimes(
	beats: SourceBeats | undefined,
	profile: AutoCutStyleProfile
): number[] {
	if (!beats || beats.times.length < 2) {
		return [];
	}
	if (profile.grid === "beat") {
		return beatGrid(beats.times, 1);
	}
	const bars =
		beats.detected && (beats.downbeats?.length ?? 0) >= 2
			? beatGrid(beats.downbeats ?? [], 1)
			: beatGrid(beats.times, 4);
	return profile.grid === "two-bars"
		? bars.filter((_, index) => index % 2 === 0)
		: bars;
}

/**
 * Split `[0, duration]` into slots that start on the music's beats (bar
 * starts for the calmer styles). Slots shorter than the style minimum merge
 * forward, longer ones split evenly, and without beats a fixed grid is used.
 * At most `MAX_AUTO_EDIT_SLOTS` slots are returned.
 */
export function beatSlots(
	beats: SourceBeats | undefined,
	duration: number,
	style: AutoEditStyle
): AutoCutSlot[] {
	if (!(Number.isFinite(duration) && duration > 0)) {
		return [];
	}
	const profile = AUTO_CUT_STYLES[style];
	const minSlot = Math.max(profile.minSlot, duration / MAX_AUTO_EDIT_SLOTS);
	const maxSlot = Math.max(profile.maxSlot, minSlot * 2);
	let cuts = gridTimes(beats, profile).filter(
		(time) => time > MIN_RANGE && time < duration - MIN_RANGE
	);
	if (cuts.length === 0) {
		const step = Math.max(minSlot, profile.fallbackSlot);
		cuts = [];
		for (let time = step; time < duration - MIN_RANGE; time += step) {
			cuts.push(time);
		}
	}
	const slots: AutoCutSlot[] = [];
	let start = 0;
	for (const cut of [...cuts, duration]) {
		if (cut - start >= minSlot - EPSILON) {
			slots.push({ end: cut, start });
			start = cut;
		}
	}
	const last = slots.at(-1);
	if (start < duration - EPSILON) {
		if (last) {
			last.end = duration;
		} else {
			slots.push({ end: duration, start: 0 });
		}
	}
	const split = slots.flatMap((slot) => {
		const length = slot.end - slot.start;
		const parts = Math.max(1, Math.ceil(length / maxSlot - EPSILON));
		return Array.from({ length: parts }, (_, index) => ({
			end: slot.start + (length * (index + 1)) / parts,
			start: slot.start + (length * index) / parts,
		}));
	});
	return split
		.slice(0, MAX_AUTO_EDIT_SLOTS)
		.map((slot, index, all) => ({
			end: index === all.length - 1 ? round3(duration) : round3(slot.end),
			start: round3(slot.start),
		}))
		.filter((slot) => slot.end - slot.start >= MIN_RANGE);
}

interface TimedText {
	end: number;
	start: number;
	text: string;
}

/** Everything AutoCut knows about one source, in source seconds. */
export interface AutoCutSource {
	asset: Asset;
	cues?: readonly TimedText[];
	sceneCuts?: readonly number[];
	/** Shot stats from the visual index (`motion` is a 0..1 frame difference). */
	shots?: readonly { end: number; motion: number; start: number }[];
	waveform?: { bins: readonly number[]; duration: number };
	words?: readonly TimedText[];
}

export interface AutoCutMoment {
	assetId: string;
	end: number;
	reasons: string[];
	score: number;
	start: number;
	/** A still image: any length can be cut from it. */
	still: boolean;
}

/** Mean shot motion over `[start, end)`, weighted by overlap, scaled to 0..1. */
export function shotMotion(
	shots: AutoCutSource["shots"],
	start: number,
	end: number
): number {
	let weighted = 0;
	let covered = 0;
	for (const shot of shots ?? []) {
		const overlap = Math.min(end, shot.end) - Math.max(start, shot.start);
		if (overlap > 0 && Number.isFinite(shot.motion)) {
			weighted += overlap * shot.motion;
			covered += overlap;
		}
	}
	return covered > 0 ? Math.min(1, weighted / covered / FULL_MOTION) : 0;
}

/** Mean loudness over `[start, end)` relative to the source's loudest bin. */
export function windowLoudness(
	waveform: AutoCutSource["waveform"],
	start: number,
	end: number
): number {
	if (!(waveform && waveform.bins.length > 0 && waveform.duration > 0)) {
		return 0;
	}
	const { bins, duration } = waveform;
	const highest = Math.max(...bins.map((bin) => (bin > 0 ? bin : 0)));
	if (!(highest > 0)) {
		return 0;
	}
	const from = Math.max(0, Math.floor((start / duration) * bins.length));
	const to = Math.min(
		bins.length,
		Math.max(from + 1, Math.ceil((end / duration) * bins.length))
	);
	let sum = 0;
	for (let index = from; index < to; index += 1) {
		sum += Math.max(0, bins[index] ?? 0);
	}
	return Math.min(1, sum / Math.max(1, to - from) / highest);
}

/** Evenly spaced windows for a source with nothing to score. */
function coverageWindows(
	duration: number,
	length: number,
	count: number
): { end: number; start: number }[] {
	const size = Math.min(length, duration);
	const fits = Math.max(1, Math.min(count, Math.floor(duration / size)));
	const spare = duration - size * fits;
	const gap = fits > 1 ? spare / (fits - 1) : 0;
	return Array.from({ length: fits }, (_, index) => {
		const start = index * (size + gap);
		return { end: round3(start + size), start: round3(start) };
	});
}

/**
 * Rank a source's best moments: the highlight scorer (transcript sentences,
 * keywords, loudness peaks, scene alignment) plus shot motion and loudness.
 * Sources with no analysis fall back to evenly spaced windows; stills are a
 * single moment of any length.
 */
export function rankMoments(
	source: AutoCutSource,
	options: {
		keywords?: readonly string[];
		maxLength: number;
		minLength: number;
	}
): AutoCutMoment[] {
	const { asset } = source;
	if (asset.kind === "image") {
		return [
			{
				assetId: asset.id,
				end: Number.POSITIVE_INFINITY,
				reasons: ["Still image"],
				score: STILL_SCORE,
				start: 0,
				still: true,
			},
		];
	}
	if (!(asset.duration > MIN_RANGE)) {
		return [];
	}
	const min = Math.min(
		600,
		Math.max(1, Math.min(options.minLength, asset.duration))
	);
	const max = Math.min(600, Math.max(min, options.maxLength));
	let windows: {
		end: number;
		reasons: string[];
		score: number;
		start: number;
	}[] = scoreHighlights({
		count: MOMENTS_PER_SOURCE,
		cues: source.cues ?? [],
		...(options.keywords?.length ? { keywords: [...options.keywords] } : {}),
		sceneCuts: source.sceneCuts ?? [],
		target: { max, min },
		...(source.waveform ? { waveform: source.waveform } : {}),
		words: source.words ?? [],
	}).filter(
		(candidate) =>
			candidate.end <= asset.duration + 0.05 && candidate.end > candidate.start
	);
	if (windows.length === 0) {
		windows = coverageWindows(asset.duration, max, MOMENTS_PER_SOURCE).map(
			(window) => ({ ...window, reasons: ["Even coverage"], score: 0 })
		);
	}
	return windows
		.map((window) => {
			const end = Math.min(asset.duration, window.end);
			const motion = shotMotion(source.shots, window.start, end);
			const loudness = windowLoudness(source.waveform, window.start, end);
			const reasons = [...window.reasons];
			if (motion >= 0.5) {
				reasons.push("Motion");
			}
			if (loudness >= 0.6) {
				reasons.push("Loud");
			}
			return {
				assetId: asset.id,
				end,
				reasons,
				score: round3(
					window.score + MOTION_WEIGHT * motion + LOUDNESS_WEIGHT * loudness
				),
				start: window.start,
				still: false,
			};
		})
		.toSorted((a, b) => b.score - a.score || a.start - b.start);
}

export interface AutoCutPlacement {
	assetId: string;
	/** Timeline length (the slot length). */
	duration: number;
	reasons: string[];
	score: number;
	slotIndex: number;
	sourceIn: number;
	sourceOut: number;
	speed: number;
	/** Timeline start (the slot start). */
	start: number;
}

interface QueuedMoment {
	cursor: number;
	moment: AutoCutMoment;
}

/** Round-robin the per-source rankings, strongest source first. */
function interleave(ranked: readonly AutoCutMoment[][]): QueuedMoment[] {
	const order = ranked
		.flatMap((moments, index) =>
			moments[0] ? [{ best: moments[0].score, index }] : []
		)
		.toSorted((a, b) => b.best - a.best || a.index - b.index);
	const queue: QueuedMoment[] = [];
	const rounds = Math.max(0, ...ranked.map((moments) => moments.length));
	for (let round = 0; round < rounds; round += 1) {
		for (const { index } of order) {
			const moment = ranked[index]?.[round];
			if (moment) {
				queue.push({ cursor: moment.start, moment });
			}
		}
	}
	return queue;
}

function placementFrom(
	entry: QueuedMoment,
	slot: AutoCutSlot,
	slotIndex: number,
	sourceIn: number,
	sourceOut: number,
	speed: number
): AutoCutPlacement {
	return {
		assetId: entry.moment.assetId,
		duration: round3(slot.end - slot.start),
		reasons: entry.moment.reasons,
		score: entry.moment.score,
		slotIndex,
		sourceIn: round3(sourceIn),
		sourceOut: round3(sourceOut),
		speed,
		start: slot.start,
	};
}

/** Take the next fitting moment for one slot, advancing the queue. */
function takeMoment(
	queue: QueuedMoment[],
	state: { pointer: number },
	slot: AutoCutSlot,
	slotIndex: number,
	durations: ReadonlyMap<string, number>
): AutoCutPlacement | undefined {
	const length = slot.end - slot.start;
	for (let tries = 0; tries < queue.length; tries += 1) {
		const entry = queue[state.pointer];
		state.pointer = (state.pointer + 1) % queue.length;
		if (!entry) {
			continue;
		}
		if (entry.moment.still) {
			return placementFrom(entry, slot, slotIndex, 0, length, 1);
		}
		const available = entry.moment.end - entry.cursor;
		const mediaLeft = (durations.get(entry.moment.assetId) ?? 0) - entry.cursor;
		// Run past the moment's end only when at least half the slot is inside it.
		if (
			available >= length - EPSILON ||
			(available >= length / 2 && mediaLeft >= length - EPSILON)
		) {
			const sourceIn = entry.cursor;
			entry.cursor = Math.min(entry.moment.end, sourceIn + length);
			return placementFrom(
				entry,
				slot,
				slotIndex,
				sourceIn,
				sourceIn + length,
				1
			);
		}
	}
	return undefined;
}

/**
 * Fill a slot no moment fits from the moment with the most media after its
 * start: at normal speed when the source has enough media, otherwise slowed
 * down (never below `MIN_FILL_SPEED`).
 */
function stretchMoment(
	queue: readonly QueuedMoment[],
	slot: AutoCutSlot,
	slotIndex: number,
	durations: ReadonlyMap<string, number>
): AutoCutPlacement | undefined {
	const length = slot.end - slot.start;
	const longest = queue
		.filter((entry) => !entry.moment.still)
		.map((entry) => {
			const mediaEnd = durations.get(entry.moment.assetId) ?? 0;
			return { entry, span: mediaEnd - entry.moment.start };
		})
		.toSorted((a, b) => b.span - a.span)[0];
	if (!longest || longest.span / length < MIN_FILL_SPEED) {
		return undefined;
	}
	// Slow a short source down to fill the slot; never fast-forward a long one.
	const speed = Math.min(1, Math.floor((longest.span / length) * 1000) / 1000);
	return placementFrom(
		longest.entry,
		slot,
		slotIndex,
		longest.entry.moment.start,
		longest.entry.moment.start + length * speed,
		speed
	);
}

/**
 * Fill each slot with the next ranked moment, alternating sources. A moment
 * longer than a slot feeds several slots in order; when every moment is used
 * up the ranking repeats from its start. A slot no source can fill at normal
 * speed slows the longest source down (to `MIN_FILL_SPEED` at most).
 */
export function fillSlots(
	slots: readonly AutoCutSlot[],
	ranked: readonly AutoCutMoment[][],
	assets: readonly Asset[]
): AutoCutPlacement[] {
	const queue = interleave(ranked);
	if (queue.length === 0) {
		throw new Error("None of the sources has usable media for AutoCut.");
	}
	const durations = new Map(assets.map((asset) => [asset.id, asset.duration]));
	const state = { pointer: 0 };
	const placements: AutoCutPlacement[] = [];
	for (const [slotIndex, slot] of slots.entries()) {
		let placement = takeMoment(queue, state, slot, slotIndex, durations);
		if (!placement) {
			for (const entry of queue) {
				entry.cursor = entry.moment.start;
			}
			placement =
				takeMoment(queue, state, slot, slotIndex, durations) ??
				stretchMoment(queue, slot, slotIndex, durations);
		}
		if (!placement) {
			throw new Error(
				`The sources are too short to fill a ${(slot.end - slot.start).toFixed(1)} s beat slot.`
			);
		}
		placements.push(placement);
	}
	return placements;
}

/** The transition AutoCut puts on cut `cutIndex` (1 = the first cut). */
export function autoCutTransition(
	style: AutoEditStyle,
	cutIndex: number
): TransitionIn | undefined {
	const profile = AUTO_CUT_STYLES[style];
	if (
		profile.transitionEvery <= 0 ||
		profile.transitions.length === 0 ||
		cutIndex < 1 ||
		cutIndex % profile.transitionEvery !== 0
	) {
		return undefined;
	}
	const turn = cutIndex / profile.transitionEvery - 1;
	return profile.transitions[turn % profile.transitions.length];
}

// --- Reframe adapter ------------------------------------------------------

/** What a reframe planner may set on a clip placed on a new canvas. */
export type ReframePatch = Partial<Pick<Segment, "crop" | "fit">>;

export interface ReframeInput {
	asset: Asset;
	canvas: { height: number; width: number };
	segment: Segment;
}

/**
 * Plans how a clip fills a canvas of another aspect while a project is
 * built. Builds are pure, so they place clips with `centreReframe`; the
 * routes then measure the subjects of the clips a build reframed (recorded
 * with `recordReframes`) and re-frame them with W4-AI1's saliency planner
 * (`reframeToSubjects` in `shared/reframe.ts`).
 */
export type ReframeAdapter = (input: ReframeInput) => ReframePatch;

/**
 * `centreReframe` that also records every clip it changed, so the caller
 * knows which clips of the built project were reframed (by their final id).
 */
export function recordReframes(): {
	adapter: ReframeAdapter;
	clipIds: string[];
} {
	const clipIds: string[] = [];
	return {
		adapter: (input) => {
			const patch = centreReframe(input);
			if (patch.fit) {
				clipIds.push(input.segment.id);
			}
			return patch;
		},
		clipIds,
	};
}

const aspectOf = (size: { height: number; width: number }) =>
	size.width > 0 && size.height > 0 ? size.width / size.height : 0;

/** Fill the canvas with a centred crop when the aspects differ. */
export const centreReframe: ReframeAdapter = ({ asset, canvas }) => {
	const source = aspectOf(asset);
	const target = aspectOf(canvas);
	if (!(source > 0 && target > 0) || Math.abs(source - target) < 0.01) {
		return {};
	}
	return { fit: "fill" };
};

/**
 * Fill the canvas with a crop window centred on a subject point (normalized
 * source coordinates), clamped to the frame. Falls back to `centreReframe`
 * when the asset size is unknown.
 */
export function subjectReframe(subject: {
	x: number;
	y: number;
}): ReframeAdapter {
	return (input) => {
		const source = aspectOf(input.asset);
		const target = aspectOf(input.canvas);
		if (!(source > 0 && target > 0) || Math.abs(source - target) < 0.01) {
			return centreReframe(input);
		}
		const crop: Crop = { bottom: 0, left: 0, right: 0, top: 0 };
		const clampEdge = (centre: number, kept: number) => {
			const lead = Math.min(1 - kept, Math.max(0, centre - kept / 2));
			return {
				lead: round3(lead),
				trail: round3(Math.max(0, 1 - kept - lead)),
			};
		};
		if (source > target) {
			const kept = target / source;
			const { lead, trail } = clampEdge(subject.x, kept);
			crop.left = lead;
			crop.right = trail;
		} else {
			const kept = source / target;
			const { lead, trail } = clampEdge(subject.y, kept);
			crop.top = lead;
			crop.bottom = trail;
		}
		const tooDeep = [crop.left, crop.right, crop.top, crop.bottom].some(
			(edge) => edge > 0.9
		);
		return tooDeep ? { fit: "fill" } : { crop, fit: "fill" };
	};
}

// --- Captions -----------------------------------------------------------

/** One clip whose source speech becomes captions. */
export interface CaptionSourceClip {
	/** Source asset, recorded on each caption when known. */
	assetId?: string;
	cues?: readonly TimedText[];
	sourceIn: number;
	sourceOut: number;
	speed: number;
	start: number;
	words?: readonly TimedText[];
}

/**
 * Captions for clips cut from transcribed sources: each clip's words (or
 * cues, when it has no word timing) inside its source range, mapped to the
 * timeline and grouped by `chunking`.
 */
export function captionsForClips(
	clips: readonly CaptionSourceClip[],
	chunking: CaptionChunking,
	newId: () => string
): Caption[] {
	const words: ChunkWord[] = [];
	for (const [index, clip] of clips.entries()) {
		const units = clip.words?.length ? clip.words : (clip.cues ?? []);
		for (const unit of units) {
			const start = Math.max(unit.start, clip.sourceIn);
			const end = Math.min(unit.end, clip.sourceOut);
			const text = unit.text.trim();
			if (end - start < 0.01 || !text) {
				continue;
			}
			words.push({
				end: round3(clip.start + (end - clip.sourceIn) / clip.speed),
				source: index,
				...(clip.assetId ? { sourceAssetId: clip.assetId } : {}),
				start: round3(clip.start + (start - clip.sourceIn) / clip.speed),
				text: text.slice(0, 2000),
			});
		}
	}
	if (words.length === 0) {
		return [];
	}
	return rechunk([], words, chunking, { newId }).slice(0, 5000);
}

// --- AutoCut project ------------------------------------------------------

export interface AutoCutMusic {
	asset: Asset;
	/** `sourceBeats(analysis, …)` when the music has a completed analysis. */
	beats?: SourceBeats;
}

export interface AutoCutOptions {
	newId?: () => string;
	reframe?: ReframeAdapter;
}

export interface AutoCutResult {
	beatSource: "detected" | "estimate" | "none";
	captions: number;
	duration: number;
	placements: (AutoCutPlacement & { clipId: string })[];
	project: Project;
	slots: AutoCutSlot[];
	transitions: number;
}

/** Project frame rate from the first video source that matches a preset rate. */
function sourceFps(
	sources: readonly AutoCutSource[],
	fallback: ProjectFps
): ProjectFps {
	for (const { asset } of sources) {
		if (asset.kind !== "video" || asset.frameRate === undefined) {
			continue;
		}
		const parsed = projectFpsSchema.safeParse(
			Math.round(asset.frameRate * 1000) / 1000
		);
		if (parsed.success) {
			return parsed.data;
		}
	}
	return fallback;
}

/** Apply each style transition on the cut into a clip, skipping cuts without spare media. */
function withTransitions(
	project: Project,
	assets: readonly Asset[],
	clipIds: readonly string[],
	style: AutoEditStyle
): { applied: number; project: Project } {
	let next = project;
	let applied = 0;
	for (const [index, clipId] of clipIds.entries()) {
		const transition = autoCutTransition(style, index);
		if (!transition) {
			continue;
		}
		try {
			next = applyRevealTransition(next, assets, clipId, transition);
			applied += 1;
		} catch {
			// Neither neighbour has spare media for the overlap; keep a hard cut.
		}
	}
	return { applied, project: next };
}

/**
 * Track-0 clips cut back so none overlaps the next: a transition overlap
 * belongs to the incoming clip, so each clip's source range ends where the
 * next clip starts (converted to source time through its speed). Captions
 * built from these spans never interleave two sources' speech. With
 * `include`, only spans of the clips it accepts are returned (the cut
 * points still come from every track-0 clip).
 */
export function visibleSpans(
	segments: readonly Segment[],
	include: (segment: Segment) => boolean = () => true
): Pick<Segment, "assetId" | "sourceIn" | "sourceOut" | "speed" | "start">[] {
	const visuals = segments
		.filter((segment) => segment.track === 0)
		.toSorted((a, b) => a.start - b.start);
	return visuals.flatMap((segment, index) => {
		const next = visuals[index + 1];
		const end = segment.start + segmentDuration(segment);
		const visibleEnd = next ? Math.min(end, next.start) : end;
		if (visibleEnd - segment.start < EPSILON || !include(segment)) {
			return [];
		}
		const sourceOut = Math.min(
			segment.sourceOut,
			segment.sourceIn + (visibleEnd - segment.start) * segment.speed
		);
		return [
			{
				assetId: segment.assetId,
				sourceIn: segment.sourceIn,
				sourceOut: round3(sourceOut),
				speed: segment.speed,
				start: segment.start,
			},
		];
	});
}

/** The sources and music an AutoCut request names, checked against the library. */
export function autoCutMedia(
	request: Pick<AutoEditRequest, "assetIds" | "musicAssetId">,
	assets: readonly Asset[]
): { music?: Asset; sources: Asset[] } {
	const byId = new Map(assets.map((asset) => [asset.id, asset]));
	const sources = request.assetIds.map((id) => {
		const asset = byId.get(id);
		if (!asset) {
			throw new Error("An AutoCut source is not in the media library.");
		}
		if (asset.kind === "audio") {
			throw new Error("AutoCut sources must be video or image media.");
		}
		return asset;
	});
	if (request.musicAssetId === undefined) {
		return { sources };
	}
	const music = byId.get(request.musicAssetId);
	if (!music) {
		throw new Error("The music track is not in the media library.");
	}
	if (music.kind !== "audio") {
		throw new Error("Choose an audio file for the AutoCut music bed.");
	}
	return { music, sources };
}

/**
 * Build an AutoCut edit into `base` (a fresh project): visuals on track 0
 * cut to the music's beat slots, the music bed on track 1 (source audio is
 * muted under it), style transitions on the cuts, and optional captions.
 */
export function buildAutoCutProject(
	base: Project,
	assets: readonly Asset[],
	input: AutoEditInput,
	data: { music?: AutoCutMusic; sources: readonly AutoCutSource[] },
	options: AutoCutOptions = {}
): AutoCutResult {
	const request = autoEditRequestSchema.parse(input);
	const newId = options.newId ?? (() => crypto.randomUUID());
	const reframe = options.reframe ?? centreReframe;
	const media = autoCutMedia(request, assets);
	const music = media.music
		? { asset: media.music, beats: data.music?.beats }
		: undefined;
	const duration = round3(
		music ? Math.min(request.duration, music.asset.duration) : request.duration
	);
	if (duration < 1) {
		throw new Error("The music track is shorter than one second.");
	}
	const profile = AUTO_CUT_STYLES[request.style];
	const slots = beatSlots(music?.beats, duration, request.style);
	const sources = media.sources.map(
		(asset) =>
			data.sources.find((source) => source.asset.id === asset.id) ?? { asset }
	);
	const ranked = sources.map((source) =>
		rankMoments(source, {
			keywords: request.keywords,
			maxLength: profile.maxSlot * 3,
			minLength: profile.minSlot,
		})
	);
	const canvas = canvasForAspect(request.aspect);
	const placements = fillSlots(slots, ranked, assets).map((placement) => ({
		...placement,
		clipId: newId(),
	}));
	const byId = new Map(assets.map((asset) => [asset.id, asset]));
	const segments: Segment[] = placements.map((placement) => {
		const asset = byId.get(placement.assetId);
		if (!asset) {
			throw new Error("An AutoCut source is not in the media library.");
		}
		const segment: Segment = {
			...newSegment(asset, placement.start, 0),
			id: placement.clipId,
			sourceIn: placement.sourceIn,
			sourceOut: placement.sourceOut,
			speed: placement.speed,
			...(music && asset.hasAudio ? { muted: true } : {}),
		};
		return { ...segment, ...reframe({ asset, canvas, segment }) };
	});
	if (music) {
		segments.push({
			...newSegment(music.asset, 0, 1),
			fadeOut: round3(Math.min(2, duration / 4)),
			id: newId(),
			sourceIn: 0,
			sourceOut: duration,
		});
	}
	const vertical = canvas.height > canvas.width;
	const chunking: CaptionChunking = vertical
		? { maxWords: 3, mode: "words" }
		: { mode: "words" };
	let project = validateProject(
		{
			...base,
			...canvas,
			fps: sourceFps(sources, base.fps),
			segments,
			title: request.title ?? base.title,
		},
		[...assets]
	);
	const transitioned = withTransitions(
		project,
		assets,
		placements.map((placement) => placement.clipId),
		request.style
	);
	project = transitioned.project;
	let captions: Caption[] = [];
	if (request.captions) {
		const sourceById = new Map(
			sources.map((source) => [source.asset.id, source])
		);
		captions = captionsForClips(
			// Speech nobody hears (sources muted under the music bed) does not
			// become captions, the rule shorts and highlights follow.
			visibleSpans(project.segments, (segment) =>
				clipHeard(project, segment)
			).flatMap((segment) => {
				const source = sourceById.get(segment.assetId);
				return source
					? [
							{
								assetId: segment.assetId,
								cues: source.cues,
								sourceIn: segment.sourceIn,
								sourceOut: segment.sourceOut,
								speed: segment.speed,
								start: segment.start,
								words: source.words,
							},
						]
					: [];
			}),
			chunking,
			newId
		);
		if (captions.length > 0) {
			project = validateProject(
				{
					...withActiveCaptions(project, captions),
					captionChunking: chunking,
					...(vertical ? { captionStyle: captionPreset("punch")?.style } : {}),
				},
				[...assets]
			);
		}
	}
	let beatSource: AutoCutResult["beatSource"] = "none";
	if (music?.beats && music.beats.times.length >= 2) {
		beatSource = music.beats.detected ? "detected" : "estimate";
	}
	return {
		beatSource,
		captions: captions.length,
		duration,
		placements,
		project,
		slots,
		transitions: transitioned.applied,
	};
}

// --- Shorts ---------------------------------------------------------------

export interface ShortWindow {
	end: number;
	start: number;
	title: string;
}

export interface ShortOptions {
	aspect: AutoEditAspect;
	captions: boolean;
	newId?: () => string;
	publishPreset?: PublishPresetId;
	reframe?: ReframeAdapter;
	/** Timeline-time transcript words (or cues) of the source project. */
	words?: readonly TimedText[];
}

/** A clip that covers the whole frame: no offset, scale, rotation or layout. */
function fullFrame(segment: Segment): boolean {
	return (
		segment.scale === 1 &&
		segment.x === 0 &&
		segment.y === 0 &&
		segment.rotation === 0 &&
		segment.scaleX === undefined &&
		segment.scaleY === undefined &&
		(segment.fit === undefined || segment.fit === "fit")
	);
}

/** Captions for a short: the window's captions or transcript, one word at a time. */
function shortCaptions(
	project: Project,
	window: ShortWindow,
	words: readonly TimedText[],
	newId: () => string
): Caption[] {
	const chunking: CaptionChunking = { mode: "single-word" };
	const existing = activeCaptions(project);
	if (existing.length > 0) {
		return rechunk(existing, undefined, chunking, { newId }).slice(0, 5000);
	}
	const length = window.end - window.start;
	return captionsForClips(
		[
			{
				sourceIn: window.start,
				sourceOut: window.end,
				speed: 1,
				start: 0,
				words: words.filter(
					(word) =>
						word.end > window.start && word.start < window.start + length
				),
			},
		],
		chunking,
		newId
	);
}

/**
 * A vertical short cut from `source`: everything outside the highlight
 * window is ripple-deleted on every track, the canvas changes to the aspect,
 * full-frame visual clips are reframed, captions are rechunked one word at a
 * time (or built from the transcript), and the publish preset is stored in
 * the export settings. Returns a validated project that still carries the
 * source id; the caller saves it as a new project.
 */
export function buildShortProject(
	source: Project,
	assets: readonly Asset[],
	window: ShortWindow,
	rank: number,
	options: ShortOptions
): Project {
	const newId = options.newId ?? (() => crypto.randomUUID());
	const reframe = options.reframe ?? centreReframe;
	const total = projectDuration(source);
	const start = Math.max(0, window.start);
	const end = Math.min(total, window.end);
	if (!(end - start >= MIN_RANGE)) {
		throw new Error("The highlight is outside the timeline.");
	}
	const ranges = highlightToRanges({ end, start }, total).filter(
		(range) => range.end - range.start >= MIN_RANGE
	);
	const locked = new Set(
		source.trackSettings.filter((setting) => setting.locked).map((s) => s.track)
	);
	const unlocked: Project = {
		...source,
		trackSettings: source.trackSettings.map((setting) => ({
			...setting,
			locked: false,
		})),
	};
	let next =
		ranges.length > 0
			? removeWordRanges(unlocked, assets, {
					ranges,
					revision: source.revision,
					tracks: Array.from({ length: MAX_TRACKS }, (_, track) => track),
				})
			: unlocked;
	const canvas = canvasForAspect(options.aspect);
	const byId = new Map(assets.map((asset) => [asset.id, asset]));
	next = {
		...next,
		...canvas,
		segments: next.segments.map((segment) => {
			const asset = byId.get(segment.assetId);
			if (!asset || asset.kind === "audio" || !fullFrame(segment)) {
				return segment;
			}
			return { ...segment, ...reframe({ asset, canvas, segment }) };
		}),
		title: `${source.title} · short ${rank}`.slice(0, 200),
		trackSettings: next.trackSettings.map((setting) => ({
			...setting,
			locked: locked.has(setting.track),
		})),
	};
	if (options.captions) {
		const captions = shortCaptions(
			next,
			{ ...window, end, start },
			options.words ?? [],
			newId
		);
		if (captions.length > 0) {
			next = {
				...withActiveCaptions(next, captions),
				captionChunking: { mode: "single-word" },
				captionStyle: next.captionStyle ?? captionPreset("punch")?.style,
			};
		}
	}
	const preset = options.publishPreset ?? defaultPublishPreset(options.aspect);
	if (preset && publishPresetFor(preset)) {
		next = {
			...next,
			exportSettings: { container: "mp4", platformPreset: preset },
		};
	}
	return validateProject(next, [...assets]);
}
