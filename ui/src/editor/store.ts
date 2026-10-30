import { useSyncExternalStore } from "react";
import {
	emptyPreviewTabs,
	type PreviewTabsState,
} from "../../../shared/preview-tabs.ts";
import type { MergeConflict } from "../../../shared/project-merge.ts";
import type { TrackRegion } from "../../../shared/tracking.ts";
import type { TrimTool } from "../editing-ui.ts";
import type { SourceMarks } from "../library/source-marks.ts";
import type { CustomGuide } from "../preview/overlays/guide-geometry.ts";
import { emptyHistory, type HistoryState } from "./history.ts";

/** A selected title, graphic, caption, avatar, or adjustment layer. */
export interface OverlaySelection {
	id: string;
	kind: "titles" | "graphics" | "captions" | "avatars" | "adjustmentLayers";
}

export interface EditorSelection {
	overlayIds: OverlaySelection[];
	/** The clip the inspector edits; when set it is always in `segmentIds`. */
	primaryId: string | null;
	segmentIds: string[];
}

/** Clips, overlays, and their timeline span captured by copy or cut. */
export interface ClipboardPayload {
	items: { offset: number; segmentId: string }[];
	overlays: OverlaySelection[];
	span: number;
}

/** An in-flight pointer gesture on the timeline (move, trim, slip, marquee…). */
export interface DragState {
	/** Clip or overlay ids the gesture acts on. */
	ids: string[];
	kind: "move" | "trim" | "ripple" | "roll" | "slip" | "slide" | "marquee";
	/** Pointer origin in client pixels. */
	originX: number;
	originY: number;
}

export type LoopMode = "off" | "range" | "all";
export type PreviewQuality = "full" | "half" | "quarter";
export type MarkerStatusFilter = "all" | "open" | "resolved";

/**
 * Transient editor UI state shared by the timeline, inspector, preview, and
 * shortcuts. Project data stays in the editor context; this holds only how
 * the viewer is looking at and manipulating it.
 */
export interface EditorState {
	clipboard: ClipboardPayload | null;
	/** The viewer's custom guide and grid density (loaded from viewer storage). */
	customGuide?: CustomGuide;
	drag: DragState | null;
	/**
	 * Export panel settings a range action asks for (Export range, Save range
	 * to library); the panel applies them once and clears the field.
	 */
	exportPreset?: { rangeOnly: boolean; saveAsAsset: boolean } | null;
	guides: Set<string>;
	history: HistoryState;
	loop: { mode: LoopMode };
	markerStatusFilter: MarkerStatusFilter;
	maximizedPanel: string | null;
	/**
	 * What both this editor and a save elsewhere changed, from the last
	 * three-way merge that failed; the "Changed elsewhere" banner lists it.
	 */
	mergeConflicts: readonly MergeConflict[];
	/**
	 * Clips whose keyframe lanes are expanded. Kept here (not in the lane
	 * component) so lanes stay open when the timeline remounts a clip
	 * (virtualized scrolling, workspace layout changes).
	 */
	openKeyframeLanes: readonly string[];
	playbackRate: number;
	previewQuality: PreviewQuality;
	/** Timeline plus open source tabs in the preview (stored per viewer). */
	previewTabs: PreviewTabsState;
	previewZoom: "fit" | number;
	rippleMode: boolean;
	scrollLeft: number;
	selection: EditorSelection;
	snapEnabled: boolean;
	snapGuideTime: number | null;
	/**
	 * Source I/O marks per library asset, set from the tile viewer or a
	 * source tab; they feed the tile's drag payload, Add, and Insert.
	 */
	sourceMarks: Readonly<Record<string, SourceMarks>>;
	tool: TrimTool;
	/** Track index → lane height in pixels; absent tracks use the default. */
	trackHeights: Record<number, number>;
	/**
	 * The motion-tracking region (canvas fractions) while the Motion tracking
	 * panel is open, drawn on the preview; null otherwise.
	 */
	trackingRegion: TrackRegion | null;
	/** True while the next drag on the preview draws a new tracking region. */
	trackingRegionDrawing: boolean;
	/** The "Use proxies" toggle: preview video plays from proxies when they exist. */
	useProxies: boolean;
	zoomPxPerSec: number;
}

/** Timeline zoom used before the viewer picks one. */
export const DEFAULT_ZOOM_PX_PER_SEC = 70;

export function initialEditorState(): EditorState {
	return {
		clipboard: null,
		drag: null,
		guides: new Set(),
		history: emptyHistory(),
		loop: { mode: "off" },
		markerStatusFilter: "all",
		maximizedPanel: null,
		mergeConflicts: [],
		openKeyframeLanes: [],
		playbackRate: 1,
		previewQuality: "full",
		previewTabs: emptyPreviewTabs(),
		previewZoom: "fit",
		rippleMode: false,
		scrollLeft: 0,
		selection: { overlayIds: [], primaryId: null, segmentIds: [] },
		snapEnabled: true,
		snapGuideTime: null,
		sourceMarks: {},
		tool: "pointer",
		trackHeights: {},
		trackingRegion: null,
		trackingRegionDrawing: false,
		useProxies: false,
		zoomPxPerSec: DEFAULT_ZOOM_PX_PER_SEC,
	};
}

/**
 * Make `id` the inspected clip. Selecting a clip outside the current
 * multi-selection collapses the selection to it; selecting one inside keeps
 * the multi-selection. `null` clears both.
 */
export function withPrimarySelection(
	selection: EditorSelection,
	id: string | null
): EditorSelection {
	if (id === null) {
		return { ...selection, primaryId: null, segmentIds: [] };
	}
	return {
		...selection,
		primaryId: id,
		segmentIds: selection.segmentIds.includes(id) ? selection.segmentIds : [id],
	};
}

/**
 * Click selection: a plain click selects only `id`; an additive (Shift) click
 * toggles it, and the last remaining clip becomes the inspected one.
 */
export function withClickSelection(
	selection: EditorSelection,
	id: string,
	additive: boolean
): EditorSelection {
	const segmentIds = additive
		? selection.segmentIds.includes(id)
			? selection.segmentIds.filter((candidate) => candidate !== id)
			: [...selection.segmentIds, id]
		: [id];
	return { ...selection, primaryId: segmentIds.at(-1) ?? null, segmentIds };
}

export interface EditorStore {
	getState: () => EditorState;
	setState: (
		update:
			| Partial<EditorState>
			| ((state: EditorState) => Partial<EditorState>)
	) => void;
	subscribe: (listener: () => void) => () => void;
}

export function createEditorStore(
	initial: EditorState = initialEditorState()
): EditorStore {
	let state = initial;
	const listeners = new Set<() => void>();
	return {
		getState: () => state,
		setState: (update) => {
			const patch = typeof update === "function" ? update(state) : update;
			const keys = Object.keys(patch) as (keyof EditorState)[];
			if (keys.every((key) => Object.is(patch[key], state[key]))) {
				return;
			}
			state = { ...state, ...patch };
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

/** Subscribe a component to one slice of the editor store. */
export function useEditorStore<Selected>(
	store: EditorStore,
	select: (state: EditorState) => Selected
): Selected {
	return useSyncExternalStore(
		store.subscribe,
		() => select(store.getState()),
		() => select(store.getState())
	);
}
