import { cutsInside, splitClips } from "../../../../shared/cut-ops.ts";
import type { Segment } from "../../../../shared/project.ts";
import {
	applySplitEdit,
	applySplitEditRequest,
} from "../../../../shared/split-edits.ts";
import {
	collectSnapTargets,
	quantizeToFrame,
	snap,
} from "../../../../shared/timeline-snap.ts";
import { cutForClip, nearestCut, splitEditStatus } from "../../editing-ui.ts";
import { clock, message } from "../format.ts";
import type { EditorRuntime } from "../runtime.ts";
import type { ActionHandlers } from "./types.ts";

const plural = (count: number, noun: string) =>
	`${count} ${noun}${count === 1 ? "" : "s"}`;

/**
 * The clips a playhead operation (split, trim to playhead) acts on: the
 * selected clips, or `undefined` for every unlocked clip under the playhead.
 */
export function playheadTargets(runtime: EditorRuntime): string[] | undefined {
	return runtime.selectedIds.length ? [...runtime.selectedIds] : undefined;
}

function applySplit(
	runtime: EditorRuntime,
	time: number,
	clipIds: readonly string[] | undefined,
	label?: string
) {
	const { assets, project } = runtime;
	if (!project) {
		return;
	}
	try {
		const result = splitClips(project, assets, {
			...(clipIds ? { clipIds } : {}),
			times: [time],
		});
		runtime.edit(
			result.project,
			label ?? (result.splitCount === 1 ? "Split clip" : "Split clips")
		);
		runtime.setStatus(
			`Split ${plural(result.splitCount, "clip")} at ${clock(time)}.`
		);
	} catch (error) {
		runtime.setStatus(message(error));
	}
}

/**
 * S, Cmd/Ctrl+K and the toolbar split: cut the selected clips at the
 * playhead, or every unlocked clip under it when nothing is selected.
 * Linked partners are always cut with their clip, in one undo step.
 */
export function splitAtPlayhead(runtime: EditorRuntime) {
	applySplit(runtime, runtime.time, playheadTargets(runtime));
}

/** Kept for the toolbar's split button; same as `splitAtPlayhead`. */
export const splitSelected = splitAtPlayhead;

export interface RazorCut {
	/** Pointer position in timeline seconds. */
	at: number;
	segment: Segment;
	/** Cut through every unlocked track instead of the clicked clip only. */
	shiftKey: boolean;
}

/**
 * The razor's cut time: snapped to the playhead, markers, I/O, and other
 * clips' edges while snapping is on, otherwise the nearest frame. A snap
 * that would land outside the clicked clip falls back to the frame.
 */
export function razorTime(runtime: EditorRuntime, cut: RazorCut): number {
	const { project } = runtime;
	if (!project) {
		return cut.at;
	}
	const frame = quantizeToFrame(cut.at, project.fps);
	if (!runtime.store.getState().snapEnabled) {
		return frame;
	}
	const snapped = snap(
		cut.at,
		collectSnapTargets(project, {
			exclude: new Set([cut.segment.id]),
			range: runtime.range,
			time: runtime.time,
		}),
		{ fps: project.fps, pxPerSec: runtime.zoom }
	).time;
	return cutsInside(cut.segment, snapped) ? snapped : frame;
}

/** Razor click: cut the clicked clip (Shift: every track) at the pointer. */
export function razorCut(runtime: EditorRuntime, cut: RazorCut) {
	if (!runtime.project) {
		return;
	}
	const time = razorTime(runtime, cut);
	applySplit(
		runtime,
		time,
		cut.shiftKey ? undefined : [cut.segment.id],
		"Razor cut"
	);
}

/** Apply a manual J/L/straight split edit to the inspected linked clip. */
export function splitEditSelected(
	runtime: EditorRuntime,
	kind: "j" | "l" | "none"
) {
	const { project, selectedSegment, splitSettings } = runtime;
	if (!(project && selectedSegment)) {
		return;
	}
	try {
		const result = applySplitEditRequest(
			project,
			runtime.assets,
			{
				clipId: selectedSegment.id,
				crossfade: splitSettings.crossfade,
				kind,
				offset: splitSettings.offset,
				revision: project.revision,
			},
			runtime.time
		);
		runtime.localEdit(
			result.project,
			splitEditStatus(kind, result.appliedOffset, splitSettings.offset)
		);
	} catch (error) {
		runtime.setStatus(message(error));
	}
}

/**
 * Alt+J / Alt+L: the selected linked clip's cut nearest the playhead (the
 * same cut its inspector buttons edit), else the timeline cut nearest it.
 */
export function splitEditNearestCut(runtime: EditorRuntime, kind: "j" | "l") {
	const { assets, project, selectedSegment, splitSettings, time } = runtime;
	if (!project) {
		return;
	}
	const cut =
		(selectedSegment &&
			cutForClip(project, assets, selectedSegment.id, time)) ??
		nearestCut(project, assets, time);
	if (!cut) {
		runtime.setStatus(
			"No linked audio/video cut on the timeline. Detach or link clip audio first."
		);
		return;
	}
	try {
		const result = applySplitEdit(project, assets, cut, {
			crossfade: splitSettings.crossfade,
			offset: kind === "j" ? -splitSettings.offset : splitSettings.offset,
		});
		runtime.localEdit(
			result.project,
			splitEditStatus(kind, result.appliedOffset, splitSettings.offset)
		);
	} catch (error) {
		runtime.setStatus(message(error));
	}
}

/**
 * Split handlers. S (`split.selected`) and Cmd/Ctrl+K (`split.atPlayhead`)
 * both cut the selection, or every unlocked clip under the playhead.
 */
export const splitActions: ActionHandlers = {
	"split.atPlayhead": (runtime) => {
		if (!runtime.project) {
			return false;
		}
		splitAtPlayhead(runtime);
	},
	"split.selected": (runtime) => {
		splitAtPlayhead(runtime);
	},
	"splitEdit.jCut": (runtime) => {
		splitEditNearestCut(runtime, "j");
	},
	"splitEdit.lCut": (runtime) => {
		splitEditNearestCut(runtime, "l");
	},
	"splitEdit.openPanel": (runtime) => {
		runtime.setPanel("split-edits");
	},
	// Alt+Shift+L is consumed so it never falls through to L (play forward).
	"splitEdit.reserved": () => undefined,
};
