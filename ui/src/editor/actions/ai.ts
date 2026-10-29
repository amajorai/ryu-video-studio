import {
	type HandoffScope,
	handoffScope,
	markedRange,
} from "../../agent/agent-bridge.ts";
import type { EditorRuntime } from "../runtime.ts";
import type { ActionHandler, ActionHandlers } from "./types.ts";

type HandoffListener = (scope: HandoffScope) => void;

/**
 * The runtime fields the handoff reads. `rangeMarked` is set by mark in/out
 * and the range toolbar and cleared when a project opens; callers without it
 * fall back to treating the editor's untouched default range as unmarked.
 */
type HandoffRuntime = Pick<EditorRuntime, "project" | "range" | "selectedIds"> &
	Partial<Pick<EditorRuntime, "rangeMarked">>;

const handoffListeners = new Set<HandoffListener>();

/** The agent handoff scope for the editor's current selection and range. */
export function handoffScopeFor(runtime: HandoffRuntime): HandoffScope {
	return handoffScope({
		range: markedRange(runtime.range, runtime.rangeMarked),
		segments: runtime.project?.segments ?? [],
		selectedIds: runtime.selectedIds,
	});
}

/**
 * Subscribe a mounted handoff surface to "Ask agent" requests. Returns the
 * unsubscribe function.
 */
export function onAgentHandoffRequest(listener: HandoffListener): () => void {
	handoffListeners.add(listener);
	return () => {
		handoffListeners.delete(listener);
	};
}

/** Whether a handoff surface is mounted to receive "Ask agent" requests. */
export function agentHandoffAvailable(): boolean {
	return handoffListeners.size > 0;
}

/**
 * Open the agent handoff for the current selection or range. Returns false
 * when no project is open or no handoff surface is mounted, so a shortcut
 * or menu item can report "Not available" instead of doing nothing.
 */
export function requestAgentHandoff(
	runtime: HandoffRuntime,
	scopeOverride?: HandoffScope
): boolean {
	if (!runtime.project || handoffListeners.size === 0) {
		return false;
	}
	const scope = scopeOverride ?? handoffScopeFor(runtime);
	for (const listener of handoffListeners) {
		listener(scope);
	}
	return true;
}

/** "Ask agent about selection or range"; declines when it cannot open. */
export const askAgentHandler: ActionHandler = (runtime) =>
	requestAgentHandoff(runtime) ? undefined : false;

/**
 * Agent handoff and AI edit handlers, keyed by shortcut action id. Menus can
 * also call `requestAgentHandoff` directly.
 */
export const aiActions: ActionHandlers = {
	"ai.askAgent": askAgentHandler,
};
