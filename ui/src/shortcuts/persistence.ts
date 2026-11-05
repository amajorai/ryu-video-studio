import { z } from "zod";
import {
	readViewerValue,
	type ViewerStorageArea,
	writeViewerValue,
} from "../editor/viewer-storage.ts";
import {
	DEFAULT_BINDINGS,
	type KeyCombo,
	type ShortcutBinding,
} from "./defaults.ts";
import { comboId } from "./keys.ts";

/**
 * Per-viewer shortcut overrides. Only bindings the viewer changed are stored
 * (binding id → its full chord list), so new defaults reach everyone who has
 * not touched that binding. Unknown ids from older builds are ignored, and a
 * missing, unreadable, or invalid value means "use the defaults".
 */

/** Viewer-storage key (namespaced by `viewer-storage`). */
export const SHORTCUT_STORAGE_KEY = "shortcuts";

/** Most chords one binding may hold (multicam uses nine). */
export const MAX_COMBOS_PER_BINDING = 12;

export const keyComboSchema = z
	.object({
		alt: z.boolean().optional(),
		cmd: z.boolean().optional(),
		code: z.string().min(1).max(32).optional(),
		key: z.string().min(1).max(32).optional(),
		shift: z.boolean().optional(),
	})
	.strict()
	.refine((combo) => combo.key !== undefined || combo.code !== undefined, {
		message: "A shortcut needs a key or a key code.",
	});

export const shortcutOverridesSchema = z
	.object({
		bindings: z.record(
			z.string().min(1).max(64),
			z.array(keyComboSchema).max(MAX_COMBOS_PER_BINDING)
		),
		version: z.literal(1),
	})
	.strict();

/** Binding id → the chords that replace its defaults (an empty list unbinds it). */
export type ShortcutOverrides = Readonly<Record<string, readonly KeyCombo[]>>;

export const NO_OVERRIDES: ShortcutOverrides = Object.freeze({});

/** The viewer's saved overrides, or none when storage is empty, blocked, or invalid. */
export function readShortcutOverrides(
	area?: ViewerStorageArea | null
): ShortcutOverrides {
	const stored = readViewerValue(
		SHORTCUT_STORAGE_KEY,
		shortcutOverridesSchema.nullable(),
		null,
		area
	);
	return stored?.bindings ?? NO_OVERRIDES;
}

/** Persist overrides; returns false when this browser is not keeping preferences. */
export function writeShortcutOverrides(
	overrides: ShortcutOverrides,
	area?: ViewerStorageArea | null
): boolean {
	return writeViewerValue(
		SHORTCUT_STORAGE_KEY,
		{ bindings: overrides, version: 1 },
		area
	);
}

/** The default table with the viewer's chords swapped in; table order never changes. */
export function applyShortcutOverrides(
	overrides: ShortcutOverrides,
	defaults: readonly ShortcutBinding[] = DEFAULT_BINDINGS
): readonly ShortcutBinding[] {
	if (Object.keys(overrides).length === 0) {
		return defaults;
	}
	return defaults.map((binding) => {
		const keys = Object.hasOwn(overrides, binding.id)
			? overrides[binding.id]
			: undefined;
		return keys ? { ...binding, keys } : binding;
	});
}

/** The viewer's effective key map. */
export function loadShortcutBindings(
	area?: ViewerStorageArea | null
): readonly ShortcutBinding[] {
	return applyShortcutOverrides(readShortcutOverrides(area));
}

const sameCombos = (a: readonly KeyCombo[], b: readonly KeyCombo[]) =>
	a.length === b.length &&
	a.every((combo, index) => {
		const other = b[index];
		return other !== undefined && comboId(combo) === comboId(other);
	});

/** Remove duplicate chords (same `comboId`), keeping the first. */
export function uniqueCombos(combos: readonly KeyCombo[]): KeyCombo[] {
	const seen = new Set<string>();
	return combos.filter((combo) => {
		const id = comboId(combo);
		if (seen.has(id)) {
			return false;
		}
		seen.add(id);
		return true;
	});
}

/**
 * Overrides with `bindingId` set to `keys`. Setting a binding back to its
 * defaults drops the override, so it follows future default changes again.
 */
export function withBindingKeys(
	overrides: ShortcutOverrides,
	bindingId: string,
	keys: readonly KeyCombo[],
	defaults: readonly ShortcutBinding[] = DEFAULT_BINDINGS
): ShortcutOverrides {
	const binding = defaults.find((candidate) => candidate.id === bindingId);
	if (!binding) {
		return overrides;
	}
	const next = uniqueCombos(keys).slice(0, MAX_COMBOS_PER_BINDING);
	const { [bindingId]: _previous, ...rest } = overrides;
	return sameCombos(next, binding.keys) ? rest : { ...rest, [bindingId]: next };
}

/** Overrides without `bindingId`, which returns to its default chords. */
export function withBindingReset(
	overrides: ShortcutOverrides,
	bindingId: string
): ShortcutOverrides {
	const { [bindingId]: _previous, ...rest } = overrides;
	return rest;
}

/** Whether the viewer changed `bindingId` from its defaults. */
export function isBindingCustomized(
	overrides: ShortcutOverrides,
	bindingId: string
): boolean {
	return Object.hasOwn(overrides, bindingId);
}

/** How a recorded chord joins its binding. */
export type RecordMode = "add" | "replace";

const NARROWABLE_MODIFIERS = ["shift", "alt", "cmd"] as const;

/**
 * What a reassign leaves of another binding's chord `existing` once `taken`
 * (the newly recorded chord) claims part of it. When `existing` leaves a
 * modifier open that `taken` holds down, the chord is narrowed to that
 * modifier being up, so taking Shift+S from Split (`S`, Shift open) leaves
 * Split with plain `S`. Returns null when nothing usable is left (the chords
 * share their plain press), meaning the chord is removed.
 */
export function narrowedClashCombo(
	existing: KeyCombo,
	taken: KeyCombo
): KeyCombo | null {
	for (const modifier of NARROWABLE_MODIFIERS) {
		if (existing[modifier] !== undefined || taken[modifier] !== true) {
			continue;
		}
		// `taken` needs this modifier down and the narrowed chord needs it up,
		// so neither can match the other's press any more.
		return { ...existing, [modifier]: false };
	}
	return null;
}

/**
 * Overrides after recording `combo` for `bindingId`: `replace` makes it the
 * only chord, `add` appends it. Each clash (another binding's chord the new
 * one collides with) is narrowed or removed from that binding (see
 * `narrowedClashCombo`), which is how the resolve prompt's "Reassign" works.
 */
export function withRecordedCombo(
	overrides: ShortcutOverrides,
	bindings: readonly ShortcutBinding[],
	bindingId: string,
	combo: KeyCombo,
	mode: RecordMode,
	clashes: readonly { combo: KeyCombo; otherId: string }[] = [],
	defaults: readonly ShortcutBinding[] = DEFAULT_BINDINGS
): ShortcutOverrides {
	const current = bindings.find((binding) => binding.id === bindingId);
	if (!current) {
		return overrides;
	}
	let next = withBindingKeys(
		overrides,
		bindingId,
		mode === "replace" ? [combo] : [...current.keys, combo],
		defaults
	);
	for (const clash of clashes) {
		const other = bindings.find((binding) => binding.id === clash.otherId);
		if (!other || other.id === bindingId) {
			continue;
		}
		const removed = comboId(clash.combo);
		const otherKeys = applyShortcutOverrides(next, defaults).find(
			(binding) => binding.id === other.id
		)?.keys;
		const kept = narrowedClashCombo(clash.combo, combo);
		next = withBindingKeys(
			next,
			other.id,
			(otherKeys ?? other.keys).flatMap((key) => {
				if (comboId(key) !== removed) {
					return [key];
				}
				return kept ? [kept] : [];
			}),
			defaults
		);
	}
	return next;
}
