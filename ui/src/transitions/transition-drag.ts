/**
 * Drag payload for a gallery transition (W2-V10). A timeline drop target reads
 * it with `readTransitionDrag` and applies it to the cut under the pointer
 * with `cutNear` + `applyRevealTransition` (`shared/transitions.ts`).
 */
import {
	isRevealTransition,
	type RevealTransition,
} from "../../../shared/reveal-transitions.ts";

export const TRANSITION_DRAG_TYPE = "application/x-ryu-video-transition";

/** Minimal `DataTransfer` surface, so tests can pass a plain object. */
interface TransferLike {
	getData(format: string): string;
	setData(format: string, data: string): void;
	types: readonly string[];
}

export function writeTransitionDrag(
	transfer: Pick<TransferLike, "setData">,
	type: RevealTransition
): void {
	transfer.setData(TRANSITION_DRAG_TYPE, type);
	transfer.setData("text/plain", `transition:${type}`);
}

/** Whether a drag carries a transition (readable during `dragover`). */
export const carriesTransition = (transfer: Pick<TransferLike, "types">) =>
	transfer.types.includes(TRANSITION_DRAG_TYPE);

/** The dropped transition, or undefined for other drags or unknown values. */
export function readTransitionDrag(
	transfer: Pick<TransferLike, "getData">
): RevealTransition | undefined {
	const value = transfer.getData(TRANSITION_DRAG_TYPE);
	return isRevealTransition(value) ? value : undefined;
}
