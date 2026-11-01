import { bindingLabel } from "./catalog.ts";
import type { ShortcutConflict } from "./conflicts.ts";
import type { KeyCombo, ShortcutBinding } from "./defaults.ts";
import { comboLabel, type KeyPlatform } from "./keys.ts";
import { narrowedClashCombo } from "./persistence.ts";

/** What a reassign does to one clashing chord, naming the exact chord kept or lost. */
export function describeClashOutcome(
	otherLabel: string,
	existing: KeyCombo,
	taken: KeyCombo,
	platform: KeyPlatform
): string {
	const kept = narrowedClashCombo(existing, taken);
	if (kept) {
		return `${otherLabel} keeps ${comboLabel(kept, platform)}.`;
	}
	return `${otherLabel} loses ${comboLabel(existing, platform)}.`;
}

/** Conflict notes keyed by binding id, worded from that binding's side. */
export function conflictNotes(
	conflicts: readonly ShortcutConflict[],
	bindings: readonly ShortcutBinding[],
	platform: KeyPlatform
): Map<string, string[]> {
	const notes = new Map<string, string[]>();
	const add = (id: string, note: string) =>
		notes.set(id, [...(notes.get(id) ?? []), note]);
	for (const { bindingIds, combo } of conflicts) {
		const [winner, loser] = bindingIds;
		if (!(winner && loser)) {
			continue;
		}
		const chord = comboLabel(combo, platform);
		add(
			loser,
			`${chord} runs ${bindingLabel(bindings, winner)} instead of this.`
		);
		add(winner, `Also takes ${chord} from ${bindingLabel(bindings, loser)}.`);
	}
	return notes;
}
