import {
	ACTIONS,
	type ActionCategory,
	type ActionId,
	type ShortcutBinding,
} from "./defaults.ts";
import { comboLabel, type KeyPlatform } from "./keys.ts";

/** Categories in the order the dialog and the reference sheet list them. */
export const CATEGORY_ORDER: readonly ActionCategory[] = [
	"Playback",
	"Navigation",
	"Edit",
	"Tools",
	"Selection",
	"Clipboard",
	"Markers",
	"Tracks",
	"Multicam",
	"AI",
	"Preview",
	"View",
	"History",
	"Project",
];

export interface ShortcutRow {
	binding: ShortcutBinding;
	label: string;
}

export interface ShortcutGroup {
	category: ActionCategory;
	rows: ShortcutRow[];
}

export interface GroupOptions {
	/** Only actions passing this test are listed (default: all). */
	isAvailable?: (action: ActionId) => boolean;
	platform?: KeyPlatform;
	/** Case-insensitive filter over label, category, and chord labels. */
	query?: string;
	/** Leave out bindings with no chords (the printed sheet does). */
	skipUnbound?: boolean;
}

const searchText = (binding: ShortcutBinding, platform: KeyPlatform) => {
	const meta = ACTIONS[binding.action];
	const chords = binding.keys.flatMap((combo) => [
		comboLabel(combo, platform),
		comboLabel(combo, platform === "mac" ? "other" : "mac"),
	]);
	return [meta.label, meta.category, ...chords].join(" ").toLowerCase();
};

/** Bindings grouped by category for display, filtered by `options`. */
export function groupShortcuts(
	bindings: readonly ShortcutBinding[],
	options: GroupOptions = {}
): ShortcutGroup[] {
	const platform = options.platform ?? "other";
	const terms = (options.query ?? "")
		.toLowerCase()
		.split(/\s+/)
		.filter(Boolean);
	const groups = new Map<ActionCategory, ShortcutRow[]>();
	for (const binding of bindings) {
		if (options.isAvailable && !options.isAvailable(binding.action)) {
			continue;
		}
		if (options.skipUnbound && binding.keys.length === 0) {
			continue;
		}
		const text = searchText(binding, platform);
		if (!terms.every((term) => text.includes(term))) {
			continue;
		}
		const meta = ACTIONS[binding.action];
		const rows = groups.get(meta.category) ?? [];
		rows.push({ binding, label: meta.label });
		groups.set(meta.category, rows);
	}
	return CATEGORY_ORDER.flatMap((category) => {
		const rows = groups.get(category);
		return rows ? [{ category, rows }] : [];
	});
}

/** The display label for a binding id (falls back to the id). */
export function bindingLabel(
	bindings: readonly ShortcutBinding[],
	bindingId: string
): string {
	const binding = bindings.find((candidate) => candidate.id === bindingId);
	return binding ? ACTIONS[binding.action].label : bindingId;
}
