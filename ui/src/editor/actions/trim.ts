import { formatMessage } from "@ryu/i18n/core";
import type { LiteralMessage } from "@ryu/i18n/react";
import { type TrimEdge, trimToPlayhead } from "../../../../shared/cut-ops.ts";
import { groupTrim } from "../../../../shared/group-edits.ts";
import { type Segment, segmentDuration } from "../../../../shared/project.ts";
import { trimEdit } from "../../../../shared/trim-modes.ts";
import {
	type DragEdge,
	TRIM_TOOLS,
	type TrimTool,
	toolDragEdit,
} from "../../editing-ui.ts";
import { clock, message } from "../format.ts";
import type { EditorRuntime } from "../runtime.ts";
import { playheadTargets } from "./split.ts";
import type { ActionHandlers } from "./types.ts";

/** English fallback until a caller passes the Companion's `tl`. */
const englishMessages: LiteralMessage = (source, values) =>
	formatMessage(source, values, "en");

/**
 * Q/W and Alt+Q/Alt+W: trim the start or end of the selected clips (or of
 * every unlocked clip under the playhead) to the playhead in one undo step.
 * A ripple trim closes the trimmed span and moves the playhead to where the
 * kept media now starts; a gap trim leaves the space empty.
 */
export function trimClipsToPlayhead(
	runtime: EditorRuntime,
	edge: TrimEdge,
	ripple: boolean,
	clipIds: readonly string[] | undefined = playheadTargets(runtime),
	tl: LiteralMessage = englishMessages
): boolean {
	const { assets, project, time } = runtime;
	if (!project) {
		return false;
	}
	try {
		const result = trimToPlayhead(project, assets, {
			...(clipIds ? { clipIds } : {}),
			edge,
			ripple,
			time,
		});
		const count = result.trimmedIds.length;
		runtime.edit(
			result.project,
			ripple ? `Ripple trim ${edge}` : `Trim ${edge} to playhead`
		);
		runtime.setTime(result.playhead);
		const limited = result.limited
			? ` ${tl(
					"{limitedCount, plural, one {{limited} trim was} other {{limited} trims were}} left a gap: another clip sits in the trimmed span.",
					{ limited: String(result.limited), limitedCount: result.limited }
				)}`
			: "";
		const values = { clipCount: String(count), count, edge, time: clock(time) };
		runtime.setStatus(
			ripple
				? `${tl(
						"Ripple-trimmed the {edge, select, start {start} other {end}} of {count, plural, one {{clipCount} clip} other {{clipCount} clips}} to {time}.",
						values
					)}${limited}`
				: tl(
						"Trimmed the {edge, select, start {start} other {end}} of {count, plural, one {{clipCount} clip} other {{clipCount} clips}} to {time}, leaving a gap.",
						values
					)
		);
	} catch (error) {
		runtime.setStatus(message(error));
	}
	return true;
}

/**
 * Alt+[ / Alt+]: trim the inspected clip's start or end to the playhead,
 * leaving a gap. In ripple mode the trim closes the span instead.
 */
export function trimSelectedToPlayhead(
	runtime: EditorRuntime,
	edge: "start" | "end",
	tl: LiteralMessage = englishMessages
) {
	const { project, selectedSegment, selectedTrackLocked, time } = runtime;
	if (
		project &&
		selectedSegment &&
		!selectedTrackLocked &&
		runtime.store.getState().rippleMode
	) {
		trimClipsToPlayhead(runtime, edge, true, [selectedSegment.id], tl);
		return;
	}
	if (!(project && selectedSegment) || selectedTrackLocked) {
		if (selectedTrackLocked) {
			runtime.setStatus("Unlock this track before trimming its clips.");
		}
		return;
	}
	const asset = runtime.assets.find(
		(candidate) => candidate.id === selectedSegment.assetId
	);
	if (!asset) {
		return;
	}
	const currentEdge =
		edge === "start"
			? selectedSegment.start
			: selectedSegment.start + segmentDuration(selectedSegment);
	try {
		// The group trim fits fades, reveal and exit transitions to the new
		// length and drops a reveal it uncovers, so the edit stays valid.
		const result = groupTrim(project, runtime.assets, {
			clipIds: [selectedSegment.id],
			delta: time - currentEdge,
			edge,
			exact: true,
			linked: false,
			revision: project.revision,
		});
		if (result.applied === 0) {
			return;
		}
		const trimmed =
			result.project.segments.find(
				(segment) => segment.id === selectedSegment.id
			) ?? selectedSegment;
		runtime.edit(result.project, `Trim ${edge} to playhead`);
		runtime.setTime(
			edge === "start"
				? trimmed.start
				: trimmed.start + segmentDuration(trimmed)
		);
		runtime.setStatus(
			tl("Trimmed {edge, select, start {start} other {end}} to {time}.", {
				edge,
				time: clock(time),
			})
		);
	} catch (error) {
		runtime.setStatus(message(error));
	}
}

/**
 * Shown when the razor is dragged: it cuts on click and never moves or trims.
 * (The name predates the razor cut; tests import it under this name.)
 */
export const RAZOR_UNAVAILABLE =
	"The razor cuts on click: click a clip to split it, or Shift-click to cut every track. Press V to move or trim clips.";

/** Apply a ripple/roll/slip/slide drag from the active timeline tool. */
export function applyToolEdit(
	runtime: EditorRuntime,
	segment: Segment,
	edge: DragEdge,
	delta: number,
	tl: LiteralMessage = englishMessages
) {
	const { project, tool } = runtime;
	if (!project) {
		return;
	}
	try {
		const input = toolDragEdit(project, tool, segment, edge, delta);
		if (!input) {
			if (tool === "razor") {
				runtime.setStatus(RAZOR_UNAVAILABLE);
			}
			return;
		}
		const result = trimEdit(project, runtime.assets, input);
		const label =
			TRIM_TOOLS.find((entry) => entry.tool === tool)?.label ?? "Trim";
		runtime.setSelected(segment.id);
		if (result.applied === 0) {
			runtime.setStatus(
				tl("{toolLabel} edit: no room to move this edit any further.", {
					toolLabel: label,
				})
			);
			return;
		}
		runtime.localEdit(
			result.project,
			`${label} edit applied · ${result.applied.toFixed(3)}s${Math.abs(result.applied) + 1e-6 < Math.abs(input.delta) ? " (limited by source media or a neighbouring clip)" : ""}.`
		);
	} catch (error) {
		runtime.setStatus(message(error));
	}
}

const selectTool =
	(tool: TrimTool): NonNullable<ActionHandlers["tool.pointer"]> =>
	(runtime) => {
		runtime.setTool(tool);
	};

/**
 * Tool selection (including the razor, C), Q/W ripple trims, Alt+Q/Alt+W gap
 * trims, and the legacy inspected-clip trims (Alt+[ / Alt+]).
 */
export const trimActions: ActionHandlers = {
	"tool.pointer": selectTool("pointer"),
	"tool.razor": (runtime) => {
		runtime.setTool("razor");
		runtime.setStatus(
			"Razor: click a clip to cut it at the pointer; Shift-click cuts every unlocked track."
		);
	},
	"tool.ripple": selectTool("ripple"),
	"tool.roll": selectTool("roll"),
	"tool.slide": selectTool("slide"),
	"tool.slip": selectTool("slip"),
	"trim.endToPlayhead": (runtime) => trimClipsToPlayhead(runtime, "end", true),
	"trim.endToPlayheadGap": (runtime) =>
		trimClipsToPlayhead(runtime, "end", false),
	"trim.selectedEndToPlayhead": (runtime) => {
		trimSelectedToPlayhead(runtime, "end");
	},
	"trim.selectedStartToPlayhead": (runtime) => {
		trimSelectedToPlayhead(runtime, "start");
	},
	"trim.startToPlayhead": (runtime) =>
		trimClipsToPlayhead(runtime, "start", true),
	"trim.startToPlayheadGap": (runtime) =>
		trimClipsToPlayhead(runtime, "start", false),
};
