import { useSyncExternalStore } from "react";
import {
	type TimelineClipKind,
	type TimelineColorOverrides,
	timelineColorOverridesSchema,
	withTimelineColor,
} from "../../../shared/timeline-colors.ts";
import {
	readViewerValue,
	removeViewerValue,
	type ViewerStorageArea,
	writeViewerValue,
} from "../editor/viewer-storage.ts";

/** Viewer-storage key of the Timeline colors preference. */
export const TIMELINE_COLORS_KEY = "timeline-colors";

/**
 * The viewer's timeline clip colors. The Timeline colors pane writes here
 * and the timeline root reads it, so a change repaints the lanes at once
 * and survives a reload.
 */
export interface TimelineColorStore {
	getState: () => TimelineColorOverrides;
	/** Clear every override (Reset all). */
	reset: () => void;
	/** Set one kind's color; the default color removes its override. */
	setColor: (kind: TimelineClipKind, color: string) => void;
	subscribe: (listener: () => void) => () => void;
}

export function createTimelineColorStore(
	area?: ViewerStorageArea | null
): TimelineColorStore {
	let state: TimelineColorOverrides = readViewerValue(
		TIMELINE_COLORS_KEY,
		timelineColorOverridesSchema,
		{},
		area
	);
	const listeners = new Set<() => void>();
	const update = (next: TimelineColorOverrides) => {
		state = next;
		if (Object.keys(next).length) {
			writeViewerValue(TIMELINE_COLORS_KEY, next, area);
		} else {
			removeViewerValue(TIMELINE_COLORS_KEY, area);
		}
		for (const listener of listeners) {
			listener();
		}
	};
	return {
		getState: () => state,
		reset: () => update({}),
		setColor: (kind, color) => update(withTimelineColor(state, kind, color)),
		subscribe: (listener) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
	};
}

/** This viewer's store, read from viewer storage on load. */
export const timelineColorStore: TimelineColorStore =
	createTimelineColorStore();

/** The viewer's color overrides (empty when every kind uses its default). */
export function useTimelineColors(
	store: TimelineColorStore = timelineColorStore
): TimelineColorOverrides {
	return useSyncExternalStore(store.subscribe, store.getState, store.getState);
}
