import {
	RyuAppEmpty,
	RyuAppMain,
	RyuAppToolbar,
} from "@ryu/blocks/companion/app-ui";
import { Button } from "@ryu/blocks/companion/controls";
import {
	NativeSelect,
	NativeSelectOption,
} from "@ryu/ui/components/native-select.tsx";
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
import { AgentHandoffDialog } from "./agent/AgentHandoffDialog.tsx";
import {
	isRevisionConflict,
	loadAssets,
	loadLibrary,
	mediaBlob,
	request,
	studioResponseSchema,
} from "./bridge.ts";
import {
	DEFAULT_SPLIT_EDIT_SETTINGS,
	type SplitEditSettings,
} from "./ClipEditActions.tsx";
import { planIsCurrent, projectEditResponse } from "./editing-ui.ts";
import {
	AutosaveConflictBanner,
	AutosaveProvider,
} from "./editor/AutosaveIndicator.tsx";
import { hasRenderableContent } from "./editor/actions/export.ts";
import { togglePlayback } from "./editor/actions/playback.ts";
import { EditorProvider } from "./editor/context.tsx";
import { clock, defaultMarkerColor, message } from "./editor/format.ts";
import {
	DEFAULT_EDIT_LABEL,
	emptyHistory,
	recordHistory,
	redoHistory,
	undoHistory,
} from "./editor/history.ts";
import { usePlaybackClock } from "./editor/playback-clock.ts";
import { openProject } from "./editor/project-actions.ts";
import type {
	EditorRuntime,
	ProjectUpdate,
	RouteEditOptions,
} from "./editor/runtime.ts";
import { recordSavedBase } from "./editor/saved-base.ts";
import { useStatusLine } from "./editor/status-notice.ts";
import {
	createEditorStore,
	useEditorStore,
	withPrimarySelection,
} from "./editor/store.ts";
import { useRenderJobs } from "./editor/use-render-jobs.ts";
import { useRevisionWatch } from "./editor/use-revision-watch.ts";
import { studioFormat } from "./i18n/format.ts";
import { ClipInspector } from "./inspector/ClipInspector.tsx";
import { Preview } from "./Preview.tsx";
import { LibraryTabs } from "./panels/LibraryTabs.tsx";
import { PreviewTabsPanel } from "./preview/PreviewTabs.tsx";
import {
	alphaPreviewMissing,
	PreviewSources,
	previewMimeType,
	wantedProxyVariant,
} from "./preview-sources.ts";
import { ProjectTabs } from "./projects/ProjectTabs.tsx";
import type { RouteEditOutcome, TimelineGuide } from "./SplitEditPanel.tsx";
import { MediaMismatchPrompt } from "./settings/MediaMismatchPrompt.tsx";
import { dispatchShortcut } from "./shortcuts/registry.ts";
import { ConnectedShortcutsDialog } from "./shortcuts/ShortcutsDialog.tsx";
import { useShortcutBindings } from "./shortcuts/shortcut-state.ts";
import { Timeline } from "./timeline/Timeline.tsx";
import { StudioToolbarActions } from "./toolbar/StudioToolbarActions.tsx";
import { WorkspaceLayout } from "./workspace/WorkspaceLayout.tsx";

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
	// Edits an agent (or another window) saves appear live as undoable steps.
	useRevisionWatch({
		busy,
		dirtyRef,
		latestProject,
		onConflict: (conflicts) => {
			const known = store.getState().mergeConflicts;
			if (JSON.stringify(known) !== JSON.stringify(conflicts)) {
				store.setState({ mergeConflicts: conflicts });
			}
		},
		onExternal: (next, previous) => {
			commitServerProjectRef.current(next, previous, "Agent edit");
			store.setState({ mergeConflicts: [] });
			setStatus(
				studioFormat(
					"Applied an edit saved outside this editor (revision {revision}). Undo reverts it.",
					{ revision: next.revision }
				)
			);
		},
		onMerge: (merged, previous) => {
			// The merged project carries the edit made elsewhere plus this
			// editor's unsaved edits; it stays unsaved, so autosave writes it on
			// the newer revision. Undo steps back to the pre-merge timeline.
			latestProject.current = merged;
			store.setState((state) => ({
				history: recordHistory(state.history, previous, "Agent edit"),
				mergeConflicts: [],
			}));
			setProject((current) => (current?.id === merged.id ? merged : current));
			setDirty(true);
			setStatus(
				studioFormat(
					"Merged an edit saved outside this editor (revision {revision}) under your unsaved edits.",
					{ revision: merged.revision }
				)
			);
		},
		projectId: project?.id ?? null,
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
	useEffect(() => {
		if (!ready) {
			return;
		}
		let live = true;
		loadAssets(true)
			.then((library) => {
				if (live) {
					setProxyLibrary(library);
				}
			})
			.catch(() => {
				// Without the proxy listing the preview keeps the originals.
			});
		return () => {
			live = false;
		};
	}, [assets, ready]);
	const clipAssetKey = project?.segments.map((s) => s.assetId).join(",") ?? "";
	const clipAssets = useCallback(() => {
		const ids = new Set(clipAssetKey.split(",").filter(Boolean));
		return assets.filter((asset) => ids.has(asset.id));
	}, [assets, clipAssetKey]);
	useEffect(
		() =>
			previewSources.sync(
				clipAssets(),
				setSources,
				(error) => setStatus(message(error)),
				{ library: proxyLibrary, quality: previewQuality, useProxies }
			),
		[clipAssets, previewQuality, previewSources, proxyLibrary, useProxies]
	);
	// Half and Quarter quality ask the sidecar for a proxy of that size when
	// none is adequate yet; the listing is reloaded once each one is ready.
	const requestedProxies = useRef(new Set<string>());
	useEffect(() => {
		if (previewQuality === "full") {
			return;
		}
		for (const asset of clipAssets()) {
			const variant = wantedProxyVariant(asset, proxyLibrary, previewQuality);
			const key = `${asset.id}:${variant}`;
			if (!variant || requestedProxies.current.has(key)) {
				continue;
			}
			requestedProxies.current.add(key);
			request(studioResponseSchema, `/assets/${asset.id}/proxy`, "POST", {
				variant,
			})
				.then(() => loadAssets(true))
				.then(setProxyLibrary)
				.catch((error) =>
					setStatus(`Preview proxy unavailable: ${message(error)}`)
				);
		}
	}, [clipAssets, previewQuality, proxyLibrary]);
	// A transparent ProRes take (AI matte, cutout, Lottie) without its VP9
	// alpha copy cannot play with transparency in the browser: say so once.
	const reportedAlphaGaps = useRef(new Set<string>());
	useEffect(() => {
		// Judge only media the proxy listing already holds: its preview copy is
		// made before the derivative is returned, so a listing with the master
		// has the copy too, when there is one.
		const listed = new Set(proxyLibrary.map((asset) => asset.id));
		for (const asset of clipAssets()) {
			if (
				reportedAlphaGaps.current.has(asset.id) ||
				!listed.has(asset.id) ||
				!alphaPreviewMissing(asset, proxyLibrary)
			) {
				continue;
			}
			reportedAlphaGaps.current.add(asset.id);
			setStatus(
				`The preview cannot show “${asset.name}” with transparency: no VP9 alpha preview copy was made (this FFmpeg may lack libvpx-vp9). Exports keep its alpha.`
			);
		}
	}, [clipAssets, proxyLibrary]);

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
	/** Run a revision-checked sidecar edit; a stale revision reloads the project. */
	const routeEdit = async (
		action: string,
		body: Record<string, unknown>,
		describe: (extras: Record<string, unknown>) => string,
		options: RouteEditOptions = {}
	): Promise<RouteEditOutcome> => {
		let outcome: RouteEditOutcome = { status: "error" };
		await act(async () => {
			const previous = latestProject.current;
			if (
				options.planStamp !== undefined &&
				previous &&
				!planIsCurrent(options.planStamp, previous)
			) {
				setStatus(
					"The timeline changed since this plan was made. Run the plan again before applying it."
				);
				outcome = { status: "conflict" };
				return;
			}
			const saved = await ensureSaved();
			if (!(previous && saved)) {
				return;
			}
			try {
				const result = projectEditResponse(
					await request(
						studioResponseSchema,
						`/projects/${saved.id}/${action}`,
						"POST",
						{ ...body, revision: saved.revision }
					)
				);
				commitServerProject(result.project, previous);
				if (options.refreshAssets) {
					setAssets(await loadAssets());
				}
				store.setState((state) => {
					const current = state.selection.primaryId;
					return {
						selection: withPrimarySelection(
							state.selection,
							current &&
								result.project.segments.some(
									(segment) => segment.id === current
								)
								? current
								: null
						),
					};
				});
				setStatus(describe(result.extras));
				outcome = { extras: result.extras, status: "ok" };
			} catch (error) {
				if (!isRevisionConflict(error)) {
					throw error;
				}
				commitServerProject(
					projectSchema.parse(
						await request(studioResponseSchema, `/projects/${saved.id}`)
					)
				);
				store.setState({ history: emptyHistory() });
				setStatus(
					"The project changed elsewhere, so its latest revision was reloaded. Review it and try again."
				);
				outcome = { status: "conflict" };
			}
		});
		return outcome;
	};
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
		<EditorProvider value={runtime}>
			<AutosaveProvider>
				<div className="studio-app">
					<RyuAppToolbar className="studio-toolbar">
						<strong>Video Studio</strong>
						<NativeSelect
							aria-label="Project"
							className="min-w-[9rem]"
							disabled={!ready || busy}
							onChange={(event) =>
								void openProject(runtime, event.target.value)
							}
							value={project?.id ?? ""}
						>
							{!project && (
								<NativeSelectOption value="">
									Your film library
								</NativeSelectOption>
							)}
							{projects.map((p) => (
								<NativeSelectOption key={p.id} value={p.id}>
									{p.title}
								</NativeSelectOption>
							))}
						</NativeSelect>
						<StudioToolbarActions ready={ready} />
					</RyuAppToolbar>
					<ProjectTabs />
					<div aria-live="polite" className="studio-status" role="status">
						{status}
					</div>
					<div className="studio-banner empty:hidden">
						<AutosaveConflictBanner />
					</div>
					{project ? (
						<div
							aria-label="Media settings"
							className="studio-banner empty:hidden"
							role="region"
						>
							<MediaMismatchPrompt />
						</div>
					) : null}
					{project ? <AgentHandoffDialog /> : null}
					<ConnectedShortcutsDialog />
					{project ? (
						<WorkspaceLayout
							busy={busy}
							inspector={<ClipInspector />}
							library={<LibraryTabs />}
							stage={
								<main className="studio-stage">
									<div className="studio-stage-heading">
										<span>{project.title}</span>
										<span>
											{project.width} × {project.height} · {project.fps} fps
										</span>
									</div>
									<PreviewTabsPanel>
										<div className="studio-preview">
											<Preview
												assets={assets}
												onError={reportPreviewError}
												playing={playing}
												project={project}
												sources={sources}
												time={time}
											/>
											{!hasRenderableContent(project) && (
												<p className="studio-preview-empty">
													Add media, graphics, an avatar, a mesh, or a 3D block
													to start your timeline
												</p>
											)}
										</div>
										<div className="studio-playback">
											<Button
												aria-label={
													playing ? "Pause playback" : "Play timeline"
												}
												disabled={!duration}
												onClick={() => {
													setDirection(1);
													togglePlayback(runtime);
												}}
												variant="ghost"
											>
												{playing ? "Pause" : "Play"}
											</Button>
											<span className="font-mono">
												{clock(time)} / {clock(duration)}
											</span>
										</div>
									</PreviewTabsPanel>
								</main>
							}
							timeline={<Timeline />}
						/>
					) : (
						<RyuAppMain>
							<RyuAppEmpty
								description="Import your footage, build a timeline, and shape each scene. Your projects and exports stay on your Ryu node."
								title="A place for your next film"
							/>
						</RyuAppMain>
					)}
				</div>
			</AutosaveProvider>
		</EditorProvider>
	);
}
