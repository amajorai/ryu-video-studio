import {
	zoomTimeline,
	zoomTimelineToFit,
} from "../../timeline/useTimelineZoom.ts";
import { stepZoom } from "../../timeline/zoom-math.ts";
import type { EditorRuntime } from "../runtime.ts";
import type { ActionHandlers } from "./types.ts";

/** `+`/`-`: one zoom step, keeping the playhead (or the view center) in place. */
export function stepTimelineZoom(runtime: EditorRuntime, direction: 1 | -1) {
	const { store } = runtime;
	return zoomTimeline(
		store,
		stepZoom(store.getState().zoomPxPerSec, direction)
	);
}

/** Shift+Z: fit the whole timeline into the visible lanes. */
export function fitTimelineZoom(runtime: EditorRuntime) {
	return zoomTimelineToFit(runtime.store, runtime.duration);
}

/** Timeline zoom handlers (+/=, -, Shift+Z). */
export const zoomActions: ActionHandlers = {
	"zoom.fit": (runtime) => {
		fitTimelineZoom(runtime);
	},
	"zoom.in": (runtime) => {
		stepTimelineZoom(runtime, 1);
	},
	"zoom.out": (runtime) => {
		stepTimelineZoom(runtime, -1);
	},
};
