import { z } from "zod";
import type { Asset, Project } from "./project.ts";
import { projectDuration, segmentDuration } from "./project.ts";
import {
	MAX_SOUNDTRACK_SECTIONS,
	MIN_SOUNDTRACK_SECTION_SECONDS,
	SOUNDTRACK_BEATS_PER_BAR,
	SOUNDTRACK_STYLES,
	type SoundtrackRequest,
	type SoundtrackSection,
	soundtrackBarSeconds,
	soundtrackLayerSchema,
	soundtrackSectionSchema,
	soundtrackStyleSchema,
} from "./soundtrack.ts";

/** Longest music description a planner prompt carries. */
export const MAX_SOUNDTRACK_DESCRIPTION = 500;
export const soundtrackDescriptionSchema = z
	.string()
	.trim()
	.max(MAX_SOUNDTRACK_DESCRIPTION);

/** The JSON a planning model returns, before alignment. */
export const soundtrackPlanSchema = z
	.object({
		bpm: z.number().finite().min(60).max(180),
		/** Instrument layers the planner picked; omitted keeps the style's band. */
		layers: z.array(soundtrackLayerSchema).min(1).max(7).optional(),
		sections: z
			.array(soundtrackSectionSchema)
			.min(1)
			.max(MAX_SOUNDTRACK_SECTIONS),
		style: soundtrackStyleSchema,
	})
	.strict();
export type SoundtrackPlan = z.infer<typeof soundtrackPlanSchema>;

/** An aligned plan; `downbeatOffset` phases the score's bars to the beats. */
export type AlignedSoundtrackPlan = SoundtrackPlan & {
	downbeatOffset?: number;
};

const clampNumber = (minimum: number, maximum: number) =>
	z
		.number()
		.finite()
		.transform((value) => Math.min(maximum, Math.max(minimum, value)));

const styleAliases: Record<string, string> = { lofi: "lo-fi" };

/**
 * Model output is looser than the API: unknown keys are dropped, the style
 * is matched case-insensitively, and tempo and intensity are clamped.
 */
const soundtrackPlanModelSchema = z
	.object({
		bpm: clampNumber(60, 180),
		// Unknown layer names are dropped; an empty or missing list keeps the style's band.
		layers: z
			.unknown()
			.optional()
			.transform((value) => {
				if (!Array.isArray(value)) {
					return;
				}
				const known = [
					...new Set(
						value
							.map((item) =>
								typeof item === "string" ? item.trim().toLowerCase() : ""
							)
							.filter((item) => soundtrackLayerSchema.safeParse(item).success)
					),
				].map((item) => soundtrackLayerSchema.parse(item));
				return known.length > 0 ? known.slice(0, 7) : undefined;
			}),
		sections: z
			.array(
				z
					.object({
						start: clampNumber(0, 7200),
						end: clampNumber(0, 7200),
						intensity: clampNumber(0, 1),
					})
					.strip()
			)
			.min(1)
			.transform((sections) => sections.slice(0, MAX_SOUNDTRACK_SECTIONS)),
		style: z.preprocess((value) => {
			if (typeof value !== "string") {
				return value;
			}
			const normalized = value
				.trim()
				.toLowerCase()
				.replace(/[\s_]+/gu, "-");
			return styleAliases[normalized] ?? normalized;
		}, soundtrackStyleSchema),
	})
	.strip();

/** What the planner is told about the edit; bounded so prompts stay small. */
export interface SoundtrackTimelineSummary {
	brief: string;
	clipCount: number;
	duration: number;
	markers: { label: string; time: number }[];
	scenes: string[];
	title: string;
}

const MAX_PROMPT_TIMES = 200;
const MAX_SUMMARY_MARKERS = 40;
const MAX_SUMMARY_SCENES = 20;
const MAX_BRIEF_CHARACTERS = 1000;
const CUT_MERGE_SECONDS = 0.05;
const BEAT_MARKER_PREFIX = "Beat";

const round3 = (value: number) => Math.round(value * 1000) / 1000;

const isBeatMarker = (label: string) =>
	label === BEAT_MARKER_PREFIX || label.startsWith(`${BEAT_MARKER_PREFIX} `);

/** Summarize a project for a soundtrack planner. */
export function soundtrackTimelineSummary(
	project: Project
): SoundtrackTimelineSummary {
	return {
		brief: project.brief.slice(0, MAX_BRIEF_CHARACTERS),
		clipCount: project.segments.length,
		duration: round3(projectDuration(project)),
		markers: project.markers
			.filter((marker) => !isBeatMarker(marker.label))
			.sort((a, b) => a.time - b.time)
			.slice(0, MAX_SUMMARY_MARKERS)
			.map((marker) => ({ label: marker.label, time: round3(marker.time) })),
		scenes: project.scenes
			.slice(0, MAX_SUMMARY_SCENES)
			.map((scene) => scene.title),
		title: project.title,
	};
}

/** Sorted, de-duplicated times strictly inside `(0, duration)`. */
function interiorTimes(times: Iterable<number>, duration: number): number[] {
	const sorted = [...times]
		.filter(
			(time) =>
				Number.isFinite(time) &&
				time > CUT_MERGE_SECONDS &&
				time < duration - CUT_MERGE_SECONDS
		)
		.sort((a, b) => a - b);
	const result: number[] = [];
	for (const time of sorted) {
		const last = result.at(-1);
		if (last === undefined || time - last > CUT_MERGE_SECONDS) {
			result.push(round3(time));
		}
	}
	return result;
}

/**
 * Timeline cut points: where a visual clip starts or ends. Audio-only clips
 * do not mark a picture cut.
 */
export function timelineSceneCuts(
	project: Project,
	assets: readonly Pick<Asset, "id" | "kind">[]
): number[] {
	const audio = new Set(
		assets.filter((asset) => asset.kind === "audio").map((asset) => asset.id)
	);
	const times: number[] = [];
	for (const segment of project.segments) {
		if (audio.has(segment.assetId)) {
			continue;
		}
		times.push(segment.start, segment.start + segmentDuration(segment));
	}
	return interiorTimes(times, projectDuration(project));
}

/** A timeline range, in seconds, that a soundtrack is scored for. */
export interface SoundtrackRange {
	end: number;
	start: number;
}

/**
 * Planner input for the whole timeline, or for one range of it: the summary
 * lasts the range, and scene cuts, beats and markers inside the range are
 * shifted so the range starts at 0. The scored music is placed at
 * `range.start`.
 */
export function soundtrackPlanInput(
	project: Project,
	assets: readonly Pick<Asset, "id" | "kind">[],
	range?: SoundtrackRange,
	description?: string
): SoundtrackPlanInput {
	const summary = soundtrackTimelineSummary(project);
	const sceneCuts = timelineSceneCuts(project, assets);
	const beats = beatMarkerTimes(project);
	const extra = description?.trim() ? { description: description.trim() } : {};
	if (!range) {
		return { beats, sceneCuts, summary, ...extra };
	}
	const start = Math.max(0, range.start);
	const end = Math.min(summary.duration, range.end);
	if (!(end - start >= 0.5)) {
		throw new Error("Mark a range of at least half a second to score it.");
	}
	const inside = (time: number) => time >= start && time < end;
	const shift = (time: number) => round3(time - start);
	return {
		beats: beats.filter(inside).map(shift),
		sceneCuts: sceneCuts.filter(inside).map(shift),
		summary: {
			...summary,
			duration: round3(end - start),
			markers: summary.markers
				.filter((marker) => inside(marker.time))
				.map((marker) => ({ ...marker, time: shift(marker.time) })),
		},
		...extra,
	};
}

/** Beat times from the project's "Beat N" markers. */
export function beatMarkerTimes(project: Project): number[] {
	return project.markers
		.filter((marker) => isBeatMarker(marker.label))
		.map((marker) => round3(marker.time))
		.sort((a, b) => a - b);
}

/**
 * Tempo implied by beat times: 60 over the median interval, folded into the
 * 60-180 BPM range by octave. `undefined` when fewer than four beats exist.
 */
export function measuredBpm(beats: readonly number[]): number | undefined {
	const intervals = beats
		.slice(1)
		.map((time, index) => time - (beats[index] ?? time))
		.filter((interval) => interval > 0)
		.sort((a, b) => a - b);
	if (intervals.length < 3) {
		return;
	}
	const middle = Math.floor(intervals.length / 2);
	const median =
		intervals.length % 2
			? (intervals[middle] ?? 0)
			: ((intervals[middle - 1] ?? 0) + (intervals[middle] ?? 0)) / 2;
	let bpm = 60 / median;
	while (bpm < 60) {
		bpm *= 2;
	}
	while (bpm > 180) {
		bpm /= 2;
	}
	return Math.round(bpm * 10) / 10;
}

/**
 * Where the score's bars are anchored: the first beat marker when enough
 * beats exist to measure a tempo, otherwise time 0.
 */
export function downbeatAnchor(beats: readonly number[]): number {
	return beats.length > SOUNDTRACK_BEATS_PER_BAR - 1 && measuredBpm(beats)
		? (beats[0] ?? 0)
		: 0;
}

/**
 * Downbeats of the score that will be rendered: a bar grid at `bpm` through
 * `anchor` (see `downbeatAnchor`). Boundaries snapped to these land on the
 * generated music's bars, because the request carries the same tempo and
 * the anchor as `downbeatOffset`.
 */
export function downbeatTimes(
	beats: readonly number[],
	bpm: number,
	duration: number
): number[] {
	const bar = soundtrackBarSeconds(bpm);
	const anchor = downbeatAnchor(beats);
	const first = anchor - Math.floor(anchor / bar) * bar;
	const grid: number[] = [];
	for (let index = 0; first + index * bar < duration; index++) {
		grid.push(first + index * bar);
	}
	return interiorTimes(grid, duration);
}

/** Build the `model.complete` request for a soundtrack plan. */
export function soundtrackPlanPrompt(
	summary: SoundtrackTimelineSummary,
	sceneCuts: readonly number[],
	beats: readonly number[],
	description?: string
): { prompt: string; system: string } {
	const tempo = measuredBpm(beats);
	const styles = soundtrackStyleSchema.options.join(", ");
	const layers = soundtrackLayerSchema.options.join(", ");
	const wanted = description?.trim().slice(0, MAX_SOUNDTRACK_DESCRIPTION);
	return {
		system: [
			"You are a film music supervisor planning a short instrumental score.",
			'Return only JSON shaped {"style": string, "bpm": number, "layers": [string], "sections": [{"start": number, "end": number, "intensity": number}]}.',
			`style must be one of: ${styles}.`,
			"bpm is between 60 and 180.",
			`layers is 1 to 7 of: ${layers}; leave it out to use the style's usual band.`,
			...(wanted
				? [
						"The user described the music they want in musicDescription. Choose the style, tempo, layers and section energy that best match it; the description wins over the timeline when they disagree, except that a measured tempo keeps the bars on the beat.",
					]
				: []),
			`Use 1 to 8 sections in time order that cover 0 to ${summary.duration} seconds without overlapping.`,
			"intensity is 0 (sparse bed) to 1 (full band). Build and release energy to follow the edit.",
			"Start sections at the listed scene cuts or downbeats where possible.",
			"No markdown or commentary.",
		].join(" "),
		prompt: JSON.stringify({
			timeline: summary,
			sceneCuts: sceneCuts.slice(0, MAX_PROMPT_TIMES),
			downbeats: downbeatTimes(
				beats,
				tempo ?? SOUNDTRACK_STYLES.cinematic.bpm,
				summary.duration
			).slice(0, MAX_PROMPT_TIMES),
			...(tempo ? { measuredBpm: tempo } : {}),
			...(wanted ? { musicDescription: wanted } : {}),
		}),
	};
}

export class SoundtrackPlanError extends Error {
	override name = "SoundtrackPlanError";
}

/** The first balanced `{…}` object in free text, ignoring braces in strings. */
function firstJsonObject(text: string): string | undefined {
	const start = text.indexOf("{");
	if (start < 0) {
		return;
	}
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let index = start; index < text.length; index++) {
		const character = text[index];
		if (inString) {
			if (escaped) {
				escaped = false;
			} else if (character === "\\") {
				escaped = true;
			} else if (character === '"') {
				inString = false;
			}
			continue;
		}
		if (character === '"') {
			inString = true;
		} else if (character === "{") {
			depth++;
		} else if (character === "}") {
			depth--;
			if (depth === 0) {
				return text.slice(start, index + 1);
			}
		}
	}
	return;
}

const UNUSABLE_PLAN =
	"The model returned an unusable soundtrack plan. Try planning again.";

/**
 * Parse model output into a plan. Tolerates prose or a Markdown fence around
 * the JSON, extra keys, a capitalised style, and out-of-range tempo or
 * intensity. Throws `SoundtrackPlanError` with a readable message otherwise.
 */
export function parseSoundtrackPlan(text: string): SoundtrackPlan {
	const fenced = /```(?:json)?\s*([\s\S]*?)```/u.exec(text);
	const body = firstJsonObject(fenced?.[1] ?? text);
	if (body === undefined) {
		throw new SoundtrackPlanError(UNUSABLE_PLAN);
	}
	let value: unknown;
	try {
		value = JSON.parse(body);
	} catch {
		throw new SoundtrackPlanError(UNUSABLE_PLAN);
	}
	const parsed = soundtrackPlanModelSchema.safeParse(value);
	if (!parsed.success) {
		throw new SoundtrackPlanError(UNUSABLE_PLAN);
	}
	return parsed.data;
}

export interface SoundtrackAlignmentContext {
	beats: readonly number[];
	duration: number;
	sceneCuts: readonly number[];
	/** Largest move, in seconds, when snapping a boundary. Default 1.5. */
	tolerance?: number;
}

const DEFAULT_SNAP_TOLERANCE = 1.5;

function nearestWithin(
	time: number,
	candidates: readonly number[],
	tolerance: number
): number | undefined {
	let best: number | undefined;
	for (const candidate of candidates) {
		const distance = Math.abs(candidate - time);
		if (
			distance <= tolerance &&
			(best === undefined || distance < Math.abs(best - time))
		) {
			best = candidate;
		}
	}
	return best;
}

/**
 * Normalize a plan to contiguous sections from 0 to `duration` and move each
 * section change to the nearest scene cut within `tolerance`, otherwise the
 * nearest downbeat within `tolerance`. A picture cut wins over a downbeat
 * because the change must be seen and heard together. Changes that would
 * leave a section shorter than the minimum are merged into the previous one.
 * With four or more beats the plan's tempo follows the measured tempo.
 */
export function alignSoundtrackPlan(
	plan: SoundtrackPlan,
	context: SoundtrackAlignmentContext
): AlignedSoundtrackPlan {
	const { duration } = context;
	if (!(Number.isFinite(duration) && duration >= 0.5)) {
		throw new Error("Add at least half a second of timeline before planning.");
	}
	const tolerance = Math.max(0, context.tolerance ?? DEFAULT_SNAP_TOLERANCE);
	// The rendered tempo (0.1 BPM precision) is the grid boundaries snap to.
	const bpm = Math.round((measuredBpm(context.beats) ?? plan.bpm) * 10) / 10;
	const anchor = downbeatAnchor(context.beats);
	const cuts = interiorTimes(context.sceneCuts, duration);
	const downbeats = downbeatTimes(context.beats, bpm, duration);
	const ordered = plan.sections
		.filter((section) => section.start < duration && section.end > 0)
		.sort((a, b) => a.start - b.start);
	if (ordered.length === 0) {
		throw new Error("The soundtrack plan has no sections inside the timeline.");
	}
	const starts: { intensity: number; start: number }[] = [];
	for (const [index, section] of ordered.entries()) {
		if (index === 0) {
			starts.push({ intensity: section.intensity, start: 0 });
			continue;
		}
		const snapped =
			nearestWithin(section.start, cuts, tolerance) ??
			nearestWithin(section.start, downbeats, tolerance) ??
			section.start;
		const previous = starts.at(-1)?.start ?? 0;
		if (
			snapped - previous < MIN_SOUNDTRACK_SECTION_SECONDS ||
			duration - snapped < MIN_SOUNDTRACK_SECTION_SECONDS
		) {
			continue;
		}
		starts.push({ intensity: section.intensity, start: round3(snapped) });
	}
	const sections: SoundtrackSection[] = starts.map((entry, index) => ({
		start: entry.start,
		end: round3(starts[index + 1]?.start ?? duration),
		intensity: round3(entry.intensity),
	}));
	return {
		bpm,
		...(anchor > 0 ? { downbeatOffset: round3(anchor) } : {}),
		...(plan.layers?.length ? { layers: plan.layers } : {}),
		sections,
		style: plan.style,
	};
}

/** The `POST /soundtrack` body for an aligned plan. */
export function soundtrackRequestFromPlan(
	plan: AlignedSoundtrackPlan,
	duration: number
): Pick<
	SoundtrackRequest,
	"bpm" | "downbeatOffset" | "duration" | "layers" | "mood" | "sections"
> {
	return {
		...(plan.layers?.length ? { layers: plan.layers } : {}),
		// Keep the measured tempo (0.1 BPM) so bars stay on the beat markers.
		bpm: Math.min(180, Math.max(60, Math.round(plan.bpm * 10) / 10)),
		...(plan.downbeatOffset === undefined
			? {}
			: { downbeatOffset: plan.downbeatOffset }),
		duration: round3(duration),
		mood: plan.style,
		sections: plan.sections,
	};
}

export interface SoundtrackPlanInput {
	beats: readonly number[];
	/** What the user wants the music to sound like, in their words. */
	description?: string;
	sceneCuts: readonly number[];
	summary: SoundtrackTimelineSummary;
}

/**
 * Ask a model for a plan and align it to the edit. `complete` is injected
 * (the UI passes `window.ryu.model.complete`) so this stays deterministic
 * under test.
 */
export async function planSoundtrack(
	input: SoundtrackPlanInput,
	complete: (request: { prompt: string; system: string }) => Promise<string>
): Promise<AlignedSoundtrackPlan> {
	const response = await complete(
		soundtrackPlanPrompt(
			input.summary,
			input.sceneCuts,
			input.beats,
			input.description
		)
	);
	return alignSoundtrackPlan(parseSoundtrackPlan(response), {
		beats: input.beats,
		duration: input.summary.duration,
		sceneCuts: input.sceneCuts,
	});
}

/**
 * Sections that fit a soundtrack of `duration` seconds: later sections are
 * dropped, the last one is clipped, and too-short remainders are removed.
 */
export function clipSoundtrackSections(
	sections: readonly SoundtrackSection[],
	duration: number
): SoundtrackSection[] {
	return sections
		.filter(
			(section) => duration - section.start >= MIN_SOUNDTRACK_SECTION_SECONDS
		)
		.map((section) => ({
			...section,
			end: round3(Math.min(section.end, duration)),
		}))
		.filter(
			(section) => section.end - section.start >= MIN_SOUNDTRACK_SECTION_SECONDS
		);
}
