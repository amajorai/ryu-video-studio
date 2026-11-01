import { formatMessage } from "@ryu/i18n/core";
import type { LiteralMessage } from "@ryu/i18n/react";
import { selectAll, selectForward } from "../../../../shared/selection.ts";
import type { EditorRuntime } from "../runtime.ts";
import type { EditorSelection } from "../store.ts";
import type { ActionHandlers } from "./types.ts";

/** English fallback until a caller passes the Companion's `tl`. */
const englishMessages: LiteralMessage = (source, values) =>
	formatMessage(source, values, "en");

/**
 * Replace the clip selection with `ids`. The inspected clip stays the same
 * when it is still selected, otherwise the last id becomes it.
 */
export function selectClips(runtime: EditorRuntime, ids: readonly string[]) {
	const { primaryId } = runtime.store.getState().selection;
	const primary =
		primaryId && ids.includes(primaryId) ? primaryId : (ids.at(-1) ?? null);
	runtime.store.setState((state): { selection: EditorSelection } => ({
		selection: {
			...state.selection,
			overlayIds: [],
			primaryId: null,
			segmentIds: [...ids],
		},
	}));
	runtime.setSelected(primary);
}

/** Clear the clip and overlay selection. */
export function clearSelection(runtime: EditorRuntime) {
	runtime.store.setState((state) => ({
		selection: { ...state.selection, overlayIds: [] },
	}));
	runtime.setSelected(null);
}

/** The track of the inspected clip, or a status asking for one. */
function selectedTrack(runtime: EditorRuntime): number | null {
	const track = runtime.selectedSegment?.track;
	if (track === undefined) {
		runtime.setStatus("Select a clip to choose its track first.");
		return null;
	}
	return track;
}

function applySelection(
	runtime: EditorRuntime,
	ids: readonly string[],
	empty: string,
	tl: LiteralMessage = englishMessages
) {
	if (!ids.length) {
		runtime.setStatus(empty);
		return;
	}
	selectClips(runtime, ids);
	runtime.setStatus(
		tl(
			"{count, plural, one {Selected {total} clip.} other {Selected {total} clips.}}",
			{ count: ids.length, total: String(ids.length) }
		)
	);
}

function forward(runtime: EditorRuntime, track?: number) {
	const { project, time } = runtime;
	if (!project) {
		return;
	}
	applySelection(
		runtime,
		selectForward(project, time, track === undefined ? {} : { track }),
		"No unlocked clips start after the playhead."
	);
}

function all(runtime: EditorRuntime, track?: number) {
	const { project } = runtime;
	if (!project) {
		return;
	}
	applySelection(
		runtime,
		selectAll(project, track === undefined ? {} : { track }),
		"There are no unlocked clips to select."
	);
}

/**
 * Escape: cancel an in-flight timeline gesture first, otherwise clear the
 * selection. Declines (so other Escape handlers run) when there is neither.
 */
export function cancelOrClear(runtime: EditorRuntime): boolean {
	const state = runtime.store.getState();
	if (state.drag) {
		runtime.store.setState({ drag: null, snapGuideTime: null });
		return true;
	}
	if (state.selection.segmentIds.length || state.selection.overlayIds.length) {
		clearSelection(runtime);
		return true;
	}
	return false;
}

/**
 * Selection handlers: select forward (A / Shift+A), select all, and Escape.
 * Ctrl+Y redo (`history.redoAlt`) ships here too because the plan assigns it
 * to the selection work (gap G04); it is the same redo as Cmd+Shift+Z.
 */
export const selectActions: ActionHandlers = {
	"history.redoAlt": (runtime) => {
		runtime.redo();
	},
	"select.all": (runtime) => {
		all(runtime);
	},
	"select.allOnTrack": (runtime) => {
		const track = selectedTrack(runtime);
		if (track !== null) {
			all(runtime, track);
		}
	},
	"select.cancel": (runtime) => cancelOrClear(runtime),
	"select.forwardAllTracks": (runtime) => {
		forward(runtime);
	},
	"select.forwardOnTrack": (runtime) => {
		const track = selectedTrack(runtime);
		if (track !== null) {
			forward(runtime, track);
		}
	},
};
