import {
	type ActionId,
	formatCombo,
	type ShortcutBinding,
} from "./defaults.ts";
import { comboLabel, detectKeyPlatform, type KeyPlatform } from "./keys.ts";
import { useShortcutBindings } from "./shortcut-state.ts";

/** An action's current keys, for `aria-keyshortcuts` and a title suffix. */
export interface ActionKeyHint {
	/** Space-separated `aria-keyshortcuts` value; absent when unbound. */
	aria?: string;
	/** Comma-separated keys as the platform writes them; absent when unbound. */
	label?: string;
}

/**
 * The viewer's keys for `actions` (every editor-wide binding, in table order),
 * so buttons describe the keys that actually run them after a rebind. Pass
 * several actions when they run the same handler (Split: `S` and `Cmd+K`).
 */
export function actionKeyHint(
	bindings: readonly ShortcutBinding[],
	actions: ActionId | readonly ActionId[],
	platform: KeyPlatform
): ActionKeyHint {
	const wanted = new Set<ActionId>(
		typeof actions === "string" ? [actions] : actions
	);
	const combos = bindings
		.filter(
			(binding) =>
				wanted.has(binding.action) && (binding.scope ?? "global") === "global"
		)
		.flatMap((binding) => binding.keys);
	if (combos.length === 0) {
		return {};
	}
	const unique = (values: string[]) => [...new Set(values)];
	return {
		aria: unique(combos.map((combo) => formatCombo(combo, platform))).join(" "),
		label: unique(combos.map((combo) => comboLabel(combo, platform))).join(
			", "
		),
	};
}

/** `text (keys)` when the action has keys, else `text`. */
export const withKeyHint = (text: string, hint: ActionKeyHint) =>
	hint.label ? `${text} (${hint.label})` : text;

/** Live key hint for `action` from the viewer's current bindings. */
export function useActionKeyHint(
	actions: ActionId | readonly ActionId[]
): ActionKeyHint {
	return actionKeyHint(useShortcutBindings(), actions, detectKeyPlatform());
}
