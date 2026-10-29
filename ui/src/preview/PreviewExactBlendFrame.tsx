import { adjustmentPreviewApproximate } from "../../../shared/adjustment.ts";
import type { Project } from "../../../shared/project.ts";
import {
	SERVER_FRAME_Z_INDEX,
	useServerFrame,
	visibleAdjustmentLayers,
} from "./PreviewAdjustmentLayer.tsx";
import { blendGapAt, overlayBlendGapAt } from "./stages/blend.ts";
import { previewSegmentVisible } from "./stages/visibility.ts";

/**
 * The exact frame for blend modes the browser only approximates. While the
 * preview is paused with no unsaved edits and a clip at the playhead uses a
 * mode with a preview gap (`blendPreviewGaps`), the sidecar's rendered frame
 * (`inspect-frame`, debounced and keyed by revision and time) covers the CSS
 * approximation. During playback, or while edits are unsaved, the CSS
 * `mix-blend-mode` preview stays on screen.
 *
 * While the WebGL2 blend compositor has a frame on screen
 * (`compositorShown`, see `PreviewBlendCompositor`) the media stack is
 * already exact, so the server frame is fetched only when a title or
 * graphic above it uses a blend mode the CSS preview approximates
 * (`overlayBlendGapAt`). Until the compositor has drawn, or while it is
 * hidden (media not ready), the clips' own gaps still bring in the frame.
 */
export function PreviewExactBlendFrame({
	compositorShown = false,
	project,
	time,
}: {
	compositorShown?: boolean;
	project: Project;
	time: number;
}) {
	// An approximate adjustment layer already swaps in the same frame.
	const needed =
		!visibleAdjustmentLayers(project, time).some(
			adjustmentPreviewApproximate
		) &&
		(compositorShown
			? overlayBlendGapAt(project, time)
			: blendGapAt(project, time, (segment) =>
					previewSegmentVisible(project, segment)
				));
	const frame = useServerFrame(project, time, needed);
	if (!(needed && frame)) {
		return null;
	}
	return (
		<img
			alt=""
			className="pointer-events-none absolute inset-0 size-full object-fill"
			data-testid="blend-server-frame"
			height={project.height}
			src={frame}
			style={{ zIndex: SERVER_FRAME_Z_INDEX }}
			width={project.width}
		/>
	);
}
