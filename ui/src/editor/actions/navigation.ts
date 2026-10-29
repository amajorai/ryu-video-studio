import {
	nextEditPoint,
	nextMarkerPoint,
	previousEditPoint,
	previousMarkerPoint,
} from "../../../../shared/edit-points.ts";
import { activeSourceTransport } from "../../preview/source-tabs.ts";
import { clock } from "../format.ts";
import type { EditorRuntime } from "../runtime.ts";
import type { ActionHandlers } from "./types.ts";

/** Smallest I/O range, matching the sidecar's ripple-delete bound. */
const MIN_RANGE = 0.04;

export function markRangeStart(runtime: EditorRuntime) {
	const { duration, range, time } = runtime;
	const next = Math.min(duration, Math.max(0, time));
	runtime.setRangeStart(next);
	if (range.end <= next + MIN_RANGE) {
		runtime.setRangeEnd(Math.min(duration, next + 1));
	}
	runtime.setRangeMarked(true);
	runtime.setStatus(`Range start set to ${clock(next)}.`);
}

export function markRangeEnd(runtime: EditorRuntime) {
	const { duration, range, time } = runtime;
	const next = Math.min(duration, Math.max(0, time));
	if (next <= range.start + MIN_RANGE) {
		runtime.setStatus(
			"Move the playhead after the range start before marking its end."
		);
		return;
	}
	runtime.setRangeEnd(next);
	runtime.setRangeMarked(true);
	runtime.setStatus(`Range end set to ${clock(next)}.`);
}

/** Hide the I/O range (Alt+X); the next I or O marks a new one. */
export function clearRange(
	runtime: Pick<EditorRuntime, "rangeMarked" | "setRangeMarked" | "setStatus">
) {
	if (!runtime.rangeMarked) {
		return false;
	}
	runtime.setRangeMarked(false);
	runtime.setStatus("Range cleared.");
	return true;
}

/** Stop and move the playhead by `seconds`, clamped to the timeline. */
export function stepPlayhead(runtime: EditorRuntime, seconds: number) {
	runtime.setPlaying(false);
	runtime.setTime(
		Math.max(0, Math.min(runtime.duration, runtime.time + seconds))
	);
}

const frameStep = (runtime: EditorRuntime) => 1 / (runtime.project?.fps ?? 30);

/**
 * Up/Down: stop and move the playhead to the previous or next clip edge on
 * a visible track. Returns the new time, or null when there is none.
 */
export function goToEditPoint(
	runtime: EditorRuntime,
	direction: -1 | 1
): number | null {
	const { project, time } = runtime;
	if (!project) {
		return null;
	}
	const target =
		direction > 0
			? nextEditPoint(project, time)
			: previousEditPoint(project, time);
	if (target === null) {
		runtime.setStatus(
			direction > 0 ? "No later edit point." : "No earlier edit point."
		);
		return null;
	}
	runtime.setPlaying(false);
	runtime.setTime(Math.min(runtime.duration, target));
	return target;
}

/**
 * Shift+Up/Down: stop and move the playhead to the previous or next marker
 * (range markers stop at both ends). Unlike `[`/`]`, this does not wrap.
 */
export function goToMarkerPoint(
	runtime: EditorRuntime,
	direction: -1 | 1
): number | null {
	const { project, time } = runtime;
	if (!project) {
		return null;
	}
	if (!project.markers.length) {
		runtime.setStatus("Add a timeline marker before navigating markers.");
		return null;
	}
	const target =
		direction > 0
			? nextMarkerPoint(project, time)
			: previousMarkerPoint(project, time);
	if (target === null) {
		runtime.setStatus(
			direction > 0 ? "No later marker." : "No earlier marker."
		);
		return null;
	}
	runtime.setPlaying(false);
	runtime.setTime(Math.min(runtime.duration, target));
	runtime.setStatus(`Marker at ${clock(target)}.`);
	return target;
}

/** Playhead navigation, edit-point and marker stepping, and I/O marks. */
export const navigationActions: ActionHandlers = {
	"navigation.end": (runtime) => {
		runtime.setPlaying(false);
		runtime.setPlaybackDirection(-1);
		runtime.setTime(runtime.duration);
	},
	"navigation.markIn": (runtime) => {
		const source = activeSourceTransport(runtime.store);
		if (source) {
			source.markIn();
			return;
		}
		markRangeStart(runtime);
	},
	"navigation.markOut": (runtime) => {
		const source = activeSourceTransport(runtime.store);
		if (source) {
			source.markOut();
			return;
		}
		markRangeEnd(runtime);
	},
	"navigation.nextEdit": (runtime) => {
		goToEditPoint(runtime, 1);
	},
	"navigation.nextMarker": (runtime) => {
		goToMarkerPoint(runtime, 1);
	},
	"navigation.previousEdit": (runtime) => {
		goToEditPoint(runtime, -1);
	},
	"navigation.clearRange": (runtime) =>
		clearRange(runtime) ? undefined : false,
	"navigation.jumpBack5": (runtime) => {
		stepPlayhead(runtime, -5);
	},
	"navigation.jumpForward5": (runtime) => {
		stepPlayhead(runtime, 5);
	},
	"navigation.previousMarker": (runtime) => {
		goToMarkerPoint(runtime, -1);
	},
	"navigation.start": (runtime) => {
		runtime.setPlaying(false);
		runtime.setPlaybackDirection(1);
		runtime.setTime(0);
	},
	"navigation.stepBackFrame": (runtime) => {
		stepPlayhead(runtime, -frameStep(runtime));
	},
	"navigation.stepBackSecond": (runtime) => {
		stepPlayhead(runtime, -1);
	},
	"navigation.stepForwardFrame": (runtime) => {
		stepPlayhead(runtime, frameStep(runtime));
	},
	"navigation.stepForwardSecond": (runtime) => {
		stepPlayhead(runtime, 1);
	},
};
