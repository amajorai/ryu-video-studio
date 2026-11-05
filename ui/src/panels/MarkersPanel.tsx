import {
	RyuAppActions,
	RyuAppEmpty,
	RyuAppField,
	RyuAppSection,
} from "@ryu/blocks/companion/app-ui";
import { Button, Switch, Textarea } from "@ryu/blocks/companion/controls";
import { useLiteralMessages } from "@ryu/i18n/react";
import {
	NativeSelect,
	NativeSelectOption,
} from "@ryu/ui/components/native-select.tsx";
import { useEffect, useRef, useState } from "react";
import {
	filterMarkers,
	markerStatusOf,
	markerStatusSchema,
} from "../../../shared/markers.ts";
import type { Marker } from "../../../shared/project.ts";
import { rippleMarkersOf } from "../../../shared/sync-lock.ts";
import { markerHandoffScope } from "../agent/agent-bridge.ts";
import {
	agentHandoffAvailable,
	requestAgentHandoff,
} from "../editor/actions/ai.ts";
import {
	editMarkers,
	markerFromRange,
	navigateMarker,
	setRippleMarkers,
	toggleMarker,
	updateMarker,
} from "../editor/actions/markers.ts";
import { useEditor } from "../editor/context.tsx";
import { clock } from "../editor/format.ts";
import type { EditorRuntime } from "../editor/runtime.ts";
import { type MarkerStatusFilter, useEditorStore } from "../editor/store.ts";
import { MARKER_STATUS_LABELS } from "../markers/MarkerEditor.tsx";
import { usePreviewMarkerLabels } from "../markers/marker-preferences.ts";
import type { EditorTimelineStyle } from "../timeline/timeline-style.ts";
import type { PanelTab } from "./types.ts";

/** The Markers panel has its own library tab. */
export const markersPanelTab: PanelTab | null = {
	label: "Markers",
	value: "markers",
};

/** The panel's status filter choices (the editor store's filter values). */
export const MARKER_FILTER_OPTIONS: readonly {
	label: string;
	value: MarkerStatusFilter;
}[] = [
	{ label: "All markers", value: "all" },
	{ label: "Unresolved", value: "open" },
	{ label: "Resolved", value: "resolved" },
];

const isMarkerFilter = (value: string): value is MarkerStatusFilter =>
	MARKER_FILTER_OPTIONS.some((option) => option.value === value);

/** One marker: seek, status, review comment (saved on blur), and delete. */
function MarkerRow({
	marker,
	runtime,
}: {
	marker: Marker;
	runtime: EditorRuntime;
}) {
	const tl = useLiteralMessages();
	const saved = marker.comment ?? "";
	const [comment, setComment] = useState(saved);
	const dirty = useRef(false);
	// Follow outside edits (undo, agents) without remounting the row, but
	// never overwrite an unsaved draft the user is typing.
	useEffect(() => {
		if (!dirty.current) {
			setComment(saved);
		}
	}, [saved]);
	const swatch: EditorTimelineStyle = {
		"--studio-marker-color": marker.color ?? "var(--warning)",
	};
	const saveComment = () => {
		const edited = dirty.current;
		dirty.current = false;
		if (edited && comment !== saved) {
			updateMarker(runtime, marker.id, { comment });
		}
	};
	const span = `${clock(marker.time)}${marker.duration ? `–${clock(marker.time + marker.duration)}` : ""}`;
	return (
		<li
			className="flex flex-col gap-1 border-border border-b py-2 last:border-b-0"
			data-marker-id={marker.id}
		>
			<div className="flex items-center gap-2">
				<span
					aria-hidden="true"
					className="size-2.5 flex-none rounded-full bg-(--studio-marker-color)"
					style={swatch}
				/>
				<Button
					aria-label={tl("Go to marker {label} at {time}", {
						label: marker.label,
						time: clock(marker.time),
					})}
					className="min-w-0 flex-1 justify-start truncate"
					onClick={() => {
						runtime.setPlaying(false);
						runtime.setTime(marker.time);
					}}
					size="sm"
					variant="ghost"
				>
					<span className="truncate">{marker.label}</span>
					<span className="ms-auto font-mono text-muted-foreground text-xs">
						{span}
					</span>
				</Button>
				<NativeSelect
					aria-label={tl("Status of {label}", { label: marker.label })}
					onChange={(event) =>
						updateMarker(runtime, marker.id, {
							status: markerStatusSchema.parse(event.target.value),
						})
					}
					value={markerStatusOf(marker)}
				>
					{markerStatusSchema.options.map((status) => (
						<NativeSelectOption key={status} value={status}>
							{MARKER_STATUS_LABELS[status]}
						</NativeSelectOption>
					))}
				</NativeSelect>
				<Button
					aria-label={tl("Ask agent about marker {label}", {
						label: marker.label,
					})}
					disabled={!agentHandoffAvailable()}
					onClick={() => {
						if (!requestAgentHandoff(runtime, markerHandoffScope(marker))) {
							runtime.setStatus("Ask agent is not available on this surface.");
						}
					}}
					size="sm"
					title={
						agentHandoffAvailable()
							? "Ask the agent about this marker"
							: "Ask agent is not available on this surface"
					}
					variant="ghost"
				>
					Ask agent
				</Button>
				<Button
					aria-label={tl("Delete marker {label}", { label: marker.label })}
					onClick={() =>
						editMarkers(
							runtime,
							{ action: "delete", markerId: marker.id },
							"Remove marker"
						)
					}
					size="sm"
					variant="ghost"
				>
					Delete
				</Button>
			</div>
			<Textarea
				aria-label={tl("Comment on {label}", { label: marker.label })}
				maxLength={2000}
				onBlur={saveComment}
				onChange={(event) => {
					dirty.current = true;
					setComment(event.target.value);
				}}
				placeholder="Add a review comment"
				rows={2}
				value={comment}
			/>
		</li>
	);
}

/** Marker list with status filter, comments, ripple toggle, and navigation. */
export function MarkersPanel() {
	const runtime = useEditor();
	const filter = useEditorStore(
		runtime.store,
		(state) => state.markerStatusFilter
	);
	const [previewLabels, setPreviewLabels] = usePreviewMarkerLabels();
	const { project } = runtime;
	if (!project) {
		return null;
	}
	const listed = filterMarkers(project.markers, filter);
	return (
		<RyuAppSection aria-label="Markers" title="Markers">
			<RyuAppActions>
				<Button
					onClick={() => toggleMarker(runtime)}
					size="sm"
					variant="outline"
				>
					Toggle at playhead
				</Button>
				<Button
					disabled={!(runtime.range.end > runtime.range.start)}
					onClick={() => markerFromRange(runtime)}
					size="sm"
					variant="outline"
				>
					Mark in/out range
				</Button>
				<Button
					disabled={!project.markers.length}
					onClick={() => navigateMarker(runtime, -1)}
					size="sm"
					variant="ghost"
				>
					Previous
				</Button>
				<Button
					disabled={!project.markers.length}
					onClick={() => navigateMarker(runtime, 1)}
					size="sm"
					variant="ghost"
				>
					Next
				</Button>
			</RyuAppActions>
			<div className="flex flex-wrap gap-3">
				<RyuAppField label="Show">
					<NativeSelect
						aria-label="Marker status filter"
						onChange={(event) => {
							const { value } = event.target;
							if (isMarkerFilter(value)) {
								runtime.store.setState({ markerStatusFilter: value });
							}
						}}
						value={filter}
					>
						{MARKER_FILTER_OPTIONS.map((option) => (
							<NativeSelectOption key={option.value} value={option.value}>
								{option.label}
							</NativeSelectOption>
						))}
					</NativeSelect>
				</RyuAppField>
				<RyuAppField
					description="Ripple deletes, inserts, and trims move markers after the edit."
					label="Ripple markers"
				>
					<Switch
						aria-label="Ripple markers"
						checked={rippleMarkersOf(project)}
						onCheckedChange={(checked) => setRippleMarkers(runtime, checked)}
					/>
				</RyuAppField>
				<RyuAppField label="Labels on preview">
					<Switch
						aria-label="Show marker labels on the preview"
						checked={previewLabels}
						onCheckedChange={setPreviewLabels}
					/>
				</RyuAppField>
			</div>
			{listed.length ? (
				<ul aria-label="Timeline markers" className="flex flex-col">
					{listed.map((marker) => (
						<MarkerRow key={marker.id} marker={marker} runtime={runtime} />
					))}
				</ul>
			) : (
				<RyuAppEmpty
					description={
						project.markers.length
							? "No markers match this filter."
							: "Press M to toggle a marker at the playhead, or Alt+M to mark the in/out range."
					}
					title={project.markers.length ? "Nothing to show" : "No markers yet"}
				/>
			)}
		</RyuAppSection>
	);
}
