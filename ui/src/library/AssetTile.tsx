import { Button, Checkbox } from "@ryu/blocks/companion/controls";
import { useLiteralMessages } from "@ryu/i18n/react";
import type { DragEvent, MouseEvent, SyntheticEvent } from "react";
import type { Asset } from "../../../shared/project.ts";
import { AssetOrganization } from "../AssetOrganization.tsx";
import { AssetPreview } from "../AssetPreview.tsx";
import { ColorScopes } from "../ColorScopes.tsx";
import {
	addBarMarkers,
	addBeatMarkers,
	addLoudnessMarkers,
} from "../editor/actions/markers.ts";
import { dropAssetOnTimeline } from "../editor/actions/placement.ts";
import { removeDetectedSilence } from "../editor/actions/ripple.ts";
import { useEditor } from "../editor/context.tsx";
import { clock } from "../editor/format.ts";
import { useEditorStore } from "../editor/store.ts";
import { openAssetInViewer, setSourceMarks } from "../preview/source-tabs.ts";
import { SourceAnalysis } from "../SourceAnalysis.tsx";
import { addLibraryAsset, libraryTrackFor } from "./add-to-timeline.ts";
import { assetDragProps } from "./drag-source.ts";
import { useHoverSkim } from "./hover-skim.ts";
import {
	organizeAsset,
	refreshSequence,
	upscaleAsset,
} from "./library-actions.ts";
import { type SelectModifiers, selectModifiers } from "./library-selection.ts";
import type { LibraryView } from "./sort.ts";
import { markedRange, type SourceMarks } from "./source-marks.ts";

/** Hover-skim surface: pointer x scrubs the source frames of a tile. */
function SkimSurface({ asset, compact }: { asset: Asset; compact: boolean }) {
	const skim = useHoverSkim(asset);
	const label = skim.unavailable
		? "No preview"
		: skim.frame
			? null
			: asset.kind === "video"
				? "Hover to skim"
				: "Hover to preview";
	return (
		<div
			aria-hidden="true"
			className={`relative overflow-hidden rounded-md bg-muted ${compact ? "aspect-video w-full" : "h-14 w-24 shrink-0"}`}
			data-skim-time={skim.time ?? undefined}
			onPointerLeave={skim.onPointerLeave}
			onPointerMove={skim.onPointerMove}
		>
			{skim.frame && (
				<img
					alt=""
					className="pointer-events-none h-full w-full object-cover"
					draggable={false}
					height={asset.height || undefined}
					src={skim.frame}
					width={asset.width || undefined}
				/>
			)}
			{label && (
				<span className="absolute inset-0 flex items-center justify-center px-1 text-center text-[0.65rem] text-muted-foreground">
					{label}
				</span>
			)}
			{skim.time !== null && asset.kind === "video" && (
				<span className="absolute right-1 bottom-1 rounded bg-black/70 px-1 text-[0.6rem] text-white tabular-nums">
					{clock(skim.time)}
				</span>
			)}
		</div>
	);
}

/**
 * Whether an event really started inside the tile's DOM. React bubbles
 * events through portals, so clicks and drags inside the open preview dialog
 * would otherwise reach the tile's selection and drag handlers.
 */
function eventFromTile(event: SyntheticEvent<HTMLElement>): boolean {
	const { target } = event;
	return target instanceof Node && event.currentTarget.contains(target);
}

/** The tile's drag props, ignoring drags that bubble out of a portal. */
function tileDragProps(...args: Parameters<typeof assetDragProps>) {
	const props = assetDragProps(...args);
	return {
		...props,
		onDragEnd: (event: DragEvent<HTMLElement>) => {
			if (eventFromTile(event)) {
				props.onDragEnd();
			}
		},
		onDragStart: (event: DragEvent<HTMLElement>) => {
			if (eventFromTile(event)) {
				props.onDragStart(event);
			}
		},
	};
}

const NO_MARKS: SourceMarks = {};

/** One media library entry with its preview, analysis, and actions. */
export function AssetTile({
	asset,
	onDeleted,
	onSelect,
	selected = false,
	view = "list",
}: {
	asset: Asset;
	/** Called after the asset is deleted (the library resets a now-empty folder filter). */
	onDeleted: (asset: Asset) => void;
	/** Click on the tile body or its checkbox, with the selection modifiers. */
	onSelect?: (modifiers: SelectModifiers) => void;
	selected?: boolean;
	view?: LibraryView;
}) {
	const tl = useLiteralMessages();
	const runtime = useEditor();
	const { busy, setStatus } = runtime;
	const marks =
		useEditorStore(runtime.store, (state) => state.sourceMarks[asset.id]) ??
		NO_MARKS;
	const setMarks = (next: SourceMarks) =>
		setSourceMarks(runtime.store, asset.id, next);
	const openInViewer = () => openAssetInViewer(runtime.store, asset.id);
	const openOnDoubleClick = (event: MouseEvent<HTMLElement>) => {
		if (
			eventFromTile(event) &&
			!(event.target as HTMLElement).closest("button, a, input, summary")
		) {
			openInViewer();
		}
	};
	const range = markedRange(marks, asset);
	const grid = view === "grid";
	const select = (event: MouseEvent<HTMLElement>) => {
		if (
			!eventFromTile(event) ||
			(event.target as HTMLElement).closest("button, a, input, summary")
		) {
			return;
		}
		onSelect?.(selectModifiers(event));
	};
	const insertAtPlayhead = () =>
		dropAssetOnTimeline(runtime, asset, {
			at: runtime.time,
			mode: "insert",
			sourceIn: range?.start,
			sourceOut: range?.end,
			track: libraryTrackFor(asset),
		});
	const placement = (
		<>
			<Button
				aria-label={tl("Open {assetName} in the viewer", {
					assetName: asset.name,
				})}
				onClick={openInViewer}
				size="sm"
				title="Open in a preview tab (or double-click the tile)"
				variant="ghost"
			>
				Open in viewer
			</Button>
			<Button
				aria-label={tl("Add {assetName} to timeline", {
					assetName: asset.name,
				})}
				onClick={() => addLibraryAsset(runtime, asset, range)}
				size="sm"
				variant="ghost"
			>
				Add
			</Button>
			<Button
				aria-label={tl("Insert {assetName} at playhead", {
					assetName: asset.name,
				})}
				disabled={!runtime.project}
				onClick={insertAtPlayhead}
				size="sm"
				variant="ghost"
			>
				Insert at playhead
			</Button>
		</>
	);
	const heading = (
		<div className="flex min-w-0 items-start gap-2">
			{onSelect && (
				<Checkbox
					aria-label={tl("Select {assetName}", { assetName: asset.name })}
					checked={selected}
					className="mt-0.5"
					onClick={(event: MouseEvent<HTMLElement>) => {
						event.stopPropagation();
						const modifiers = selectModifiers(event);
						// A plain checkbox click toggles; Shift still selects a range.
						onSelect({
							...modifiers,
							toggle: !modifiers.range || modifiers.toggle,
						});
					}}
				/>
			)}
			<div className="min-w-0">
				<strong>{asset.name}</strong>
				<small>
					{asset.kind} · {clock(asset.duration)}
					{asset.width ? ` · ${asset.width} × ${asset.height}` : ""}
				</small>
				{range && (
					<small>
						{tl("Marked {markIn}–{markOut}", {
							markIn: clock(range.start),
							markOut: clock(range.end),
						})}
					</small>
				)}
				{!grid && asset.folder && (
					<small>
						{tl("Folder: {folderName}", { folderName: asset.folder })}
					</small>
				)}
				{!grid && asset.origin && (
					<small>
						{tl("Source: {provider} · {attribution}", {
							attribution: asset.origin.attribution,
							provider: asset.origin.provider,
						})}
					</small>
				)}
			</div>
		</div>
	);
	const preview = (
		<AssetPreview
			asset={asset}
			marks={marks}
			onError={setStatus}
			onMarksChange={setMarks}
		/>
	);
	if (grid) {
		return (
			// biome-ignore lint/a11y/noStaticElementInteractions: the checkbox is the accessible selection control; the tile click is a pointer shortcut.
			// biome-ignore lint/a11y/useKeyWithClickEvents: keyboard users select with the checkbox.
			<div
				className={`flex min-w-0 flex-col gap-1 rounded-md border p-1.5 text-xs ${selected ? "border-primary bg-primary/5" : "border-border"}`}
				data-asset-id={asset.id}
				data-selected={selected || undefined}
				onClick={select}
				onDoubleClick={openOnDoubleClick}
				{...tileDragProps(asset, range)}
			>
				{asset.kind !== "audio" && <SkimSurface asset={asset} compact />}
				{heading}
				<div className="flex flex-wrap gap-1">
					{preview}
					{placement}
				</div>
			</div>
		);
	}
	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: the checkbox is the accessible selection control; the tile click is a pointer shortcut.
		// biome-ignore lint/a11y/useKeyWithClickEvents: keyboard users select with the checkbox.
		<div
			className={`studio-asset ${selected ? "bg-primary/5" : ""}`}
			data-asset-id={asset.id}
			data-selected={selected || undefined}
			onClick={select}
			onDoubleClick={openOnDoubleClick}
			{...tileDragProps(asset, range)}
		>
			<div className="flex min-w-0 gap-2">
				{asset.kind !== "audio" && (
					<SkimSurface asset={asset} compact={false} />
				)}
				{heading}
			</div>
			{preview}
			{asset.kind !== "audio" && (
				<ColorScopes asset={asset} onError={setStatus} />
			)}
			{asset.kind !== "audio" && (
				<>
					<Button
						aria-label={tl("Upscale {assetName} 2 times", {
							assetName: asset.name,
						})}
						disabled={busy}
						onClick={() => void upscaleAsset(runtime, asset, 2)}
						size="sm"
						variant="ghost"
					>
						2× upscale
					</Button>
					<Button
						aria-label={tl("Upscale {assetName} 4 times", {
							assetName: asset.name,
						})}
						disabled={busy}
						onClick={() => void upscaleAsset(runtime, asset, 4)}
						size="sm"
						variant="ghost"
					>
						4× upscale
					</Button>
				</>
			)}
			{asset.sequenceProjectId && (
				<Button
					aria-label={tl("Refresh {assetName}", { assetName: asset.name })}
					disabled={busy}
					onClick={() => void refreshSequence(runtime, asset)}
					size="sm"
					variant="ghost"
				>
					Refresh sequence
				</Button>
			)}
			{placement}
			<AssetOrganization
				asset={asset}
				busy={busy}
				onDelete={() =>
					void organizeAsset(runtime, asset, {}, { onDeleted, remove: true })
				}
				onSave={(patch) => void organizeAsset(runtime, asset, patch)}
			/>
			{asset.kind !== "image" && (
				<SourceAnalysis
					asset={asset}
					onBarMarkers={(times) => addBarMarkers(runtime, times, asset.name)}
					onBeatMarkers={(times) => addBeatMarkers(runtime, times, asset.name)}
					onError={setStatus}
					onMarkers={(times) => addLoudnessMarkers(runtime, times, asset.name)}
					onRange={(start, end) =>
						addLibraryAsset(runtime, asset, { end, start })
					}
					onRemoveSilence={(ranges) =>
						removeDetectedSilence(runtime, asset.id, asset.name, ranges)
					}
				/>
			)}
		</div>
	);
}
