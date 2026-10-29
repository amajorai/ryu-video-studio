import type { Dispatch, RefObject, SetStateAction } from "react";
import type {
	Asset,
	Caption,
	Project,
	Segment,
} from "../../../shared/project.ts";
import type { timelineDeletion } from "../../../shared/timeline-delete.ts";
import type { SplitEditSettings } from "../ClipEditActions.tsx";
import type { TrimTool } from "../editing-ui.ts";
import type { PreviewSources } from "../preview-sources.ts";
import type { RouteEditOutcome, TimelineGuide } from "../SplitEditPanel.tsx";
import type { Job } from "./format.ts";
import type { PlaybackDirection } from "./playback-clock.ts";
import type { StatusOptions } from "./status-notice.ts";
import type { EditorStore } from "./store.ts";

export type ProjectUpdate = Project | ((current: Project) => Project);

export interface RouteEditOptions {
	/**
	 * Stamp of the timeline a plan was computed from. The edit is refused as a
	 * conflict when clips have moved since (saved or not), so ranges from an
	 * older timeline are never applied to the current one.
	 */
	planStamp?: string;
	refreshAssets?: boolean;
}

/**
 * Everything editor actions, panels, and shortcuts read or change. App builds
 * a fresh runtime on every render, so handlers always see the rendered state
 * (the same closure semantics the editor had before the shell split).
 */
export interface EditorRuntime {
	act: (operation: () => Promise<void>) => Promise<void>;
	/** POST `body` (or GET without one) to a sidecar path. */
	api: (path: string, body?: Record<string, unknown>) => Promise<unknown>;
	assets: Asset[];
	busy: boolean;
	/** Apply a project the sidecar saved; `previous` becomes an undo step. */
	commitServerProject: (next: Project, previous?: Project) => void;
	deletion: ReturnType<typeof timelineDeletion> | null;
	dirty: boolean;
	drafting: boolean;
	duration: number;
	/** Record an undoable local edit of the rendered project. */
	edit: (next: ProjectUpdate, label?: string) => void;
	editCaptions: (captions: Caption[]) => void;
	editingCaptions: Caption[];
	/** Save pending edits from the latest state so route plans see them. */
	ensureSaved: () => Promise<Project | undefined>;
	jobs: Job[];
	/** Apply `update` to the latest timeline (for edits that finish after an await). */
	latestEdit: (
		update: (current: Project) => Project,
		describe: () => string
	) => void;
	latestProject: RefObject<Project | null>;
	localEdit: (next: Project, statusText: string) => void;
	markerColor: string;
	markerLabel: string;
	panel: string;
	playing: boolean;
	previewSources: PreviewSources;
	project: Project | null;
	projects: Project[];
	range: { end: number; start: number };
	/**
	 * Whether the viewer marked the I/O range (mark in/out or the range
	 * fields) since the project opened; the agent handoff scopes to the range
	 * only when it is marked.
	 */
	rangeMarked: boolean;
	redo: () => void;
	/** Track a newly queued export job in the export history. */
	registerJob: (job: Job) => void;
	routeEdit: (
		action: string,
		body: Record<string, unknown>,
		describe: (extras: Record<string, unknown>) => string,
		options?: RouteEditOptions
	) => Promise<RouteEditOutcome>;
	save: (target?: Project | null) => Promise<Project>;
	selectedId: string | null;
	selectedIds: string[];
	selectedSegment: Segment | undefined;
	selectedTrackLocked: boolean;
	setAssets: Dispatch<SetStateAction<Asset[]>>;
	setDirty: (dirty: boolean) => void;
	setDrafting: (drafting: boolean) => void;
	setMarkerColor: (color: string) => void;
	setMarkerLabel: (label: string) => void;
	setPanel: (panel: string) => void;
	setPlaybackDirection: (direction: PlaybackDirection) => void;
	setPlaying: (playing: boolean) => void;
	setProject: Dispatch<SetStateAction<Project | null>>;
	setProjects: Dispatch<SetStateAction<Project[]>>;
	setRangeEnd: (value: number) => void;
	setRangeMarked: (marked: boolean) => void;
	setRangeStart: (value: number) => void;
	/** Inspect `id` (null clears the selection). */
	setSelected: (id: string | null) => void;
	setSources: Dispatch<SetStateAction<Record<string, string>>>;
	setSplitSettings: (settings: SplitEditSettings) => void;
	/**
	 * Show `status` in the status line. With `options` it is a transient
	 * notice: it clears on the next timeline edit (`clearOn: "edit"`, or
	 * after 6 s) or after the given milliseconds.
	 */
	setStatus: (status: string, options?: StatusOptions) => void;
	setTime: (time: number) => void;
	setTimelineGuides: (guides: TimelineGuide[]) => void;
	setTool: (tool: TrimTool) => void;
	splitSettings: SplitEditSettings;
	store: EditorStore;
	time: number;
	timelineGuides: TimelineGuide[];
	tool: TrimTool;
	undo: () => void;
	zoom: number;
}
