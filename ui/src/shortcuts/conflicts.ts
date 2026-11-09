import type { ShortcutEventLike } from "../editor/actions/types.ts";
import type { KeyCombo, ShortcutBinding } from "./defaults.ts";
import { codeForCharacter, comboCharacter, comboId } from "./keys.ts";
import { matchesCombo } from "./registry.ts";

/**
 * Conflict detection follows the registry's own dispatch rule: bindings are
 * tried in table order and the first match wins. A chord is in conflict when
 * pressing it plainly (every unconstrained modifier up) reaches an earlier
 * binding first, so the later binding never sees it. Deliberate refinements
 * in the default table, such as `Shift+Delete` (ripple delete) ahead of
 * `Delete`, or the preview-only crop key ahead of the razor, are not
 * conflicts because the earlier binding only claims part of the chord space.
 */
export interface ShortcutConflict {
	/** Binding ids that share a chord in the same scope, in priority order. */
	bindingIds: string[];
	/** The later binding's chord that the earlier binding claims. */
	combo: KeyCombo;
}

type EventShape = Pick<
	ShortcutEventLike,
	"altKey" | "code" | "ctrlKey" | "key" | "metaKey" | "shiftKey"
>;

/** The keydown a viewer makes for `combo`, with unconstrained modifiers up. */
export function plainEventFor(combo: KeyCombo): EventShape {
	const key = combo.key ?? comboCharacter(combo);
	return {
		altKey: combo.alt ?? false,
		code: combo.code ?? codeForCharacter(key),
		ctrlKey: false,
		key,
		metaKey: combo.cmd ?? false,
		shiftKey: combo.shift ?? false,
	};
}

const scopeOf = (binding: ShortcutBinding) => binding.scope ?? "global";

/**
 * Whether `earlier` would take `combo` (a chord of a binding in `laterScope`)
 * before it. Preview-scoped bindings only claim keys pressed inside the
 * preview, so they never fully shadow a global chord.
 */
function claims(
	earlier: ShortcutBinding,
	combo: KeyCombo,
	laterScope: ShortcutBinding["scope"]
): KeyCombo | null {
	if (scopeOf(earlier) === "preview" && (laterScope ?? "global") === "global") {
		return null;
	}
	const event = plainEventFor(combo);
	return (
		earlier.keys.find((candidate) => matchesCombo(candidate, event)) ?? null
	);
}

/** Every chord in `bindings` that an earlier binding claims, in table order. */
export function findShortcutConflicts(
	bindings: readonly ShortcutBinding[]
): ShortcutConflict[] {
	const conflicts: ShortcutConflict[] = [];
	for (const [index, later] of bindings.entries()) {
		const seen = new Set<string>();
		for (const combo of later.keys) {
			const id = comboId(combo);
			if (seen.has(id)) {
				continue;
			}
			seen.add(id);
			const winner = bindings
				.slice(0, index)
				.find(
					(earlier) =>
						earlier.id !== later.id && claims(earlier, combo, later.scope)
				);
			if (winner) {
				conflicts.push({ bindingIds: [winner.id, later.id], combo });
			}
		}
	}
	return conflicts;
}

/** A clash between a proposed chord and another binding's chord. */
export interface ComboClash {
	/** The other binding's chord involved (removed by a reassign). */
	combo: KeyCombo;
	/** The other binding. */
	otherId: string;
	/** `steals`: the other binding comes first and would take the new chord; `shadows`: the new chord would take this one. */
	relation: "shadows" | "steals";
}

/**
 * What assigning `combo` to `bindingId` would collide with, checked in both
 * directions: an earlier binding that would take the new chord, and a later
 * binding whose plain chord the new one would take.
 */
export function clashesForCombo(
	bindings: readonly ShortcutBinding[],
	bindingId: string,
	combo: KeyCombo
): ComboClash[] {
	const index = bindings.findIndex((binding) => binding.id === bindingId);
	const target = bindings[index];
	if (!target) {
		return [];
	}
	const proposed: ShortcutBinding = { ...target, keys: [combo] };
	const clashes: ComboClash[] = [];
	for (const [position, other] of bindings.entries()) {
		if (other.id === bindingId) {
			continue;
		}
		if (position < index) {
			const claimed = claims(other, combo, target.scope);
			if (claimed) {
				clashes.push({ combo: claimed, otherId: other.id, relation: "steals" });
			}
			continue;
		}
		for (const otherCombo of other.keys) {
			if (claims(proposed, otherCombo, other.scope)) {
				clashes.push({
					combo: otherCombo,
					otherId: other.id,
					relation: "shadows",
				});
			}
		}
	}
	return clashes;
}

/**
 * OS-wide accelerators Ryu itself registers by default (the island's
 * `globalShortcut` push-to-talk and command bar, and desktop dictation; see the
 * desktop's `global: true` hotkeys). The OS takes these chords before the
 * Companion webview sees them, so a Video Studio binding on one never fires.
 */
export const PLATFORM_RESERVED_CHORDS: readonly {
	accelerator: string;
	combo: KeyCombo;
	label: string;
}[] = [
	{
		accelerator: "Mod+Shift+Space",
		combo: { alt: false, cmd: true, code: "Space", key: " ", shift: true },
		label: "Ryu command bar",
	},
	{
		accelerator: "Mod+Shift+A",
		combo: { alt: false, cmd: true, code: "KeyA", key: "a", shift: true },
		label: "Ryu push-to-talk",
	},
	{
		accelerator: "Mod+Shift+D",
		combo: { alt: false, cmd: true, code: "KeyD", key: "d", shift: true },
		label: "Ryu dictation",
	},
];

/** The platform-wide chord that pressing `combo` plainly would trigger, if any. */
export function reservedChordFor(
	combo: KeyCombo
): (typeof PLATFORM_RESERVED_CHORDS)[number] | undefined {
	const event = plainEventFor(combo);
	return PLATFORM_RESERVED_CHORDS.find(
		(reserved) =>
			event.metaKey === (reserved.combo.cmd ?? false) &&
			event.altKey === (reserved.combo.alt ?? false) &&
			event.shiftKey === (reserved.combo.shift ?? false) &&
			(event.code === reserved.combo.code ||
				event.key.toLowerCase() === reserved.combo.key)
	);
}
