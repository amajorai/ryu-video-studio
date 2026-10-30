import { formatMessage } from "@ryu/i18n/core";
import type { LiteralMessage } from "@ryu/i18n/react";
import { type InsertClip, insertClips } from "../../../../shared/insert.ts";
import { overwriteClips } from "../../../../shared/overwrite.ts";
import {
	type Asset,
	newSegment,
	type Project,
	type Segment,
	segmentDuration,
	trackSettingFor,
} from "../../../../shared/project.ts";
import { moveClip } from "../../../../shared/timeline-edits.ts";
import { placeOnNewTrack } from "../../../../shared/track-placement.ts";
import { clock, message } from "../format.ts";
import type { EditorRuntime } from "../runtime.ts";
import type { ActionHandlers } from "./types.ts";

/** English fallback until a caller passes the Companion's `tl`. */
const englishMessages: LiteralMessage = (source, values) =>
	formatMessage(source, values, "en");

const TIMELINE_LIMIT = 7200;

/** Append an asset (optionally a source range of it) at the end of the timeline. */
export function addAssetToTimeline(
	runtime: EditorRuntime,
	asset: Asset,
	sourceRange?: { end: number; start: number }
) {
	const { duration, project } = runtime;
	if (!project) {
		runtime.setStatus("Create a project before adding media to the timeline.");
		return;
	}
	const segment = sourceRange
		? {
				...newSegment(asset, duration),
				sourceIn: sourceRange.start,
				sourceOut: sourceRange.end,
			}
		: newSegment(asset, duration, asset.kind === "audio" ? 1 : 0);
	runtime.edit(
		{ ...project, segments: [...project.segments, segment] },
		`Add ${asset.name}`
	);
	runtime.setSelected(segment.id);
	runtime.setTime(segment.start);
}

/**
 * Move a clip with `moveClip` semantics so linked partners follow. Pointer
 * drags pass `exact`: they are already snapped to frames or to a marker, and
 * a marker between frames must stay the exact snap target.
 */
export function moveLinkedClip(
	runtime: EditorRuntime,
	segment: Segment,
	start: number,
	track: number,
	exact = false
) {
	const { project } = runtime;
	if (!project) {
		return;
	}
	try {
		const next = moveClip(
			project,
			runtime.assets,
			{
				clipId: segment.id,
				revision: project.revision,
				start: Math.max(0, start),
				track,
			},
			{ exact }
		);
		runtime.edit(next, "Move clip");
		runtime.setSelected(segment.id);
		runtime.setTime(
			next.segments.find((candidate) => candidate.id === segment.id)?.start ??
				start
		);
	} catch (error) {
		runtime.setStatus(message(error));
	}
}

/** Move the inspected clip one frame left or right (Alt+arrow). */
export function nudgeSelected(runtime: EditorRuntime, direction: -1 | 1) {
	const { project, selectedSegment, selectedTrackLocked } = runtime;
	if (!(project && selectedSegment) || selectedTrackLocked) {
		if (selectedTrackLocked) {
			runtime.setStatus("Unlock this track before moving its clips.");
		}
		return;
	}
	moveLinkedClip(
		runtime,
		selectedSegment,
		Math.min(
			TIMELINE_LIMIT - segmentDuration(selectedSegment),
			selectedSegment.start + direction / project.fps
		),
		selectedSegment.track
	);
}

/** Insert a copy of the inspected clip at the playhead, rippling later layers. */
export function insertSelectedAtPlayhead(
	runtime: EditorRuntime,
	tl: LiteralMessage = englishMessages
) {
	const { duration, project, selectedSegment, selectedTrackLocked, time } =
		runtime;
	if (!(project && selectedSegment) || selectedTrackLocked) {
		if (selectedTrackLocked) {
			runtime.setStatus("Unlock this track before inserting a clip.");
		}
		return;
	}
	const asset = runtime.assets.find(
		(candidate) => candidate.id === selectedSegment.assetId
	);
	if (!asset || trackSettingFor(project, selectedSegment.track).locked) {
		runtime.setStatus("Unlock this track before inserting a clip.");
		return;
	}
	try {
		const at = Math.max(0, Math.min(duration, time));
		const next = insertClips(
			project,
			runtime.assets,
			at,
			selectedSegment.track,
			[
				{
					assetId: asset.id,
					sourceIn: selectedSegment.sourceIn,
					sourceOut: selectedSegment.sourceOut,
					speed: selectedSegment.speed,
					volume: selectedSegment.volume,
				},
			]
		);
		runtime.edit(next, "Insert clip");
		runtime.setTime(at);
		runtime.setStatus(
			tl("Inserted {assetName} at {time} and rippled later layers.", {
				assetName: asset.name,
				time: clock(at),
			})
		);
	} catch (error) {
		runtime.setStatus(message(error));
	}
}

/** How a library drop lands: overwrite what is there, or ripple-insert. */
export type DropMode = "overwrite" | "insert";

export interface AssetDrop {
	/** Timeline time the clip starts at (already snapped by the caller). */
	at: number;
	mode: DropMode;
	/** Marked source range; absent places the whole asset. */
	sourceIn?: number;
	sourceOut?: number;
	track: number;
}

const INSERT_EDGE_TOLERANCE = 1e-6;

/** Apply a drop to a project; returns the next project and the placed clip id. */
export function applyAssetDrop(
	project: Project,
	assets: readonly Asset[],
	asset: Asset,
	drop: AssetDrop
): { clipId: string; project: Project } {
	const entry: InsertClip = {
		assetId: asset.id,
		sourceIn: drop.sourceIn ?? 0,
		sourceOut: drop.sourceOut,
		speed: 1,
		volume: 1,
	};
	const at = Math.max(0, drop.at);
	// Past the last clip there is nothing to ripple, so insert falls back to overwrite.
	const end = Math.max(
		0,
		...project.segments.map(
			(segment) => segment.start + segmentDuration(segment)
		)
	);
	if (drop.mode === "insert" && at < end - INSERT_EDGE_TOLERANCE) {
		if (trackSettingFor(project, drop.track).locked) {
			throw new Error("Unlock the target track before placing clips.");
		}
		const before = new Set(project.segments.map((segment) => segment.id));
		const next = insertClips(project, assets, at, drop.track, [entry]);
		const placed = next.segments.find(
			(segment) =>
				!before.has(segment.id) &&
				segment.assetId === asset.id &&
				segment.track === drop.track &&
				Math.abs(segment.start - at) < INSERT_EDGE_TOLERANCE
		);
		return { clipId: placed?.id ?? "", project: next };
	}
	const result = overwriteClips(project, assets, [entry], {
		at,
		track: drop.track,
	});
	return { clipId: result.newIds[0] ?? "", project: result.project };
}

/**
 * Drop a library asset on a lane: overwrite by default, ripple-insert with
 * Cmd/Ctrl. One undo step; the placed clip becomes the selection.
 */
export function dropAssetOnTimeline(
	runtime: EditorRuntime,
	asset: Asset,
	drop: AssetDrop,
	tl: LiteralMessage = englishMessages
): boolean {
	const { project } = runtime;
	if (!project) {
		runtime.setStatus("Create a project before adding media to the timeline.");
		return false;
	}
	try {
		const { clipId, project: next } = applyAssetDrop(
			project,
			runtime.assets,
			asset,
			drop
		);
		const verb = drop.mode === "insert" ? "Insert" : "Place";
		runtime.edit(next, `${verb} ${asset.name}`);
		if (clipId) {
			runtime.setSelected(clipId);
		}
		runtime.setTime(Math.max(0, drop.at));
		runtime.setStatus(
			drop.mode === "insert"
				? tl("Inserted {assetName} at {time} and rippled later layers.", {
						assetName: asset.name,
						time: clock(drop.at),
					})
				: tl("Placed {assetName} at {time} on {trackName}.", {
						assetName: asset.name,
						time: clock(drop.at),
						trackName: trackSettingFor(project, drop.track).name,
					})
		);
		return true;
	} catch (error) {
		runtime.setStatus(message(error));
		return false;
	}
}

/**
 * Move the selected clips (or copy them, with `duplicate`) to the first free
 * tracks above them, as one undo step. Copies become the selection.
 */
export function selectionToNewTrack(
	runtime: EditorRuntime,
	duplicate: boolean,
	tl: LiteralMessage = englishMessages
) {
	const { project, selectedIds } = runtime;
	if (!project) {
		return;
	}
	if (!selectedIds.length) {
		runtime.setStatus("Select clips to move to a new track.");
		return;
	}
	try {
		const result = placeOnNewTrack(project, runtime.assets, {
			clipIds: selectedIds,
			duplicate,
			revision: project.revision,
		});
		runtime.edit(
			result.project,
			duplicate ? "Duplicate to new track" : "Move to new track"
		);
		// Seed the multi-selection, then inspect the last clip inside it.
		runtime.store.setState((state) => ({
			selection: { ...state.selection, segmentIds: result.ids },
		}));
		runtime.setSelected(result.ids.at(-1) ?? null);
		runtime.setStatus(
			tl(
				duplicate
					? "Duplicated {clipCount, plural, one {{clipCountLabel} clip} other {{clipCountLabel} clips}} {trackCount, plural, one {{trackCountLabel} track} other {{trackCountLabel} tracks}} up."
					: "Moved {clipCount, plural, one {{clipCountLabel} clip} other {{clipCountLabel} clips}} {trackCount, plural, one {{trackCountLabel} track} other {{trackCountLabel} tracks}} up.",
				{
					clipCount: result.ids.length,
					clipCountLabel: String(result.ids.length),
					trackCount: result.trackDelta,
					trackCountLabel: String(result.trackDelta),
				}
			)
		);
	} catch (error) {
		runtime.setStatus(message(error));
	}
}

const nudge =
	(direction: -1 | 1): NonNullable<ActionHandlers["clip.nudgeLeft"]> =>
	(runtime) => {
		if (!runtime.selectedSegment) {
			// Without a clip, Alt+arrow steps the playhead like a plain arrow.
			return false;
		}
		runtime.setPlaying(false);
		nudgeSelected(runtime, direction);
	};

/**
 * Placement shortcut handlers. Library drops (`dropAssetOnTimeline`) and
 * move or duplicate to a new track (`selectionToNewTrack`) are called from
 * the lanes and the clip context menu; they have no default bindings.
 */
export const placementActions: ActionHandlers = {
	"clip.nudgeLeft": nudge(-1),
	"clip.nudgeRight": nudge(1),
	"insert.selectedAtPlayhead": (runtime) => {
		insertSelectedAtPlayhead(runtime);
	},
};
