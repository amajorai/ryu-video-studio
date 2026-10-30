import {
	type Asset,
	type Project,
	projectSchema,
	type Segment,
	segmentDuration,
} from "../../shared/project.ts";
import {
	type CutPoint,
	findCutPoints,
	resolveCutForClip,
} from "../../shared/split-edits.ts";
import type { TrimEditInput } from "../../shared/trim-modes.ts";

export type TrimTool =
	| "pointer"
	| "ripple"
	| "roll"
	| "slip"
	| "slide"
	| "razor";
export type DragEdge = "start" | "end" | "move";

/**
 * Timeline tools shown in the tool group; shortcut letters are free in the
 * editor's shortcut handler. `razor` stays out of this list (and C stays
 * unbound) until its cut-at-pointer click ships, so the UI never offers a
 * tool that cannot edit.
 */
export const TRIM_TOOLS: readonly {
	description: string;
	key: string;
	label: string;
	tool: TrimTool;
}[] = [
	{
		description:
			"Drag to move clips and their linked partners; drag an edge to trim.",
		key: "v",
		label: "Pointer",
		tool: "pointer",
	},
	{
		description: "Drag an edge to trim and shift later clips on the track.",
		key: "b",
		label: "Ripple",
		tool: "ripple",
	},
	{
		description: "Drag a shared edge to move the edit point between two clips.",
		key: "r",
		label: "Roll",
		tool: "roll",
	},
	{
		description: "Drag a clip to change which part of its source plays.",
		key: "y",
		label: "Slip",
		tool: "slip",
	},
	{
		description: "Drag a clip between its neighbours; their edges follow.",
		key: "u",
		label: "Slide",
		tool: "slide",
	},
];

export function trimToolForKey(key: string): TrimTool | undefined {
	const lower = key.toLowerCase();
	return TRIM_TOOLS.find((entry) => entry.key === lower)?.tool;
}

/**
 * Whether a drag on this part of a clip is handled by the tool instead of the
 * pointer. The razor owns every gesture so a drag never moves or trims a clip.
 */
export function toolHandlesDrag(tool: TrimTool, edge: DragEdge): boolean {
	if (tool === "razor") {
		return true;
	}
	if (tool === "ripple" || tool === "roll") {
		return edge !== "move";
	}
	if (tool === "slip" || tool === "slide") {
		return edge === "move";
	}
	return false;
}

const segmentEnd = (segment: Segment) =>
	segment.start + segmentDuration(segment);

/**
 * Build the trim-edit request for a tool drag. `delta` is the timeline seconds
 * the pointer moved (already snapped for edges). Returns `null` for drags the
 * pointer tool owns and for razor gestures, which cut on click instead. Slip
 * follows the Premiere convention: dragging left reveals later source.
 */
export function toolDragEdit(
	project: Project,
	tool: TrimTool,
	segment: Segment,
	edge: DragEdge,
	delta: number
): TrimEditInput | null {
	if (tool === "razor" || !toolHandlesDrag(tool, edge)) {
		return null;
	}
	const revision = project.revision;
	if (tool === "ripple" && edge !== "move") {
		return { clipId: segment.id, delta, edge, mode: "ripple", revision };
	}
	if (tool === "slip") {
		return {
			clipId: segment.id,
			delta: -delta * segment.speed,
			mode: "slip",
			revision,
		};
	}
	if (tool === "slide") {
		return { clipId: segment.id, delta, mode: "slide", revision };
	}
	const halfFrame = 0.5 / Math.max(1, project.fps);
	const neighbour = project.segments.find(
		(candidate) =>
			candidate.id !== segment.id &&
			candidate.track === segment.track &&
			(edge === "end"
				? Math.abs(candidate.start - segmentEnd(segment)) <= halfFrame
				: Math.abs(segmentEnd(candidate) - segment.start) <= halfFrame)
	);
	if (!neighbour) {
		throw new Error(
			"Roll needs another clip touching this edge on the same track."
		);
	}
	return edge === "end"
		? {
				delta,
				inClipId: neighbour.id,
				mode: "roll",
				outClipId: segment.id,
				revision,
			}
		: {
				delta,
				inClipId: segment.id,
				mode: "roll",
				outClipId: neighbour.id,
				revision,
			};
}

export interface SplitOffsetBadge {
	edge: "start" | "end";
	kind: "J" | "L";
	/** Signed seconds: audio edge minus picture edge. */
	offset: number;
}

/**
 * Offsets between a linked audio clip's edges and its picture partner's edges,
 * so J-cuts (audio leads) and L-cuts (audio trails) stay visible on the timeline.
 * An edge at an editable cut uses the cut's measured edit point (the midpoint
 * of any audio crossfade, as the split-edit planner reads it), so a straight
 * cut with a crossfade is not mislabelled as J or L. Pass `cuts` from
 * `findCutPoints` when badging many clips to scan the timeline once.
 */
export function splitOffsetBadges(
	project: Project,
	assets: readonly Asset[],
	segment: Segment,
	cuts: readonly CutPoint[] = findCutPoints(project, assets)
): SplitOffsetBadge[] {
	const kindOf = (candidate: Segment) =>
		assets.find((asset) => asset.id === candidate.assetId)?.kind;
	if (!segment.linkGroupId || kindOf(segment) !== "audio") {
		return [];
	}
	const partner = project.segments.find(
		(candidate) =>
			candidate.id !== segment.id &&
			candidate.linkGroupId === segment.linkGroupId &&
			(kindOf(candidate) === "video" || kindOf(candidate) === "image")
	);
	if (!partner) {
		return [];
	}
	const halfFrame = 0.5 / Math.max(1, project.fps);
	const badge = (
		edge: SplitOffsetBadge["edge"],
		offset: number
	): SplitOffsetBadge[] =>
		Math.abs(offset) > halfFrame
			? [
					{
						edge,
						kind: offset < 0 ? "J" : "L",
						offset: Number(offset.toFixed(3)),
					},
				]
			: [];
	const startCut = cuts.find((cut) => cut.incoming.audio.id === segment.id);
	const endCut = cuts.find((cut) => cut.outgoing.audio.id === segment.id);
	return [
		...badge("start", startCut?.currentOffset ?? segment.start - partner.start),
		...badge(
			"end",
			endCut?.currentOffset ?? segmentEnd(segment) - segmentEnd(partner)
		),
	];
}

/**
 * Split detach requests so each one extracts audio from at most `maxSources`
 * distinct media files and carries at most `maxClips` clips, matching the
 * sidecar's per-request limits.
 */
export function detachBatches(
	project: Pick<Project, "segments">,
	clipIds: readonly string[],
	maxSources = 16,
	maxClips = 64
): string[][] {
	const batches: string[][] = [];
	let current: string[] = [];
	let sources = new Set<string>();
	for (const clipId of clipIds) {
		const assetId = project.segments.find(
			(segment) => segment.id === clipId
		)?.assetId;
		if (!assetId) {
			continue;
		}
		const addsSource = !sources.has(assetId);
		if (
			current.length >= maxClips ||
			(addsSource && sources.size >= maxSources)
		) {
			batches.push(current);
			current = [];
			sources = new Set();
		}
		current.push(clipId);
		sources.add(assetId);
	}
	if (current.length) {
		batches.push(current);
	}
	return batches;
}

/**
 * Fingerprint of everything that places media on the timeline. Plans that
 * return absolute timeline times (cleanup ranges, highlight windows) stay
 * valid while it is unchanged, even across saves that only touch markers,
 * titles, or settings.
 */
export function timelineTimingKey(project: Pick<Project, "segments">): string {
	return JSON.stringify(
		project.segments.map((segment) => [
			segment.id,
			segment.assetId,
			segment.track,
			segment.start,
			segment.sourceIn,
			segment.sourceOut,
			segment.speed,
		])
	);
}

/**
 * Stamp a plan computed from `saved`. A plan whose reported revision is not
 * the revision it was requested at was computed from a timeline this editor
 * has not seen, so it gets no stamp and is never applied.
 */
export function planStamp(saved: Project, planRevision: number): string | null {
	return planRevision === saved.revision ? timelineTimingKey(saved) : null;
}

/** Whether a stamped plan still describes `project`'s timeline. */
export function planIsCurrent(
	stamp: string | null,
	project: Pick<Project, "segments">
): boolean {
	return stamp !== null && stamp === timelineTimingKey(project);
}

/** `J −0.50s` / `L +0.68s`, with a true minus sign. */
export function formatSplitOffset(
	badge: Pick<SplitOffsetBadge, "kind" | "offset">
) {
	const sign = badge.offset < 0 ? "−" : "+";
	return `${badge.kind} ${sign}${Math.abs(badge.offset).toFixed(2)}s`;
}

/** The editable audio/video cut closest to `time`, if any. */
export function nearestCut(
	project: Project,
	assets: readonly Asset[],
	time: number
): CutPoint | undefined {
	let best: CutPoint | undefined;
	for (const cut of findCutPoints(project, assets)) {
		if (!best || Math.abs(cut.time - time) < Math.abs(best.time - time)) {
			best = cut;
		}
	}
	return best;
}

/** The cut at either end of a linked clip, nearest the playhead; undefined when there is none. */
export function cutForClip(
	project: Project,
	assets: readonly Asset[],
	clipId: string,
	time: number
): CutPoint | undefined {
	try {
		return resolveCutForClip(project, assets, clipId, time);
	} catch {
		return undefined;
	}
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const projectKeys = new Set(Object.keys(projectSchema.shape));

/**
 * Read a revisioned edit response: either the saved project itself (the
 * `links` shape, optionally with extra result fields beside it) or
 * `{ project, ...extras }`.
 */
export function projectEditResponse(value: unknown): {
	extras: Record<string, unknown>;
	project: Project;
} {
	if (!isRecord(value)) {
		throw new Error("Video Studio returned an unexpected edit response.");
	}
	if (isRecord(value.project)) {
		const { project, ...extras } = value;
		return { extras, project: projectSchema.parse(project) };
	}
	const projectFields: Record<string, unknown> = {};
	const extras: Record<string, unknown> = {};
	for (const [key, field] of Object.entries(value)) {
		if (projectKeys.has(key)) {
			projectFields[key] = field;
		} else {
			extras[key] = field;
		}
	}
	return { extras, project: projectSchema.parse(projectFields) };
}

/** `m:ss.s` timeline clock, matching the editor's playback readout. */
export const timelineClock = (value: number) =>
	`${Math.floor(value / 60)}:${(value % 60).toFixed(1).padStart(4, "0")}`;

/** Status line for a manual J/L/straight split edit, noting handle clamping. */
export function splitEditStatus(
	kind: "j" | "l" | "none",
	appliedOffset: number,
	requested: number
): string {
	if (kind === "none") {
		return "Straight cut restored.";
	}
	if (appliedOffset === 0) {
		return "No source media is available past this cut for a split edit.";
	}
	const limited =
		Math.abs(appliedOffset) + 1e-3 < requested
			? " (limited by the source media)"
			: "";
	const label = kind === "j" ? "J" : "L";
	return `${label}-cut applied · ${formatSplitOffset({ kind: label, offset: appliedOffset })}${limited}.`;
}
