import {
	type SetStateAction,
	useCallback,
	useEffect,
	useEffectEvent,
	useRef,
	useState,
} from "react";
import {
	type Asset,
	activeCaptions,
	type Caption,
	type Project,
	projectDuration,
	projectSchema,
	trackSettingFor,
	withActiveCaptions,
} from "../../shared/project.ts";
import { timelineDeletion } from "../../shared/timeline-delete.ts";
import { useStudioPreviewProxies } from "./App-preview-proxies.ts";
import { useStudioRevisionWatch } from "./App-revision-watch.ts";
import { createStudioRouteEdit } from "./App-route-edit.ts";
import { StudioAppShell } from "./App-shell.tsx";
import {
	loadLibrary,
	mediaBlob,
	request,
	studioResponseSchema,
} from "./bridge.ts";
import {
	DEFAULT_SPLIT_EDIT_SETTINGS,
	type SplitEditSettings,
} from "./ClipEditActions.tsx";
import { defaultMarkerColor, message } from "./editor/format.ts";
import {
	DEFAULT_EDIT_LABEL,
	recordHistory,
	redoHistory,
	undoHistory,
} from "./editor/history.ts";
import { usePlaybackClock } from "./editor/playback-clock.ts";
import type { EditorRuntime, ProjectUpdate } from "./editor/runtime.ts";
import { recordSavedBase } from "./editor/saved-base.ts";
import { useStatusLine } from "./editor/status-notice.ts";
import {
	createEditorStore,
	useEditorStore,
	withPrimarySelection,
} from "./editor/store.ts";
import { useRenderJobs } from "./editor/use-render-jobs.ts";
import { PreviewSources, previewMimeType } from "./preview-sources.ts";
import type { TimelineGuide } from "./SplitEditPanel.tsx";
import { dispatchShortcut } from "./shortcuts/registry.ts";
import { useShortcutBindings } from "./shortcuts/shortcut-state.ts";

export function App() {
	const [projects, setProjects] = useState<Project[]>([]);
	const [project, setProjectState] = useState<Project | null>(null);
	// The project the latest switch targets, recorded when the switch is
	// requested rather than after it renders, so a media error that the
	// outgoing project's preview raises in between cannot replace the status
	// of the project that replaces it.
	const requestedProjectId = useRef<string | null>(null);
	const setProject = useCallback((next: SetStateAction<Project | null>) => {
		if (typeof next !== "function") {
			requestedProjectId.current = next?.id ?? null;
		}
		setProjectState(next);
	}, []);
	const latestProject = useRef<Project | null>(null);
	const commitServerProjectRef = useRef<
		(next: Project, previous?: Project, label?: string) => void
	>(() => undefined);
	useEffect(() => {
		latestProject.current = project;
	}, [project]);
	const [assets, setAssets] = useState<Asset[]>([]);
	// The library with preview proxies (`GET /assets?includeProxies=1`), which
	// the media listing hides; the preview picks proxies from it.
	const [proxyLibrary, setProxyLibrary] = useState<Asset[]>([]);
	const assetIndex = useRef(new Map<string, Asset>());
	useEffect(() => {
		assetIndex.current = new Map(
			[...proxyLibrary, ...assets].map((asset) => [asset.id, asset])
		);
	}, [assets, proxyLibrary]);
	const [sources, setSources] = useState<Record<string, string>>({});
	const [previewSources] = useState(
		() =>
			new PreviewSources((asset, signal) =>
				mediaBlob(
					`/assets/${asset.id}/data`,
					previewMimeType(asset, (id) => assetIndex.current.get(id)),
					signal
				)
			)
	);
	const [store] = useState(createEditorStore);
	const previewQuality = useEditorStore(store, (state) => state.previewQuality);
	const useProxies = useEditorStore(store, (state) => state.useProxies);
	const selection = useEditorStore(store, (state) => state.selection);
	const tool = useEditorStore(store, (state) => state.tool);
	const zoom = useEditorStore(store, (state) => state.zoomPxPerSec);
	const { setStatus, status } = useStatusLine(
		"Connecting to Video Studio…",
		project
	);
	const [ready, setReady] = useState(false);
	const [busy, setBusy] = useState(false);
	const [drafting, setDrafting] = useState(false);
	const [dirty, setDirty] = useState(false);
	const dirtyRef = useRef(false);
	useEffect(() => {
		dirtyRef.current = dirty;
	}, [dirty]);
	const [panel, setPanel] = useState("media");
	const [markerLabel, setMarkerLabel] = useState("");
	const [markerColor, setMarkerColor] = useState(defaultMarkerColor);
	const [rangeStart, setRangeStart] = useState(0);
	const [rangeEnd, setRangeEnd] = useState(1);
	const [rangeMarked, setRangeMarked] = useState(false);
	const [splitSettings, setSplitSettings] = useState<SplitEditSettings>(
		DEFAULT_SPLIT_EDIT_SETTINGS
	);
	const [timelineGuides, setTimelineGuides] = useState<TimelineGuide[]>([]);
	const duration = project ? projectDuration(project) : 0;
	const clockState = usePlaybackClock(duration);
	const { playing, setDirection, setPlaying, setTime, time } = clockState;
	const { jobs, registerJob } = useRenderJobs(ready, setStatus);
	useStudioRevisionWatch({
		busy,
		commitServerProjectRef,
		dirtyRef,
		latestProject,
		project,
		setDirty,
		setProject,
		setStatus,
		store,
	});
	// The saved copy of the open revision is the base of a later merge.
	useEffect(() => {
		if (project && !dirty) {
			recordSavedBase(project);
		}
	}, [dirty, project]);

	const selectedId = selection.primaryId;
	const selectedIds = selection.segmentIds;
	const selectedSegment = project?.segments.find((s) => s.id === selectedId);
	const deletion = project
		? timelineDeletion(
				project,
				selectedIds.length ? selectedIds : selectedId ? [selectedId] : []
			)
		: null;
	const selectedTrackLocked = Boolean(
		project &&
			selectedSegment &&
			trackSettingFor(project, selectedSegment.track).locked
	);
	const previewProjectId = project?.id ?? null;
	const reportPreviewError = useCallback(
		(text: string) => {
			if (
				previewProjectId !== null &&
				previewProjectId === requestedProjectId.current
			) {
				setStatus(text);
			}
		},
		[previewProjectId, setStatus]
	);
	const editingCaptions = project ? activeCaptions(project) : [];

	const setSelected = useCallback(
		(id: string | null) =>
			store.setState((state) => ({
				selection: withPrimarySelection(state.selection, id),
			})),
		[store]
	);
	const act = useCallback(async (operation: () => Promise<void>) => {
		setBusy(true);
		try {
			await operation();
		} catch (error) {
			setStatus(message(error));
		} finally {
			setBusy(false);
		}
	}, []);
	useEffect(() => {
		let mounted = true;
		void loadLibrary()
			.then((library) => {
				if (!mounted) {
					return;
				}
				setProjects(library.projects);
				setAssets(library.assets);
				setProject(library.projects[0] ?? null);
				setReady(true);
				setStatus("Project library connected.");
			})
			.catch((error) => {
				if (mounted) {
					setStatus(message(error));
				}
			});
		return () => {
			mounted = false;
			previewSources.dispose();
		};
	}, [previewSources]);
	useStudioPreviewProxies({
		assets,
		previewQuality,
		previewSources,
		project,
		proxyLibrary,
		ready,
		setProxyLibrary,
		setSources,
		setStatus,
		useProxies,
	});

	/**
	 * Record an undoable edit. A project replaces the rendered project; an
	 * updater runs against the latest project (for edits that finish after an
	 * await, when the rendered one may be stale).
	 */
	const edit = (update: ProjectUpdate, label = DEFAULT_EDIT_LABEL) => {
		const base = typeof update === "function" ? latestProject.current : project;
		if (!base) {
			return;
		}
		const next = typeof update === "function" ? update(base) : update;
		if (typeof update === "function") {
			latestProject.current = next;
			dirtyRef.current = true;
		}
		store.setState((state) => ({
			history: recordHistory(state.history, base, label),
		}));
		setProject(next);
		setDirty(true);
	};
	const editCaptions = (captions: Caption[]) => {
		if (project) {
			edit(withActiveCaptions(project, captions), "Edit captions");
		}
	};
	const save = async (target: Project | null = project) => {
		if (!target) {
			throw new Error("Create a project first.");
		}
		const saved = projectSchema.parse(
			await request(
				studioResponseSchema,
				`/projects/${target.id}`,
				"PUT",
				target
			)
		);
		setProject(saved);
		setProjects((current) => [
			saved,
			...current.filter((p) => p.id !== saved.id),
		]);
		setDirty(false);
		setStatus("Project saved.");
		return saved;
	};
	const undo = () => {
		if (!project) {
			return;
		}
		const result = undoHistory(store.getState().history, project);
		if (!result) {
			return;
		}
		store.setState({ history: result.state });
		setProject(result.project);
		setDirty(true);
	};
	const redo = () => {
		if (!project) {
			return;
		}
		const result = redoHistory(store.getState().history, project);
		if (!result) {
			return;
		}
		store.setState({ history: result.state });
		setProject(result.project);
		setDirty(true);
	};
	const commitServerProject = (
		next: Project,
		previous?: Project,
		label = "Server edit"
	) => {
		latestProject.current = next;
		dirtyRef.current = false;
		if (previous) {
			store.setState((state) => ({
				history: recordHistory(state.history, previous, label),
			}));
		}
		setProject(next);
		setProjects((current) => [
			next,
			...current.filter((item) => item.id !== next.id),
		]);
		setDirty(false);
	};
	commitServerProjectRef.current = commitServerProject;
	/** Save pending edits from the latest state so route plans and edits see them. */
	const ensureSaved = async (): Promise<Project | undefined> => {
		const current = latestProject.current;
		if (!current) {
			return undefined;
		}
		if (!dirtyRef.current) {
			return current;
		}
		const saved = await save(current);
		latestProject.current = saved;
		dirtyRef.current = false;
		return saved;
	};
	const routeEdit = createStudioRouteEdit({
		act,
		commitServerProject,
		ensureSaved,
		latestProject,
		setAssets,
		setStatus,
		store,
	});
	const localEdit = (next: Project, statusText: string) => {
		edit(next);
		setStatus(statusText);
	};
	/**
	 * Apply `update` to the latest timeline. For edits that finish after an
	 * await: the closure's `project` may predate edits made meanwhile.
	 */
	const latestEdit = (
		update: (current: Project) => Project,
		describe: () => string
	) => {
		if (!latestProject.current) {
			return;
		}
		edit(update);
		setStatus(describe());
	};

	const runtime: EditorRuntime = {
		act,
		api: (path, body) =>
			request(studioResponseSchema, path, body ? "POST" : "GET", body),
		assets,
		busy,
		commitServerProject,
		deletion,
		dirty,
		drafting,
		duration,
		edit,
		editCaptions,
		editingCaptions,
		ensureSaved,
		jobs,
		latestEdit,
		latestProject,
		localEdit,
		markerColor,
		markerLabel,
		panel,
		playing,
		previewSources,
		project,
		projects,
		range: { end: rangeEnd, start: rangeStart },
		rangeMarked,
		redo,
		registerJob,
		routeEdit,
		save,
		selectedId,
		selectedIds,
		selectedSegment,
		selectedTrackLocked,
		setAssets,
		setDirty,
		setDrafting,
		setMarkerColor,
		setMarkerLabel,
		setPanel,
		setPlaybackDirection: setDirection,
		setPlaying,
		setProject,
		setProjects,
		setRangeEnd,
		setRangeMarked,
		setRangeStart,
		setSelected,
		setSources,
		setSplitSettings,
		setStatus,
		setTime,
		setTimelineGuides,
		setTool: (next) => store.setState({ tool: next }),
		splitSettings,
		store,
		time,
		timelineGuides,
		tool,
		undo,
		zoom,
	};

	// The viewer's key map: rebinding in the shortcuts dialog applies at once.
	const bindings = useShortcutBindings();
	const handleShortcut = useEffectEvent((event: KeyboardEvent) => {
		dispatchShortcut(event, runtime, bindings);
	});
	useEffect(() => {
		window.addEventListener("keydown", handleShortcut);
		return () => window.removeEventListener("keydown", handleShortcut);
	}, []);

	return (
		<StudioAppShell
			ready={ready}
			reportPreviewError={reportPreviewError}
			runtime={runtime}
			sources={sources}
			status={status}
		/>
	);
}
