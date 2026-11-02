import { RyuAppActions } from "@ryu/blocks/companion/app-ui";
import { Button, Input } from "@ryu/blocks/companion/controls";
import { useLiteralMessages } from "@ryu/i18n/react";
import { ColorPickerPopover } from "@ryu/ui/components/color-picker.tsx";
import {
	NativeSelect,
	NativeSelectOption,
} from "@ryu/ui/components/native-select.tsx";
import { duplicateSelected } from "../editor/actions/clipboard.ts";
import { addMarker, removeMarker } from "../editor/actions/markers.ts";
import { insertSelectedAtPlayhead } from "../editor/actions/placement.ts";
import { deleteSelected } from "../editor/actions/ripple.ts";
import { useEditorProject } from "../editor/context.tsx";
import { clock } from "../editor/format.ts";
import { useEditorStore } from "../editor/store.ts";
import { NumberField } from "../NumberField.tsx";
import { useActionKeyHint, withKeyHint } from "../shortcuts/action-keys.ts";
import type { ActionId } from "../shortcuts/defaults.ts";
import { runAction } from "../shortcuts/registry.ts";
import { TrimToolSelector } from "../TrimToolSelector.tsx";
import { ActionToolbar } from "./ActionToolbar.tsx";
import type { EditorTimelineStyle } from "./timeline-style.ts";

/** Zoom levels offered in pixels per second. */
export const ZOOM_LEVELS = [20, 40, 70, 120] as const;

/** `S` and `Cmd/Ctrl+K` both run the toolbar's split. */
const SPLIT_ACTIONS: readonly ActionId[] = [
	"split.selected",
	"split.atPlayhead",
];

/** Edit buttons, tool selector, markers, playhead field, and zoom. */
export function TimelineToolbar() {
	const tl = useLiteralMessages();
	const runtime = useEditorProject();
	const {
		deletion,
		duration,
		project,
		selectedIds,
		selectedSegment,
		selectedTrackLocked,
		store,
	} = runtime;
	const { future, past } = useEditorStore(store, (state) => state.history);
	const splitKeys = useActionKeyHint(SPLIT_ACTIONS);
	const splitEditKeys = useActionKeyHint("splitEdit.openPanel");
	return (
		<div className="studio-timeline-toolbar">
			{/* Edit tools keep one row and scroll sideways when the panel is
			    narrow, so the playhead and zoom keep their width. */}
			<div className="studio-timeline-toolbar-tools">
				<RyuAppActions>
					<Button
						disabled={!past.length}
						onClick={runtime.undo}
						size="sm"
						variant="ghost"
					>
						Undo
					</Button>
					<Button
						disabled={!future.length}
						onClick={runtime.redo}
						size="sm"
						variant="ghost"
					>
						Redo
					</Button>
					<Button
						aria-keyshortcuts={splitKeys.aria}
						disabled={!project.segments.length}
						onClick={() => runAction("split.atPlayhead", runtime)}
						size="sm"
						title={withKeyHint(
							"Split the selection, or every unlocked clip under the playhead",
							splitKeys
						)}
						variant="outline"
					>
						Split at playhead
					</Button>
					<Button
						disabled={!selectedSegment || selectedTrackLocked}
						onClick={() => duplicateSelected(runtime)}
						size="sm"
						variant="ghost"
					>
						Duplicate
					</Button>
					<Button
						aria-keyshortcuts={splitEditKeys.aria}
						onClick={() => runtime.setPanel("split-edits")}
						size="sm"
						title={withKeyHint("Open automatic J/L cuts", splitEditKeys)}
						variant="ghost"
					>
						Auto J/L cuts
					</Button>
					<Button
						aria-label="Insert selected clip at playhead"
						disabled={!selectedSegment || selectedTrackLocked}
						onClick={() => insertSelectedAtPlayhead(runtime)}
						size="sm"
						variant="outline"
					>
						Insert
					</Button>
					<Button
						disabled={!selectedSegment || deletion?.locked}
						onClick={() => deleteSelected(runtime)}
						size="sm"
						title={
							deletion?.locked
								? "Unlock every affected clip track before deleting."
								: undefined
						}
						variant="ghost"
					>
						{selectedIds.length > 1
							? tl("Delete {count} clips", {
									count: String(selectedIds.length),
								})
							: "Delete clip"}
					</Button>
				</RyuAppActions>
				<TrimToolSelector onChange={runtime.setTool} tool={runtime.tool} />
				<ActionToolbar />
				{selectedIds.length > 1 && (
					<small className="shrink-0">
						{tl("{count} timeline clips selected · Shift-click to toggle", {
							count: String(selectedIds.length),
						})}
					</small>
				)}
				<div className="studio-marker-controls">
					<Input
						aria-label="Marker label"
						maxLength={120}
						onChange={(event) => runtime.setMarkerLabel(event.target.value)}
						placeholder="Marker label"
						value={runtime.markerLabel}
					/>
					<ColorPickerPopover
						onValueChange={runtime.setMarkerColor}
						triggerAriaLabel="Marker color"
						triggerClassName="h-9 w-14 shrink-0"
						triggerShowValue={false}
						value={runtime.markerColor}
					/>
					<Button
						onClick={() => addMarker(runtime)}
						size="sm"
						variant="outline"
					>
						Add marker
					</Button>
				</div>
			</div>
			<div className="studio-timeline-toolbar-fixed">
				{project.markers.length > 0 && (
					<details className="studio-marker-list">
						<summary>
							{tl(
								"{count, plural, one {{countText} timeline marker} other {{countText} timeline markers}}",
								{
									count: project.markers.length,
									countText: String(project.markers.length),
								}
							)}
						</summary>
						{project.markers.map((marker) => {
							const markerLegendStyle: EditorTimelineStyle = {
								"--studio-marker-color": marker.color ?? "var(--warning)",
							};
							return (
								<div className="studio-marker-row" key={marker.id}>
									<span
										aria-hidden="true"
										className="studio-marker-swatch"
										style={markerLegendStyle}
									/>
									<Button
										onClick={() => runtime.setTime(marker.time)}
										size="sm"
										variant="ghost"
									>
										{marker.label} · {clock(marker.time)}
										{marker.duration
											? `–${clock(marker.time + marker.duration)}`
											: ""}
									</Button>
									{(marker.status || marker.comment) && (
										<small>
											{marker.status ?? "open"}
											{marker.comment ? ` · ${marker.comment}` : ""}
										</small>
									)}
									<Button
										aria-label={tl("Remove marker {label}", {
											label: marker.label,
										})}
										onClick={() => removeMarker(runtime, marker.id)}
										size="sm"
										variant="ghost"
									>
										Remove
									</Button>
								</div>
							);
						})}
					</details>
				)}
				<NumberField
					label="Playhead"
					max={Math.max(duration, 1)}
					min={0}
					onChange={runtime.setTime}
					onFocus={() => runtime.setPlaying(false)}
					value={runtime.time}
				/>
				<NativeSelect
					aria-label="Timeline zoom"
					className="studio-timeline-zoom"
					onChange={(event) =>
						store.setState({ zoomPxPerSec: Number(event.target.value) })
					}
					value={runtime.zoom}
				>
					{ZOOM_LEVELS.map((value) => (
						<NativeSelectOption key={value} value={value}>
							{tl("{value}px / sec", { value })}
						</NativeSelectOption>
					))}
				</NativeSelect>
			</div>
		</div>
	);
}
