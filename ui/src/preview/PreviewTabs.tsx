import { Button } from "@ryu/blocks/companion/controls";
import { useLiteralMessages } from "@ryu/i18n/react";
import { type ReactNode, useEffect, useRef } from "react";
import {
	canGoBack,
	canGoForward,
	prunePreviewTabs,
	TIMELINE_TAB,
} from "../../../shared/preview-tabs.ts";
import { useEditor } from "../editor/context.tsx";
import { useEditorStore } from "../editor/store.ts";
import type { ViewerStorageArea } from "../editor/viewer-storage.ts";
import { type SourceMediaLoader, SourceMonitor } from "./SourceMonitor.tsx";
import {
	activateTab,
	closeTab,
	loadPreviewTabs,
	savePreviewTabs,
	tabBack,
	tabForward,
} from "./source-tabs.ts";

/**
 * Restore the viewer's tabs when a project opens, save them on change, and
 * close tabs whose media left the library.
 */
function usePersistedTabs(storage?: ViewerStorageArea | null) {
	const { assets, project, store } = useEditor();
	const projectId = project?.id ?? null;
	const tabs = useEditorStore(store, (state) => state.previewTabs);
	const loadedFor = useRef<string | null>(null);
	useEffect(() => {
		if (!projectId) {
			return;
		}
		loadedFor.current = projectId;
		store.setState({ previewTabs: loadPreviewTabs(projectId, storage) });
	}, [projectId, storage, store]);
	const assetIds = assets.map((asset) => asset.id).join(",");
	useEffect(() => {
		if (!(assetIds && projectId)) {
			return;
		}
		const ids = new Set(assetIds.split(","));
		store.setState((state) => ({
			previewTabs: prunePreviewTabs(state.previewTabs, ids),
		}));
	}, [assetIds, projectId, store]);
	useEffect(() => {
		if (projectId && loadedFor.current === projectId) {
			savePreviewTabs(projectId, tabs, storage);
		}
	}, [projectId, storage, tabs]);
}

/**
 * The Preview panel's tab strip: a fixed Timeline tab and one closeable tab
 * per source opened from the library (double-click a tile or choose Open in
 * viewer), with Back and Forward through the tabs viewed.
 */
export function PreviewTabStrip() {
	const tl = useLiteralMessages();
	const { assets, store } = useEditor();
	const tabs = useEditorStore(store, (state) => state.previewTabs);
	const nameOf = (id: string) =>
		assets.find((asset) => asset.id === id)?.name ?? "Missing media";
	return (
		<div className="studio-preview-tabs">
			<Button
				aria-label="Previous preview tab"
				disabled={!canGoBack(tabs)}
				onClick={() => tabBack(store)}
				size="sm"
				variant="ghost"
			>
				‹
			</Button>
			<Button
				aria-label="Next preview tab"
				disabled={!canGoForward(tabs)}
				onClick={() => tabForward(store)}
				size="sm"
				variant="ghost"
			>
				›
			</Button>
			<div
				aria-label="Preview tabs"
				className="studio-preview-tablist"
				role="tablist"
			>
				<Button
					aria-selected={tabs.active === TIMELINE_TAB}
					data-preview-tab={TIMELINE_TAB}
					onClick={() => activateTab(store, TIMELINE_TAB)}
					role="tab"
					size="sm"
					variant={tabs.active === TIMELINE_TAB ? "secondary" : "ghost"}
				>
					Timeline
				</Button>
				{tabs.tabs.map((id) => {
					const name = nameOf(id);
					const active = tabs.active === id;
					return (
						<span className="studio-preview-tab" key={id}>
							<Button
								aria-selected={active}
								data-preview-tab={id}
								onAuxClick={(event) => {
									if (event.button === 1) {
										closeTab(store, id);
									}
								}}
								onClick={() => activateTab(store, id)}
								role="tab"
								size="sm"
								title={name}
								variant={active ? "secondary" : "ghost"}
							>
								<span className="max-w-[10rem] truncate">{name}</span>
							</Button>
							<Button
								aria-label={tl("Close {name}", { name })}
								onClick={() => closeTab(store, id)}
								size="sm"
								variant="ghost"
							>
								×
							</Button>
						</span>
					);
				})}
			</div>
		</div>
	);
}

/**
 * The preview with tabs: `children` (the timeline preview and transport)
 * while the Timeline tab is active, otherwise the source monitor for the
 * active tab. Switching to a source pauses timeline playback.
 */
export function PreviewTabsPanel({
	children,
	load,
	storage,
}: {
	children: ReactNode;
	/** Test hook: loads source media; production reads the sidecar. */
	load?: SourceMediaLoader;
	/** Test hook: the viewer storage area; production uses localStorage. */
	storage?: ViewerStorageArea | null;
}) {
	usePersistedTabs(storage);
	const runtime = useEditor();
	const active = useEditorStore(
		runtime.store,
		(state) => state.previewTabs.active
	);
	const source =
		active === TIMELINE_TAB
			? undefined
			: runtime.assets.find((asset) => asset.id === active);
	const showingSource = source !== undefined;
	const pauseTimeline = useRef(runtime.setPlaying);
	pauseTimeline.current = runtime.setPlaying;
	useEffect(() => {
		if (showingSource) {
			pauseTimeline.current(false);
		}
	}, [showingSource]);
	return (
		<>
			<PreviewTabStrip />
			{source ? (
				<SourceMonitor asset={source} key={source.id} load={load} />
			) : (
				children
			)}
		</>
	);
}
