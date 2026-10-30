import type { ActionHandler } from "../editor/actions/types.ts";
import type { EditorStore } from "../editor/store.ts";
import { panelContaining, type WorkspacePanel } from "./layout-presets.ts";

/**
 * Maximize the panel holding `focus`, or restore the full workspace when a
 * panel is already maximized. Returns the panel now maximized, or null.
 */
export function toggleFocusedPanel(
	store: EditorStore,
	focus: Element | null
): WorkspacePanel | null {
	const current = store.getState().maximizedPanel;
	const next = current === null ? panelContaining(focus) : null;
	store.setState({ maximizedPanel: next });
	return next;
}

function activeElement(): Element | null {
	return typeof document === "undefined" ? null : document.activeElement;
}

/**
 * The `workspace.maximizePanel` handler (backtick). Register it in the
 * workspace action group: `"workspace.maximizePanel": maximizePanelAction`.
 */
export const maximizePanelAction: ActionHandler = (runtime, event) => {
	const target = event?.target;
	const focus =
		target && typeof (target as Element).closest === "function"
			? (target as Element)
			: activeElement();
	toggleFocusedPanel(runtime.store, focus);
};
