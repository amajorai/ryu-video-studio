import {
	projectDuration,
	rippleDeleteRange,
} from "../../../../shared/project.ts";
import {
	rippleDeleteGap,
	rippleRemoveClips,
} from "../../../../shared/ripple-edits.ts";
import { withoutClips } from "../../../../shared/timeline-edits.ts";
import { clock, message } from "../format.ts";
import type { EditorRuntime } from "../runtime.ts";
import type { ActionHandlers } from "./types.ts";

/** Delete the selection and its linked partners, leaving gaps. */
export function deleteSelected(runtime: EditorRuntime) {
	const { deletion, project } = runtime;
	if (!(project && deletion?.ids.size)) {
		return;
	}
	if (deletion.locked) {
		runtime.setStatus("Unlock every affected clip track before deleting.");
		return;
	}
	runtime.edit(
		// The shared removal also drops references to the clips and reveals
		// left without a predecessor, so the result stays saveable.
		withoutClips(project, deletion.ids),
		"Delete clips"
	);
	runtime.setSelected(null);
}

/**
 * Shift+Delete (and Delete in ripple mode): remove the selection with its
 * linked partners and close each span it covered, in one undo step.
 * Returns false when nothing is selected so the key falls through.
 */
export function rippleDeleteSelection(runtime: EditorRuntime): boolean {
	const { assets, project, selectedIds, time } = runtime;
	if (!(project && selectedIds.length)) {
		return false;
	}
	try {
		const result = rippleRemoveClips(project, assets, selectedIds);
		const removed = project.segments.length - result.project.segments.length;
		runtime.edit(result.project, "Ripple delete");
		runtime.setSelected(null);
		runtime.setTime(Math.min(time, projectDuration(result.project)));
		const status = `Ripple-deleted ${removed} clip${removed === 1 ? "" : "s"}.`;
		runtime.setStatus(
			result.unclosed
				? `${status} ${result.unclosed} gap${result.unclosed === 1 ? "" : "s"} stayed open because other clips still cover ${result.unclosed === 1 ? "it" : "them"}.`
				: status
		);
	} catch (error) {
		runtime.setStatus(message(error));
	}
	return true;
}

/** Ripple Delete Gap: close the empty span on `track` at `time`. */
export function rippleDeleteGapAt(
	runtime: EditorRuntime,
	track: number,
	time: number
) {
	const { assets, project } = runtime;
	if (!project) {
		return;
	}
	try {
		const result = rippleDeleteGap(project, assets, { time, track });
		runtime.edit(result.project, "Ripple delete gap");
		runtime.setStatus(
			`Closed a ${clock(result.gap.end - result.gap.start)} gap on track ${track + 1}.`
		);
	} catch (error) {
		runtime.setStatus(message(error));
	}
}

/**
 * Toggle ripple mode: Delete, the Alt+[ / Alt+] trims, and pointer-tool
 * edge trims and moves (`timeline/clip-drag.ts`) close the gaps they make.
 */
export function toggleRippleMode(runtime: EditorRuntime) {
	const rippleMode = !runtime.store.getState().rippleMode;
	runtime.store.setState({ rippleMode });
	runtime.setStatus(
		rippleMode
			? "Ripple mode on: deleting, trimming or moving a clip closes the gap it leaves."
			: "Ripple mode off: deleting, trimming or moving a clip leaves a gap."
	);
}

/** Ripple-delete the I/O range across every layer. */
export function deleteRange(runtime: EditorRuntime) {
	const { project, range, selectedId, time } = runtime;
	if (!project) {
		return;
	}
	try {
		const deleted = range.end - range.start;
		const next = rippleDeleteRange(
			project,
			runtime.assets,
			range.start,
			range.end
		);
		const nextDuration = projectDuration(next);
		runtime.edit(next, "Ripple delete range");
		if (
			selectedId &&
			!next.segments.some((segment) => segment.id === selectedId)
		) {
			runtime.setSelected(null);
		}
		runtime.setTime(Math.min(time, nextDuration));
		const nextRangeStart = Math.min(range.start, nextDuration);
		runtime.setRangeStart(nextRangeStart);
		runtime.setRangeEnd(Math.min(nextDuration, nextRangeStart + 1));
		// The default span left behind is not a range the user marked.
		runtime.setRangeMarked(false);
		runtime.setStatus(`Ripple-deleted ${clock(deleted)} from the timeline.`);
	} catch (error) {
		runtime.setStatus(message(error));
	}
}

/**
 * Map silent source ranges of one asset onto every clip that uses it, merge
 * them, and ripple-delete them from the latest range backwards.
 */
export function removeDetectedSilence(
	runtime: EditorRuntime,
	assetId: string,
	assetName: string,
	sourceRanges: readonly [number, number][]
) {
	const { project, selectedId, time } = runtime;
	if (!project) {
		return;
	}
	const timelineRanges = project.segments
		.filter((segment) => segment.assetId === assetId)
		.flatMap((segment) =>
			sourceRanges.flatMap(([sourceStart, sourceEnd]): [number, number][] => {
				const start = Math.max(sourceStart, segment.sourceIn);
				const end = Math.min(sourceEnd, segment.sourceOut);
				return end - start >= 0.04
					? [
							[
								segment.start + (start - segment.sourceIn) / segment.speed,
								segment.start + (end - segment.sourceIn) / segment.speed,
							],
						]
					: [];
			})
		)
		.sort((a, b) => a[0] - b[0]);
	const merged: [number, number][] = [];
	for (const range of timelineRanges) {
		const previous = merged.at(-1);
		if (previous && range[0] <= previous[1]) {
			previous[1] = Math.max(previous[1], range[1]);
		} else {
			merged.push([...range]);
		}
	}
	if (!merged.length) {
		runtime.setStatus(
			`Add ${assetName} to the timeline before removing silence.`
		);
		return;
	}
	let next = project;
	let removed = 0;
	try {
		for (const [start, end] of [...merged].reverse()) {
			next = rippleDeleteRange(next, runtime.assets, start, end);
			removed += end - start;
		}
	} catch (error) {
		runtime.setStatus(message(error));
		return;
	}
	runtime.edit(next, "Remove silence");
	if (
		selectedId &&
		!next.segments.some((segment) => segment.id === selectedId)
	) {
		runtime.setSelected(null);
	}
	runtime.setTime(Math.min(time, projectDuration(next)));
	runtime.setStatus(
		`Removed ${clock(removed)} of detected silence from ${assetName}.`
	);
}

/**
 * Delete, ripple delete (Shift+Delete), the ripple-mode toggle, and range
 * ripple. In ripple mode a plain Delete ripples too.
 */
export const rippleActions: ActionHandlers = {
	"clip.delete": (runtime) => {
		if (!runtime.selectedId || runtime.selectedTrackLocked) {
			return false;
		}
		if (runtime.store.getState().rippleMode) {
			return rippleDeleteSelection(runtime);
		}
		deleteSelected(runtime);
	},
	"ripple.deleteRange": (runtime) => {
		deleteRange(runtime);
	},
	"ripple.deleteSelection": (runtime) => rippleDeleteSelection(runtime),
	"ripple.toggleMode": (runtime) => {
		toggleRippleMode(runtime);
	},
};
