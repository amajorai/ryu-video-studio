import type { AutosaveController } from "./autosave.ts";
import type { EditorStore } from "./store.ts";

/**
 * The autosave controller running for an editor, keyed by its store (one per
 * editor, stable for its lifetime). Manual saves and actions that save first
 * look it up so they wait for an in-flight autosave instead of racing it with
 * the same revision.
 */
const controllers = new WeakMap<EditorStore, AutosaveController>();

/** Register `controller` for `store`; returns the unregister. */
export function registerAutosave(
	store: EditorStore,
	controller: AutosaveController
): () => void {
	controllers.set(store, controller);
	return () => {
		if (controllers.get(store) === controller) {
			controllers.delete(store);
		}
	};
}

/** The autosave running for `store`, if one is mounted. */
export function autosaveFor(
	store: EditorStore
): AutosaveController | undefined {
	return controllers.get(store);
}
