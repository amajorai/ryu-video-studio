import { MAX_TRACK_INDEX } from "../../../shared/limits.ts";
import type { DragEdge } from "../editing-ui.ts";

/** Pointer travel (|dx| + |dy| in px) below which a press is a click, not a drag. */
export const DRAG_THRESHOLD_PX = 4;
/** Width of the trim zone at each clip edge, in px. */
export const EDGE_HANDLE_PX = 10;
/** Height of one track row; vertical drags change track every row. */
export const TRACK_ROW_PX = 54;
/** Highest track a pointer drag can reach. */
export const MAX_DRAG_TRACK = MAX_TRACK_INDEX;
export const TIMELINE_LIMIT = 7200;

/** Which part of a clip a press at `clientX` grabs. */
export function dragEdgeAt(
	bounds: { left: number; right: number },
	clientX: number
): DragEdge {
	if (clientX - bounds.left < EDGE_HANDLE_PX) {
		return "start";
	}
	if (bounds.right - clientX < EDGE_HANDLE_PX) {
		return "end";
	}
	return "move";
}
