import { markerStatusOf, markersAt } from "../../../../shared/markers.ts";
import { clock } from "../../editor/format.ts";
import { MARKER_STATUS_LABELS } from "../../markers/MarkerEditor.tsx";
import { usePreviewMarkerLabels } from "../../markers/marker-preferences.ts";
import type { EditorTimelineStyle } from "../../timeline/timeline-style.ts";
import type { PreviewOverlayProps } from "./overlay-props.ts";

/** Most marker labels stacked over the frame at once. */
const MAX_PREVIEW_MARKERS = 3;

/**
 * Marker labels over the frame while the playhead is inside a range marker
 * or just past a point marker. Shown only when the viewer turns marker labels
 * on in the Markers panel.
 */
export function PreviewMarkers({ project, time }: PreviewOverlayProps) {
	const [enabled] = usePreviewMarkerLabels();
	if (!enabled) {
		return null;
	}
	const visible = markersAt(project.markers, time).slice(-MAX_PREVIEW_MARKERS);
	if (!visible.length) {
		return null;
	}
	return (
		<ul
			aria-label="Markers at the playhead"
			className="pointer-events-none absolute top-2 left-2 z-[5] flex max-w-[60%] flex-col gap-1"
			data-testid="preview-markers"
		>
			{visible.map((marker) => {
				const style: EditorTimelineStyle = {
					"--studio-marker-color": marker.color ?? "var(--warning)",
				};
				return (
					<li
						className="rounded-md border-(--studio-marker-color) border-l-4 bg-background/80 px-2 py-1 text-foreground text-xs shadow-sm backdrop-blur-sm"
						key={marker.id}
						style={style}
					>
						<span className="font-medium">{marker.label}</span>
						<span className="ms-2 text-muted-foreground">
							{clock(marker.time)}
							{marker.duration
								? `–${clock(marker.time + marker.duration)}`
								: ""}
							{marker.status
								? ` · ${MARKER_STATUS_LABELS[markerStatusOf(marker)]}`
								: ""}
						</span>
						{marker.comment ? (
							<span className="block truncate text-muted-foreground">
								{marker.comment}
							</span>
						) : null}
					</li>
				);
			})}
		</ul>
	);
}
