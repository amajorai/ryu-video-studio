import { useSyncExternalStore } from "react";
import { z } from "zod";
import {
	readViewerValue,
	type ViewerStorageArea,
	writeViewerValue,
} from "../editor/viewer-storage.ts";

/** Viewer-storage key for the preview marker labels toggle. */
export const PREVIEW_MARKER_LABELS_KEY = "markers.previewLabels";

/**
 * Whether marker labels show over the preview: a per-viewer convenience
 * shared by the Markers panel toggle and the preview overlay.
 */
export interface MarkerPreferenceStore {
	get: () => boolean;
	set: (enabled: boolean) => void;
	subscribe: (listener: () => void) => () => void;
}

export function createMarkerPreferenceStore(
	area?: ViewerStorageArea | null
): MarkerPreferenceStore {
	let enabled = readViewerValue(
		PREVIEW_MARKER_LABELS_KEY,
		z.boolean(),
		false,
		area
	);
	const listeners = new Set<() => void>();
	return {
		get: () => enabled,
		set: (next) => {
			if (next === enabled) {
				return;
			}
			enabled = next;
			writeViewerValue(PREVIEW_MARKER_LABELS_KEY, next, area);
			for (const listener of listeners) {
				listener();
			}
		},
		subscribe: (listener) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
	};
}

let shared: MarkerPreferenceStore | null = null;

/** The editor-wide preference store, created on first use. */
export function markerPreferences(): MarkerPreferenceStore {
	shared ??= createMarkerPreferenceStore();
	return shared;
}

/** Subscribe to the preview marker labels toggle. */
export function usePreviewMarkerLabels(
	store: MarkerPreferenceStore = markerPreferences()
): [boolean, (enabled: boolean) => void] {
	const enabled = useSyncExternalStore(store.subscribe, store.get, store.get);
	return [enabled, store.set];
}
