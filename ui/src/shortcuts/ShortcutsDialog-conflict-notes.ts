import { translate as tl } from "@ryu/i18n/core";
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
		return tl("{binding} keeps {chord}.", {
			binding: otherLabel,
			chord: comboLabel(kept, platform),
		});
	}
	return tl("{binding} loses {chord}.", {
		binding: otherLabel,
		chord: comboLabel(existing, platform),
	});
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
			tl("{chord} runs {binding} instead of this.", {
				binding: bindingLabel(bindings, winner),
				chord,
			})
		);
		add(
			winner,
			tl("Also takes {chord} from {binding}.", {
				binding: bindingLabel(bindings, loser),
				chord,
			})
		);
	}
	return notes;
}
