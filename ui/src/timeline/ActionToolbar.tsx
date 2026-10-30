import { Magnet01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { RyuAppActions } from "@ryu/blocks/companion/app-ui";
import { Button } from "@ryu/blocks/companion/controls";
import { useEditorProject } from "../editor/context.tsx";
import { type EditorState, useEditorStore } from "../editor/store.ts";
import { ACTIONS, type ActionId, formatCombo } from "../shortcuts/defaults.ts";
import { comboLabel, detectKeyPlatform } from "../shortcuts/keys.ts";
import { runAction } from "../shortcuts/registry.ts";
import { useShortcutBindings } from "../shortcuts/shortcut-state.ts";

interface ToolbarEntry {
	action: ActionId;
	/** Toggle state read from the editor store, for `aria-pressed`. */
	pressed?: (state: EditorState) => boolean;
	/** Shown in the button; the full label stays the accessible name. */
	short: string;
}

/**
 * The `toolbar: true` actions other than "Split at playhead" (which keeps
 * its own button in `TimelineToolbar`), in display order. A test keeps this
 * list in step with `ACTIONS`.
 */
export const ACTION_TOOLBAR_ENTRIES: readonly ToolbarEntry[] = [
	{
		action: "tool.razor",
		pressed: (state) => state.tool === "razor",
		short: "Razor",
	},
	{ action: "trim.startToPlayhead", short: "Trim start" },
	{ action: "trim.endToPlayhead", short: "Trim end" },
	{
		action: "ripple.toggleMode",
		pressed: (state) => state.rippleMode,
		short: "Ripple",
	},
	{
		action: "snapping.toggle",
		pressed: (state) => state.snapEnabled,
		short: "Snap",
	},
	{
		action: "playback.toggleLoop",
		pressed: (state) => state.loop.mode !== "off",
		short: "Loop",
	},
	{
		action: "preview.toggleGuides",
		pressed: (state) => state.guides.size > 0,
		short: "Guides",
	},
	{ action: "export.range", short: "Export range" },
];

/**
 * Toolbar buttons for the editor actions declared with `toolbar: true`:
 * razor, ripple trims to the playhead, ripple mode, the snapping magnet,
 * loop, preview guides and export range. Each runs the same handler as its
 * shortcut, and its title names the viewer's current key.
 */
export function ActionToolbar() {
	const runtime = useEditorProject();
	// One string per render so unrelated store changes (drags, scrolls)
	// do not re-render the toolbar.
	const pressedKey = useEditorStore(runtime.store, (current) =>
		ACTION_TOOLBAR_ENTRIES.map((entry) =>
			entry.pressed?.(current) ? "1" : "0"
		).join("")
	);
	const bindings = useShortcutBindings();
	const platform = detectKeyPlatform();
	const comboFor = (action: ActionId) =>
		bindings.find(
			(binding) => binding.action === action && binding.keys.length > 0
		)?.keys[0];
	return (
		<RyuAppActions aria-label="Timeline tools" role="toolbar">
			{ACTION_TOOLBAR_ENTRIES.map(({ action, pressed, short }, index) => {
				const label = ACTIONS[action].label;
				const combo = comboFor(action);
				const key = combo ? comboLabel(combo, platform) : undefined;
				const isPressed = pressed ? pressedKey[index] === "1" : undefined;
				return (
					<Button
						aria-keyshortcuts={combo ? formatCombo(combo, platform) : undefined}
						aria-label={label}
						aria-pressed={isPressed}
						data-toolbar-action={action}
						disabled={runtime.busy}
						key={action}
						onClick={() => runAction(action, runtime)}
						size="sm"
						title={key ? `${label} (${key})` : label}
						variant={isPressed ? "secondary" : "ghost"}
					>
						{action === "snapping.toggle" ? (
							<HugeiconsIcon className="size-3.5" icon={Magnet01Icon} />
						) : null}
						{short}
					</Button>
				);
			})}
		</RyuAppActions>
	);
}
