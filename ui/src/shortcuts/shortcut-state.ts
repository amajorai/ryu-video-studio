import { useSyncExternalStore } from "react";
import type { ViewerStorageArea } from "../editor/viewer-storage.ts";
import { DEFAULT_BINDINGS, type ShortcutBinding } from "./defaults.ts";
import {
	applyShortcutOverrides,
	readShortcutOverrides,
	type ShortcutOverrides,
	writeShortcutOverrides,
} from "./persistence.ts";

/**
 * Live shortcut state: the viewer's overrides, the effective key map, and
 * whether the shortcuts dialog is open. The dialog writes here, the `?`
 * action opens it, and the app's keydown handler reads `bindings` so a
 * rebind takes effect immediately and survives a reload.
 */
export interface ShortcutState {
	bindings: readonly ShortcutBinding[];
	dialogOpen: boolean;
	overrides: ShortcutOverrides;
	/** False once a write failed: changes then last only for this session. */
	persisted: boolean;
}

export interface ShortcutStore {
	closeDialog: () => void;
	getState: () => ShortcutState;
	openDialog: () => void;
	/** Re-read overrides from storage (another tab saved). */
	reload: () => void;
	/** Apply and persist overrides; returns whether they were saved. */
	setOverrides: (overrides: ShortcutOverrides) => boolean;
	subscribe: (listener: () => void) => () => void;
}

export function createShortcutStore(
	area?: ViewerStorageArea | null,
	defaults: readonly ShortcutBinding[] = DEFAULT_BINDINGS
): ShortcutStore {
	const read = () => readShortcutOverrides(area);
	const initial = read();
	let state: ShortcutState = {
		bindings: applyShortcutOverrides(initial, defaults),
		dialogOpen: false,
		overrides: initial,
		persisted: true,
	};
	const listeners = new Set<() => void>();
	const update = (patch: Partial<ShortcutState>) => {
		state = { ...state, ...patch };
		for (const listener of listeners) {
			listener();
		}
	};
	const withOverrides = (overrides: ShortcutOverrides) => ({
		bindings: applyShortcutOverrides(overrides, defaults),
		overrides,
	});
	return {
		closeDialog: () => {
			if (state.dialogOpen) {
				update({ dialogOpen: false });
			}
		},
		getState: () => state,
		openDialog: () => {
			if (!state.dialogOpen) {
				update({ dialogOpen: true });
			}
		},
		reload: () => update(withOverrides(read())),
		setOverrides: (overrides) => {
			const persisted = writeShortcutOverrides(overrides, area);
			update({ ...withOverrides(overrides), persisted });
			return persisted;
		},
		subscribe: (listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	};
}

/** The editor's shortcut store, read from this viewer's storage on load. */
export const shortcutStore: ShortcutStore = createShortcutStore();

export function useShortcutState<Selected>(
	select: (state: ShortcutState) => Selected,
	store: ShortcutStore = shortcutStore
): Selected {
	return useSyncExternalStore(
		store.subscribe,
		() => select(store.getState()),
		() => select(store.getState())
	);
}

/** The viewer's effective key map; pass it to `dispatchShortcut`. */
export function useShortcutBindings(
	store: ShortcutStore = shortcutStore
): readonly ShortcutBinding[] {
	return useShortcutState((state) => state.bindings, store);
}
