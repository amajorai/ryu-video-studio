import { trimBounds } from "../../../shared/group-edits.ts";
import {
	type Asset,
	type Project,
	type Segment,
	segmentDuration,
	trackSettingFor,
} from "../../../shared/project.ts";
import { withLinkedPartners } from "../../../shared/selection.ts";
import {
	collectSnapTargets,
	type SnapTarget,
	snap,
} from "../../../shared/timeline-snap.ts";
import type { DragEdge } from "../editing-ui.ts";
import {
	DRAG_THRESHOLD_PX,
	MAX_DRAG_TRACK,
	TIMELINE_LIMIT,
	TRACK_ROW_PX,
} from "./clip-drag-geometry.ts";

/*
 * Group drag engine. A pointer-tool press on a clip body moves the clip, or
 * the whole selection when the clip is part of it (linked A/V partners move
 * in time with their clip); a press on an edge trims that edge of the clip
 * or selection, with linked partners unless Alt is held (a J/L cut). Alt on
 * release of a body drag duplicates instead of moving. Every candidate edge
 * snaps through the shared snap contract; Shift suspends snapping. Escape
 * (which clears `store.drag`) cancels the gesture.
 */

/** What a group drag reads from the open editor. */
export interface GroupDragContext {
	assets: readonly Asset[];
	project: Project;
	range: { end: number; start: number } | null;
	/**
	 * Ripple mode: edge trims are not limited by the neighbouring clip (later
	 * clips move instead) and the release ripples the trim or move.
	 */
	rippleMode?: boolean;
	selectedIds: readonly string[];
	snapEnabled: boolean;
	time: number | null;
	/** Timeline zoom in pixels per second. */
	zoom: number;
}

/** Where and on which clip a group drag started. */
export interface GroupDragGesture {
	anchorId: string;
	edge: DragEdge;
	originX: number;
	originY: number;
}

/** The latest pointer position and modifiers of a group drag. */
export interface GroupDragPointer {
	altKey: boolean;
	shiftKey: boolean;
	x: number;
	y: number;
}

export type GroupDragPlan =
	| { kind: "none" }
	| {
			/** Clips that change track (the dragged ones, without partners). */
			directIds: string[];
			/** Every clip that moves in time (dragged ones plus linked partners). */
			ids: string[];
			delta: number;
			exact: boolean;
			kind: "move" | "duplicate";
			snapTime: number | null;
			trackDelta: number;
	  }
	| {
			delta: number;
			edge: "start" | "end";
			exact: boolean;
			/** Clips whose edge changes (with partners when `linked`). */
			ids: string[];
			kind: "trim";
			linked: boolean;
			snapTime: number | null;
	  };

const EPSILON = 1e-6;
const clipEnd = (segment: Segment) => segment.start + segmentDuration(segment);

/**
 * Clips a drag of `anchorId` acts on: the selection when the anchor is part
 * of a multi-clip selection (minus clips on locked tracks), else the anchor.
 */
export function dragGroupIds(
	project: Project,
	anchorId: string,
	selectedIds: readonly string[]
): string[] {
	if (!(selectedIds.length > 1 && selectedIds.includes(anchorId))) {
		return [anchorId];
	}
	const wanted = new Set(selectedIds);
	return project.segments
		.filter(
			(segment) =>
				wanted.has(segment.id) &&
				(segment.id === anchorId ||
					!trackSettingFor(project, segment.track).locked)
		)
		.map((segment) => segment.id);
}

function segmentsFor(project: Project, ids: readonly string[]): Segment[] {
	const wanted = new Set(ids);
	return project.segments.filter((segment) => wanted.has(segment.id));
}

interface SnappedDelta {
	delta: number;
	exact: boolean;
	snapTime: number | null;
}

/**
 * Snap a raw timeline delta applied to several edges at once: the edge that
 * lands on the best target (lowest priority, then nearest) decides the
 * delta. With no target the delta is returned raw for frame quantization.
 */
export function snapGroupDelta(
	edges: readonly number[],
	raw: number,
	targets: readonly SnapTarget[],
	options: { enabled: boolean; fps: number; pxPerSec: number }
): SnappedDelta {
	if (!options.enabled) {
		return { delta: raw, exact: false, snapTime: null };
	}
	let best: { adjust: number; target: SnapTarget; time: number } | null = null;
	for (const edge of edges) {
		const result = snap(edge + raw, targets, {
			fps: options.fps,
			pxPerSec: options.pxPerSec,
		});
		if (!result.target) {
			continue;
		}
		const adjust = Math.abs(result.time - (edge + raw));
		if (
			!best ||
			result.target.priority < best.target.priority ||
			(result.target.priority === best.target.priority &&
				adjust < best.adjust - EPSILON)
		) {
			best = { adjust, target: result.target, time: result.time - edge };
		}
	}
	return best
		? { delta: best.time, exact: true, snapTime: best.target.time }
		: { delta: raw, exact: false, snapTime: null };
}

const clamp = (value: number, low: number, high: number) =>
	Math.max(Math.min(low, 0), Math.min(Math.max(high, 0), value));

/**
 * One drag gesture over a fixed project. Snap targets and clamp bounds are
 * computed once; `plan` resolves each pointer position to the edit a
 * release there would make.
 */
export function createGroupDragSession(
	context: GroupDragContext,
	gesture: GroupDragGesture
) {
	const { project } = context;
	const groupIds = dragGroupIds(project, gesture.anchorId, context.selectedIds);
	const direct = segmentsFor(project, groupIds);
	const movers = segmentsFor(project, withLinkedPartners(project, groupIds));
	const targetCache = new Map<boolean, SnapTarget[]>();
	const targetsFor = (excludeLinked: boolean, exclude: readonly string[]) => {
		const cached = targetCache.get(excludeLinked);
		if (cached) {
			return cached;
		}
		const targets = collectSnapTargets(project, {
			exclude: new Set(exclude),
			excludeLinked,
			range: context.range,
			time: context.time,
		});
		targetCache.set(excludeLinked, targets);
		return targets;
	};
	const trimTargetsFor = (linked: boolean) =>
		segmentsFor(
			project,
			linked ? withLinkedPartners(project, groupIds) : groupIds
		);
	const trimLimits = (edge: "start" | "end", linked: boolean) => {
		let low = Number.NEGATIVE_INFINITY;
		let high = Number.POSITIVE_INFINITY;
		for (const segment of trimTargetsFor(linked)) {
			const asset = context.assets.find(
				(candidate) => candidate.id === segment.assetId
			);
			if (!asset) {
				continue;
			}
			// In ripple mode later clips make room, so only the media and the
			// shortest clip bound an edge.
			const bounds = trimBounds(
				context.rippleMode
					? {
							...project,
							segments: project.segments.filter(
								(other) =>
									other.id === segment.id || other.track !== segment.track
							),
						}
					: project,
				segment,
				asset,
				edge
			);
			low = Math.max(low, bounds.low);
			high = Math.min(high, bounds.high);
		}
		return { high, low };
	};
	const snapOptions = (pointer: GroupDragPointer) => ({
		enabled: context.snapEnabled && !pointer.shiftKey,
		fps: project.fps,
		pxPerSec: context.zoom,
	});
	return {
		groupIds,
		plan(pointer: GroupDragPointer): GroupDragPlan {
			const dx = pointer.x - gesture.originX;
			const dy = pointer.y - gesture.originY;
			if (
				!direct.length ||
				Math.abs(dx) + Math.abs(dy) < DRAG_THRESHOLD_PX ||
				context.zoom <= 0
			) {
				return { kind: "none" };
			}
			const raw = dx / context.zoom;
			if (gesture.edge === "move") {
				const snapped = snapGroupDelta(
					movers.flatMap((segment) => [segment.start, clipEnd(segment)]),
					raw,
					targetsFor(true, groupIds),
					snapOptions(pointer)
				);
				const earliest = Math.min(...movers.map((segment) => segment.start));
				const latest = Math.max(...movers.map(clipEnd));
				const lowest = Math.min(...direct.map((segment) => segment.track));
				const highest = Math.max(...direct.map((segment) => segment.track));
				return {
					delta: clamp(snapped.delta, -earliest, TIMELINE_LIMIT - latest),
					directIds: groupIds,
					exact: snapped.exact,
					ids: movers.map((segment) => segment.id),
					kind: pointer.altKey ? "duplicate" : "move",
					snapTime: snapped.snapTime,
					trackDelta:
						clamp(
							Math.round(dy / TRACK_ROW_PX),
							-lowest,
							MAX_DRAG_TRACK - highest
						) || 0,
				};
			}
			const edge = gesture.edge;
			const linked = !pointer.altKey;
			const trimmed = trimTargetsFor(linked);
			const snapped = snapGroupDelta(
				trimmed.map((segment) =>
					edge === "start" ? segment.start : clipEnd(segment)
				),
				raw,
				// Unlinked trims may snap to the partner's edge (to line a cut back up).
				targetsFor(
					linked,
					trimmed.map((segment) => segment.id)
				),
				snapOptions(pointer)
			);
			const limits = trimLimits(edge, linked);
			return {
				delta: clamp(snapped.delta, limits.low, limits.high),
				edge,
				exact: snapped.exact,
				ids: trimmed.map((segment) => segment.id),
				kind: "trim",
				linked,
				snapTime: snapped.snapTime,
			};
		},
	};
}
