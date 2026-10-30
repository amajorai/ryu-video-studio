import { RyuAppSection } from "@ryu/blocks/companion/app-ui";
import {
	Button,
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	Input,
	ToggleGroup,
	ToggleGroupItem,
} from "@ryu/blocks/companion/controls";
import { useLiteralMessages, useRichLiteralMessages } from "@ryu/i18n/react";
import {
	NativeSelect,
	NativeSelectOption,
} from "@ryu/ui/components/native-select.tsx";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { useEditorProject } from "../editor/context.tsx";
import { createSequenceClip } from "../editor/project-actions.ts";
import { readViewerValue, writeViewerValue } from "../editor/viewer-storage.ts";
import { studioFormat } from "../i18n/format.ts";
import { SequencePanel } from "../SequencePanel.tsx";
import { SoundtrackPanel } from "../SoundtrackPanel.tsx";
import { AssetTile } from "./AssetTile.tsx";
import { deleteSelectedAssets, selectedAssetsInUse } from "./bulk-actions.ts";
import { importFiles, importRemoteMedia } from "./library-actions.ts";
import {
	EMPTY_LIBRARY_SELECTION,
	type LibrarySelection,
	pruneLibrarySelection,
	selectAllLibraryAssets,
	selectLibraryAsset,
} from "./library-selection.ts";
import { NewMediaMenu } from "./NewMediaMenu.tsx";
import { useOfflineMedia } from "./offline-media.ts";
import { RelinkDialog } from "./RelinkDialog.tsx";
import {
	DEFAULT_LIBRARY_PREFERENCES,
	filterAssets,
	LIBRARY_PREFERENCES_KEY,
	LIBRARY_SORT_DEFAULT_DIRECTION,
	LIBRARY_SORT_LABELS,
	type LibraryPreferences,
	libraryFolders,
	libraryPreferencesSchema,
	librarySortKeySchema,
	sortAssets,
} from "./sort.ts";

/** Library filters and the remote-import draft, kept while other tabs are open. */
export interface LibraryFilters {
	importUrl: string;
	mediaFolder: string;
	query: string;
}

/** The library's per-viewer sort and view, remembered across sessions. */
function useLibraryPreferences() {
	const [preferences, setPreferences] = useState<LibraryPreferences>(() =>
		readViewerValue(
			LIBRARY_PREFERENCES_KEY,
			libraryPreferencesSchema,
			DEFAULT_LIBRARY_PREFERENCES
		)
	);
	const update = (patch: Partial<LibraryPreferences>) =>
		setPreferences((current) => {
			const next = { ...current, ...patch };
			writeViewerValue(LIBRARY_PREFERENCES_KEY, next);
			return next;
		});
	return [preferences, update] as const;
}

/** The Media tab: import, generated sequences and soundtracks, and the asset list. */
export function AssetLibrary({
	filters,
	onFiltersChange,
}: {
	filters: LibraryFilters;
	onFiltersChange: (patch: Partial<LibraryFilters>) => void;
}) {
	const tl = useLiteralMessages();
	const tlRich = useRichLiteralMessages();
	const runtime = useEditorProject();
	const { assets, busy, project, projects } = runtime;
	const picker = useRef<HTMLInputElement>(null);
	// The library column opens at its top: a restored panel layout or tiles
	// that size after the first paint must not leave it scrolled partway.
	useLayoutEffect(() => {
		const scroller = picker.current?.closest<HTMLElement>(".studio-library");
		if (!scroller) {
			return;
		}
		scroller.scrollTop = 0;
		const frame = requestAnimationFrame(() => {
			scroller.scrollTop = 0;
		});
		return () => cancelAnimationFrame(frame);
	}, []);
	const { importUrl, mediaFolder, query } = filters;
	const [preferences, updatePreferences] = useLibraryPreferences();
	const [rawSelection, setSelection] = useState<LibrarySelection>(
		EMPTY_LIBRARY_SELECTION
	);
	const [confirming, setConfirming] = useState(false);
	const [relinkOpen, setRelinkOpen] = useState(false);
	const offline = useOfflineMedia();
	const mediaFolders = libraryFolders(assets);
	const visible = useMemo(
		() =>
			sortAssets(
				filterAssets(assets, { folder: mediaFolder, query }),
				preferences.sort,
				preferences.direction
			),
		[assets, mediaFolder, preferences.direction, preferences.sort, query]
	);
	const visibleIds = visible.map((asset) => asset.id);
	// Deleted or filtered-out assets leave the selection.
	const selection = pruneLibrarySelection(rawSelection, visibleIds);
	const selectedCount = selection.ids.length;
	const inUse = confirming
		? selectedAssetsInUse(projects, project, selection.ids)
		: new Map<string, string[]>();
	const deletableCount = selectedCount - inUse.size;
	const confirmDelete = () => {
		setConfirming(false);
		void deleteSelectedAssets(runtime, selection.ids, (deleted) => {
			setSelection(EMPTY_LIBRARY_SELECTION);
			if (
				mediaFolder &&
				deleted.some((asset) => asset.folder === mediaFolder) &&
				!runtime.assets.some(
					(asset) =>
						asset.folder === mediaFolder &&
						!deleted.some((item) => item.id === asset.id)
				)
			) {
				onFiltersChange({ mediaFolder: "" });
			}
		});
	};
	return (
		<RyuAppSection title="Media library">
			<Button
				disabled={busy}
				onClick={() => picker.current?.click()}
				variant="outline"
			>
				Import media
			</Button>
			<NewMediaMenu />
			<Button
				disabled={busy}
				onClick={() => setRelinkOpen(true)}
				variant="outline"
			>
				{offline.length
					? tl("Relink offline media ({offlineCount})", {
							offlineCount: String(offline.length),
						})
					: "Relink offline media"}
			</Button>
			<RelinkDialog onClose={() => setRelinkOpen(false)} open={relinkOpen} />
			<div className="studio-inline-fields">
				<Input
					aria-label="Import media URL"
					disabled={busy}
					onChange={(event) =>
						onFiltersChange({ importUrl: event.target.value })
					}
					placeholder="https://example.com/footage.mp4"
					value={importUrl}
				/>
				<Button
					disabled={busy || !importUrl.trim()}
					onClick={() =>
						importRemoteMedia(runtime, importUrl, () =>
							onFiltersChange({ importUrl: "" })
						)
					}
					variant="outline"
				>
					Import URL
				</Button>
			</div>
			<small>HTTPS URLs are probed and copied into app-owned storage.</small>
			<SequencePanel
				busy={busy}
				currentProjectId={project.id}
				onCreate={(source) => void createSequenceClip(runtime, source)}
				projects={projects}
			/>
			<SoundtrackPanel
				onAsset={(asset) => runtime.setAssets((current) => [asset, ...current])}
				onStatus={runtime.setStatus}
			/>
			<Input
				aria-label="Search media"
				onChange={(event) => onFiltersChange({ query: event.target.value })}
				placeholder="Search your footage…"
				value={query}
			/>
			<NativeSelect
				aria-label="Media folder"
				onChange={(event) =>
					onFiltersChange({ mediaFolder: event.target.value })
				}
				value={mediaFolder}
			>
				<NativeSelectOption value="">All folders</NativeSelectOption>
				{mediaFolders.map((folder) => (
					<NativeSelectOption key={folder} value={folder}>
						{folder}
					</NativeSelectOption>
				))}
			</NativeSelect>
			<div className="flex flex-wrap items-center gap-2">
				<NativeSelect
					aria-label="Sort media by"
					onChange={(event) => {
						const sort = librarySortKeySchema.parse(event.target.value);
						updatePreferences({
							direction: LIBRARY_SORT_DEFAULT_DIRECTION[sort],
							sort,
						});
					}}
					value={preferences.sort}
				>
					{librarySortKeySchema.options.map((key) => (
						<NativeSelectOption key={key} value={key}>
							{LIBRARY_SORT_LABELS[key]}
						</NativeSelectOption>
					))}
				</NativeSelect>
				<Button
					aria-label={
						preferences.direction === "asc"
							? "Sort ascending; switch to descending"
							: "Sort descending; switch to ascending"
					}
					onClick={() =>
						updatePreferences({
							direction: preferences.direction === "asc" ? "desc" : "asc",
						})
					}
					size="sm"
					variant="ghost"
				>
					{preferences.direction === "asc" ? "↑ Asc" : "↓ Desc"}
				</Button>
				<ToggleGroup
					aria-label="Library view"
					onValueChange={(value: unknown[]) => {
						const view = value[0];
						if (view === "grid" || view === "list") {
							updatePreferences({ view });
						}
					}}
					size="sm"
					value={[preferences.view]}
					variant="outline"
				>
					<ToggleGroupItem aria-label="List view" value="list">
						List
					</ToggleGroupItem>
					<ToggleGroupItem aria-label="Grid view" value="grid">
						Grid
					</ToggleGroupItem>
				</ToggleGroup>
			</div>
			{visible.length > 0 && (
				<div className="flex flex-wrap items-center gap-2 text-xs">
					<span aria-live="polite" className="text-muted-foreground">
						{selectedCount
							? studioFormat("{selected} of {total} selected", {
									selected: selectedCount,
									total: visible.length,
								})
							: studioFormat("{count, plural, one {# item} other {# items}}", {
									count: visible.length,
								})}
					</span>
					<Button
						disabled={selectedCount === visible.length}
						onClick={() => setSelection(selectAllLibraryAssets(visibleIds))}
						size="sm"
						variant="ghost"
					>
						Select all
					</Button>
					<Button
						disabled={!selectedCount}
						onClick={() => setSelection(EMPTY_LIBRARY_SELECTION)}
						size="sm"
						variant="ghost"
					>
						Clear selection
					</Button>
					<Button
						disabled={busy || !selectedCount}
						onClick={() => setConfirming(true)}
						size="sm"
						variant="outline"
					>
						Delete selected
					</Button>
				</div>
			)}
			{!assets.length && (
				<p className="text-muted-foreground">
					Bring in video, music, voice recordings, or still images.
				</p>
			)}
			<div
				className={
					preferences.view === "grid"
						? "grid grid-cols-[repeat(auto-fill,minmax(9rem,1fr))] gap-2"
						: "contents"
				}
				data-library-view={preferences.view}
			>
				{visible.map((asset) => (
					<AssetTile
						asset={asset}
						key={asset.id}
						onDeleted={(deleted) => {
							if (deleted.folder === mediaFolder) {
								onFiltersChange({ mediaFolder: "" });
							}
						}}
						onSelect={(modifiers) =>
							setSelection((current) =>
								selectLibraryAsset(
									pruneLibrarySelection(current, visibleIds),
									visibleIds,
									asset.id,
									modifiers
								)
							)
						}
						selected={selection.ids.includes(asset.id)}
						view={preferences.view}
					/>
				))}
			</div>
			<Dialog onOpenChange={setConfirming} open={confirming}>
				<DialogContent className="sm:max-w-lg">
					<DialogHeader>
						<DialogTitle>
							{tl(
								"{count, plural, one {Delete {countLabel} media item?} other {Delete {countLabel} media items?}}",
								{ count: selectedCount, countLabel: String(selectedCount) }
							)}
						</DialogTitle>
						<DialogDescription>
							Deleted media is removed from app storage and cannot be restored.
							Media a project still uses is kept; remove its clips first.
						</DialogDescription>
					</DialogHeader>
					{inUse.size > 0 && (
						<ul className="flex max-h-48 flex-col gap-1 overflow-y-auto text-xs">
							{[...inUse].map(([id, titles]) => (
								<li key={id}>
									{tlRich(
										"<b>{assetName}</b> stays: used in {projectTitles}",
										{
											assetName:
												assets.find((asset) => asset.id === id)?.name ?? id,
											projectTitles: titles.join(", "),
										},
										{ b: (chunks) => <strong>{chunks}</strong> }
									)}
								</li>
							))}
						</ul>
					)}
					<DialogFooter>
						<Button onClick={() => setConfirming(false)} variant="outline">
							Cancel
						</Button>
						<Button
							disabled={deletableCount === 0}
							onClick={confirmDelete}
							variant="destructive"
						>
							{tl(
								"{count, plural, one {Delete {countLabel} item} other {Delete {countLabel} items}}",
								{ count: deletableCount, countLabel: String(deletableCount) }
							)}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
			<input
				accept="video/*,audio/*,image/png,image/jpeg,image/webp,.json,.lottie"
				hidden
				multiple
				onChange={(event) => {
					void importFiles(runtime, event.target.files);
					event.target.value = "";
				}}
				ref={picker}
				type="file"
			/>
		</RyuAppSection>
	);
}
