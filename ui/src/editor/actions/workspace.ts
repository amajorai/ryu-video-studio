import { shortcutStore } from "../../shortcuts/shortcut-state.ts";
import { maximizePanelAction } from "../../workspace/maximize.ts";
import type { ActionHandlers } from "./types.ts";

/**
 * `?` (and View → Keyboard shortcuts) opens the shortcut dialog, which
 * `App.tsx` mounts as `<ConnectedShortcutsDialog />`.
 */
export const shortcutDialogActions: ActionHandlers = {
	"workspace.shortcuts": () => {
		shortcutStore.openDialog();
	},
};

/** Workspace handlers registered with the shortcut registry. */
export const workspaceActions: ActionHandlers = {
	...shortcutDialogActions,
	"workspace.maximizePanel": maximizePanelAction,
};
