import { Button } from "@ryu/blocks/companion/controls";
import { useLiteralMessages } from "@ryu/i18n/react";
import {
	Popover,
	PopoverAnchor,
	PopoverContent,
} from "@ryu/ui/components/popover.tsx";
import {
	type KeyboardEvent,
	type PointerEvent,
	useContext,
	useEffect,
	useRef,
	useState,
} from "react";
import type { Marker } from "../../../shared/project.ts";
import { markerHandoffScope } from "../agent/agent-bridge.ts";
import {
	agentHandoffAvailable,
	requestAgentHandoff,
} from "../editor/actions/ai.ts";
import {
	draggedMarkerTime,
	editMarkers,
	moveMarker,
	updateMarker,
} from "../editor/actions/markers.ts";
import { EditorContext } from "../editor/context.tsx";
import { clock } from "../editor/format.ts";
import type { EditorRuntime } from "../editor/runtime.ts";
import { MarkerEditor } from "../markers/MarkerEditor.tsx";
import type { EditorTimelineStyle } from "./timeline-style.ts";

/** Pointer travel, in pixels, before a press on a marker becomes a drag. */
export const MARKER_DRAG_THRESHOLD_PX = 3;

/** Short ruler labels for dense analysis markers (`Peak 3` → `P3`). */
export const rulerMarkerLabel = (label: string) =>
	label.startsWith("Peak ")
		? `P${label.slice("Peak ".length)}`
		: label.startsWith("Beat ")
			? `B${label.slice("Beat ".length)}`
			: label;

const markerSpan = (marker: Marker) =>
	`${clock(marker.time)}${marker.duration ? `–${clock(marker.time + marker.duration)}` : ""}`;

/**
 * Where a marker dragged by `deltaPx` lands: frame-quantized, on the
 * timeline, and with its range inside it.
 */
export function markerDragTime({
	deltaPx,
	duration,
	fps,
	marker,
	zoom,
}: {
	deltaPx: number;
	duration: number;
	fps: number;
	marker: Marker;
	zoom: number;
}): number {
	const raw = marker.time + deltaPx / Math.max(zoom, 1e-6);
	const frame = Math.max(1, fps);
	return draggedMarkerTime(marker, Math.round(raw * frame) / frame, duration);
}

interface MarkerDrag {
	id: string;
	moved: boolean;
	originX: number;
	time: number;
}

/**
 * Drag a ruler marker; the move is saved once, as one undo step, on
 * pointerup. A press that never travels stays a click (seek).
 */
function useMarkerDrag(runtime: EditorRuntime | null, zoom: number) {
	const [drag, setDrag] = useState<MarkerDrag | null>(null);
	const dragRef = useRef<MarkerDrag | null>(null);
	const suppressClick = useRef(false);
	const runtimeRef = useRef(runtime);
	runtimeRef.current = runtime;
	const dragging = drag !== null;

	useEffect(() => {
		if (!dragging) {
			return;
		}
		const update = (next: MarkerDrag | null) => {
			dragRef.current = next;
			setDrag(next);
		};
		const onMove = (event: globalThis.PointerEvent) => {
			const current = dragRef.current;
			const editor = runtimeRef.current;
			const marker = editor?.project?.markers.find(
				(candidate) => candidate.id === current?.id
			);
			if (!(current && editor?.project && marker)) {
				return;
			}
			const deltaPx = event.clientX - current.originX;
			if (!current.moved && Math.abs(deltaPx) < MARKER_DRAG_THRESHOLD_PX) {
				return;
			}
			update({
				...current,
				moved: true,
				time: markerDragTime({
					deltaPx,
					duration: editor.duration,
					fps: editor.project.fps,
					marker,
					zoom,
				}),
			});
		};
		const onUp = () => {
			const current = dragRef.current;
			const editor = runtimeRef.current;
			update(null);
			if (!(current?.moved && editor)) {
				return;
			}
			// Swallow only the click this release produces. Released off the
			// flag (clamped drag, vertical drift), that click lands on an
			// ancestor, so disarm after this tick rather than wait for it.
			suppressClick.current = true;
			setTimeout(() => {
				suppressClick.current = false;
			}, 0);
			const marker = editor.project?.markers.find(
				(candidate) => candidate.id === current.id
			);
			if (marker && marker.time !== current.time) {
				moveMarker(editor, current.id, current.time);
			}
		};
		const onCancel = () => update(null);
		window.addEventListener("pointermove", onMove);
		window.addEventListener("pointerup", onUp);
		window.addEventListener("pointercancel", onCancel);
		return () => {
			window.removeEventListener("pointermove", onMove);
			window.removeEventListener("pointerup", onUp);
			window.removeEventListener("pointercancel", onCancel);
		};
	}, [dragging, zoom]);

	const start = (event: PointerEvent<HTMLElement>, marker: Marker) => {
		if (!runtime?.project || event.button !== 0) {
			return;
		}
		// A fresh press never inherits a previous drag's suppression.
		suppressClick.current = false;
		const next = {
			id: marker.id,
			moved: false,
			originX: event.clientX,
			time: marker.time,
		};
		dragRef.current = next;
		setDrag(next);
	};
	/** True once for the click that ends a drag, so it does not seek. */
	const consumeClick = () => {
		const suppressed = suppressClick.current;
		suppressClick.current = false;
		return suppressed;
	};
	return { consumeClick, drag, start };
}

/**
 * Marker flags on the ruler. Clicking one seeks to it; dragging moves it
 * (saved on release); double-click, right-click, or Shift+Enter opens the
 * marker editor.
 */
export function TimelineMarkers({
	markers,
	onSeek,
	zoom,
}: {
	markers: readonly Marker[];
	onSeek: (time: number) => void;
	zoom: number;
}) {
	const tl = useLiteralMessages();
	const runtime = useContext(EditorContext);
	const { consumeClick, drag, start } = useMarkerDrag(runtime, zoom);
	const [editingId, setEditingId] = useState<string | null>(null);
	const editing = runtime
		? markers.find((marker) => marker.id === editingId)
		: undefined;
	const openEditor = (marker: Marker) => {
		runtime?.setPlaying(false);
		setEditingId(marker.id);
	};
	const onKeyDown = (event: KeyboardEvent<HTMLElement>, marker: Marker) => {
		if (event.key === "Enter" && event.shiftKey && runtime) {
			event.preventDefault();
			event.stopPropagation();
			openEditor(marker);
		}
	};
	const flags = markers.map((marker) => {
		const time = drag?.id === marker.id && drag.moved ? drag.time : marker.time;
		const markerPositionStyle: EditorTimelineStyle = {
			"--studio-marker-color": marker.color ?? "var(--warning)",
			"--studio-marker-left": `${time * zoom}px`,
			"--studio-marker-width": marker.duration
				? `${Math.max(1, marker.duration * zoom)}px`
				: "auto",
		};
		return (
			<Button
				aria-label={
					marker.duration
						? tl("Marker {label} at {start} through {end}", {
								end: clock(marker.time + marker.duration),
								label: marker.label,
								start: clock(marker.time),
							})
						: tl("Marker {label} at {start}", {
								label: marker.label,
								start: clock(marker.time),
							})
				}
				className={
					drag?.id === marker.id && drag.moved
						? "studio-marker cursor-grabbing"
						: "studio-marker cursor-grab"
				}
				data-compact={
					marker.label.startsWith("Peak ") || marker.label.startsWith("Beat ")
						? "true"
						: undefined
				}
				data-marker-id={marker.id}
				data-status={marker.status}
				key={marker.id}
				onClick={() => {
					if (!consumeClick()) {
						onSeek(marker.time);
					}
				}}
				onContextMenu={(event) => {
					if (runtime) {
						event.preventDefault();
						openEditor(marker);
					}
				}}
				onDoubleClick={() => openEditor(marker)}
				onKeyDown={(event) => onKeyDown(event, marker)}
				onPointerDown={(event) => start(event, marker)}
				size="sm"
				style={markerPositionStyle}
				title={`${marker.label} · ${markerSpan(marker)}${marker.comment ? ` · ${marker.comment}` : ""}`}
				variant="ghost"
			>
				{rulerMarkerLabel(marker.label)}
			</Button>
		);
	});
	if (!(runtime && editing)) {
		return flags;
	}
	const anchorStyle: EditorTimelineStyle = {
		"--studio-marker-left": `${editing.time * zoom}px`,
	};
	return (
		<>
			{flags}
			<Popover
				onOpenChange={(open) => {
					if (!open) {
						setEditingId(null);
					}
				}}
				open
			>
				<PopoverAnchor>
					<span
						aria-hidden="true"
						className="pointer-events-none absolute top-0 left-(--studio-marker-left) h-full w-px"
						style={anchorStyle}
					/>
				</PopoverAnchor>
				<PopoverContent align="start" data-no-scrub="" spacing="form">
					<MarkerEditor
						key={editing.id}
						marker={editing}
						onAskAgent={
							agentHandoffAvailable()
								? () => {
										setEditingId(null);
										requestAgentHandoff(runtime, markerHandoffScope(editing));
									}
								: undefined
						}
						onCancel={() => setEditingId(null)}
						onDelete={() => {
							setEditingId(null);
							editMarkers(
								runtime,
								{ action: "delete", markerId: editing.id },
								"Remove marker"
							);
						}}
						onSave={(patch) => {
							updateMarker(runtime, editing.id, patch);
						}}
					/>
				</PopoverContent>
			</Popover>
		</>
	);
}
