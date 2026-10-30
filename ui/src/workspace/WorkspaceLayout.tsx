import { Button } from "@ryu/blocks/companion/controls";
import { useLiteralMessages } from "@ryu/i18n/react";
import {
	NativeSelect,
	NativeSelectOption,
} from "@ryu/ui/components/native-select.tsx";
import {
	ResizableHandle,
	ResizablePanel,
	ResizablePanelGroup,
} from "@ryu/ui/components/resizable.tsx";
import {
	type ReactNode,
	useEffect,
	useEffectEvent,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";
import { useEditor } from "../editor/context.tsx";
import { useEditorStore } from "../editor/store.ts";
import type { ViewerStorageArea } from "../editor/viewer-storage.ts";
import { TimelineColorsButton } from "../settings/TimelineColorsPane.tsx";
import {
	hasActionHandler,
	isEditableTarget,
	matchesCombo,
} from "../shortcuts/registry.ts";
import { shortcutStore } from "../shortcuts/shortcut-state.ts";
import {
	applyLayoutChoice,
	groupLayout,
	isWorkspacePanel,
	LAYOUT_PRESET_IDS,
	LAYOUT_PRESETS,
	type LayoutPresetId,
	MIN_PANEL_PERCENT,
	panelContaining,
	panelDomId,
	readLayoutState,
	resizeGroup,
	saveCurrentLayout,
	toggleMaximized,
	WORKSPACE_PANEL_ATTRIBUTE,
	WORKSPACE_PANEL_LABELS,
	type WorkspaceLayoutState,
	type WorkspacePanel,
	writeLayoutState,
} from "./layout-presets.ts";
import { toggleFocusedPanel } from "./maximize.ts";
import { Tour, type TourController, useTour } from "./Tour.tsx";
import type { TourTarget } from "./tour-state.ts";

/** Below this width the panels stack in one scrolling column, without splitters. */
export const STACKED_LAYOUT_QUERY = "(max-width: 680px)";

/** The splitter group's imperative handle (`setLayout` applies a preset). */
interface GroupHandle {
	getLayout: () => Record<string, number>;
	setLayout: (layout: Record<string, number>) => Record<string, number>;
}

function subscribeMedia(query: string, listener: () => void): () => void {
	try {
		const media = window.matchMedia(query);
		media.addEventListener("change", listener);
		return () => media.removeEventListener("change", listener);
	} catch {
		return () => undefined;
	}
}

function mediaMatches(query: string): boolean {
	try {
		return window.matchMedia(query).matches;
	} catch {
		return false;
	}
}

/** Whether the viewport is phone-width (the stacked layout). */
export function useStackedLayout(query = STACKED_LAYOUT_QUERY): boolean {
	return useSyncExternalStore(
		(listener) => subscribeMedia(query, listener),
		() => mediaMatches(query),
		() => false
	);
}

/** Layout sizes and preset for this viewer, saved on every change. */
function useLayoutState(area?: ViewerStorageArea | null) {
	const [layout, setLayout] = useState<WorkspaceLayoutState>(() =>
		readLayoutState(area)
	);
	useEffect(() => {
		writeLayoutState(layout, area);
	}, [area, layout]);
	return [layout, setLayout] as const;
}

/**
 * Until the shortcut registry has a `workspace.maximizePanel` handler, the
 * layout answers the viewer's binding for it (backtick by default) itself.
 */
function useMaximizeShortcutFallback(
	onToggle: (focus: Element | null) => void
) {
	const handleKey = useEffectEvent((event: KeyboardEvent) => {
		if (
			event.defaultPrevented ||
			hasActionHandler("workspace.maximizePanel") ||
			isEditableTarget(event.target)
		) {
			return;
		}
		const binding = shortcutStore
			.getState()
			.bindings.find((entry) => entry.action === "workspace.maximizePanel");
		if (!binding?.keys.some((combo) => matchesCombo(combo, event))) {
			return;
		}
		event.preventDefault();
		onToggle(
			event.target instanceof Element ? event.target : document.activeElement
		);
	});
	useEffect(() => {
		window.addEventListener("keydown", handleKey);
		return () => window.removeEventListener("keydown", handleKey);
	}, []);
}

/** Data attributes that show, hide, or highlight one workspace panel. */
function panelAttributes(
	panel: WorkspacePanel,
	maximized: WorkspacePanel | null,
	tourTarget: TourTarget | null
) {
	return {
		[WORKSPACE_PANEL_ATTRIBUTE]: panel,
		"data-tour-target": tourTarget === panel ? "" : undefined,
		"data-workspace-fill": maximized === panel ? "" : undefined,
		"data-workspace-hidden":
			maximized !== null && maximized !== panel ? "" : undefined,
	};
}

function LayoutBar({
	layout,
	maximized,
	onChoose,
	onMaximize,
	onSave,
	onTour,
	stacked,
	target,
	tourTarget,
}: {
	layout: WorkspaceLayoutState;
	maximized: WorkspacePanel | null;
	onChoose: (choice: LayoutPresetId | "saved") => void;
	onMaximize: () => void;
	onSave: () => void;
	onTour: () => void;
	stacked: boolean;
	target: WorkspacePanel;
	tourTarget: TourTarget | null;
}) {
	const tl = useLiteralMessages();
	const maximizeLabel = maximized
		? tl("Restore panels ({panel} is maximized)", {
				panel: tl(WORKSPACE_PANEL_LABELS[maximized]),
			})
		: tl("Maximize {panel}", {
				panel: tl(WORKSPACE_PANEL_LABELS[target]).toLowerCase(),
			});
	return (
		<div
			className="studio-layout-bar"
			data-tour-target={tourTarget === "layout" ? "" : undefined}
		>
			{!stacked && (
				<>
					<NativeSelect
						aria-label="Workspace layout"
						onChange={(event) => {
							const value = event.target.value;
							if (value === "saved" || value in LAYOUT_PRESETS) {
								onChoose(value as LayoutPresetId | "saved");
							}
						}}
						size="sm"
						value={layout.choice}
					>
						{LAYOUT_PRESET_IDS.map((id) => (
							<NativeSelectOption key={id} value={id}>
								{tl("{preset} layout", {
									preset: tl(LAYOUT_PRESETS[id].label),
								})}
							</NativeSelectOption>
						))}
						{layout.saved && (
							<NativeSelectOption value="saved">My layout</NativeSelectOption>
						)}
						{layout.choice === "custom" && (
							<NativeSelectOption disabled value="custom">
								Custom (unsaved)
							</NativeSelectOption>
						)}
					</NativeSelect>
					<Button
						disabled={maximized !== null}
						onClick={onSave}
						size="sm"
						variant="ghost"
					>
						Save current layout
					</Button>
				</>
			)}
			<Button
				aria-pressed={maximized !== null}
				onClick={onMaximize}
				size="sm"
				title="Maximize the focused panel (`)"
				variant="ghost"
			>
				{maximizeLabel}
			</Button>
			<Button
				aria-keyshortcuts="?"
				onClick={() => shortcutStore.openDialog()}
				size="sm"
				title="Keyboard shortcuts (?)"
				variant="ghost"
			>
				Keyboard shortcuts
			</Button>
			<TimelineColorsButton />
			<Button onClick={onTour} size="sm" variant="ghost">
				Take the tour
			</Button>
		</div>
	);
}

/**
 * The editor workspace: library, stage, and inspector columns above the
 * timeline, with splitters whose sizes, preset, and saved layout persist per
 * viewer. Backtick maximizes the focused panel, and a first-run tour walks
 * through each area. At phone width the panels stack in one column. The
 * library, stage, and inspector are inert while a blocking operation runs.
 */
export function WorkspaceLayout({
	busy,
	inspector,
	library,
	stage,
	storage,
	timeline,
}: {
	busy: boolean;
	inspector: ReactNode;
	library: ReactNode;
	stage: ReactNode;
	/** Test hook: the viewer storage area; production uses localStorage. */
	storage?: ViewerStorageArea | null;
	timeline: ReactNode;
}) {
	const { store } = useEditor();
	const stored = useEditorStore(store, (state) => state.maximizedPanel);
	const maximized = isWorkspacePanel(stored) ? stored : null;
	const stacked = useStackedLayout();
	const [layout, setLayout] = useLayoutState(storage);
	const [focused, setFocused] = useState<WorkspacePanel>("stage");
	const tour = useTour(storage);
	const tourTarget = tour.current?.target ?? null;
	const columnsRef = useRef<GroupHandle | null>(null);
	const rowsRef = useRef<GroupHandle | null>(null);

	useMaximizeShortcutFallback((focus) => {
		toggleFocusedPanel(store, focus);
	});

	const applySizes = (next: WorkspaceLayoutState) => {
		setLayout(next);
		columnsRef.current?.setLayout(groupLayout(next.sizes, "columns"));
		rowsRef.current?.setLayout(groupLayout(next.sizes, "rows"));
	};
	const onResized =
		(group: "columns" | "rows") => (sizes: Record<string, number>) => {
			if (store.getState().maximizedPanel !== null) {
				return;
			}
			setLayout((current) => resizeGroup(current, group, sizes));
		};
	const attributes = (panel: WorkspacePanel) =>
		panelAttributes(panel, maximized, tourTarget);
	const minSize = (id: keyof typeof MIN_PANEL_PERCENT) =>
		`${MIN_PANEL_PERCENT[id]}%`;

	const bar = (
		<WorkspaceChrome
			layout={layout}
			maximized={maximized}
			onChoose={(choice) => applySizes(applyLayoutChoice(layout, choice))}
			onMaximize={() =>
				store.setState({
					maximizedPanel: toggleMaximized(maximized, focused),
				})
			}
			onSave={() => setLayout(saveCurrentLayout(layout))}
			stacked={stacked}
			target={focused}
			tour={tour}
			tourTarget={tourTarget}
		/>
	);

	return (
		<div
			className="studio-workspace-shell"
			data-maximized={maximized ?? undefined}
			data-stacked={stacked ? "" : undefined}
			onFocusCapture={(event) =>
				setFocused(panelContaining(event.target, focused))
			}
		>
			{bar}
			{stacked ? (
				<>
					<div className="studio-workspace" inert={busy}>
						<div className="studio-workspace-panel" {...attributes("stage")}>
							{stage}
						</div>
						<div className="studio-workspace-panel" {...attributes("library")}>
							{library}
						</div>
						<div
							className="studio-workspace-panel"
							{...attributes("inspector")}
						>
							{inspector}
						</div>
					</div>
					<div className="studio-workspace-panel" {...attributes("timeline")}>
						{timeline}
					</div>
				</>
			) : (
				<ResizablePanelGroup
					className="studio-workspace-rows"
					defaultLayout={groupLayout(layout.sizes, "rows")}
					groupRef={rowsRef}
					id="studio-workspace-rows"
					onLayoutChanged={onResized("rows")}
					orientation="vertical"
				>
					<ResizablePanel
						className="studio-workspace-row"
						data-workspace-fill={
							maximized !== null && maximized !== "timeline" ? "" : undefined
						}
						data-workspace-hidden={maximized === "timeline" ? "" : undefined}
						id={panelDomId("workspace")}
						minSize={minSize("workspace")}
					>
						<ResizablePanelGroup
							className="studio-workspace"
							defaultLayout={groupLayout(layout.sizes, "columns")}
							groupRef={columnsRef}
							id="studio-workspace-columns"
							inert={busy}
							onLayoutChanged={onResized("columns")}
							orientation="horizontal"
						>
							<ResizablePanel
								className="studio-workspace-panel"
								id={panelDomId("library")}
								minSize={minSize("library")}
								{...attributes("library")}
							>
								{library}
							</ResizablePanel>
							<ResizableHandle
								aria-label="Resize library and preview"
								withHandle
							/>
							<ResizablePanel
								className="studio-workspace-panel"
								id={panelDomId("stage")}
								minSize={minSize("stage")}
								{...attributes("stage")}
							>
								{stage}
							</ResizablePanel>
							<ResizableHandle
								aria-label="Resize preview and inspector"
								withHandle
							/>
							<ResizablePanel
								className="studio-workspace-panel"
								id={panelDomId("inspector")}
								minSize={minSize("inspector")}
								{...attributes("inspector")}
							>
								{inspector}
							</ResizablePanel>
						</ResizablePanelGroup>
					</ResizablePanel>
					<ResizableHandle
						aria-label="Resize workspace and timeline"
						withHandle
					/>
					<ResizablePanel
						className="studio-workspace-panel"
						id={panelDomId("timeline")}
						minSize={minSize("timeline")}
						{...attributes("timeline")}
					>
						{timeline}
					</ResizablePanel>
				</ResizablePanelGroup>
			)}
		</div>
	);
}

function WorkspaceChrome({
	tour,
	...bar
}: Omit<Parameters<typeof LayoutBar>[0], "onTour"> & {
	tour: TourController;
}) {
	return (
		<>
			<LayoutBar {...bar} onTour={() => tour.send({ type: "start" })} />
			<Tour controller={tour} />
		</>
	);
}
