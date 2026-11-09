import {
	activatePreviewTab,
	closePreviewTab,
	emptyPreviewTabs,
	openSourceTab,
	type PreviewTabsState,
	previewTabBack,
	previewTabForward,
	previewTabsSchema,
	TIMELINE_TAB,
} from "../../../shared/preview-tabs.ts";
import type { EditorStore } from "../editor/store.ts";
import {
	readViewerValue,
	type ViewerStorageArea,
	writeViewerValue,
} from "../editor/viewer-storage.ts";
import type { SourceMarks } from "../library/source-marks.ts";

/** Viewer-storage key of a project's open preview tabs. */
export const previewTabsKey = (projectId: string) =>
	`preview-tabs.${projectId}`;

/** The viewer's saved tabs for `projectId` (empty when none or unreadable). */
export function loadPreviewTabs(
	projectId: string,
	area?: ViewerStorageArea | null
): PreviewTabsState {
	return readViewerValue(
		previewTabsKey(projectId),
		previewTabsSchema,
		emptyPreviewTabs(),
		area
	);
}

export function savePreviewTabs(
	projectId: string,
	state: PreviewTabsState,
	area?: ViewerStorageArea | null
): boolean {
	return writeViewerValue(previewTabsKey(projectId), state, area);
}

const updateTabs = (
	store: EditorStore,
	change: (state: PreviewTabsState) => PreviewTabsState
) => store.setState((state) => ({ previewTabs: change(state.previewTabs) }));

/** Open a library asset in a source tab of the preview. */
export const openAssetInViewer = (store: EditorStore, assetId: string) =>
	updateTabs(store, (tabs) => openSourceTab(tabs, assetId));
export const activateTab = (store: EditorStore, target: string) =>
	updateTabs(store, (tabs) => activatePreviewTab(tabs, target));
export const closeTab = (store: EditorStore, assetId: string) =>
	updateTabs(store, (tabs) => closePreviewTab(tabs, assetId));
export const tabBack = (store: EditorStore) =>
	updateTabs(store, previewTabBack);
export const tabForward = (store: EditorStore) =>
	updateTabs(store, previewTabForward);

/** The asset id shown in the preview, or null while the Timeline tab is active. */
export function activeSourceId(store: EditorStore): string | null {
	const { active } = store.getState().previewTabs;
	return active === TIMELINE_TAB ? null : active;
}

const NO_MARKS: SourceMarks = {};

export const sourceMarksOf = (store: EditorStore, assetId: string) =>
	store.getState().sourceMarks[assetId] ?? NO_MARKS;

/** Store `assetId`'s source marks (shared by the library tile and its tab). */
export function setSourceMarks(
	store: EditorStore,
	assetId: string,
	marks: SourceMarks
) {
	store.setState((state) => {
		const sourceMarks = { ...state.sourceMarks };
		if (marks.in === undefined && marks.out === undefined) {
			delete sourceMarks[assetId];
		} else {
			sourceMarks[assetId] = marks;
		}
		return { sourceMarks };
	});
}

/**
 * The playing source tab's transport. While a source tab is active, the
 * playback shortcuts (Space, J/K/L) and mark in/out drive it instead of the
 * timeline.
 */
export interface SourceTransport {
	markIn: () => void;
	markOut: () => void;
	pause: () => void;
	/** J (-1) or L (1); repeated presses double the speed up to 8×. */
	shuttle: (direction: -1 | 1) => void;
	toggle: () => void;
}

const transports = new WeakMap<EditorStore, SourceTransport>();

/** Register the mounted source monitor's transport; returns the unregister. */
export function registerSourceTransport(
	store: EditorStore,
	transport: SourceTransport
): () => void {
	transports.set(store, transport);
	return () => {
		if (transports.get(store) === transport) {
			transports.delete(store);
		}
	};
}

/** The source transport, when a source tab is active and mounted. */
export function activeSourceTransport(
	store: EditorStore
): SourceTransport | null {
	return activeSourceId(store) === null
		? null
		: (transports.get(store) ?? null);
}
