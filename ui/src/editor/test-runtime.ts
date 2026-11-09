import {
	type Asset,
	activeCaptions,
	newProject,
	newSegment,
	type Project,
	projectDuration,
	trackSettingFor,
	withActiveCaptions,
} from "../../../shared/project.ts";
import { timelineDeletion } from "../../../shared/timeline-delete.ts";
import { DEFAULT_SPLIT_EDIT_SETTINGS } from "../ClipEditActions.tsx";
import type { PreviewSources } from "../preview-sources.ts";
import { defaultMarkerColor } from "./format.ts";
import { recordHistory, redoHistory, undoHistory } from "./history.ts";
import type { EditorRuntime, ProjectUpdate } from "./runtime.ts";
import { createEditorStore, withPrimarySelection } from "./store.ts";

/** A video asset for runtime tests. */
export function testVideo(name = "clip.mp4", duration = 10): Asset {
	return {
		createdAt: new Date(0).toISOString(),
		duration,
		hasAudio: true,
		height: 360,
		id: crypto.randomUUID(),
		kind: "video",
		name,
		width: 640,
	};
}

/** A project with one asset and two back-to-back clips on track 0. */
export function testProject() {
	const asset = testVideo();
	const first = newSegment(asset, 0);
	const second = { ...newSegment(asset, 10), sourceOut: 5 };
	const project: Project = {
		...newProject("Runtime test"),
		segments: [first, second],
	};
	return { asset, first, project, second };
}

export interface TestRuntime extends EditorRuntime {
	/** Every runtime call that changes state, in order (`name` plus arguments). */
	calls: [string, ...unknown[]][];
	/** Rebuild derived fields (selection, duration, deletion) after a change. */
	refresh: () => void;
}

/**
 * An in-memory editor runtime with App's semantics for edits, selection, and
 * history, so actions can be exercised without React or the sidecar.
 */
export function createTestRuntime(
	project: Project | null,
	assets: Asset[] = []
): TestRuntime {
	const store = createEditorStore();
	const calls: [string, ...unknown[]][] = [];
	const latestProject = { current: project };
	const log =
		(name: string) =>
		(...args: unknown[]) => {
			calls.push([name, ...args]);
		};
	const runtime: TestRuntime = {
		act: async (operation) => {
			try {
				await operation();
			} catch (error) {
				runtime.setStatus(error instanceof Error ? error.message : "failed");
			}
		},
		api: () => Promise.resolve(undefined),
		assets,
		busy: false,
		calls,
		commitServerProject: (next) => {
			runtime.project = next;
			runtime.refresh();
		},
		deletion: null,
		dirty: false,
		drafting: false,
		duration: 0,
		edit: (update: ProjectUpdate, label = "Edit") => {
			const base =
				typeof update === "function" ? latestProject.current : runtime.project;
			if (!base) {
				return;
			}
			const next = typeof update === "function" ? update(base) : update;
			store.setState((state) => ({
				history: recordHistory(state.history, base, label),
			}));
			calls.push(["edit", label]);
			runtime.project = next;
			latestProject.current = next;
			runtime.dirty = true;
			runtime.refresh();
		},
		editCaptions: (captions) => {
			if (runtime.project) {
				runtime.edit(withActiveCaptions(runtime.project, captions));
			}
		},
		editingCaptions: project ? activeCaptions(project) : [],
		ensureSaved: () => Promise.resolve(runtime.project ?? undefined),
		jobs: [],
		latestEdit: (update, describe) => {
			runtime.edit(update);
			runtime.setStatus(describe());
		},
		latestProject,
		localEdit: (next, statusText) => {
			runtime.edit(next);
			runtime.setStatus(statusText);
		},
		markerColor: defaultMarkerColor,
		markerLabel: "",
		panel: "media",
		playing: false,
		previewSources: {} as PreviewSources,
		project,
		projects: project ? [project] : [],
		range: { end: 1, start: 0 },
		rangeMarked: false,
		redo: () => {
			const result =
				runtime.project &&
				redoHistory(store.getState().history, runtime.project);
			calls.push(["redo"]);
			if (result) {
				store.setState({ history: result.state });
				runtime.project = result.project;
				runtime.refresh();
			}
		},
		refresh: () => {
			const current = runtime.project;
			const { selection } = store.getState();
			runtime.selectedId = selection.primaryId;
			runtime.selectedIds = selection.segmentIds;
			runtime.selectedSegment = current?.segments.find(
				(segment) => segment.id === selection.primaryId
			);
			runtime.selectedTrackLocked = Boolean(
				current &&
					runtime.selectedSegment &&
					trackSettingFor(current, runtime.selectedSegment.track).locked
			);
			runtime.deletion = current
				? timelineDeletion(current, selection.segmentIds)
				: null;
			runtime.duration = current ? projectDuration(current) : 0;
			runtime.tool = store.getState().tool;
		},
		registerJob: log("registerJob"),
		routeEdit: (action) => {
			calls.push(["routeEdit", action]);
			return Promise.resolve({ status: "error" });
		},
		save: () => {
			calls.push(["save"]);
			if (!runtime.project) {
				return Promise.reject(new Error("Create a project first."));
			}
			runtime.dirty = false;
			return Promise.resolve(runtime.project);
		},
		selectedId: null,
		selectedIds: [],
		selectedSegment: undefined,
		selectedTrackLocked: false,
		setAssets: log("setAssets"),
		setDirty: (dirty) => {
			runtime.dirty = dirty;
		},
		setDrafting: (drafting) => {
			runtime.drafting = drafting;
		},
		setMarkerColor: (color) => {
			runtime.markerColor = color;
		},
		setMarkerLabel: (label) => {
			runtime.markerLabel = label;
		},
		setPanel: (panel) => {
			calls.push(["setPanel", panel]);
			runtime.panel = panel;
		},
		setPlaybackDirection: log("setPlaybackDirection"),
		setPlaying: (playing) => {
			calls.push(["setPlaying", playing]);
			runtime.playing = playing;
		},
		setProject: log("setProject"),
		setProjects: log("setProjects"),
		setRangeEnd: (end) => {
			runtime.range = { ...runtime.range, end };
		},
		setRangeMarked: (marked) => {
			runtime.rangeMarked = marked;
		},
		setRangeStart: (start) => {
			runtime.range = { ...runtime.range, start };
		},
		setSelected: (id) => {
			store.setState((state) => ({
				selection: withPrimarySelection(state.selection, id),
			}));
			runtime.refresh();
		},
		setSources: log("setSources"),
		setSplitSettings: (settings) => {
			runtime.splitSettings = settings;
		},
		setStatus: (status) => {
			calls.push(["setStatus", status]);
		},
		setTime: (time) => {
			calls.push(["setTime", time]);
			runtime.time = time;
		},
		setTimelineGuides: (guides) => {
			runtime.timelineGuides = guides;
		},
		setTool: (tool) => {
			store.setState({ tool });
			runtime.refresh();
		},
		splitSettings: DEFAULT_SPLIT_EDIT_SETTINGS,
		store,
		time: 0,
		timelineGuides: [],
		tool: "pointer",
		undo: () => {
			const result =
				runtime.project &&
				undoHistory(store.getState().history, runtime.project);
			calls.push(["undo"]);
			if (result) {
				store.setState({ history: result.state });
				runtime.project = result.project;
				runtime.refresh();
			}
		},
		zoom: 70,
	};
	runtime.refresh();
	return runtime;
}

/** Last status message a test runtime reported. */
export function lastStatus(runtime: TestRuntime): unknown {
	return runtime.calls.findLast(([name]) => name === "setStatus")?.[1];
}
